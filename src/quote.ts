// 引用摘要（quote digest）：新版微信客户端的引用消息可能只带被引消息的服务端 id
// （ref_msg.svr_id），不给正文。参照实现为此维护本地引用缓存；本包把「最近消息摘要」
// 存进 StatePort（宿主落 kv），实例侧在摄取前按 id 解出正文线索随载荷上行
// （payload.quoteText）——parser 保持纯函数，core 零改动。
//
// 局部引用（用户选区）：按 start/end 锚文本在全文里定位，quotemd5（若有）用于消歧
// （算法移植参照实现 messaging/partial-quote.ts 的两种 endindex 解释）。

import { createHash } from "node:crypto";
import { MessageItemType, type PartialText, type WeixinMessage } from "./types";

/** 单条摘要保留的码点数上限（引用展示只取首行 ≤50 字，局部引用需全文锚定——400 字够用） */
export const DIGEST_MAX_CHARS = 400;

/** 媒体类别的文字占位（与读取层 QQ 的 [图片]/[语音]/[视频]/[文件] 词汇一致） */
export function mediaLabelOf(type: number | undefined): string {
  switch (type) {
    case MessageItemType.IMAGE:
      return "[图片]";
    case MessageItemType.VIDEO:
      return "[视频]";
    case MessageItemType.FILE:
      return "[文件]";
    case MessageItemType.VOICE:
      return "[语音]";
    default:
      return "";
  }
}

/** 消息摘要：各 item 的文本/占位以 " | " 连接（TEXT 取原文，VOICE 优先转写） */
export function digestOf(m: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of m.item_list ?? []) {
    if (item.type === MessageItemType.TEXT) {
      const t = (item.text_item?.text ?? "").trim();
      if (t !== "") parts.push(t);
    } else if (item.type === MessageItemType.VOICE) {
      const t = (item.voice_item?.text ?? "").trim();
      parts.push(t !== "" ? t : mediaLabelOf(item.type));
    } else {
      const label = mediaLabelOf(item.type);
      if (label !== "") parts.push(label);
    }
  }
  const joined = parts.join(" | ");
  return [...joined].slice(0, DIGEST_MAX_CHARS).join("");
}

function nthIndexOf(text: string, value: string, occurrence: number, from = 0): number {
  if (!value || !Number.isInteger(occurrence) || occurrence < 0) return -1;
  let position = from;
  for (let current = 0; current <= occurrence; current += 1) {
    position = text.indexOf(value, position);
    if (position < 0) return -1;
    if (current < occurrence) position += value.length;
  }
  return position;
}

function candidate(
  fullText: string,
  partial: PartialText,
  endMode: "global" | "relative",
): string | null {
  const start = nthIndexOf(fullText, partial.start ?? "", partial.startindex ?? 0);
  if (start < 0) return null;
  const end =
    endMode === "global"
      ? nthIndexOf(fullText, partial.end ?? "", partial.endindex ?? 0)
      : nthIndexOf(fullText, partial.end ?? "", partial.endindex ?? 0, start + (partial.start ?? "").length);
  if (end < start) return null;
  return fullText.slice(start, end + (partial.end ?? "").length);
}

function md5Of(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export interface PartialQuoteResult {
  resolved: string | null;
  /** 无法可靠解析：调用侧应回落整条正文 */
  fallback: boolean;
}

/**
 * 解析局部引用选区。quotemd5 存在时用它在两种 endindex 解释间消歧；
 * 缺失时取首个可行候选（global 优先，对应新版载荷的口径）。
 */
export function resolvePartialQuote(fullText: string, partial: PartialText): PartialQuoteResult {
  if (!fullText || !partial.start || !partial.end) {
    return { resolved: null, fallback: true };
  }
  const candidates = [candidate(fullText, partial, "global"), candidate(fullText, partial, "relative")].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
  );
  if (!partial.quotemd5) {
    return candidates[0] !== undefined
      ? { resolved: candidates[0], fallback: false }
      : { resolved: null, fallback: true };
  }
  const expected = partial.quotemd5.toLowerCase();
  const resolved = candidates.find((value) => md5Of(value) === expected) ?? null;
  return { resolved, fallback: resolved === null };
}
