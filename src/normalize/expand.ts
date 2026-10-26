// msg_elements 递归展开：官方元素类型 0=文本 / 3=结构化卡片 / 101=并行消息 / 102=聊天记录(合并转发) / 103=引用。
// 官方对元素内字段命名未给全样例，这里做容错提取（message_type/type 双名、content/text 双名、
// 递归字段 children/elements/messages 全试），保证未知形状不炸、已知形状都能抽出文本。
//
// 媒体保序（markdown 占位符）：元素内嵌的附件（真机 2026-10-26 核实：103 引用元素自带 attachments
// 携带被引图片）以 `![附件n]` 占位符内联在展开树原位，描述符统一进 AttachmentCollector 编号。

import type { NormalizedAttachment } from "./types";

const TYPE_TEXT = 0;
const TYPE_ARK = 3;
const TYPE_PARALLEL = 101;
const TYPE_FORWARD = 102;
const TYPE_QUOTE = 103;

interface ElementLike {
  message_type?: number;
  type?: number;
  content?: string;
  text?: string;
  msg_idx?: string;
  title?: string;
  desc?: string;
  children?: unknown[];
  elements?: unknown[];
  messages?: unknown[];
  paragraphs?: unknown[];
  [k: string]: unknown;
}

const asElements = (v: unknown): ElementLike[] =>
  Array.isArray(v) ? (v as ElementLike[]) : [];

function childrenOf(el: ElementLike): ElementLike[] {
  for (const key of ["children", "elements", "messages", "paragraphs"]) {
    const v = el[key];
    if (Array.isArray(v)) return v as ElementLike[];
  }
  return [];
}

function textOf(el: ElementLike): string {
  if (typeof el.content === "string") return el.content;
  if (typeof el.text === "string") return el.text;
  return "";
}

/** 官方 attachments 数组单项 / 元素自身媒体的容错解析；无 url 视为非媒体返回 null */
export function parseAttachmentLike(a: unknown): NormalizedAttachment | null {
  if (a === null || typeof a !== "object") return null;
  const x = a as Record<string, unknown>;
  if (typeof x.url !== "string" || x.url === "") return null;
  return {
    url: x.url,
    filename: typeof x.filename === "string" ? x.filename : undefined,
    width: typeof x.width === "number" ? x.width : undefined,
    height: typeof x.height === "number" ? x.height : undefined,
    size: typeof x.size === "number" ? x.size : undefined,
    content_type:
      typeof x.content_type === "string" ? x.content_type : undefined,
    voice_wav_url:
      typeof x.voice_wav_url === "string" ? x.voice_wav_url : undefined,
    asr_refer_text:
      typeof x.asr_refer_text === "string" ? x.asr_refer_text : undefined,
  };
}

/**
 * 附件收集器：占位符 `![附件n]` 的 n 与 list 下标一一对应（n = 下标 + 1）。
 * 同 URL 去重（返回已有编号，不重复入库）；语音带官方 ASR 转写时内联进占位符
 * （转写的语义价值就在文本，不藏两层）。
 */
export class AttachmentCollector {
  readonly list: NormalizedAttachment[] = [];
  private readonly numByUrl = new Map<string, number>();

  /** 登记一个附件并返回其占位符文本 */
  place(att: NormalizedAttachment): string {
    const known = this.numByUrl.get(att.url);
    if (known !== undefined) return `![附件${known}]`;
    this.list.push(att);
    this.numByUrl.set(att.url, this.list.length);
    const asr =
      att.asr_refer_text !== undefined ? `（转写：${att.asr_refer_text}）` : "";
    return `![附件${this.list.length}]${asr}`;
  }

  /** 该 URL 是否已收集过（顶层附件与树内媒体去重用） */
  has(url: string): boolean {
    return this.numByUrl.has(url);
  }
}

/** 元素携带的媒体：el.attachments 数组（真机 103 引用形状）或元素自身即媒体（带 url 字段，容错） */
function elementAttachments(el: ElementLike): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  if (Array.isArray(el.attachments)) {
    for (const a of el.attachments) {
      const att = parseAttachmentLike(a);
      if (att !== null) out.push(att);
    }
  }
  if (out.length === 0 && typeof el.url === "string" && el.url !== "") {
    const self = parseAttachmentLike(el);
    if (self !== null) out.push(self);
  }
  return out;
}

/**
 * 展开为可读文本树：
 * - 0 文本：原文
 * - 3 卡片：[卡片] title/desc 摘要
 * - 101 并行：逐个子元素展开
 * - 102 聊天记录（合并转发）：[聊天记录] 前缀 + 缩进递归子消息
 * - 103 引用：[引用 msg_idx] 前缀 + 递归被引用内容
 */
export function expandElements(
  elements: unknown,
  depth = 0,
  media?: AttachmentCollector,
): string[] {
  const out: string[] = [];
  const indent = "  ".repeat(depth);
  for (const el of asElements(elements)) {
    const type = el.message_type ?? el.type;
    // 元素内嵌媒体 → 原位占位（在各分支的结构行之后、文本之前，贴近客户端展示位置）
    const pushMedia = (): void => {
      if (media === undefined) return;
      for (const att of elementAttachments(el)) {
        out.push(`${indent}${media.place(att)}`);
      }
    };
    if (type === TYPE_TEXT) {
      const text = textOf(el).trim();
      if (text !== "") out.push(`${indent}${text}`);
      pushMedia();
    } else if (type === TYPE_ARK) {
      const label = el.title ?? el.desc ?? "";
      out.push(`${indent}[卡片]${label !== "" ? ` ${label}` : ""}`);
      pushMedia();
    } else if (type === TYPE_PARALLEL) {
      out.push(`${indent}[并行消息]`);
      pushMedia();
      out.push(...expandElements(childrenOf(el), depth + 1, media));
    } else if (type === TYPE_FORWARD) {
      const title =
        typeof el.title === "string" && el.title !== "" ? el.title : "聊天记录";
      out.push(`${indent}[${title}]`);
      // 官方 102：content 可能带摘要文本（title 之外的正文补充）
      const fwdText = textOf(el).trim();
      if (fwdText !== "" && fwdText !== title) out.push(`${indent}${fwdText}`);
      pushMedia();
      out.push(...expandElements(childrenOf(el), depth + 1, media));
    } else if (type === TYPE_QUOTE) {
      const ref =
        typeof el.msg_idx === "string" ? ` msg_idx=${el.msg_idx}` : "";
      out.push(`${indent}[引用${ref}]`);
      pushMedia();
      // 官方 103：被引用原文就在本元素的 content 字段（真机 2026-10-24 核实），children 通常为空
      const quoted = textOf(el).trim();
      if (quoted !== "") out.push(`${indent}${quoted}`);
      out.push(...expandElements(childrenOf(el), depth + 1, media));
    } else {
      // 未知类型：有文本抽文本，保证不静默丢内容
      const text = textOf(el).trim();
      if (text !== "") out.push(`${indent}${text}`);
      pushMedia();
    }
  }
  return out;
}

/** 从事件体容错提取 ARK 卡片对象（ark / ark_data 字段名都试） */
export function extractArk(raw: Record<string, unknown>): unknown {
  return raw.ark_data ?? raw.ark ?? undefined;
}
