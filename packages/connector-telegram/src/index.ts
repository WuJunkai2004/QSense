// @qsense/connector-telegram —— Telegram Bot 连接器插件（P3.5 试金石，独立仓形态）。
// 默认导出 = 工厂（宿主 loadModule 注入 {log}）；命名导出供宿主/测试按需引用。
// 零运行时依赖（Node 20 全局 fetch/FormData/Blob）；对 SDK 只做类型导入。

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
export type { TelegramApi, TelegramApiOverrides } from "./api";
// —— parser（契约 v2 自 core 下沉）：命名导出供测试/宿主按需引用 ——
export {
  normalizeTelegramInbound,
  normalizeTelegramUpdate,
} from "./parser";

const factory: ConnectorPluginFactory = (init) =>
  createTelegramConnector({ log: init?.log });

export default factory;
