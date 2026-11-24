// 档案 JSON 读取单点：「落盘/线格式 JSON → schema safeParse」的统一入口。
// 坏 JSON 或形状不符返回 null，由调用方按缺失处理；解析产物类型由 schema 决定。

import { z } from "zod";

/**
 * JSON 字符串 → schema 校验一步到位：坏 JSON 或形状不符返回 null（调用方按缺失处理）。
 * T = schema 的产出类型（z.infer）。
 */
export function parseJsonWith<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
