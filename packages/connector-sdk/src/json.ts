// 档案 JSON 读取单点（B⁺ T6，2026-11-24）：
// 「落盘/线格式 JSON → schema safeParse」管线的统一入口。坏 JSON 或形状不符 →
// null，由调用方按缺失处理——JSON.parse 的抛错面封死，且解析产物一律是 schema
// 声明的具体类型（泛型 T），不存在无类型的中间值。

import { z } from "zod";

/**
 * JSON 字符串 → schema 把关一步到位：坏 JSON 或形状不符返回 null（调用方按缺失处理）。
 * T = schema 的具体产出类型（z.infer）——档案读取不允许出现无类型中间值。
 */
export function parseJsonWith<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
