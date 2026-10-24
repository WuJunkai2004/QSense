// msg_elements 递归展开：官方元素类型 0=文本 / 3=结构化卡片 / 101=并行消息 / 102=聊天记录(合并转发) / 103=引用。
// 官方对元素内字段命名未给全样例，这里做容错提取（message_type/type 双名、content/text 双名、
// 递归字段 children/elements/messages 全试），保证未知形状不炸、已知形状都能抽出文本。

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
  for (const key of ['children', 'elements', 'messages', 'paragraphs']) {
    const v = el[key];
    if (Array.isArray(v)) return v as ElementLike[];
  }
  return [];
}

function textOf(el: ElementLike): string {
  if (typeof el.content === 'string') return el.content;
  if (typeof el.text === 'string') return el.text;
  return '';
}

/**
 * 展开为可读文本树：
 * - 0 文本：原文
 * - 3 卡片：[卡片] title/desc 摘要
 * - 101 并行：逐个子元素展开
 * - 102 聊天记录（合并转发）：[聊天记录] 前缀 + 缩进递归子消息
 * - 103 引用：[引用 msg_idx] 前缀 + 递归被引用内容
 */
export function expandElements(elements: unknown, depth = 0): string[] {
  const out: string[] = [];
  const indent = '  '.repeat(depth);
  for (const el of asElements(elements)) {
    const type = el.message_type ?? el.type;
    if (type === TYPE_TEXT) {
      const text = textOf(el).trim();
      if (text !== '') out.push(`${indent}${text}`);
    } else if (type === TYPE_ARK) {
      const label = el.title ?? el.desc ?? '';
      out.push(`${indent}[卡片]${label !== '' ? ` ${label}` : ''}`);
    } else if (type === TYPE_PARALLEL) {
      out.push(`${indent}[并行消息]`);
      out.push(...expandElements(childrenOf(el), depth + 1));
    } else if (type === TYPE_FORWARD) {
      const title = typeof el.title === 'string' && el.title !== '' ? el.title : '聊天记录';
      out.push(`${indent}[${title}]`);
      // 官方 102：content 可能带摘要文本（title 之外的正文补充）
      const fwdText = textOf(el).trim();
      if (fwdText !== '' && fwdText !== title) out.push(`${indent}${fwdText}`);
      out.push(...expandElements(childrenOf(el), depth + 1));
    } else if (type === TYPE_QUOTE) {
      const ref = typeof el.msg_idx === 'string' ? ` msg_idx=${el.msg_idx}` : '';
      out.push(`${indent}[引用${ref}]`);
      // 官方 103：被引用原文就在本元素的 content 字段（真机 2026-10-24 核实），children 通常为空
      const quoted = textOf(el).trim();
      if (quoted !== '') out.push(`${indent}${quoted}`);
      out.push(...expandElements(childrenOf(el), depth + 1));
    } else {
      // 未知类型：有文本抽文本，保证不静默丢内容
      const text = textOf(el).trim();
      if (text !== '') out.push(`${indent}${text}`);
    }
  }
  return out;
}

/** 从事件体容错提取 ARK 卡片对象（ark / ark_data 字段名都试） */
export function extractArk(raw: Record<string, unknown>): unknown {
  return raw.ark_data ?? raw.ark ?? undefined;
}
