// 微信 parser（契约 v2：解读权在插件）：WeixinMessage → NormalizedMessage + InboundEffect。
//
// 映射决策（每条都是平台语义翻译，不是猜测）：
// - scope 恒 "chat"（caps.scopes=["chat"]；带 group_id 的消息超出当前能力面，不消费）
// - 会话/作者 id：from_user_id（形如 xxx@im.wechat）；平台消息体不含昵称 → authorName 省略
// - msg_id：message_id（uint64 无损字符串）；缺失回落首个 item 的 msg_id，再回落 client_id
// - message_type=BOT 是机器人自身消息的回声 → 不入库（自发消息由 core 发送侧本地补记）
// - delete_time_ms>0 = 已撤回/删除 → 不消费（原消息已在库；v1 无删除效应词汇）
// - 引用：ref_msg → quote_json。msgIdx=msgId=被引 svr_id：msgIdx 供 core 懒补被引作者；
//   msgId 保证懒补未命中（如被引是 bot 自发补记行）时仍有锚点。正文快照优先级：
//   服务端快照（ref_msg.message_item）> 实例侧本地引用缓存（payload.quoteText）> title 摘要
// - 附件：image/voice/file/video → ![附件n] 约定（图片 url 来自摄取期解密富化 mediaBlobs，
//   缺失时空串——get_media 给可操作错误）；文件名进 text 可检索（与 QQ 同约定）
// - 被引媒体归 quote.attachments，不混本条正文/附件（与 QQ 103 被引图同一语义）
// - 私聊 opt-in 等价映射：用户给 bot 发消息即视为在场同意（chat-opt allow=true，同 Telegram）
// - raw 里的 context_token 是出站回带凭据 → 入库前打码（已单独持久化在 StatePort，
//   不随消息行扩散到 WebUI 详情/导出面）

import { z } from "zod";
import type {
  NormalizedAttachment,
  NormalizedInbound,
  NormalizedMessage,
  NormalizedQuote,
} from "@qsense/connector-sdk";
import { mediaLabelOf, resolvePartialQuote } from "./quote";
import {
  MessageItemType,
  MessageType,
  WeixinMessageSchema,
  type MessageItem,
  type WeixinMessage,
} from "./types";

/** 上行载荷信封（instance → host.ingest）：core ingest 按 platform 字段路由到本 parser */
export interface WeixinInboundPayload {
  platform: "weixin";
  message: WeixinMessage;
  /** 摄取期解密富化的图片（键=item_list 下标；被引图为 "quote"）；无图无键 */
  mediaBlobs?: Record<string, string>;
  /** 实例侧本地引用缓存命中的被引正文（ID-only 引用的正文线索） */
  quoteText?: string;
}

/** 信封 wire schema（B⁺ T5）：plugin.normalize 头部 safeParse 入口——形状违规
 * = 可观测丢弃 + warn（路由已保证 platform 匹配，schema 失败即载荷损坏） */
export const WeixinInboundPayloadSchema = z.looseObject({
  platform: z.literal("weixin"),
  message: WeixinMessageSchema,
  mediaBlobs: z.record(z.string(), z.string()).optional(),
  quoteText: z.string().optional(),
});

const REDACTED = "<redacted>";

/** id 字段取值：trim（uint64 无损解析后恒字符串；空串=缺失） */
export function idOf(v: string | undefined): string {
  return v?.trim() ?? "";
}

function textOf(v: string | undefined): string {
  return v ?? "";
}

/** 消息 id（无损）：message_id → 首个 item 的 msg_id → client_id；皆无为空串 */
export function weixinMsgIdOf(m: WeixinMessage): string {
  const top = idOf(m.message_id);
  if (top !== "") return top;
  for (const item of m.item_list ?? []) {
    const id = idOf(item?.msg_id);
    if (id !== "") return id;
  }
  return idOf(m.client_id);
}

/** 被引消息 id（ref_msg.svr_id 优先，回落 message_item.msg_id）；无引用/无 id 为 undefined */
export function quoteRefIdOf(m: WeixinMessage): string | undefined {
  const ref = (m.item_list ?? []).find((i) => i.ref_msg !== undefined)?.ref_msg;
  if (ref === undefined) return undefined;
  const id =
    idOf(ref.svr_id) ||
    (ref.message_item !== undefined ? idOf(ref.message_item.msg_id) : "");
  return id === "" ? undefined : id;
}

/**
 * 是否属于消费面（instance 摄取前与 parser 共用同一判定，避免给将丢弃的消息做网络富化）：
 * 机器人回声 / 群消息 / 已删除 / 无法定位作者或 id 的消息不消费。
 */
export function isSupportedInbound(m: WeixinMessage): boolean {
  if (m.message_type === MessageType.BOT) return false;
  if ((m.group_id ?? "").trim() !== "") return false;
  if ((m.delete_time_ms ?? 0) > 0) return false;
  if (idOf(m.from_user_id) === "") return false;
  return weixinMsgIdOf(m) !== "";
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function mimeOfName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function mimeOfDataUrl(url: string): string | undefined {
  return /^data:([\w.+-]+\/[\w.+-]+);base64,/.exec(url)?.[1];
}

function humanSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** 单个媒体 item → 附件元数据（key = blobs 里的富化键）；非媒体/形状不全返回 null */
function attachmentOf(
  item: MessageItem,
  key: string,
  blobs: Record<string, string>,
): NormalizedAttachment | null {
  switch (item.type) {
    case MessageItemType.IMAGE: {
      const img = item.image_item;
      if (img === undefined) return null;
      const url = blobs[key] ?? "";
      return {
        kind: "image",
        url,
        ...(img.mid_size !== undefined ? { size: img.mid_size } : {}),
        content_type: mimeOfDataUrl(url) ?? "image/jpeg",
      };
    }
    case MessageItemType.VOICE: {
      const v = item.voice_item;
      if (v === undefined) return null;
      const playtime = v.playtime;
      const asr = textOf(v.text).trim();
      return {
        kind: "voice",
        url: "",
        ...(playtime !== undefined ? { duration: Math.round(playtime / 1000) } : {}),
        ...(asr !== "" ? { asr_refer_text: v.text } : {}),
        content_type: "audio/silk",
      };
    }
    case MessageItemType.FILE: {
      const f = item.file_item;
      if (f === undefined) return null;
      const name = textOf(f.file_name).trim();
      const size =
        f.len !== undefined && f.len !== "" && Number.isFinite(Number(f.len))
          ? Number(f.len)
          : undefined;
      return {
        kind: "file",
        url: "",
        ...(name !== "" ? { filename: name } : {}),
        ...(size !== undefined ? { size } : {}),
        content_type: name !== "" ? mimeOfName(name) : "application/octet-stream",
      };
    }
    case MessageItemType.VIDEO: {
      const v = item.video_item;
      if (v === undefined) return null;
      const tw = v.thumb_width;
      const th = v.thumb_height;
      return {
        kind: "video",
        url: "",
        ...(v.video_size !== undefined ? { size: v.video_size } : {}),
        ...(tw !== undefined && th !== undefined ? { width: tw, height: th } : {}),
        content_type: "video/mp4",
      };
    }
    default:
      return null;
  }
}

/** 附件占位符（与 QQ 读取层 AttachmentCollector.place 同约定） */
function placeholderOf(att: NormalizedAttachment, n: number): string {
  if (att.kind === "voice" && att.asr_refer_text !== undefined) {
    return `![附件${n}]（转写：${att.asr_refer_text}）`;
  }
  if (att.kind === "file" && att.filename !== undefined) {
    const size = att.size !== undefined ? ` (${humanSize(att.size)})` : "";
    return `[附件${n} ${att.filename}${size}]`;
  }
  return `![附件${n}]`;
}

/** 被引消息快照（ref_msg.message_item）的文字化：文本取原文，媒体取占位 */
function snapshotBodyOf(item: MessageItem): string | undefined {
  if (item.type === MessageItemType.TEXT) {
    const t = textOf(item.text_item?.text).trim();
    return t === "" ? undefined : t;
  }
  if (item.type === MessageItemType.VOICE) {
    const t = textOf(item.voice_item?.text).trim();
    return t === "" ? "[语音]" : t;
  }
  if (item.type === MessageItemType.FILE) {
    const name = textOf(item.file_item?.file_name).trim();
    return name === "" ? "[文件]" : `[文件] ${name}`;
  }
  const label = mediaLabelOf(item.type);
  return label === "" ? undefined : label;
}

function parseQuote(
  m: WeixinMessage,
  payload: WeixinInboundPayload,
  blobs: Record<string, string>,
): NormalizedQuote | null {
  const ref = (m.item_list ?? []).find((i) => i.ref_msg !== undefined)?.ref_msg;
  if (ref === undefined) return null;
  const snap = ref.message_item;
  const refId = quoteRefIdOf(m);

  let body: string | undefined;
  if (snap !== undefined) body = snapshotBodyOf(snap);
  if (body === undefined && refId !== undefined && payload.quoteText !== undefined) {
    body = payload.quoteText;
  }
  if (body === undefined) body = textOf(ref.title).trim() || undefined;

  // 局部引用：在可得正文里定位选区；定位失败回落整条
  const partial = ref.partial_text;
  if (partial !== undefined && body !== undefined && partial.start && partial.end) {
    const r = resolvePartialQuote(body, partial);
    if (!r.fallback && r.resolved !== null) body = r.resolved;
  }
  if (body === undefined && refId !== undefined) body = "[引用消息内容未缓存]";

  const quote: NormalizedQuote = {
    ...(refId !== undefined ? { msgIdx: refId, msgId: refId } : {}),
    ...(body !== undefined ? { body } : {}),
  };
  // 被引媒体归引用结构（不混本条正文/附件）
  if (snap !== undefined) {
    const att = attachmentOf(snap, "quote", blobs);
    if (att !== null) quote.attachments = [att];
  }
  return quote;
}

/**
 * WeixinMessage → NormalizedMessage。非消费面（机器人回声/群消息/已删除/无法定位）返回 null
 * （容错丢弃，与 QQ / Telegram parser 同纪律）。载荷形状由 plugin.normalize 头部的
 * WeixinInboundPayloadSchema 保证（B⁺ T5）。
 */
export function normalizeWeixinMessage(
  botId: string,
  payload: WeixinInboundPayload,
): NormalizedMessage | null {
  const msg = payload.message;
  if (!isSupportedInbound(msg)) return null;
  const msgId = weixinMsgIdOf(msg);

  const blobs = payload.mediaBlobs ?? {};
  const items = msg.item_list ?? [];
  const scopeId = idOf(msg.from_user_id);

  // —— 附件与占位（媒体占位符前置，正文随后——与 QQ「约定媒体前置」一致） ——
  const attachments: NormalizedAttachment[] = [];
  const placeholders: string[] = [];
  const textLines: string[] = [];
  for (const [idx, item] of items.entries()) {
    const att = attachmentOf(item, String(idx), blobs);
    if (att === null) {
      // 媒体 item 形状不全：仍给结构标记，不静默丢内容
      const label = mediaLabelOf(item.type);
      if (label !== "") placeholders.push(label);
      continue;
    }
    attachments.push(att);
    placeholders.push(placeholderOf(att, attachments.length));
    // 文件名属本条内容（用户主动发的文件）：进 text 供检索
    if (att.kind === "file" && att.filename !== undefined) textLines.push(att.filename);
  }

  // 本条文本：首个 TEXT item（置于 text 列首位）
  const textItem = items.find((i) => i.type === MessageItemType.TEXT);
  const ownText = textItem !== undefined ? textOf(textItem.text_item?.text) : "";
  const text = [ownText, ...textLines].filter((s) => s.trim() !== "").join("\n");

  const quote = parseQuote(msg, payload, blobs);
  // 渲染列 = 媒体占位（文件占位已带名字）+ 本条正文；text 列另含文件名供检索（与 QQ 同约定）
  const content = [...placeholders, ...(ownText.trim() !== "" ? [ownText] : [])]
    .filter((s) => s.trim() !== "")
    .join("\n");
  if (text === "" && placeholders.length === 0 && quote === null) {
    return null; // 空消息（如仅工具调用进度 item）：不入库
  }

  const rawTs = msg.create_time_ms ?? 0;
  const ts = rawTs > 0 ? (rawTs < 1e11 ? rawTs * 1000 : rawTs) : null;

  return {
    botId,
    scope: "chat",
    scopeId,
    msgId,
    authorOpenid: scopeId,
    ts,
    text,
    content,
    quote,
    records: [],
    mentions: [],
    attachments,
    // 被引锚：他人引用本条时 core 懒补作者（msgIdx 查 messages.msg_idx）
    msgIdx: msgId,
    // context_token 是出站回带凭据：入库前打码（已单独持久化在 StatePort）
    raw: {
      ...msg,
      ...(msg.context_token !== undefined ? { context_token: REDACTED } : {}),
    },
  };
}

/**
 * 信封 → NormalizedInbound（plugin.normalize 入口）：消息附 chat-opt（opt-in 等价映射——
 * 微信无「允许主动发送」开关事件，用户发来消息即视为在场同意）。
 */
export function normalizeWeixinInbound(
  botId: string,
  payload: WeixinInboundPayload,
): NormalizedInbound | null {
  const m = normalizeWeixinMessage(botId, payload);
  if (m === null) return null;
  return {
    messages: [m],
    effects: [{ kind: "chat-opt", scopeId: m.scopeId, allow: true }],
  };
}
