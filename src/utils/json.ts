// JSON 容错解析单点（B⁺ T6）：所有「落盘/线格式 JSON → schema safeParse」管线的
// 统一入口。坏 JSON → undefined，由调用方的 safeParse 统一按缺失处理——
// JSON.parse 的抛错面不外泄，各消费点不再自持 try/catch。

/**
 * JSON.parse 容错：坏 JSON 返回 undefined（走 schema safeParse 的前置步骤）。
 * 返回 unknown 是刻意的档案边界——解析产物一律紧接着过 zod schema，不裸消费。
 */
export function jsonParseOf(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
