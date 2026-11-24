// 发送错误文案：core 只保留平台无关兜底；平台官方码语义经 SDK SendErrorSemantics
// 由连接器声明（QQ=qqSendError）。顺序为「先问插件、后通用兜底」。
// bizCode 字段约定是 core 与各连接器共用的通用协议（ApiError / TelegramApiError）。

import { t } from "../i18n";
import type { SendErrorSemantics } from "@qsense/connector-sdk";

/** 容错提取业务错误码（不 import 平台 SDK 类型，避免测试造错误对象时的类型耦合） */
export function extractBizCode(e: Error): number | null {
  const code = (e as { bizCode?: number }).bizCode;
  return typeof code === "number" ? code : null;
}

/** 通用兜底文案（含原始信息）：平台语义面未覆盖的错误走这里 */
export function describeSendError(e: Error, sem?: SendErrorSemantics): string {
  const platformText = sem?.describe?.(e);
  if (platformText !== undefined && platformText !== "") return platformText;
  const biz = extractBizCode(e);
  const message = e.message;
  if (biz === null) return t("err_send_no_code", { message });
  const httpStatus = (e as { httpStatus?: number }).httpStatus;
  return t("err_send_unknown", {
    code: biz,
    status: typeof httpStatus === "number" ? httpStatus : 0,
    message,
  });
}
