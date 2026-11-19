// QQ 协议级发送原语（ConnectorNet 实现）：语义 wire → 官方线格式组装。
// 自 core/sender 的线格式组装段 + api() 适配段合并迁入（P1 QQ 收口手术，2026-11-15）。
// 策略（窗口/幂等/门禁/错误码翻译）留在 core——这里只负责"发出去"。
//
// 线格式规格（全部真机验证过，勿改）：
// - 被动回复：msg_type 0（文本）/ 2（markdown）/ 7（富媒体），带 msg_id+msg_seq；
//   quoteMsgId → message_reference {message_id, ignore_get_message_error: true}
//   （2026-03 v2 autogen 文档收录，真机实测返回 ext_info.ref_idx；ignore_get_message_error
//    兜底原消息被撤回时仍送达）
// - 主动消息：msg_type 0 / 7，无 msg_id/msg_seq，message_reference 照常受理（2026-10-26/27 真机）
// - scope 映射：core 会话形态标签 chat → 官方 API scope "c2c"；group → "group"

import {
  ApiClient,
  MediaApi,
  MediaFileType,
  MessageApi,
  type TokenManager,
} from "@tencent-connect/qqbot-nodejs/protocol";
import type {
  BotCreds,
  ConnectorLogger,
  ConnectorNet,
  MediaKind,
  MediaSourceWire,
  ProactiveWire,
  ReplyWire,
  SendReceipt,
  UploadMediaWire,
} from "@qsense/connector-sdk";

/** 官方消息 API 最小接口（生产=SDK MessageApi/MediaApi 适配；测试=记录调用的 mock） */
export interface QQSendApi {
  sendRaw(
    scope: "group" | "c2c",
    targetId: string,
    creds: { appId: string; clientSecret: string },
    body: Record<string, unknown>,
  ): Promise<{ id: string }>;
  recallMessage(
    scope: "group" | "c2c",
    targetId: string,
    messageId: string,
    creds: { appId: string; clientSecret: string },
  ): Promise<void>;
  /** 富媒体上传，返回官方 file_info（TTL 24h，按会话绑定可复用）；mediaType 决定官方 file_type */
  uploadMedia(
    scope: "group" | "c2c",
    targetId: string,
    creds: { appId: string; clientSecret: string },
    src: MediaSourceWire,
    mediaType: MediaKind,
  ): Promise<string>;
}

/** core 会话形态标签 → 官方 API scope（两套词汇在发送边界转换） */
export function scopeToApi(scope: string): "group" | "c2c" {
  return scope === "chat" ? "c2c" : "group";
}

/** 引用块（quote=true 时客户端展示引用样式；送达优先于样式） */
function messageReferenceOf(quoteMsgId: string | undefined):
  | Record<string, unknown>
  | undefined {
  return quoteMsgId === undefined
    ? undefined
    : {
        message_id: quoteMsgId,
        ignore_get_message_error: true,
      };
}

/** 被动回复线格式（msg_type 7/2/0；msg_id+msg_seq 由 core 幂等账本保证存在） */
export function buildReplyBody(wire: ReplyWire): Record<string, unknown> {
  const ref = messageReferenceOf(wire.quoteMsgId);
  const base: Record<string, unknown> = {
    ...(wire.msgId !== undefined ? { msg_id: wire.msgId } : {}),
    ...(wire.msgSeq !== undefined ? { msg_seq: wire.msgSeq } : {}),
    ...(ref !== undefined ? { message_reference: ref } : {}),
  };
  if (wire.media !== undefined) {
    // 富媒体（2026-10-27 真机验证：msg_type=7 可走被动窗口，可带引用块）
    return {
      msg_type: 7,
      content: wire.content,
      media: { file_info: wire.media.handle },
      ...base,
    };
  }
  if (wire.markdown === true) {
    return { msg_type: 2, markdown: { content: wire.content }, ...base };
  }
  return { msg_type: 0, content: wire.content, ...base };
}

/** 主动消息线格式（无 msg_id/msg_seq；msg_type 7/2/0；引用块照常受理） */
export function buildProactiveBody(
  wire: ProactiveWire,
): Record<string, unknown> {
  const ref = messageReferenceOf(wire.quoteMsgId);
  if (wire.media !== undefined) {
    return {
      ...(ref !== undefined ? { message_reference: ref } : {}),
      msg_type: 7,
      media: { file_info: wire.media.handle },
      content: wire.content,
    };
  }
  if (wire.markdown === true) {
    // 出站 AT 标签（<qqbot-at-user 等，官方「文本交互」页）仅 markdown 消息渲染
    return {
      msg_type: 2,
      markdown: { content: wire.content },
      ...(ref !== undefined ? { message_reference: ref } : {}),
    };
  }
  return {
    msg_type: 0,
    content: wire.content,
    ...(ref !== undefined ? { message_reference: ref } : {}),
  };
}

function credsOf(creds: { appid: string; secret: string }): {
  appId: string;
  clientSecret: string;
} {
  return { appId: creds.appid, clientSecret: creds.secret };
}

/** BotCreds.credential → QqApp 投影（P3 凭据 JSON 化前的约定键） */
export function appOfCreds(creds: BotCreds): {
  appid: string;
  secret: string;
} {
  return {
    appid: creds.credential["appid"] ?? creds.botId,
    secret: creds.credential["secret"] ?? "",
  };
}

export interface QqNetDeps {
  creds: BotCreds;
  tokenManager: TokenManager;
  log: ConnectorLogger;
  /** 测试注入：替换真实 MessageApi/MediaApi 适配 */
  apiFor?: (app: { appid: string; secret: string }) => QQSendApi;
}

/** 生产 SDK 适配（自 sender.api() 迁入）：懒建，进程内复用 */
export function buildSdkSendApi(
  deps: Pick<QqNetDeps, "tokenManager" | "log">,
): QQSendApi {
  const client = new ApiClient({
    logger: {
      info: (msg, meta) => deps.log.debug(msg, meta),
      error: (msg, meta) => deps.log.error(msg, meta),
      warn: (msg, meta) => deps.log.warn(msg, meta),
      debug: (msg, meta) => deps.log.debug(msg, meta),
    },
  });
  const messageApi = new MessageApi(client, deps.tokenManager, {
    markdownSupport: true,
  });
  const mediaApi = new MediaApi(client, deps.tokenManager);
  return {
    sendRaw: (scope, targetId, creds, body) =>
      messageApi.sendRaw(scope, targetId, creds, body),
    recallMessage: (scope, targetId, messageId, creds) =>
      messageApi.recallMessage(scope, targetId, messageId, creds),
    uploadMedia: (scope, targetId, creds, src, mediaType) =>
      mediaApi
        .uploadMedia(
          scope,
          targetId,
          mediaType === "voice" ? MediaFileType.VOICE : MediaFileType.IMAGE,
          creds,
          src.kind === "url"
            ? { url: src.url }
            : src.kind === "file"
              ? { localPath: src.path }
              : { fileData: src.data },
        )
        .then((up) => up.file_info),
  };
}

/** ConnectorNet 工厂：语义 wire → QQ 线格式 → 官方 API */
export function createQqNet(deps: QqNetDeps): ConnectorNet {
  const app = appOfCreds(deps.creds);
  const api = deps.apiFor?.(app) ?? buildSdkSendApi(deps);
  const creds = credsOf(app);
  return {
    reply: async (wire: ReplyWire): Promise<SendReceipt> => {
      const resp = await api.sendRaw(
        scopeToApi(wire.scope),
        wire.target,
        creds,
        buildReplyBody(wire),
      );
      return { providerMsgId: resp.id };
    },
    proactive: async (wire: ProactiveWire): Promise<SendReceipt> => {
      const resp = await api.sendRaw(
        scopeToApi(wire.scope),
        wire.target,
        creds,
        buildProactiveBody(wire),
      );
      return { providerMsgId: resp.id };
    },
    recall: async (wire): Promise<void> => {
      await api.recallMessage(
        scopeToApi(wire.scope),
        wire.target,
        wire.providerMsgId,
        creds,
      );
    },
    uploadMedia: async (wire: UploadMediaWire): Promise<{ handle: string }> => {
      const fileInfo = await api.uploadMedia(
        scopeToApi(wire.scope),
        wire.target,
        creds,
        wire.source,
        wire.kind,
      );
      return { handle: fileInfo };
    },
  };
}
