// msg_elements 解析（2026-11-08 存储重构）：官方元素类型 0=文本 / 3=结构化卡片 / 101=并行消息 /
// 102=聊天记录(合并转发) / 103=引用。
// 职责=把官方元素树**分解为语义件**，而非渲染成一坨文本（老病根：被引原文与记录转写混进正文，
// 智能体把引用当本条正文）。产出四件：本条文本行 / 渲染行（媒体占位+结构标记）/ 顶层引用 /
// 记录拍平子消息——分别落 text / content / quote_json / message_records。
// 官方对元素内字段命名未给全样例，容错提取（message_type/type 双名、content/text 双名、
// children/elements/messages 全试），保证未知形状不炸、已知形状都能抽出文本。
// 媒体仍以 `![附件n]` 占位符原位内联进渲染行（编号=attachments 下标+1，真机 2026-10-26 核实：
// 103 引用元素自带 attachments 携带被引图片——占位符保留，被引**文字**不再内联）。

import type {
  AttachmentKind,
  NormalizedAttachment,
  NormalizedQuote,
  NormalizedRecord,
} from "./types";

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
  timestamp?: string;
  author?: unknown;
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

/** content_type → 归一 kind；语音可由 wav 转写地址/ASR 文本旁证；未知兜底 file */
function kindOf(att: {
  content_type?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}): AttachmentKind {
  const ct = att.content_type ?? "";
  if (ct === "voice" || ct.startsWith("voice/")) return "voice";
  if (att.voice_wav_url !== undefined || att.asr_refer_text !== undefined) {
    return "voice";
  }
  if (ct === "image" || ct.startsWith("image/")) return "image";
  if (ct === "video" || ct.startsWith("video/")) return "video";
  return "file";
}

/** 官方 attachments 数组单项 / 元素自身媒体的容错解析；无 url 视为非媒体返回 null */
export function parseAttachmentLike(a: unknown): NormalizedAttachment | null {
  if (a === null || typeof a !== "object") return null;
  const x = a as Record<string, unknown>;
  if (typeof x.url !== "string" || x.url === "") return null;
  const att: NormalizedAttachment = {
    kind: "file",
    url: x.url,
    filename: typeof x.filename === "string" ? x.filename : undefined,
    width: typeof x.width === "number" ? x.width : undefined,
    height: typeof x.height === "number" ? x.height : undefined,
    size: typeof x.size === "number" ? x.size : undefined,
    duration: typeof x.duration === "number" ? x.duration : undefined,
    content_type:
      typeof x.content_type === "string" ? x.content_type : undefined,
    voice_wav_url:
      typeof x.voice_wav_url === "string" ? x.voice_wav_url : undefined,
    asr_refer_text:
      typeof x.asr_refer_text === "string" ? x.asr_refer_text : undefined,
  };
  att.kind = kindOf(att);
  return att;
}

/**
 * 附件收集器：占位符编号与 list 下标一一对应（n = 下标 + 1）。
 * 同 URL 去重（返回已有编号，不重复入库）。
 * 渲染分型（2026-11-08 真机核验）：图片/视频 `![附件n]`；语音带 ASR 内联 `![附件n]（转写：…）`
 * （转写的语义价值就在渲染文本，但**不进 text 检索列**——那是别人的话）；
 * 文件 `[附件n 文件名 (大小)]`（图片式占位符对 PDF 无意义）。
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
    const n = this.list.length;
    if (att.kind === "voice" && att.asr_refer_text !== undefined) {
      return `![附件${n}]（转写：${att.asr_refer_text}）`;
    }
    if (att.kind === "file" && att.filename !== undefined) {
      const size = att.size !== undefined ? ` (${humanSize(att.size)})` : "";
      return `[附件${n} ${att.filename}${size}]`;
    }
    return `![附件${n}]`;
  }

  /** 该 URL 是否已收集过（顶层附件与树内媒体去重用） */
  has(url: string): boolean {
    return this.numByUrl.has(url);
  }
}

function humanSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
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

// —— 记录子消息字段容错提取（官方对 102 子消息的字段命名未给全样例，真机样本核验后收紧） ——

function recordAuthorId(el: ElementLike): string {
  const a = el.author;
  if (a !== null && typeof a === "object") {
    const x = a as Record<string, unknown>;
    for (const k of ["member_openid", "user_openid", "id"]) {
      if (typeof x[k] === "string" && (x[k] as string) !== "") {
        return x[k] as string;
      }
    }
  }
  for (const k of ["author_openid", "member_openid", "user_openid"]) {
    const v = el[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

function recordAuthorName(el: ElementLike): string {
  const a = el.author;
  if (a !== null && typeof a === "object") {
    const x = a as Record<string, unknown>;
    for (const k of ["username", "nickname", "author_name"]) {
      if (typeof x[k] === "string" && (x[k] as string) !== "") {
        return x[k] as string;
      }
    }
  }
  for (const k of ["username", "nickname", "author_name"]) {
    const v = el[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

function recordTs(el: ElementLike): number | null {
  if (typeof el.timestamp !== "string" || el.timestamp === "") return null;
  const ms = Date.parse(el.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

export interface ParsedTranscript {
  title: string;
  records: Array<{ authorName?: string; text: string }>;
}

/**
 * 官方合并转发**无元素树形状**（真机 2026-11-08 核实：消息级 message_type=102，
 * content 直带全文转写）解析器。格式：
 *   [群聊的聊天记录]
 *   === 消息 1 ===
 *   [消息内容]  正文…
 *   [发送者] 名字
 * 非此形状返回 null（不误伤普通文本）。
 */
export function parseRecordTranscript(
  content: string,
): ParsedTranscript | null {
  const lines = content.split("\n");
  if (lines.length < 4) return null;
  const head = lines[0]!.trim();
  const m = head.match(/^\[(.+?聊天记录)\]$/);
  if (m === null) return null;
  const title = m[1]!;
  const records: Array<{ authorName?: string; text: string }> = [];
  let textLines: string[] | null = null;
  let sender: string | undefined;
  const flush = (): void => {
    if (textLines !== null) {
      const text = textLines.join("\n").trim();
      records.push({ authorName: sender, text });
      textLines = null;
      sender = undefined;
    }
  };
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^=== 消息 \d+ ===$/.test(line.trim())) {
      flush();
      textLines = [];
      continue;
    }
    if (textLines === null) continue;
    const senderMatch = line.match(/^\[发送者\]\s*(.*)$/);
    if (senderMatch !== null) {
      sender = senderMatch[1]!.trim();
      continue;
    }
    const bodyMatch = line.match(/^\[消息内容\]\s?(.*)$/);
    if (bodyMatch !== null) {
      textLines.push(bodyMatch[1]!);
      continue;
    }
    if (line.trim() === "") continue;
    textLines.push(line); // 多行正文容错
  }
  flush();
  if (records.length === 0) return null;
  return { title, records };
}

export interface Decomposed {
  /** 本条纯文本行（官方 content + 文本元素；不含媒体占位/结构标记/引用/记录转写） */
  textLines: string[];
  /** 渲染行（媒体占位原位 + [卡片] / [聊天记录·N条] 标记；不含引用与记录转写） */
  renderLines: string[];
  /** 顶层引用（首条 103；无则 null） */
  quote: NormalizedQuote | null;
  /** 聊天记录拍平子消息（嵌套记录下钻，depth 表达层级） */
  records: NormalizedRecord[];
}

/**
 * 元素树分解（唯一入口）：
 * - 0 文本：进 textLines + renderLines
 * - 3 卡片：renderLines `[卡片] title`（结构信息，不进 textLines）
 * - 101 并行：`[并行消息]` 标记 + 子元素透传下钻
 * - 102 聊天记录：renderLines 只留 `[标题·N条]`，子消息拍平进 records（嵌套记录不产行、
 *   子层 depth+1；子行 103 引用结构化为子行 quote；子行媒体进宿主编号 + 子行子集留存）
 * - 103 引用（顶层）：结构化为 quote（msgIdx 优先 message_scene.ext 令牌，body=元素自带快照），
 *   被引文字**不进任何文本列**；自带媒体照常占位（真机核实 103 携带被引图片）
 * - 未知类型：有文本抽文本，保证不静默丢内容
 */
export function decomposeElements(
  elements: unknown,
  media?: AttachmentCollector,
): Decomposed {
  const out: Decomposed = {
    textLines: [],
    renderLines: [],
    quote: null,
    records: [],
  };

  const pushMedia = (el: ElementLike): void => {
    if (media === undefined) return;
    for (const att of elementAttachments(el)) {
      out.renderLines.push(media.place(att));
    }
  };

  const flattenRecords = (els: ElementLike[], depth: number): void => {
    for (const el of els) {
      const type = el.message_type ?? el.type;
      if (type === TYPE_FORWARD) {
        // 嵌套记录：不产生行，直接下钻（depth 表达层级）
        flattenRecords(childrenOf(el), depth + 1);
        continue;
      }
      const childMedia: NormalizedAttachment[] = [];
      if (media !== undefined) {
        for (const att of elementAttachments(el)) {
          media.place(att);
          childMedia.push(att);
        }
      }
      const text = type === TYPE_ARK ? "" : textOf(el).trim();
      const authorId = recordAuthorId(el);
      const authorName = recordAuthorName(el);
      out.records.push({
        ord: out.records.length,
        depth,
        authorOpenid: authorId !== "" ? authorId : undefined,
        authorName: authorName !== "" ? authorName : undefined,
        ts: recordTs(el),
        text,
        quote:
          typeof el.msg_idx === "string" && el.msg_idx !== ""
            ? { msgIdx: el.msg_idx, body: text }
            : null,
        attachments: childMedia,
      });
      // 子行内嵌并行容器：透传下钻（同行级）
      if (type === TYPE_PARALLEL) flattenRecords(childrenOf(el), depth);
    }
  };

  const walk = (els: ElementLike[], depth: number): void => {
    for (const el of els) {
      const type = el.message_type ?? el.type;
      if (type === TYPE_TEXT) {
        const text = textOf(el).trim();
        if (text !== "") {
          out.textLines.push(text);
          out.renderLines.push(text);
        }
        pushMedia(el);
      } else if (type === TYPE_ARK) {
        const label = el.title ?? el.desc ?? "";
        out.renderLines.push(`[卡片]${label !== "" ? ` ${label}` : ""}`);
        pushMedia(el);
      } else if (type === TYPE_PARALLEL) {
        out.renderLines.push("[并行消息]");
        pushMedia(el);
        walk(childrenOf(el), depth + 1);
      } else if (type === TYPE_FORWARD) {
        const before = out.records.length;
        flattenRecords(childrenOf(el), depth + 1);
        const n = out.records.length - before;
        const title =
          typeof el.title === "string" && el.title !== ""
            ? el.title
            : "聊天记录";
        out.renderLines.push(`[${title}·${n}条]`);
        pushMedia(el);
        // 官方 102：content 可能带摘要文本（title 之外的正文补充）→ 属本条文本
        const fwdText = textOf(el).trim();
        if (fwdText !== "" && fwdText !== title) {
          out.textLines.push(fwdText);
          out.renderLines.push(fwdText);
        }
      } else if (type === TYPE_QUOTE) {
        if (out.quote === null) {
          // 被引锚点取元素自带 msg_idx（=目标消息的锚）；scene.ext 的 msg_idx 是
          // 本条消息自己的锚（供别人引用），二者不可混用
          out.quote = {
            msgIdx:
              typeof el.msg_idx === "string" && el.msg_idx !== ""
                ? el.msg_idx
                : undefined,
            body: textOf(el).trim(),
          };
        }
        pushMedia(el);
        // children 通常为空（真机核实）；有则透传兜底
        walk(childrenOf(el), depth + 1);
      } else {
        const text = textOf(el).trim();
        if (text !== "") {
          out.textLines.push(text);
          out.renderLines.push(text);
        }
        pushMedia(el);
      }
    }
  };

  walk(asElements(elements), 0);
  // 注意：scene.ext 的 msg_idx 是本条消息自己的锚（落 msg_idx 列，供他人引用），
  // 不构成「本条引用了谁」的证据——quote_json 只来自顶层 103 元素。
  return out;
}

/** 从事件体容错提取 ARK 卡片对象（ark / ark_data 字段名都试） */
export function extractArk(raw: Record<string, unknown>): unknown {
  return raw.ark_data ?? raw.ark ?? undefined;
}
