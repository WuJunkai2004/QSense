// 事件规范化（QQ parser，P5 契约 v2 下沉，2026-11-17）：官方原始事件 →
// NormalizedMessage / InboundEffect。原 core src/normalize/index.ts + handler.ts
// 的解读权整体下沉本包（决策 #8）——core ingest 表驱动按 payload.platform 路由到
// plugin.normalize，core 对平台零硬编码。历史重演（迁移 v8）经命名导出
// normalizeQqMessage 复用同一实现。
// 身份全程 open_id（bot 维度隔离），禁止解析真实QQ号。
// 2026-11-08 存储重构：text（本条纯文本）/ content（渲染 markdown）分列；顶层引用结构化
//（quote，落 quote_json）；聊天记录拍平（records，落 message_records）；scope 统一 group|chat。
// B⁺ T5：事件体过 wire schema（./wire）——防御性 typeof 分支退役，解析失败（data 非对象）
// 返回 null（容错丢弃语义不变）。

import type {
  ArkCard,
  NormalizedAttachment,
  NormalizedInbound,
  NormalizedMessage,
  NormalizedMention,
  RawEnvelope,
} from "@qsense/connector-sdk";
import { ArkCardSchema } from "@qsense/connector-sdk";
import type { QqAttachment, QqAuthor, QqMention } from "./wire";
import { QQ_EL_FORWARD } from "./wire";
import {
  QqEnvelopeSchema,
  QqGroupEventDataSchema,
  QqMessageEventDataSchema,
  QqUserDataSchema,
  type QqMessageEventData,
} from "./wire";
import {
  AttachmentCollector,
  decomposeElements,
  parseAttachmentLike,
  parseRecordTranscript,
} from "./expand";

/** QQ 官方事件信封（{type, data}）；core ingest 的 QQ 分支唯一输入形状。
 * data 是平台原始载荷边界（wire schema 在 normalizeQqMessage 内解析）。 */
export interface QqEvent {
  botId: string;
  type: string;
  data: unknown;
}

/** 解析 RFC3339 官方 timestamp → 毫秒；失败/缺失返回 null */
export function parseTimestamp(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** mentions → 归一提及：id/user_openid/member_openid 三名容错（id 非空优先，
 * 其余按名取值——空串也算命中，随后整体跳过，与旧实现逐条等价） */
function parseMentions(list: QqMention[]): NormalizedMention[] {
  const out: NormalizedMention[] = [];
  for (const u of list) {
    const id =
      u.id !== undefined && u.id !== ""
        ? u.id
        : (u.user_openid ?? u.member_openid ?? "");
    if (id === "") continue;
    out.push({
      id,
      name: u.username,
    });
  }
  return out;
}

function parseAttachments(list: QqAttachment[]): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const item of list) {
    const att = parseAttachmentLike(item);
    if (att !== null) out.push(att);
  }
  return out;
}

/**
 * @本bot 权威判定（契约 v2.1，真机 2026-11-19 修订）：官方事件体 mentions[].is_you
 * 就是「@是否本bot」的权威归属，AT 事件与全量事件一致——@本bot 时 true；@普通用户
 * （bot:false）与 @别的bot（bot:true 但 is_you:false）一律 false。任一 is_you=true
 * → true；含 mention 但无一命中 → false；官方未带 mentions → undefined（wait 层
 * mention 过滤对未知+含@ 从宽兜底，不漏叫醒优先）。
 * 旧口径「仅 AT 事件类型盖章」作废：它漏读 is_you，导致全量事件里 @他人 也是
 * atMe=undefined，误触发从宽兜底（真机三情形实证：bot:true/is_you:true、
 * bot:true/is_you:false、bot:false/is_you:false）。
 */
function atMeOf(list: QqMention[] | undefined): boolean | undefined {
  if (list === undefined || list.length === 0) return undefined;
  return list.some((m) => m.is_you === true);
}

/**
 * 官方 msg_idx 令牌提取：r.message_scene.ext 形如 ["msg_idx=REFIDX_…", "auth_token=…"]。
 * 引用元素（103）以该令牌为锚指向被引消息——入库存列，quote_json 的锚与读取端懒补都用它。
 */
function extractMsgIdx(r: QqMessageEventData): string | undefined {
  const ext = r.message_scene?.ext;
  if (ext === undefined) return undefined;
  for (const item of ext) {
    if (item !== undefined && item.startsWith("msg_idx=")) {
      const v = item.slice("msg_idx=".length);
      if (v !== "") return v;
    }
  }
  return undefined;
}

/** author 字段多名容错：按 keys 顺序取首个非空串（空串跳过继续找） */
type AuthorTextField = "user_openid" | "id" | "member_openid" | "username" | "member_role";
function authorField(author: QqAuthor | undefined, keys: readonly AuthorTextField[]): string {
  for (const k of keys) {
    const v = author?.[k];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

/** ARK 卡片提取（ark / ark_data 字段名都试）：ArkCard 契约形状校验
 * （SDK ArkCardSchema，真机采样锚定）；不合形状 = 无卡片（可观测降级） */
function extractArk(r: QqMessageEventData): ArkCard | undefined {
  const v = r.ark_data ?? r.ark;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const parsed = ArkCardSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** 消息类事件 → NormalizedMessage（元素树分解为语义件）；非消息事件/形状不符返回 null */
export function normalizeQqMessage(event: QqEvent): NormalizedMessage | null {
  const parsed = QqMessageEventDataSchema.safeParse(event.data);
  if (!parsed.success) return null;
  const r = parsed.data;

  let scope: "group" | "chat";
  let scopeId: string;
  if (
    event.type === "GROUP_MESSAGE_CREATE" ||
    event.type === "GROUP_AT_MESSAGE_CREATE"
  ) {
    scope = "group";
    scopeId = r.group_openid ?? "";
  } else if (event.type === "C2C_MESSAGE_CREATE") {
    scope = "chat";
    // 官方单聊事件体无顶层 user_openid：作者标识在 author 内（author.user_openid，兜底 author.id）
    scopeId = authorField(r.author, ["user_openid", "id"]);
  } else {
    return null;
  }
  if (scopeId === "") return null;

  const msgId = r.id ?? "";
  if (msgId === "") return null;

  const baseContent = r.content ?? "";
  const rawType = r.message_type;
  const elements = r.msg_elements;
  const extMsgIdx = extractMsgIdx(r);
  const collector = new AttachmentCollector();
  const topAtts = parseAttachments(r.attachments ?? []);
  // text = 官方 content + 元素树文本行（无标记无占位无外来内容）；content = 渲染 markdown
  //（媒体占位原位 + 结构标记）；引用与聊天记录出列结构化，不再糅进任何文本列。
  let textLines: string[];
  let renderLines: string[];
  let quote: NormalizedMessage["quote"];
  let records: NormalizedMessage["records"];
  // 官方合并转发无元素树形状（真机 2026-11-08：消息级 message_type=102 + content 直带
  // 「=== 消息 N ===」转写）：解析进 records，宿主只留条数标记——外来转写不进任何文本列。
  // 元素树若有 102 则走 decompose 拍平（带 openid，信息更全），树优先。
  const transcript =
    elements === undefined && rawType === QQ_EL_FORWARD
      ? parseRecordTranscript(baseContent)
      : null;
  if (transcript !== null) {
    renderLines = [`[${transcript.title}·${transcript.records.length}条]`];
    textLines = [];
    quote = null;
    records = transcript.records.map((rec, i) => ({
      ord: i,
      depth: 0,
      authorName: rec.authorName,
      text: rec.text,
      quote: null,
      attachments: [],
    }));
  } else if (elements !== undefined) {
    const d = decomposeElements(elements, collector);
    quote = d.quote;
    records = d.records;
    // 顶层附件里未被元素树表达的（罕见：树内已带则 URL 去重跳过）→ 追加在尾部
    const leftover = topAtts
      .filter((a) => !collector.has(a.url))
      .map((a) => collector.place(a));
    renderLines = [baseContent.trim(), ...d.renderLines, ...leftover];
    textLines = [baseContent.trim(), ...d.textLines];
  } else {
    // 无元素树（真机多数纯媒体消息形状）：载荷不含图文先后，约定媒体前置
    const placeholders = topAtts.map((a) => collector.place(a));
    renderLines = [...placeholders, baseContent.trim()];
    textLines = [baseContent.trim()];
    quote = null;
    records = [];
  }
  // 文件名属本条内容（用户主动发的文件）：进 text 供检索（渲染占位符已带名字）
  const fileNames = new Set<string>();
  for (const a of topAtts) {
    if (a.kind === "file" && a.filename !== undefined) fileNames.add(a.filename);
  }
  textLines.push(...fileNames);
  const text = textLines.filter((s) => s !== "").join("\n");
  const content = renderLines.filter((s) => s !== "").join("\n");
  // @本bot 权威判定：官方 mentions[].is_you（AT 事件与全量事件一致，见 atMeOf）；
  // 群消息盖章，单聊省略（mention 谓词里私聊天然命中）。
  const atMe = scope === "group" ? atMeOf(r.mentions) : undefined;

  return {
    botId: event.botId,
    scope,
    scopeId,
    msgId,
    authorOpenid: authorField(r.author, ["member_openid", "user_openid", "id"]),
    authorName: authorField(r.author, ["username"]) || undefined,
    authorRole: authorField(r.author, ["member_role"]) || undefined,
    ts: parseTimestamp(r.timestamp),
    text,
    content,
    quote,
    records,
    mentions: parseMentions(r.mentions ?? []),
    attachments: collector.list,
    ark: extractArk(r),
    msgIdx: extMsgIdx,
    ...(atMe !== undefined ? { atMe } : {}),
    rawJson: JSON.stringify(r),
  };
}

/** 效应事件的宽松定位：群标识（缺字段/类型不符 → ""） */
function groupOpenidOf(data: unknown): string {
  const r = QqGroupEventDataSchema.safeParse(data);
  return r.success ? (r.data.group_openid ?? "") : "";
}

/** 效应事件的宽松定位：用户标识 */
function userOpenidOf(data: unknown): string {
  const r = QqUserDataSchema.safeParse(data);
  return r.success ? (r.data.user_openid ?? "") : "";
}

/**
 * QQ 信封 → NormalizedInbound（plugin.normalize 入口）：
 * 消息类事件产出成品消息 + 群保底在册效应；生命周期/开关/审核事件只产效应。
 * 群注册表证据规则（自 core handler.ts 原样平移）：
 * - GROUP_MESSAGE_CREATE（全量消息到达）→ 群必然开着全量开关 → fullMsg=true
 * - GROUP_AT_MESSAGE_CREATE（仅@消息）→ 群在册但开关未知 → fullMsg 省略（不改开关）
 * - GROUP_ADD_ROBOT → 新增（开关未确认）；GROUP_MSG_RECEIVE/REJECT → 开/关；GROUP_DEL_ROBOT → 移出
 * - C2C_MSG_RECEIVE/REJECT → 单聊 opt-in/out；MESSAGE_AUDIT_PASS/REJECT → 审核回执
 * 其余事件（MESSAGE_AUDIT / INTERACTION 等）无落地语义 → null。
 */
export function normalizeQqEnvelope(
  botId: string,
  payload: RawEnvelope,
): NormalizedInbound | null {
  const env = QqEnvelopeSchema.safeParse(payload);
  if (!env.success) return null;
  const { type, data } = env.data;
  if (type === "") return null;
  const event: QqEvent = { botId, type, data };

  switch (type) {
    case "GROUP_MESSAGE_CREATE":
    case "GROUP_AT_MESSAGE_CREATE": {
      const m = normalizeQqMessage(event);
      if (m === null) return null;
      return {
        messages: [m],
        effects: [
          {
            kind: "group-seen",
            scopeId: m.scopeId,
            ...(type === "GROUP_MESSAGE_CREATE" ? { fullMsg: true } : {}),
          },
        ],
      };
    }
    case "C2C_MESSAGE_CREATE": {
      const m = normalizeQqMessage(event);
      if (m === null) return null;
      return { messages: [m], effects: [] };
    }
    case "GROUP_ADD_ROBOT": {
      const g = groupOpenidOf(data);
      return g === "" ? null : { messages: [], effects: [{ kind: "group-added", scopeId: g }] };
    }
    case "GROUP_DEL_ROBOT": {
      const g = groupOpenidOf(data);
      return g === "" ? null : { messages: [], effects: [{ kind: "group-removed", scopeId: g }] };
    }
    case "GROUP_MSG_RECEIVE":
    case "GROUP_MSG_REJECT": {
      const g = groupOpenidOf(data);
      return g === ""
        ? null
        : {
            messages: [],
            effects: [
              { kind: "group-opt", scopeId: g, allow: type === "GROUP_MSG_RECEIVE" },
            ],
          };
    }
    case "C2C_MSG_RECEIVE":
    case "C2C_MSG_REJECT": {
      const u = userOpenidOf(data);
      return u === ""
        ? null
        : {
            messages: [],
            effects: [
              { kind: "chat-opt", scopeId: u, allow: type === "C2C_MSG_RECEIVE" },
            ],
          };
    }
    case "MESSAGE_AUDIT_PASS":
    case "MESSAGE_AUDIT_REJECT": {
      // 主动消息人工审核结果（304023/304024 的异步回执）：回填 sends 账本 earliest pending 行。
      // 官方事件体字段未完全核实（M5 真机观察），容错取 group_openid/user_openid 定位。
      const target = groupOpenidOf(data) || userOpenidOf(data);
      return target === ""
        ? null
        : {
            messages: [],
            effects: [
              { kind: "audit", target, pass: type === "MESSAGE_AUDIT_PASS" },
            ],
          };
    }
    default:
      return null;
  }
}
