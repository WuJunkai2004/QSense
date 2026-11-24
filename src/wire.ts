// 出站线格式（协议事实：参照实现 2.4.10 messaging/send.ts，2026-11-24 解包核对）：
// - 每条消息 = 一次 sendmessage 请求，msg.message_type=BOT(2)、message_state=FINISH(2)、
//   item_list 恒单项（配文与媒体分两条消息发：先 TEXT 再媒体）
// - 图片 item：image_item.media{encrypt_query_param, aes_key, encrypt_type=1} + mid_size(密文字节)
// - 视频 item：video_item.media{…} + video_size(密文字节)
// - 文件 item：file_item.media{…} + file_name + len(明文字节，字符串)
// - from_user_id 恒空串；client_id 客户端生成（幂等/标识用）；context_token 原样回带
//
// 语音条出站线格式在参照实现中没有发送路径（encode_type 等字段只有入站语义），
// 属未核实区：音频一律按「文件附件」降级发送（走已核实的 FILE 通道），不猜线上形状。

import type { CdnUploadResult } from "./cdn";
import { outboundAesKey } from "./cdn";
import { tt } from "./texts";
import {
  MessageItemType,
  MessageState,
  MessageType,
  UploadMediaType,
  type MessageItem,
  type WeixinMessage,
} from "./types";

/** 微信单条文本上限（码点计） */
export const MAX_TEXT_CHARS = 4000;

/** 单文件上传上限（与宿主资产区 request_upload 的 20MB 对齐） */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 出站媒体类别（"file" 含音频降级：语音条线格式未核实） */
export type OutboundKind = "image" | "video" | "file";

/** 上传完成后的素材事实：句柄编码它的全部内容（无状态句柄，upload 与 send 之间不依赖进程内表） */
export interface UploadedPlan {
  kind: OutboundKind;
  fileName: string;
  up: CdnUploadResult;
}

const HANDLE_PREFIX = "wxm1.";

/** 句柄编码：base64url(JSON)。core 侧把它当不透明串（同 QQ file_info 的用法） */
export function encodeHandle(plan: UploadedPlan): string {
  return HANDLE_PREFIX + Buffer.from(JSON.stringify(plan), "utf-8").toString("base64url");
}

/** 句柄解码 + 形状校验；坏值给可操作错误 */
export function decodeHandle(handle: string): UploadedPlan {
  try {
    if (!handle.startsWith(HANDLE_PREFIX)) throw new Error("bad prefix");
    const plan = JSON.parse(
      Buffer.from(handle.slice(HANDLE_PREFIX.length), "base64url").toString("utf-8"),
    ) as UploadedPlan;
    const up = plan.up;
    if (
      (plan.kind !== "image" && plan.kind !== "video" && plan.kind !== "file") ||
      typeof plan.fileName !== "string" ||
      plan.fileName === "" ||
      up === null ||
      typeof up !== "object" ||
      typeof up.downloadParam !== "string" ||
      up.downloadParam === "" ||
      typeof up.aesKeyHex !== "string" ||
      typeof up.cipherSize !== "number" ||
      typeof up.rawSize !== "number"
    ) {
      throw new Error("bad shape");
    }
    return plan;
  } catch {
    throw new Error(tt("wx_media_handle_invalid"));
  }
}

export interface Sniffed {
  kind: OutboundKind;
  mime: string;
  ext: string;
}

/** 魔数嗅探（机械编码问题，非语义判断）：图/视频/音频/未知 */
export function sniffOutbound(buf: Buffer): Sniffed {
  const b = (i: number): number => buf[i] ?? 0;
  const ascii = (i: number, n: number): string =>
    buf.subarray(i, i + n).toString("ascii");
  const hex = (i: number, n: number): string =>
    buf.subarray(i, i + n).toString("hex");

  if (buf.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) {
    return { kind: "image", mime: "image/jpeg", ext: ".jpg" };
  }
  if (buf.length >= 8 && hex(0, 8) === "89504e470d0a1a0a") {
    return { kind: "image", mime: "image/png", ext: ".png" };
  }
  if (buf.length >= 4 && ascii(0, 4) === "GIF8") {
    return { kind: "image", mime: "image/gif", ext: ".gif" };
  }
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return { kind: "image", mime: "image/webp", ext: ".webp" };
  }
  if (buf.length >= 2 && ascii(0, 2) === "BM") {
    return { kind: "image", mime: "image/bmp", ext: ".bmp" };
  }
  if (buf.length >= 12 && ascii(4, 4) === "ftyp") {
    return { kind: "video", mime: "video/mp4", ext: ".mp4" };
  }
  if (buf.length >= 4 && hex(0, 4) === "1a45dfa3") {
    return { kind: "video", mime: "video/x-matroska", ext: ".mkv" };
  }
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") {
    return { kind: "video", mime: "video/x-msvideo", ext: ".avi" };
  }
  // 音频：语音条线格式未核实 → 文件附件降级
  if (buf.length >= 3 && ascii(0, 3) === "ID3") {
    return { kind: "file", mime: "audio/mpeg", ext: ".mp3" };
  }
  if (buf.length >= 2 && b(0) === 0xff && (b(1) & 0xe0) === 0xe0 && (b(1) & 0x06) !== 0) {
    return { kind: "file", mime: "audio/mpeg", ext: ".mp3" };
  }
  if (buf.length >= 4 && ascii(0, 4) === "OggS") {
    return { kind: "file", mime: "audio/ogg", ext: ".ogg" };
  }
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") {
    return { kind: "file", mime: "audio/wav", ext: ".wav" };
  }
  if (buf.length >= 4 && ascii(0, 4) === "fLaC") {
    return { kind: "file", mime: "audio/flac", ext: ".flac" };
  }
  return { kind: "file", mime: "application/octet-stream", ext: ".bin" };
}

/** 文件名清洗：取 basename、去控制字符、限长（码点 80）；空串返回 undefined */
export function sanitizeFileName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim()]
    .slice(0, 80)
    .join("");
  // 纯点名字（"." / ".." / "…"）不是合法文件名
  return cleaned === "" || /^\.+$/.test(cleaned) ? undefined : cleaned;
}

/**
 * 上传规划：按字节魔数定类别与扩展名（wire.kind 只提供 image|voice 粗粒度意图；
 * 语音意图的音频字节按文件附件降级）。
 */
export function planUpload(
  buf: Buffer,
  hintName?: string,
): { kind: OutboundKind; mediaType: number; fileName: string } {
  const s = sniffOutbound(buf);
  const mediaType =
    s.kind === "image"
      ? UploadMediaType.IMAGE
      : s.kind === "video"
        ? UploadMediaType.VIDEO
        : UploadMediaType.FILE;
  const hint = sanitizeFileName(hintName);
  // 有扩展名则沿用来源文件名；否则按嗅探类型给缺省名（保证扩展名与真实字节一致）
  const fileName =
    hint !== undefined && /\.[A-Za-z0-9]{1,8}$/.test(hint)
      ? hint
      : `${s.mime.startsWith("audio/") ? "audio" : s.kind}${s.ext}`;
  return { kind: s.kind, mediaType, fileName };
}

function cdnMediaOf(up: CdnUploadResult): {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: number;
} {
  return {
    encrypt_query_param: up.downloadParam,
    aes_key: outboundAesKey(up.aesKeyHex),
    encrypt_type: 1,
  };
}

/** 媒体 item 组装（按上传规划的分类别线上形状） */
export function buildMediaItem(plan: UploadedPlan): MessageItem {
  const media = cdnMediaOf(plan.up);
  if (plan.kind === "image") {
    return {
      type: MessageItemType.IMAGE,
      image_item: { media, mid_size: plan.up.cipherSize },
    };
  }
  if (plan.kind === "video") {
    return {
      type: MessageItemType.VIDEO,
      video_item: { media, video_size: plan.up.cipherSize },
    };
  }
  return {
    type: MessageItemType.FILE,
    file_item: {
      media,
      file_name: plan.fileName,
      len: String(plan.up.rawSize),
    },
  };
}

/** 出站消息信封（单 item；from_user_id 恒空串是协议约定，表示机器人自身） */
export function buildBotMessage(params: {
  to: string;
  clientId: string;
  item: MessageItem;
  contextToken?: string;
  runId?: string;
}): WeixinMessage {
  return {
    from_user_id: "",
    to_user_id: params.to,
    client_id: params.clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [params.item],
    ...(params.contextToken !== undefined && params.contextToken !== ""
      ? { context_token: params.contextToken }
      : {}),
    ...(params.runId !== undefined ? { run_id: params.runId } : {}),
  };
}

/** 文本 item */
export function buildTextItem(text: string): MessageItem {
  return { type: MessageItemType.TEXT, text_item: { text } };
}
