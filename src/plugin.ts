// 微信连接器插件声明面（ConnectorPlugin）：caps / credentialSchema / login（扫码配对）/
// webui（/login/qr/*）/ hooks（verifyCredential）/ normalize / create。
//
// 平台语义判定（与 QQ / Telegram 的差异全部走 caps 声明，不进宿主）：
// - scopes=["chat"]：iLink 是 1:1 机器人会话（参照实现 chatTypes=["direct"]）
// - passiveWindow=false：无被动窗口概念，任意时刻可发（须回带 context_token）→
//   发送只走 proactive 通道（net.reply 不实现）
// - quota=false：无官方额度语义（软频控归 connector net 内部 pace，不做门禁工具）
// - recall=false：协议无撤回通道
// - media 四项可发（语音条出站线格式未核实 → 音频按文件附件降级）；入站语音只取转写文本
//
// 扫码配对经 login: qr-pair 声明暴露：create 透传（task_id + 二维码内容），poll 的
// completed + credential 由宿主中介（core 拦截 → verifyCredential → 注册），凭据绝不下发浏览器。

import type {
  ConnectorLogger,
  ConnectorPlugin,
  NormalizedInbound,
  PluginContext,
} from "@qsense/connector-sdk";
import { createNetKit, type NetKit } from "@qsense/connector-sdk";
import { WeixinApiError, createWeixinApi } from "./api";
import { WeixinError } from "./errors";
import { createWeixinInstance } from "./instance";
import { normalizeWeixinInbound } from "./parser";
import {
  createQrLoginManager,
  safeBaseUrl,
  type QrLoginManagerDeps,
} from "./qrlogin";
import { tt } from "./texts";
import { ILINK_BASE_URL } from "./types";

export interface WeixinConnectorOpts {
  /** 宿主根日志器（loadModule 注入；缺省=静默 noop，仅独立调试用） */
  log?: ConnectorLogger;
  /** 控制面 NetKit（verifyCredential / 扫码状态机；测试注入 FakeNetKit，缺省真实现）。
   * 实例数据面一律用宿主 ctx.net。 */
  net?: NetKit;
  /** 扫码状态机产品参数（TTL/超时/重试上限） */
  qr?: Pick<
    QrLoginManagerDeps,
    "ttlMs" | "pollTimeoutMs" | "retryDelayMs" | "maxFailures"
  >;
}

export interface WeixinConnectorPlugin extends ConnectorPlugin {
  /** 移除 bot 时的运行时卫生（注销其 token 的「已绑定」登记）；宿主 removeBot 调用 */
  forget(botId: string): void;
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

/** 扫码页轮询间隔（秒）：状态机在服务端后台跑长轮询，poll 路由即时返回状态 */
const QR_POLL_INTERVAL_S = 2;

/** local_token_list 上限（参照实现：最多带最近 10 个已注册 bot 的 token） */
const LOCAL_TOKEN_LIST_MAX = 10;

/** 账号 id 安全形式（ilink_bot_id 的 @ 与 . → -）；带 @ 的原始 id 按形制错拒绝 */
const APPID_RE = /^[A-Za-z0-9_.-]+$/;

export function createWeixinConnector(
  opts: WeixinConnectorOpts = {},
): WeixinConnectorPlugin {
  const log = opts.log ?? noopLog();
  // 控制面 NetKit（verifyCredential / 扫码状态机；无实例上下文的注册期调用）
  const controlNet = opts.net ?? createNetKit();

  // 本端已注册 bot 的 token（插入序 = 新旧序）：扫码时作为 local_token_list 上送，
  // 让服务端识别「已绑定到本端」的 bot 并回 binded_redirect
  const knownTokens = new Map<string, string>();

  const qr = createQrLoginManager({
    api: createWeixinApi(controlNet.http({ timeoutMs: 15_000 }), "", ILINK_BASE_URL),
    log,
    net: controlNet,
    ...(opts.qr ?? {}),
  });

  return {
    id: "weixin",
    sdkRange: "^2.0.0",
    title: "微信（iLink）",
    caps: {
      scopes: ["chat"],
      media: { image: true, voice: true, video: true, file: true },
      recall: false,
      passiveWindow: false,
      quota: false,
      proactiveOptIn: false, // iLink：无 opt 事件概念，能对话即能发
    },
    // 契约 v2：解读权在本插件——core ingest 表驱动按 payload.platform="weixin" 路由到此
    normalize: (botId, payload): NormalizedInbound | null =>
      normalizeWeixinInbound(botId, payload),
    credentialSchema: {
      type: "object",
      required: ["appid", "token"],
      properties: {
        appid: {
          type: "string",
          description:
            "机器人账号 id（扫码后服务端下发的 ilink_bot_id，@ 与 . 换成 -，如 abc123-im-bot）",
        },
        token: {
          type: "string",
          description: "bot_token（扫码后服务端下发；长期凭据，妥善保管）",
        },
        base_url: {
          type: "string",
          description:
            "该账号的 API 入口 https 地址（扫码应答的 baseurl；缺省用 ilinkai.weixin.qq.com）",
        },
        owner_id: {
          type: "string",
          description: "扫码人的 ilink 用户 id（留档；缺省无）",
        },
      },
    },
    credentialSecrets: ["token"],
    login: { kind: "qr-pair", create: "/login/qr/create", poll: "/login/qr/poll" },
    tools: [],
    webui: [
      {
        method: "POST",
        path: "/login/qr/create",
        summary: "创建微信扫码登录任务（iLink get_bot_qrcode）",
        handler: async () => {
          const task = await qr.start(localTokenList());
          return {
            task_id: task.taskId,
            connect_url: task.qrContent,
            interval_s: QR_POLL_INTERVAL_S,
          };
        },
      },
      {
        method: "POST",
        path: "/login/qr/poll",
        summary: "轮询微信扫码登录状态",
        handler: async (req) => {
          const body = (req.body ?? {}) as Record<string, unknown>;
          const taskId = typeof body["task_id"] === "string" ? body["task_id"] : "";
          const state = qr.poll(taskId);
          if (state.status === "completed") {
            // 凭据只交回宿主（core 拦截 → verifyCredential → 注册），绝不下发浏览器
            return { status: "completed", credential: state.credential };
          }
          if (state.status === "failed") {
            // 带状态的包内错误：宿主 mapError 透传状态与可操作文案
            throw new WeixinError(state.reason, state.httpStatus);
          }
          return { status: state.status };
        },
      },
    ],
    hooks: {
      verifyCredential: async (credential) => {
        const appid = (credential["appid"] ?? "").trim();
        const token = (credential["token"] ?? "").trim();
        if (appid === "" || token === "") {
          throw new Error(tt("wx_credential_missing"));
        }
        if (!APPID_RE.test(appid)) throw new Error(tt("wx_appid_form"));
        const api = createWeixinApi(
          controlNet.http({ timeoutMs: 15_000 }),
          token,
          safeBaseUrl(credential["base_url"]) ?? ILINK_BASE_URL,
        );
        // 探活 = notifystart（账号实际入口 + token 有效性一次验证；无消息面副作用）。
        // 不用 getupdates 探活：空游标的长轮询可能取走消息却被丢弃。
        try {
          await api.notifyStart();
        } catch (e) {
          if (e instanceof WeixinApiError) {
            if (e.kind === "network" || e.kind === "timeout") {
              throw new Error(tt("wx_unreachable", { reason: e.message }));
            }
            const detail =
              e.kind === "biz"
                ? `ret/errcode=${e.code ?? "-"}，${e.message}`
                : `HTTP ${e.status ?? "-"}`;
            throw new Error(tt("wx_token_invalid", { detail }));
          }
          throw e;
        }
      },
    },
    create: (ctx: PluginContext, creds) => {
      const token = (creds.credential["token"] ?? "").trim();
      const api = createWeixinApi(
        ctx.net.http({ timeoutMs: 15_000 }),
        token,
        safeBaseUrl(creds.credential["base_url"]) ?? ILINK_BASE_URL,
      );
      if (knownTokens.has(creds.botId)) knownTokens.delete(creds.botId);
      knownTokens.set(creds.botId, token);
      return createWeixinInstance({
        ctx,
        botId: creds.botId,
        api,
      });
    },
    forget(botId: string): void {
      knownTokens.delete(botId);
    },
  };

  /** local_token_list：本端最近注册的至多 10 个 bot 的 token（空 token 不带） */
  function localTokenList(): string[] {
    return [...knownTokens.values()]
      .filter((t) => t !== "")
      .slice(-LOCAL_TOKEN_LIST_MAX);
  }
}
