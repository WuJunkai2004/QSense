// @qsense/connector-weixin —— 微信连接器插件（P4：iLink bot API 长轮询，独立仓形态）。
// 默认导出 = 工厂（宿主 loadModule 注入 {log}）；命名导出供宿主/测试按需引用。
// 零运行时依赖（Node 20 全局 fetch + node:crypto）；对 SDK 只做类型导入。
//
// 协议来源：@tencent-weixin/openclaw-weixin 2.4.10（由安装器
// @tencent-weixin/openclaw-weixin-cli 的 latest dist-tag 装入的版本）解包核对后自研实现；
// **不使用参照包本体**，仅作协议说明书（AGENTS.md P4 红线）。

import type { ConnectorPluginFactory } from "@qsense/connector-sdk";
import { createWeixinConnector } from "./plugin";
import { WeixinError } from "./errors";

export type { WeixinConnectorOpts, WeixinConnectorPlugin } from "./plugin";
export { createWeixinConnector, WeixinError };
export {
  createWeixinApi,
  WeixinApiError,
  baseInfo,
  bizCodeOf,
  clientVersionOf,
  parseWeixinJson,
  type WeixinApi,
  type WeixinApiKind,
  type WeixinApiOverrides,
  type RequestOptions,
} from "./api";
export {
  createWeixinInstance,
  type WeixinInstanceDeps,
  type WeixinInstanceOverrides,
} from "./instance";
export {
  isSupportedInbound,
  normalizeWeixinInbound,
  normalizeWeixinMessage,
  quoteRefIdOf,
  weixinMsgIdOf,
  type WeixinInboundPayload,
} from "./parser";
export {
  createQrLoginManager,
  credentialOfConfirmed,
  normalizeBotId,
  safeBaseUrl,
  type QrCredential,
  type QrLoginManager,
  type QrLoginManagerDeps,
  type QrLoginState,
} from "./qrlogin";
export {
  cdnDownloadUrl,
  cdnUploadUrl,
  downloadAndDecrypt,
  inboundImageKey,
  outboundAesKey,
  uploadMediaToCdn,
  type CdnUploadResult,
} from "./cdn";
export {
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
} from "./aes";
export {
  buildBotMessage,
  buildMediaItem,
  buildTextItem,
  decodeHandle,
  encodeHandle,
  planUpload,
  sanitizeFileName,
  sniffOutbound,
  MAX_TEXT_CHARS,
  MAX_UPLOAD_BYTES,
  type OutboundKind,
  type UploadedPlan,
} from "./wire";
export { digestOf, mediaLabelOf, resolvePartialQuote } from "./quote";
export { enrichImages, sniffImageMime } from "./enrich";
export {
  CONNECTOR_VERSION,
  ILINK_APP_ID,
  ILINK_BASE_URL,
  ILINK_CDN_BASE_URL,
  ILINK_CHANNEL_VERSION,
  MessageItemType,
  MessageState,
  MessageType,
  STALE_TOKEN_ERRCODE,
  UploadMediaType,
  type CdnMedia,
  type FileItem,
  type GetUpdatesResp,
  type ImageItem,
  type MessageItem,
  type QrcodeStatusResp,
  type RefMessage,
  type SendMessageResp,
  type VideoItem,
  type VoiceItem,
  type WeixinMessage,
} from "./types";

const factory: ConnectorPluginFactory = (init) =>
  createWeixinConnector({ log: init?.log });

export default factory;
