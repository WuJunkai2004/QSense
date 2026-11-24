// QQ 连接器实例（每 bot 一个）：官方 WS GatewayConnection 生命周期 + 状态上报 +
// 原始载荷上行（host.ingest）+ 发送原语（net.*）。
// 自 core/gateway/index.ts 的 launch() 单 bot 段迁入（P1 QQ 收口手术，2026-11-15）：
// - 消息级去重上移 core ingest 管线（这里不再去重，只上行）；
// - 会话持久化改经 StatePort（宿主落 SQLite kv；键兼容迁移见宿主实现）；
// - s 序号/心跳/RESUME/关闭码语义仍由官方 SDK 协议层权威实现。

import {
  GatewayConnection,
  GatewayErrorCode,
  type PersistedSession,
  type ReconnectPolicy,
  type SessionPersistencePort,
} from "@tencent-connect/qqbot-nodejs/protocol";
import type {
  BotCreds,
  ConnectorInstance,
  HttpClient,
  PluginContext,
  StatePort,
} from "@qsense/connector-sdk";
import { parseJsonWith } from "@qsense/connector-sdk";
import { z } from "zod";
import { flatLogMeta } from "./logmeta";
import { OUR_INTENTS } from "./intents";
import { createQqNet, appOfCreds, type QQSendApi } from "./net";
import { fetchGatewayUrl } from "./url";
import { TokenService, type QqApp } from "./token";
import { tt } from "./texts";

/**
 * 官方 SDK 边界缝（如实评估，不假装能删——SDK 内部自管网络，接不进 NetKit）：
 * - getAccessToken/clearTokenCache 包装官方 TokenManager（缓存+单飞+后台刷新是
 *   SDK 内部实现）；测试经此注入假 token，CI 不碰真实网络
 * - reconnect 是官方 ReconnectPolicy（测试要快速重连）
 * - apiFor 替换发送原语的 SDK ApiClient/MediaApi 适配（SDK 自管 fetch）
 */
export interface QqOverrides {
  getAccessToken?: (app: QqApp) => Promise<string>;
  clearTokenCache?: (app: QqApp) => void;
  reconnect?: Partial<ReconnectPolicy>;
  apiFor?: (app: QqApp) => QQSendApi;
}

export interface QqInstanceDeps {
  ctx: PluginContext;
  creds: BotCreds;
  /** 插件级共享（同一 TokenManager 服务多 bot，缓存复用） */
  tokens: TokenService;
  /** /gateway 控制请求传输（缺省 ctx.net）。QQ 数据面是官方 SDK 自管的 WS/发送，
   * 不经 NetKit——此为包内唯一 NetKit 触点；插件级注入（opts.net）供测试脚本化
   * 网关地址（原 getGatewayUrl 测试缝的形态收口）。 */
  net?: HttpClient;
  overrides?: QqOverrides;
}

/** SDK 要求同步持久化接口；StatePort 异步 → start 时预载 + 同步镜像写穿 */
function sessionPort(
  state: StatePort,
  initial: PersistedSession | null,
): SessionPersistencePort {
  let cached = initial;
  return {
    load: () => cached,
    save: (session: PersistedSession): void => {
      cached = session;
      // StatePort 值 = JSON 文本（B⁺ T6 字符串化；旧数据本就是 stringify 产物，兼容）
      void state.set("gw:session", JSON.stringify(session));
    },
    clear: (): void => {
      cached = null;
      void state.delete("gw:session");
    },
  };
}

/** 坏数据视为无会话，走全新 IDENTIFY（schema 解析 + 形状校验双兜底） */
function validSession(v: PersistedSession | null | undefined): PersistedSession | null {
  if (v === null || v === undefined) return null;
  if (typeof v.sessionId !== "string" || v.sessionId === "") return null;
  return v;
}

/** gw:session 持久化形状（官方 PersistedSession 的 JSON 文本解析锚） */
const PersistedSessionSchema = z.object({
  sessionId: z.string(),
  lastSeq: z.number().nullable(),
});

export function createQqInstance(deps: QqInstanceDeps): ConnectorInstance {
  const { ctx, creds, tokens, overrides } = deps;
  const host = ctx;
  const app: QqApp = appOfCreds(creds);
  const log = host.log.child("gateway").child(app.appid);
  const gatewayHttp = deps.net ?? ctx.net.http({ timeoutMs: 30_000 });
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  const net = createQqNet({
    creds,
    tokenManager: tokens.sdk,
    log,
    apiFor:
      overrides?.apiFor === undefined ? undefined : () => overrides.apiFor!(app),
  });

  const instance: ConnectorInstance = {
    net,
    start(): Promise<void> {
      if (loop !== null) return loop;
      const c = new AbortController();
      controller = c;
      // 测试注入 getAccessToken 时不启动真实 token 后台刷新（CI 不碰真实网络）
      if (!overrides?.getAccessToken) tokens.startBackground(app);
      loop = (async () => {
        const initial = validSession(
          parseJsonWith(
            PersistedSessionSchema,
            (await host.state.get("gw:session")) ?? "",
          ),
        );
        const connection = new GatewayConnection({
          account: {
            accountId: app.appid,
            appId: app.appid,
            clientSecret: app.secret,
          },
          abortSignal: c.signal,
          log: {
            info: (msg, meta) => log.debug(msg, flatLogMeta(meta)),
            warn: (msg, meta) => log.warn(msg, flatLogMeta(meta)),
            error: (msg, meta) => log.error(msg, flatLogMeta(meta)),
          },
          intents: OUR_INTENTS,
          session: sessionPort(host.state, initial),
          getAccessToken: () =>
            overrides?.getAccessToken
              ? overrides.getAccessToken(app)
              : tokens.getAccessToken(app),
          clearTokenCache: () => {
            overrides?.clearTokenCache?.(app);
            tokens.clear(app);
          },
          getGatewayUrl: (accessToken) => fetchGatewayUrl(gatewayHttp, accessToken),
          reconnect: overrides?.reconnect,
          onReady: () => host.reportStatus({ state: "ready" }),
          onResumed: () => host.reportStatus({ state: "resumed" }),
          onDisconnected: (e) => {
            host.reportStatus({
              state: "disconnected",
              detail: `code=${e.code} willReconnect=${String(e.willReconnect)}`,
            });
            if (!e.willReconnect) {
              log.error(
                tt("gw_disconnected_final", { code: e.code, reason: e.reason }),
              );
            }
          },
          onError: (err) =>
            log.warn("gateway recoverable error", { reason: err.message }),
          onMessage: (msg) => {
            // 群聊/C2C 消息走 SDK 规范化通道，msg.raw 为官方原始载荷
            if (msg.kind !== "group" && msg.kind !== "c2c") return;
            host.ingest({
              botId: app.appid,
              // 契约 v2：信封盖 platform 章，core ingest 表驱动路由回本插件 normalize
              payload: { platform: "qq", type: msg.rawEventType, data: msg.raw },
              receivedAt: Date.now(),
            });
          },
          onRawEvent: (type, data) => {
            host.ingest({
              botId: app.appid,
              payload: { platform: "qq", type, data },
              receivedAt: Date.now(),
            });
          },
        });
        try {
          // 默认无限重连预算下，start 仅在 abort（正常返回）或致命关闭（拒绝）时结束
          await connection.start();
        } catch (err) {
          const errCode = (err as { code?: string }).code;
          const detail =
            errCode === GatewayErrorCode.FATAL_CLOSE
              ? `close=${String((err as { closeCode?: number }).closeCode ?? "?")}`
              : err instanceof Error
                ? err.message
                : String(err);
          // 4914/4915（intents 未授权 / 机器人被封禁）属致命：不重连，人工处理
          log.error(tt("gw_fatal_close", { detail }));
          host.reportStatus({ state: "fatal", detail });
        }
      })();
      return loop;
    },
    stop(): void {
      // token 后台刷新不停（与旧 supervisor 语义一致：仅进程级 stop 由宿主统一停）
      controller?.abort();
      controller = null;
    },
  };
  return instance;
}
