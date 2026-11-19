// 事件规范化（QQ parser，P5 契约 v2 下沉，2026-11-17）：官方原始事件 →
// NormalizedMessage / InboundEffect。原 core src/normalize/index.ts + handler.ts
// 的解读权整体下沉本包（决策 #8）——core ingest 表驱动按 payload.platform 路由到
// plugin.normalize，core 对平台零硬编码。历史重演（迁移 v8）经命名导出
// normalizeQqMessage 复用同一实现。
// 身份全程 open_id（bot 维度隔离），禁止解析真实QQ号。
// 2026-11-08 存储重构：text（本条纯文本）/ content（渲染 markdown）分列；顶层引用结构化
//（quote，落 quote_json）；聊天记录拍平（records，落 message_records）；scope 统一 group|chat。

import type {
  NormalizedAttachment,
  NormalizedInbound,
  NormalizedMessage,
  NormalizedMention,
} from "@qsense/connector-sdk";
import {
  AttachmentCollector,
  decomposeElements,
  extractArk,
  parseAttachmentLike,
  parseRecordTranscript,
} from "./expand";

/** QQ 官方事件信封（{type, data}）；core ingest 的 QQ 分支唯一输入形状 */
export interface QqEvent {
  botId: string;
  type: string;
  data: unknown;
}

/** 解析 RFC3339 官方 timestamp → 毫秒；失败返回 null */
export function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function parseMentions(raw: Record<string, unknown>): NormalizedMention[] {
  const list = raw.mentions;
  if (!Array.isArray(list)) return [];
  const out: NormalizedMention[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const u = item as Record<string, unknown>;
    const id =
      typeof u.id === "string" && u.id !== ""
        ? u.id
        : typeof u.user_openid === "string"
          ? u.user_openid
          : typeof u.member_openid === "string"
            ? u.member_openid
            : "";
    if (id === "") continue;
    out.push({
      id,
      name: typeof u.username === "string" ? u.username : undefined,
    });
  }
  return out;
}

function parseAttachments(
  raw: Record<string, unknown>,
): NormalizedAttachment[] {
  const list = raw.attachments;
  if (!Array.isArray(list)) return [];
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
function atMeOf(raw: Record<string, unknown>): boolean | undefined {
  const list = raw.mentions;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  for (const item of list) {
    if (
      item !== null &&
      typeof item === "object" &&
      (item as Record<string, unknown>).is_you === true
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 官方 msg_idx 令牌提取：raw.message_scene.ext 形如 ["msg_idx=REFIDX_…", "auth_token=…"]。
 * 引用元素（103）以该令牌为锚指向被引消息——入库存列，quote_json 的锚与读取端懒补都用它。
 */
function extractMsgIdx(r: Record<string, unknown>): string | undefined {
  const scene = r.message_scene;
  if (scene === null || typeof scene !== "object") return undefined;
  const ext = (scene as Record<string, unknown>).ext;
  if (!Array.isArray(ext)) return undefined;
  for (const item of ext) {
    if (typeof item === "string" && item.startsWith("msg_idx=")) {
      const v = item.slice("msg_idx=".length);
      if (v !== "") return v;
    }
  }
  return undefined;
}

function authorField(raw: Record<string, unknown>, keys: string[]): string {
  const author = raw.author;
  if (author === null || typeof author !== "object") return "";
  const a = author as Record<string, unknown>;
  for (const k of keys) {
    if (typeof a[k] === "string" && (a[k] as string) !== "") return a[k];
  }
  return "";
}

/** 消息类事件 → NormalizedMessage（元素树分解为语义件）；非消息事件返回 null */
export function normalizeQqMessage(event: QqEvent): NormalizedMessage | null {
  const raw = event.data;
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  let scope: "group" | "chat";
  let scopeId: string;
  if (
    event.type === "GROUP_MESSAGE_CREATE" ||
    event.type === "GROUP_AT_MESSAGE_CREATE"
  ) {
    scope = "group";
    scopeId = typeof r.group_openid === "string" ? r.group_openid : "";
  } else if (event.type === "C2C_MESSAGE_CREATE") {
    scope = "chat";
    // 官方单聊事件体无顶层 user_openid：作者标识在 author 内（author.user_openid，兜底 author.id）
    scopeId = authorField(r, ["user_openid", "id"]);
  } else {
    return null;
  }
  if (scopeId === "") return null;

  const msgId = typeof r.id === "string" ? r.id : "";
  if (msgId === "") return null;

  const baseContent = typeof r.content === "string" ? r.content : "";
  const rawType =
    typeof r.message_type === "number" ? r.message_type : undefined;
  const elements = r.msg_elements ?? undefined;
  const extMsgIdx = extractMsgIdx(r);
  const collector = new AttachmentCollector();
  const topAtts = parseAttachments(r);
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
    elements === undefined && rawType === 102
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
  const fileNames = [
    ...new Set(
      topAtts
        .filter((a) => a.kind === "file" && a.filename !== undefined)
        .map((a) => a.filename as string),
    ),
  ];
  textLines.push(...fileNames);
  const text = textLines.filter((s) => s !== "").join("\n");
  const content = renderLines.filter((s) => s !== "").join("\n");
  // @本bot 权威判定：官方 mentions[].is_you（AT 事件与全量事件一致，见 atMeOf）；
  // 群消息盖章，单聊省略（mention 谓词里私聊天然命中）。
  const atMe = scope === "group" ? atMeOf(r) : undefined;

  return {
    botId: event.botId,
    scope,
    scopeId,
    msgId,
    authorOpenid: authorField(r, ["member_openid", "user_openid", "id"]),
    authorName: authorField(r, ["username"]) || undefined,
    authorRole: authorField(r, ["member_role"]) || undefined,
    ts: parseTimestamp(r.timestamp),
    text,
    content,
    quote,
    records,
    mentions: parseMentions(r),
    attachments: collector.list,
    ark: extractArk(r),
    msgIdx: extMsgIdx,
    ...(atMe !== undefined ? { atMe } : {}),
    raw: r,
  };
}

function fieldOf(data: unknown, key: string): string {
  if (data === null || typeof data !== "object") return "";
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
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
  payload: unknown,
): NormalizedInbound | null {
  if (payload === null || typeof payload !== "object") return null;
  const { type, data } = payload as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || type === "") return null;
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
      const g = fieldOf(data, "group_openid");
      return g === "" ? null : { messages: [], effects: [{ kind: "group-added", scopeId: g }] };
    }
    case "GROUP_DEL_ROBOT": {
      const g = fieldOf(data, "group_openid");
      return g === "" ? null : { messages: [], effects: [{ kind: "group-removed", scopeId: g }] };
    }
    case "GROUP_MSG_RECEIVE":
    case "GROUP_MSG_REJECT": {
      const g = fieldOf(data, "group_openid");
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
      const u = fieldOf(data, "user_openid");
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
      const target =
        fieldOf(data, "group_openid") || fieldOf(data, "user_openid");
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
