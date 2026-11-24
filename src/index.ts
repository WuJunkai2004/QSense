// @qsense/connector-telegram —— Telegram Bot 连接器插件（P3.5 试金石，独立仓形态）。
// 默认导出 = 工厂（宿主 loadModule 注入 {log}）；命名导出供宿主/测试按需引用。
// B⁺ T4.1：传输机械走 SDK NetKit（值导入），wire 类型 zod 化；
// normalizeTelegramUpdate 命名导出已收口——测试一律走声明面 plugin.normalize()。

import type { ConnectorPluginFactory } from "@qsense/connector-sdk";
import { createTelegramConnector } from "./plugin";
import { TelegramApiError } from "./api";

export type { TelegramConnectorOpts } from "./plugin";
export { createTelegramConnector, TelegramApiError };
export type {
  TelegramInboundPayload,
  TelegramUpdate,
  TelegramMessage,
  TelegramUser,
  TelegramChat,
  TelegramPhotoSize,
  TelegramVoice,
  TelegramVideo,
  TelegramDocument,
  TelegramFile,
} from "./api";
// wire schema 与 API 工厂（测试/宿主按需构造假端点驱动的 api）
export {
  createTelegramApi,
  TelegramUpdateSchema,
  TelegramMessageSchema,
  TelegramMeSchema,
  TG_POLL_TIMEOUT_S,
} from "./api";
export type { TelegramApi } from "./api";
export type { TgCallBody } from "./api";
// —— parser（契约 v2 自 core 下沉）：信封级入口供测试/宿主按需引用 ——
export { normalizeTelegramInbound } from "./parser";

const factory: ConnectorPluginFactory = (init) =>
  createTelegramConnector({ log: init?.log });

export default factory;
