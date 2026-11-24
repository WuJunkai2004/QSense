// Telegram 连接器插件声明面（ConnectorPlugin）：caps / credentialSchema /
// hooks（verifyCredential）/ create。P3.5 试金石（2026-11-16）——
// 纯外挂包进场：core 预期改动仅 normalize/telegram parser + ingest 路由 +
// Sender caps 感知路由三处（「抽象不泄漏」的试金石账本）。
//
// 平台语义判定（与 QQ 的差异全部走 caps 声明，不进宿主）：
// - passiveWindow=false：Telegram 无被动窗口概念，任意时刻可发 → 发送只走
//   proactive 通道（net.reply 仅为契约兼容别名）；
// - quota=false：无官方日额度（限流是 ~1 msg/s/chat 的网络节流，归 connector
//   net 内部节流，不做门禁工具）；
// - recall=true：deleteMessage（bot 只能删自己的消息）；
// - media 全支持：图（sendPhoto）/语音（sendVoice，OGG/MP3/M4A）。
//
// B⁺ T4.1：测试驱动权收口——opts.net 注入 FakeNetKit（verifyCredential 的
// 控制面 HTTP；缺省真 NetKit）。实例数据面一律用宿主 ctx.net。
// 自身身份（getMe）内聚在本插件：create 时 fire-and-forget 拉取（失败只降级
// atMe 精度，wait 层从宽兜底），实例不感知身份——身份是 parser 的判定依据，
// 归插件自持（identities 缓存）。

import type {
  ConnectorLogger,
  ConnectorPlugin,
  NormalizedInbound,
  PluginContext,
} from "@qsense/connector-sdk";
import { createNetKit, formatZodIssues, type NetKit } from "@qsense/connector-sdk";
import {
  createTelegramApi,
  TelegramApiError,
  TelegramInboundPayloadSchema,
  TelegramMeSchema,
  TG_ERROR_UNAUTHORIZED,
} from "./api";
import { createTelegramInstance } from "./instance";
import { normalizeTelegramInbound } from "./parser";
import { tt } from "./texts";

export interface TelegramConnectorOpts {
  /** 宿主根日志器（loadModule 注入；缺省=静默 noop，仅独立调试用） */
  log?: ConnectorLogger;
  /** 控制面 NetKit（verifyCredential / 身份拉取；测试注入 FakeNetKit，缺省真实现） */
  net?: NetKit;
}

/** 无日志器缺省（分仓包不依赖 SDK 运行时值，noop 本地实现） */
function noopLog(): ConnectorLogger {
  const noop = (): void => undefined;
  const logger: ConnectorLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

/** BotFather token 形制（<bot_id>:<至少 30 位凭据串>） */
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export function createTelegramConnector(
  opts: TelegramConnectorOpts = {},
): ConnectorPlugin {
  const log = opts.log ?? noopLog();
  // 控制面 HTTP（verifyCredential 等无实例上下文的注册期调用）
  const controlHttp = (opts.net ?? createNetKit()).http({ timeoutMs: 30_000 });

  // 自身身份缓存（botId → getMe 产物）：实例创建时拉取，normalize 据此精确判 atMe。
  // 未知（未回传前）→ atMe 省略，wait 层 mention 过滤按未知从宽。
  const identities = new Map<string, { id: number; username?: string }>();

  return {
    id: "telegram",
    sdkRange: "^2.0.0",
    title: "Telegram Bot",
    caps: {
      scopes: ["group", "c2c"],
      media: { image: true, voice: true, video: true, file: true },
      recall: true,
      passiveWindow: false,
      quota: false,
      proactiveOptIn: false, // Telegram：无 opt 事件概念，凭 chat_id 直发
    },
    // 契约 v2：解读权在本插件——core ingest 表驱动按 payload.platform="telegram" 路由到此。
    // B⁺ T5：信封过 wire schema（safeParse）——形状违规 = 可观测丢弃 + warn
    //（路由已保证 platform 匹配本插件，schema 失败即本平台载荷损坏，不容错放行）。
    normalize: (botId, payload): NormalizedInbound | null => {
      const p = TelegramInboundPayloadSchema.safeParse(payload);
      if (!p.success) {
        log.warn(
          `[${botId}] telegram 载荷形状违规，丢弃：${formatZodIssues(p.error, "payload")}`,
        );
        return null;
      }
      return normalizeTelegramInbound(botId, p.data, identities.get(botId));
    },
    credentialSchema: {
      type: "object",
      required: ["appid", "token"],
      properties: {
        appid: {
          type: "string",
          description: "Bot 数字 id（token 冒号前的数字；getMe 的 id）",
        },
        token: {
          type: "string",
          description: "BotFather 下发的 token（形如 123456:AA-xxx）",
        },
      },
    },
    credentialSecrets: ["token"],
    tools: [],
    hooks: {
      verifyCredential: async (credential) => {
        // 两级校验：token 形制 → getMe（官方真伪 + bot id 一致性）。
        // 平台专属提示由本插件自带（宿主包装只承担统一前缀）。
        const token = credential["token"] ?? "";
        if (!TOKEN_RE.test(token)) {
          throw new Error(
            "token 形制不对：应为 BotFather 下发的 <数字id>:<凭据串>（形如 123456:AA-xxx）。",
          );
        }
        const expected = credential["appid"] ?? "";
        if (!/^\d{6,12}$/.test(expected)) {
          throw new Error(
            "appid 应为 bot 数字 id（token 冒号前的数字，getMe 的 id）。",
          );
        }
        try {
          const api = createTelegramApi(controlHttp, token);
          const me = await api.call("getMe", TelegramMeSchema);
          if (String(me.id) !== expected) {
            throw new Error(
              tt("tg_appid_mismatch", {
                actual: String(me.id),
                expected,
              }),
            );
          }
        } catch (e) {
          if (e instanceof TelegramApiError && e.errorCode === TG_ERROR_UNAUTHORIZED) {
            throw new Error(tt("tg_token_invalid", { reason: e.description }));
          }
          throw e;
        }
      },
    },
    create: (ctx: PluginContext, creds) => {
      const api = createTelegramApi(ctx.net.http({ timeoutMs: 30_000 }), creds.credential["token"] ?? "");
      // 自身身份一次性获取（atMe 判定依据）：失败只降级精度，不阻塞实例启动。
      // （内聚收口：身份归插件自持，实例不感知——T4.1 删除 onIdentity 回调）
      api.call("getMe", TelegramMeSchema)
        .then((me) => {
          identities.set(creds.botId, {
            id: me.id,
            ...(me.username !== undefined ? { username: me.username } : {}),
          });
        })
        .catch(() => undefined);
      return createTelegramInstance({ ctx, botId: creds.botId, api });
    },
  };
}
