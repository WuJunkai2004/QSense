// 官方错误码 → 可操作中文（API-FACTS.md #5）。agent 不需要读原始报文。
// ApiError（SDK）字段：httpStatus / path / bizCode? / bizMessage?；非 ApiError 一律走通用文案。

import { t, type I18nKey } from "../i18n";

/** 容错提取业务错误码（不 import SDK 类型，避免测试造错误对象时的类型耦合） */
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
export function isAuditPendingCode(code: number | null): boolean {
  return code === 304023 || code === 304024;
}

/** 官方错误码 → 可操作文案（未登记的码给通用兜底，含原始信息） */
export function describeSendError(e: unknown): string {
  const biz = extractBizCode(e);
  const message = e instanceof Error ? e.message : String(e);
  if (biz === null) return t("err_send_no_code", { message });
  const httpStatus = (e as { httpStatus?: unknown }).httpStatus;
  const params = {
    code: biz,
    status: typeof httpStatus === "number" ? httpStatus : 0,
    message,
    qpm: "",
  };
  const direct: Record<number, I18nKey> = {
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
  const key = direct[biz];
  if (key !== undefined) {
    // err_40034100 需要 qpm 参数；其余键忽略未用参数
    return t(key, { ...params, qpm: 30 });
  }
  return t("err_send_unknown", params);
}
