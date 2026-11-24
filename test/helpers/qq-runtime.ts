// 测试台架：真 QQ 插件 + 假运行时（结构面满足 ui.ts / http.ts / mcp.ts，
// 绝不发起真实网络；协议侧行为由 gateway.test.ts 以 mock 网关覆盖）。

import {
  ConnectorRegistry,
  type NetKit,
} from "@qsense/connector-sdk";
import {
  createQqConnector,
  type QqConnectorPlugin,
} from "@qsense/connector-qq";
import type { BotRegistry } from "../../src/bots";
import type {
  ConnectorSupervisor,
  GatewayStatus,
} from "../../src/connectors/runtime";
import { createBotHost, configSnapshotOf } from "../../src/connectors/host";
import { createLogger, type Logger } from "../../src/utils/logger";
import type { DB } from "../../src/store/db";
import type { Repo } from "../../src/store/repo";

export interface FakeRuntimeOpts {
  db: DB;
  repo: Repo;
  registry: BotRegistry;
  log?: Logger;
  /** 控制面 NetKit（扫码 lite 接口等；缺省=插件直连 q.qq.com，测试应显式注入） */
  net?: NetKit;
  onAdd?: (appid: string) => void;
  onRemove?: (appid: string) => void;
}

export interface FakeRuntime {
  /** Supervisor 最小消费面假件（真 ConnectorRuntime 结构满足本接口） */
  runtime: ConnectorSupervisor;
  plugins: ConnectorRegistry;
  plugin: QqConnectorPlugin;
  added: string[];
  removed: string[];
  /** 已执行运行时清理（forget：token 缓存 + 会话）的 bot */
  cleared: string[];
  /** 网关状态快照（bootstrap/settings 面板渲染用） */
  statuses: GatewayStatus[];
}

export function makeFakeRuntime(opts: FakeRuntimeOpts): FakeRuntime {
  const log = opts.log ?? createLogger("error");
  const plugins = new ConnectorRegistry();
  const plugin = createQqConnector({
    log,
    ...(opts.net !== undefined ? { net: opts.net } : {}),
  });
  plugins.register(plugin);
  const added: string[] = [];
  const removed: string[] = [];
  const cleared: string[] = [];
  const statuses: GatewayStatus[] = [];
  // Supervisor 最小消费面假件（绝不发起真实网络；协议侧由 gateway.test 覆盖）
  const runtime: ConnectorSupervisor = {
    plugins,
    addBot: (bot) => {
      added.push(bot.botId);
      opts.onAdd?.(bot.botId);
    },
    removeBot: (botId) => {
      removed.push(botId);
      plugin.forget(botId); // 真 token 缓存清理（QQ 插件内联）
      cleared.push(botId); // 台架记录：运行时清理已发生
      opts.onRemove?.(botId);
    },
    configOf: (botId) => configSnapshotOf(opts.repo, opts.registry, botId),
    hostFor: (botId) =>
      createBotHost({
        db: opts.db,
        log,
        platform: "qq",
        botId,
        ingest: () => undefined,
        onStatus: () => undefined,
      }),
  };
  return {
    runtime,
    plugins,
    plugin,
    added,
    removed,
    cleared,
    statuses,
  };
}
