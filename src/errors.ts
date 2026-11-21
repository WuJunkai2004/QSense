// QQ 发送错误语义面（SDK SendErrorSemantics，契约 v2.2.2）：官方错误码 →
// core 中立词汇判定 + 包内可操作文案（官方错误码事实见 AGENTS.md）。2026-11-19 自
// core sender/errors.ts 下沉——core i18n 不再翻译 QQ 官方码，分仓文案自包含。
// ApiError（官方 SDK）字段：httpStatus / path / bizCode? / bizMessage?；
// 非 ApiError 一律走 core 通用兜底文案。

import { tt, type QqTextKey } from "./texts";

/** 容错提取业务错误码（不 import 官方 SDK 类型，避免测试造错误对象时的类型耦合） */
export function extractBizCode(e: unknown): number | null {
  if (e !== null && typeof e === "object") {
    const code = (e as { bizCode?: unknown }).bizCode;
    if (typeof code === "number") return code;
  }
  return null;
}

/** 304036：Markdown 无模板权限 → 自动降级纯文本（唯一在发送器内自动重试的码） */
export function isMarkdownPermissionError(e: unknown): boolean {
  return extractBizCode(e) === 304036;
}

/** 304023/304024：异步受理进入人工审核 → pending_audit，勿重发 */
export function isAuditPendingCode(e: unknown): boolean {
  const code = extractBizCode(e);
  return code === 304023 || code === 304024;
}

/** 官方错误码 → 包内文案键（未登记的码 = undefined → core 通用兜底） */
const DIRECT: Record<number, QqTextKey> = {
  304023: "send_audit_pending",
  304024: "send_audit_pending",
  40034004: "err_40034004",
  40034005: "err_40034005",
  304027: "err_304027",
  40034100: "err_40034100",
  40034010: "err_40034010",
  40054010: "err_40054010",
  40034101: "err_40034101",
  40054003: "err_40054003",
  40054005: "err_40054005",
  40054002: "err_40054002",
  40034006: "err_40034006",
};

/** SDK SendErrorSemantics 面（plugin.sendError 挂载） */
export const qqSendError = {
  isAuditPending: isAuditPendingCode,
  isMarkdownDowngrade: isMarkdownPermissionError,
  describe(e: unknown): string | undefined {
    const biz = extractBizCode(e);
    if (biz === null) return undefined;
    const key = DIRECT[biz];
    if (key === undefined) return undefined;
    // err_40034100 需要 qpm 参数（uncertified bot 级频控值）；send_audit_pending
    // 需要 {code}；其余键忽略未用参数（interpolate 只替换出现的占位符）
    return tt(key, { qpm: 30, code: biz });
  },
};
