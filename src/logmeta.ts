// 官方 SDK Logger meta 适配（B⁺ T6）：@tencent-connect/qqbot-nodejs 各接口的
// logger meta 是库类型键值对对象——此处按 Parameters 自库接口提取（本文件零
// 万能类型字面），平面化为 LogFields（对象值 JSON 字符串化，其余 String 化）后
// 交 core Logger（脱敏兜底照常生效）。

import type { GatewayConnectionOptions } from "@tencent-connect/qqbot-nodejs/protocol";
import type { LogFields } from "@qsense/connector-sdk";

/** 官方 SDK logger 方法 meta 参数类型（自 GatewayConnectionOptions 提取；三处
 * logger 面同源接口，结构一致） */
type SdkLogMeta = Parameters<
  NonNullable<GatewayConnectionOptions["log"]>["info"]
>[1];

export function flatLogMeta(meta?: SdkLogMeta): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}
