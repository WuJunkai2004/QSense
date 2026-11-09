// 事件接入器组装层：按 QQ_APPS 逐 bot 启动官方 GatewayConnection（SDK 协议层）。
//
// 职责边界（AGENTS.md 技术栈约定）：
// - s 序号 / 心跳 / RESUME / 关闭码语义由 SDK 状态机权威实现（内部 lastSeq 随包更新并持久化）；
// - 本层负责：token 生命周期、会话持久化(kv)、消息级 id 去重（第一道闸）、事件上行、状态告警；
// - 每条消息路径绝不抛错（SDK 已隔离回调异常，这里同样兜底）。

import {
  GatewayConnection,
  GatewayErrorCode,
  type ReconnectPolicy,
} from "@tencent-connect/qqbot-nodejs/protocol";
import type { BotApp } from "../config";
import type { BotRegistry } from "../bots";
import { t } from "../i18n";
import type { Logger } from "../logger";
import type { DB } from "../store/db";
import { BoundedDedup } from "./dedup";
import { OUR_INTENTS } from "./intents";
import { kvSessionPort } from "./session-store";
import { TokenService } from "./token";
import { fetchGatewayUrl } from "./url";

/** 上行给规范化层（M2）的原始事件：data 为官方事件原始载荷（d） */
export interface RawEvent {
  botId: string;
  type: string;
  data: unknown;
}

export type GatewayBotState = "ready" | "resumed" | "disconnected" | "fatal";

export interface GatewayStatus {
  botId: string;
  state: GatewayBotState;
  detail?: string;
}

export interface GatewayHandlers {
  onEvent: (event: RawEvent) => void | Promise<void>;
  onStatus?: (status: GatewayStatus) => void;
}

/** 测试注入点：默认全部走真实官方通道 */
export interface GatewayOverrides {
  getGatewayUrl?: (accessToken: string) => Promise<string>;
  getAccessToken?: (app: BotApp) => Promise<string>;
  clearTokenCache?: (app: BotApp) => void;
  reconnect?: Partial<ReconnectPolicy>;
}

export interface SupervisorDeps {
  log: Logger;
  db: DB;
  handlers: GatewayHandlers;
  overrides?: GatewayOverrides;
  /** 外部注入的 TokenService（M4：发送器与网关共享同一 token 缓存）；缺省自建 */
  tokens?: TokenService;
  /** 机器人注册表（bots 表域层）：启动时连接表中全部 bot */
  bots?: BotRegistry;
}

/** 携带消息 id 的事件类型（去重键 = bot:type:id；其余事件天然幂等 upsert，无需去重） */
const DEDUP_TYPES = new Set([
  "GROUP_MESSAGE_CREATE",
  "GROUP_AT_MESSAGE_CREATE",
  "C2C_MESSAGE_CREATE",
]);

export class GatewaySupervisor {
  private readonly controllers = new Map<string, AbortController>();
  private readonly dedup = new BoundedDedup(4096);
  private readonly tokens: TokenService;
  private readonly gwLog: Logger;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly deps: SupervisorDeps) {
    this.gwLog = deps.log.child("gateway");
    this.tokens = deps.tokens ?? new TokenService(deps.log.child("token"));
  }

  /** 启动全部「接收开启」的 bot 连接循环；阻塞到 stop()（各 bot abort 后正常返回）。
   *  receive_enabled=0 的 bot 不接入（WebUI 禁用），运行时可经 addBot 重新接入。 */
  start(): Promise<void> {
    if (this.startPromise === null) {
      const apps = (this.deps.bots?.list() ?? []).filter(
        (app) => this.deps.bots?.receiveEnabledOf(app.appid) ?? true,
      );
      this.startPromise = Promise.all(
        apps.map((app) => this.launch(app)),
      ).then(() => undefined);
    }
    return this.startPromise;
  }

  /** 优雅停止：abort 全部连接 + 停 token 后台刷新 */
  stop(): void {
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.tokens.stopAll();
  }

  /** 运行时接入一个 bot（已在跑则幂等跳过）；WebUI 添加机器人时调用 */
  addBot(app: BotApp): void {
    if (this.controllers.has(app.appid)) return;
    void this.launch(app).catch(() => undefined);
  }

  /** 运行时摘除一个 bot（未在跑则幂等跳过）；WebUI 移除机器人时调用 */
  removeBot(botId: string): void {
    const controller = this.controllers.get(botId);
    if (controller === undefined) return;
    this.controllers.delete(botId);
    controller.abort();
  }

  private async launch(app: BotApp): Promise<void> {
    const { handlers, overrides } = this.deps;
    const controller = new AbortController();
    this.controllers.set(app.appid, controller);
    // 测试注入 getAccessToken 时不启动真实 token 后台刷新（CI 不碰真实网络）
    if (!overrides?.getAccessToken) this.tokens.startBackground(app);
    const log = this.gwLog.child(app.appid);

    const connection = new GatewayConnection({
      account: {
        accountId: app.appid,
        appId: app.appid,
        clientSecret: app.secret,
      },
      abortSignal: controller.signal,
      log: {
        info: (msg, meta) => log.debug(msg, meta),
        warn: (msg, meta) => log.warn(msg, meta),
        error: (msg, meta) => log.error(msg, meta),
      },
      intents: OUR_INTENTS,
      session: kvSessionPort(this.deps.db, app.appid),
      getAccessToken: () =>
        overrides?.getAccessToken
          ? overrides.getAccessToken(app)
          : this.tokens.getAccessToken(app),
      clearTokenCache: () => {
        overrides?.clearTokenCache?.(app);
        this.tokens.clear(app);
      },
      getGatewayUrl: (accessToken) =>
        overrides?.getGatewayUrl
          ? overrides.getGatewayUrl(accessToken)
          : fetchGatewayUrl(accessToken),
      reconnect: overrides?.reconnect,
      onReady: () => handlers.onStatus?.({ botId: app.appid, state: "ready" }),
      onResumed: () =>
        handlers.onStatus?.({ botId: app.appid, state: "resumed" }),
      onDisconnected: (e) => {
        handlers.onStatus?.({
          botId: app.appid,
          state: "disconnected",
          detail: `code=${e.code} willReconnect=${String(e.willReconnect)}`,
        });
        if (!e.willReconnect) {
          log.error(
            t("gw_disconnected_final", { code: e.code, reason: e.reason }),
          );
        }
      },
      onError: (err) =>
        log.warn("gateway recoverable error", { reason: err.message }),
      onMessage: (msg) => {
        // 群聊/C2C 消息走 SDK 规范化通道，msg.raw 为官方原始载荷（M2 规范化以此为准）
        if (msg.kind !== "group" && msg.kind !== "c2c") return;
        void this.emit(app.appid, msg.rawEventType, msg.raw, log);
      },
      onRawEvent: (type, data) => {
        void this.emit(app.appid, type, data, log);
      },
    });

    try {
      // 默认无限重连预算下，start() 仅在 abort（正常返回）或致命关闭（拒绝）时结束
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
      log.error(t("gw_fatal_close", { detail }));
      handlers.onStatus?.({ botId: app.appid, state: "fatal", detail });
    } finally {
      // 致命结束（非 abort）时清理控制器占位，允许后续 addBot 重新接入
      if (!controller.signal.aborted) this.controllers.delete(app.appid);
    }
  }

  /** 事件上行 + 消息级 id 去重（存储层主键是第二道闸，M2 落地） */
  private async emit(
    botId: string,
    type: string,
    data: unknown,
    log: Logger,
  ): Promise<void> {
    if (DEDUP_TYPES.has(type)) {
      const id = (data as { id?: unknown }).id;
      if (typeof id === "string" && id !== "") {
        if (!this.dedup.isNew(`${botId}:${type}:${id}`)) {
          log.warn(t("gw_event_dedup", { type, id }));
          return;
        }
      }
    }
    await this.deps.handlers.onEvent({ botId, type, data });
  }
}
