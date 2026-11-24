// 入站媒体富化（connector 的网络职责）：微信媒体走 CDN 加密（AES-128-ECB），URL 本身
// 不可直接取用——摄取期解密图片并以 data:URL 随载荷上行，parser 直接落附件 url，
// core 的 get_media 通用 fetch(att.url) 即可用（与 Telegram 缩略图富化同模式，core 零改动）。
//
// 取图策略：优先中图（image_item.media，清晰度够读图）；声明尺寸明显超限或取图失败
// → 回落缩略图（thumb_media）；再失败 → 不内联（附件只留元数据，get_media 给可操作错误）。
// 语音（SILK）/文件/视频不内联：语音转写文本已随消息下发，文件/视频 get_media 本就不取。

import { downloadAndDecrypt, inboundImageKey } from "./cdn";
import {
  ILINK_CDN_BASE_URL,
  MessageItemType,
  type ImageItem,
  type WeixinMessage,
} from "./types";

/** 单张内联图上限（解密后字节）：决定「中图 or 缩略图」的取舍与落库体积 */
export const DEFAULT_MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

/** 单条消息最多解密内联的图片数（正文 + 被引；防御性上限，防大包阻塞轮询） */
const MAX_IMAGES_PER_MESSAGE = 4;

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp";

/** 解密后字节 → 图片 MIME（魔数嗅探）；非图片返回 null */
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return "image/png";
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "GIF8") {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf.subarray(0, 2).toString("ascii") === "BM") {
    return "image/bmp";
  }
  return null;
}

export interface EnrichDeps {
  fetchImpl: typeof globalThis.fetch;
  /** 缺省协议常量 */
  cdnBaseUrl?: string;
  /** 缺省 DEFAULT_MAX_INLINE_IMAGE_BYTES */
  maxBytes?: number;
  timeoutMs?: number;
  /** 取图失败回调（不挡消息摄取；由调用侧记日志） */
  onError?: (e: unknown) => void;
}

/** 下载 + 解密 + 尺寸闸门 → data:URL；任何失败返回 undefined */
async function inlineImage(
  media: NonNullable<ImageItem["media"]>,
  aesKeyBase64: string,
  deps: EnrichDeps,
): Promise<string | undefined> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES;
  try {
    const buf = await downloadAndDecrypt({
      media,
      aesKeyBase64,
      cdnBaseUrl: deps.cdnBaseUrl ?? ILINK_CDN_BASE_URL,
      fetchImpl: deps.fetchImpl,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
    if (buf.length === 0 || buf.length > maxBytes) return undefined;
    const mime = sniffImageMime(buf) ?? "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (e) {
    deps.onError?.(e);
    return undefined;
  }
}

/**
 * 消息内图片富化：键 = item_list 下标（正文图）或 "quote"（被引图——归引用结构，
 * 不混正文，与 QQ 103 被引图同一语义）。
 */
export async function enrichImages(
  message: WeixinMessage,
  deps: EnrichDeps,
): Promise<Record<string, string>> {
  const blobs: Record<string, string> = {};
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES;
  let budget = MAX_IMAGES_PER_MESSAGE;
  const items = message.item_list ?? [];

  const take = async (img: ImageItem | undefined): Promise<string | undefined> => {
    if (img === undefined || budget <= 0) return undefined;
    budget -= 1;
    const midKey = inboundImageKey(img.media, img.aeskey);
    // 声明的中图密文尺寸明显超限 → 不下载中图，直接看缩略图
    const midTooBig = img.mid_size !== undefined && img.mid_size > maxBytes * 2;
    if (midKey !== undefined && !midTooBig && img.media !== undefined) {
      const mid = await inlineImage(img.media, midKey, deps);
      if (mid !== undefined) return mid;
    }
    // 缩略图 key：自带 aes_key 优先；未带则回落图片级 key（中图 key；解密失败即放弃）
    const thumbKey = inboundImageKey(img.thumb_media, undefined) ?? midKey;
    if (thumbKey !== undefined && img.thumb_media !== undefined) {
      return inlineImage(img.thumb_media, thumbKey, deps);
    }
    return undefined;
  };

  for (const [idx, item] of items.entries()) {
    if (item.type !== MessageItemType.IMAGE || budget <= 0) continue;
    const url = await take(item.image_item);
    if (url !== undefined) blobs[String(idx)] = url;
  }

  const quoted = items.find(
    (i) => i.ref_msg?.message_item?.type === MessageItemType.IMAGE,
  )?.ref_msg?.message_item?.image_item;
  if (quoted !== undefined && budget > 0) {
    const url = await take(quoted);
    if (url !== undefined) blobs["quote"] = url;
  }
  return blobs;
}
