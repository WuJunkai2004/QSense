// 事件规范化：官方原始事件（RawEvent）→ NormalizedMessage / 状态变更。
// 身份全程 open_id（bot 维度隔离），禁止解析真实QQ号。

import type { RawEvent } from "../gateway";
import { expandElements, extractArk } from "./expand";
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
    if (item === null || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.url !== "string" || a.url === "") continue;
    out.push({
      url: a.url,
      filename: typeof a.filename === "string" ? a.filename : undefined,
      width: typeof a.width === "number" ? a.width : undefined,
      height: typeof a.height === "number" ? a.height : undefined,
      size: typeof a.size === "number" ? a.size : undefined,
      content_type:
        typeof a.content_type === "string" ? a.content_type : undefined,
      voice_wav_url:
        typeof a.voice_wav_url === "string" ? a.voice_wav_url : undefined,
      asr_refer_text:
        typeof a.asr_refer_text === "string" ? a.asr_refer_text : undefined,
    });
  }
  return out;
}

function authorField(raw: Record<string, unknown>, keys: string[]): string {
  const author = raw.author;
  if (author === null || typeof author !== "object") return "";
  const a = author as Record<string, unknown>;
  for (const k of keys) {
    if (typeof a[k] === "string" && (a[k] as string) !== "")
      return a[k] as string;
  }
  return "";
}

/** 消息类事件 → NormalizedMessage（含 elements 递归展开）；非消息事件返回 null */
export function normalizeMessage(event: RawEvent): NormalizedMessage | null {
  const raw = event.data;
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  let scope: "group" | "c2c";
  let scopeId: string;
  if (
    event.type === "GROUP_MESSAGE_CREATE" ||
    event.type === "GROUP_AT_MESSAGE_CREATE"
  ) {
    scope = "group";
    scopeId = typeof r.group_openid === "string" ? r.group_openid : "";
  } else if (event.type === "C2C_MESSAGE_CREATE") {
    scope = "c2c";
    scopeId = typeof r.user_openid === "string" ? r.user_openid : "";
  } else {
    return null;
  }
  if (scopeId === "") return null;

  const msgId = typeof r.id === "string" ? r.id : "";
  if (msgId === "") return null;

  const baseContent = typeof r.content === "string" ? r.content : "";
  const elements = r.msg_elements ?? undefined;
  const expanded = elements !== undefined ? expandElements(elements) : [];
  // content = 官方 content + 元素树展开（避免合并转发/引用内容在检索面丢失）
  const content = [baseContent.trim(), ...expanded]
    .filter((s) => s !== "")
    .join("\n");

  return {
    botId: event.botId,
    scope,
    scopeId,
    msgId,
    authorOpenid: authorField(r, ["member_openid", "user_openid", "id"]),
    authorName: authorField(r, ["username"]) || undefined,
    authorRole: authorField(r, ["member_role"]) || undefined,
    ts: parseTimestamp(r.timestamp),
    content,
    mentions: parseMentions(r),
    elements,
    attachments: parseAttachments(r),
    ark: extractArk(r),
    raw: r,
  };
}
