// @qsense/connector-qq —— 桶导出。
// 默认导出 = 插件工厂（P2 声明制：宿主 loadModule(包名) → 工厂(init{log}) → 声明面）。
export {
  createQqConnector,
  type QqConnectorOpts,
  type QqConnectorPlugin,
} from "./plugin";
export { createQqConnector as default } from "./plugin";
export {
  createQqInstance,
  type QqInstanceDeps,
  type QqOverrides,
} from "./instance";
export {
  buildProactiveBody,
  buildReplyBody,
  buildSdkSendApi,
  createQqNet,
  scopeToApi,
  appOfCreds,
  type QQSendApi,
} from "./net";
export {
  PER_GROUP_DAILY,
  PER_RELATION_QPM,
  beijingDate,
  createQuota,
  dailyCountOf,
  dailyTotalOf,
  type QuotaModule,
  type QuotaSnapshot,
  type QqSendLimits,
} from "./quota";
export { TokenService, type QqApp } from "./token";
export { fetchGatewayUrl, QQ_API_BASE } from "./url";
export {
  INTENT_GROUP_AND_C2C_EVENT,
  INTENT_MESSAGE_AUDIT,
  OUR_INTENTS,
} from "./intents";
export {
  createQrBindTask,
  decryptBindSecret,
  pollQrBind,
  QQ_BIND_HOST,
  type QrPollResult,
  type QrTask,
  QrBindError,
} from "./qrbind";
// —— QQ parser（契约 v2 自 core 下沉）：plugin.normalize 入口 + 命名导出供
//    宿主迁移重演（v8 raw_json 重演）与测试直接引用 ——
export {
  normalizeQqEnvelope,
  normalizeQqMessage,
  parseTimestamp,
  type QqEvent,
} from "./normalize";
export { decomposeElements } from "./expand";
// —— 发送错误语义面（契约 v2.2.2）：宿主/测试按需引用 ——
export {
  extractBizCode,
  isAuditPendingCode,
  isMarkdownPermissionError,
  qqSendError,
} from "./errors";
