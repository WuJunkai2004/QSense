// 事件规范化：官方原始事件（RawEvent）→ NormalizedMessage / 状态变更。
// 身份全程 open_id（bot 维度隔离），禁止解析真实QQ号。
// 2026-11-08 存储重构：text（本条纯文本）/ content（渲染 markdown）分列；顶层引用结构化
//（quote，落 quote_json）；聊天记录拍平（records，落 message_records）；scope 统一 group|chat。

import type { RawEvent } from "../gateway";
import {
  AttachmentCollector,
  decomposeElements,
  extractArk,
  parseAttachmentLike,
} from "./expand";
import type {
  NormalizedAttachment,
  NormalizedMention,
  NormalizedMessage,
} from "./types";

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
export function normalizeMessage(event: RawEvent): NormalizedMessage | null {
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
  if (elements !== undefined) {
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
  const text = textLines.filter((s) => s !== "").join("\n");
  const content = renderLines.filter((s) => s !== "").join("\n");

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
    raw: r,
  };
}
