// 连接器运行时（宿主侧编排）：per-bot 实例生命周期（启动/接入/摘除）、状态聚合、
// 发送原语与插件钩子的按 bot 解析。多 bot 管理是宿主职责；连接器实例是纯网络。
// （P1 收口：原 GatewaySupervisor 的多 bot 编排段迁此，协议段已下沉 connector-qq。）

import type {
  BotConfigSnapshot,
  ConnectorInstance,
  ConnectorNet,
  ConnectorRegistry,
  HostApi,
  ProactiveVerdict,
  RawInbound,
} from "@qsense/connector-sdk";
import type { BotRecord, BotRegistry } from "../bots";
import type { Logger } from "../utils/logger";
import type { Repo } from "../store/repo";
import type { DB } from "../store/db";
import { configSnapshotOf, createBotHost } from "./host";

export type GatewayBotState = "ready" | "resumed" | "disconnected" | "fatal";

export interface GatewayStatus {
  botId: string;
  state: GatewayBotState;
  detail?: string;
}

interface Entry {
  instance: ConnectorInstance;
  host: HostApi;
  start: Promise<void>;
  platform: string;
}

export interface ConnectorRuntimeDeps {
  log: Logger;
  db: DB;
  repo: Repo;
  bots: BotRegistry;
  plugins: ConnectorRegistry;
  /** core ingest 管线（createIngestPipeline 产物） */
  ingest: (raw: RawInbound) => void;
  /** 状态快照外送（index.ts 聚合 / 测试捕获） */
  onStatus?: (s: GatewayStatus) => void;
}

export class ConnectorRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly statusMap = new Map<string, GatewayStatus>();
  private stopping = false;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly deps: ConnectorRuntimeDeps) {}

  /** 声明面注册表（MCP 工具路由 / WebUI 声明端点用） */
  get plugins(): ConnectorRegistry {
    return this.deps.plugins;
  }

  /** 启动全部「接收开启」bot 的连接循环；阻塞到 stop()（各 bot abort 后正常返回） */
  start(): Promise<void> {
    if (this.startPromise === null) {
      const apps = this.deps.bots
        .list()
        .filter((a) => this.deps.bots.receiveEnabledOf(a.botId));
      this.startPromise = Promise.all(
        apps.map((a) => this.launch(a)),
      ).then(() => undefined);
    }
    return this.startPromise;
  }

  /** 优雅停止：abort 全部实例 */
  stop(): void {
    this.stopping = true;
    for (const e of this.entries.values()) e.instance.stop();
    this.entries.clear();
  }

  /** 运行时接入一个 bot（已在跑则幂等跳过）；WebUI/MCP 注册后调用 */
  addBot(bot: BotRecord): void {
    if (this.entries.has(bot.botId)) return;
    void this.launch(bot);
  }

  /** 运行时摘除一个 bot（未在跑则幂等跳过）；WebUI 移除机器人时调用 */
  removeBot(botId: string): void {
    const e = this.entries.get(botId);
    if (e === undefined) return;
    this.entries.delete(botId);
    e.instance.stop();
    // 会话与 token 缓存一并清理（重加即全新 IDENTIFY，同旧 DELETE /bots/:appid 语义）
    void e.host.state.delete("gw:session");
    const plugin = this.deps.plugins.get(e.platform) as
      | { forget?: (botId: string) => void }
      | undefined;
    plugin?.forget?.(botId);
    this.statusMap.delete(botId);
  }

  /** 各 bot 网关状态快照（/healthz 无关；list_bots 与 /ui/api/bootstrap 展示用） */
  statuses(): GatewayStatus[] {
    return [...this.statusMap.values()];
  }

  /** 发送原语解析（Sender 的 transportFor 绑定用） */
  netFor(botId: string): ConnectorNet | undefined {
    return this.entries.get(botId)?.instance.net;
  }

  /** 每 bot 平台归属（注册表权威；未知 bot 兜底 qq——兼容仅查询场景的键名空间） */
  private platformOf(botId: string): string {
    return this.deps.bots.platformOf(botId) ?? "qq";
  }

  /** 插件工具/钩子上下面（host+StatePort）；bot 未启动实例也可用（如仅 MCP 查询） */
  hostFor(botId: string): HostApi {
    const e = this.entries.get(botId);
    if (e !== undefined) return e.host;
    return createBotHost({
      db: this.deps.db,
      log: this.deps.log,
      platform: this.platformOf(botId),
      botId,
      ingest: (raw) => this.deps.ingest(raw),
      onStatus: (s) => this.pushStatus(botId, s),
    });
  }

  /** 每 bot 平台配置快照（bots 表列投影） */
  configOf(botId: string): BotConfigSnapshot {
    return configSnapshotOf(this.deps.repo, this.deps.bots, botId);
  }

  /** 每 bot 平台 caps（Sender caps 感知路由用；未知 bot/平台=undefined 走严格路径） */
  capsFor(botId: string): import("@qsense/connector-sdk").PlatformCaps | undefined {
    return this.deps.plugins.get(this.platformOf(botId))?.caps;
  }

  /** 每 bot 发送错误语义面（契约 v2.2.2；未知 bot/平台/未声明=undefined 走通用兜底） */
  sendErrorFor(
    botId: string,
  ): import("@qsense/connector-sdk").SendErrorSemantics | undefined {
    return this.deps.plugins.get(this.platformOf(botId))?.sendError;
  }

  /**
   * 额度门禁（Sender proactive 前置）：按 bot 平台解析插件钩子；
   * 平台未声明 proactiveGate（或插件未加载）=放行。
   */
  hooksGate(botId: string, target: string): Promise<ProactiveVerdict> {
    const plugin = this.deps.plugins.get(this.platformOf(botId));
    if (plugin?.hooks?.proactiveGate === undefined) return Promise.resolve({ ok: true });
    return plugin.hooks.proactiveGate(
      { host: this.hostFor(botId), config: this.configOf(botId) },
      botId,
      target,
    );
  }

  /** 发送受理成功记账（QQ=日额度 +1）；core await 保证先记后查一致 */
  async hooksRecord(botId: string, target: string): Promise<void> {
    const plugin = this.deps.plugins.get(this.platformOf(botId));
    await plugin?.hooks?.proactiveRecord?.(
      { host: this.hostFor(botId), config: this.configOf(botId) },
      botId,
      target,
    );
  }

  private pushStatus(botId: string, s: { state: GatewayBotState; detail?: string }): void {
    const full: GatewayStatus = { botId, ...s };
    this.statusMap.set(botId, full);
    this.deps.onStatus?.(full);
  }

  /** 按 bot 平台解析插件并拉起纯网络实例（单平台插件未加载不炸启动，warn 跳过） */
  private launch(bot: BotRecord): Promise<void> {
    if (this.entries.has(bot.botId)) return Promise.resolve();
    const plugin = this.deps.plugins.get(bot.platform);
    if (plugin === undefined) {
      this.deps.log.warn("connector not registered; bot skipped", {
        bot: bot.botId,
        platform: bot.platform,
      });
      return Promise.resolve();
    }
    const host = createBotHost({
      db: this.deps.db,
      log: this.deps.log,
      platform: bot.platform,
      botId: bot.botId,
      ingest: (raw) => this.deps.ingest(raw),
      onStatus: (s) => this.pushStatus(bot.botId, s),
    });
    const instance = plugin.create(host, {
      botId: bot.botId,
      platform: bot.platform,
      credential: bot.credentials,
    });
    const start = instance.start().finally(() => {
      // 致命结束（非 stop/remove）时清理占位，允许 addBot 重新接入（旧 supervisor 纪律）
      if (!this.stopping && this.entries.get(bot.botId)?.instance === instance) {
        this.entries.delete(bot.botId);
      }
    });
    this.entries.set(bot.botId, {
      instance,
      host,
      start,
      platform: bot.platform,
    });
    return start;
  }
}
