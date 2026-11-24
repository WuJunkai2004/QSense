// 宿主面 HostApi 工厂：每 bot 一个（log 分域 / StatePort kv 持久化 / ingest 管线 / 状态聚合）。
// 插件代码只经 HostApi 触达宿主——DB/fastify/repo 在类型上不可达（管线不可绕过闸门）。

import type {
  BotConfigSnapshot,
  ConnectorLogger,
  ConnectorStatus,
  PluginContext,
  StatePort,
} from "@qsense/connector-sdk";
import { createNetKit } from "@qsense/connector-sdk";
import type { BotRegistry } from "../bots";
import type { Logger } from "../utils/logger";
import type { Repo } from "../store/repo";
import type { DB } from "../store/db";

export interface KvStatePortOpts {
  db: DB;
  platform: string;
  botId: string;
}

/**
 * kv 表 StatePort 实现。
 * 物理键统一命名空间：`connector:{platform}:{botId}:{key}`（P3 起；v12 迁移已把
 * P1 时代的旧物理键 gw:session:{botId} 平移进来，无 shim、无双键名）。
 */
export function kvStatePort(opts: KvStatePortOpts): StatePort {
  const phys = (key: string): string =>
    `connector:${opts.platform}:${opts.botId}:${key}`;
  const select = opts.db.prepare("SELECT v FROM kv WHERE k = ?");
  const upsert = opts.db.prepare(
    "INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  );
  const del = opts.db.prepare("DELETE FROM kv WHERE k = ?");
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const row = select.get(phys(key)) as { v: string } | undefined;
      if (row === undefined) return null;
      try {
        return JSON.parse(row.v) as T;
      } catch {
        return null; // 坏数据按缺失处理（安全默认）
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      upsert.run(phys(key), JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      del.run(phys(key));
    },
  };
}

export interface BotHostOpts {
  log: Logger;
  db: DB;
  platform: string;
  botId: string;
  /** core ingest 管线（createIngestPipeline 产物） */
  ingest: (raw: { botId: string; payload: unknown }) => void;
  onStatus: (s: ConnectorStatus) => void;
}

/** 每 bot HostApi（core Logger 结构兼容 ConnectorLogger，可直接传入）。
 * T3 起返回 PluginContext（HostApi + net 注入）——结构类型是 HostApi 超集，
 * 旧声明面零改动。 */
export function createBotHost(opts: BotHostOpts): PluginContext {
  const host: PluginContext = {
    log: opts.log as ConnectorLogger,
    state: kvStatePort({ db: opts.db, platform: opts.platform, botId: opts.botId }),
    ingest: (raw) => opts.ingest(raw),
    reportStatus: (s) => opts.onStatus(s),
    net: createNetKit(),
  };
  return host;
}

/** 每 bot 平台配置快照（P1/P2 = bots 表列投影；P3 起 = bots.config_json） */
export function configSnapshotOf(
  repo: Repo,
  registry: BotRegistry,
  botId: string,
): BotConfigSnapshot {
  return {
    authLevel: registry.authLevelOf(botId),
    allowGroups: registry.allowGroupsOf(botId),
    sendEnabled: repo.getSendEnable(),
    name: registry.get(botId)?.name,
  };
}
