// 入口：dotenv → 配置校验（缺项报可操作错误并退出1）→ 日志 → SQLite 迁移 →
// Fastify（/healthz；M3 起 /mcp）→ 优雅退出（SIGINT/SIGTERM）。

import { loadConfig, loadDotEnv } from "./config";
import { BotRegistry } from "./bots";
import { GatewaySupervisor, type GatewayStatus } from "./gateway";
import { fetchGatewayUrl } from "./gateway/url";
import { TokenService } from "./gateway/token";
import { t } from "./i18n";
import { createLogger } from "./logger";
import { handleGatewayEvent } from "./normalize/handler";
import { Sender } from "./sender";
import { buildServer } from "./server/http";
import { openDatabase, runMigrations } from "./store/db";
import { migrations } from "./store/migrations";
import { Repo } from "./store/repo";

const VERSION = "0.2.0";

async function main(): Promise<void> {
  loadDotEnv();

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // 配置错误面向操作者：直接输出可操作文案，退出码 1
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(1);
  }
  const log = createLogger(config.logLevel).child("main");

  const db = openDatabase(config.dataDir);
  runMigrations(db, migrations);

  // 事件入库（M2）+ 发送器（M4）+ 机器人注册表（M7 运行时动态 bot）：
  // 单一 Repo 实例贯穿缓存/账本/MCP 工具；registry 贯穿网关/发送器/工具面/UI
  const repo = new Repo(db);
  // M8 运行时设置播种（幂等，kv 已有值不覆盖）：发送总开关 / admin token。
  // .env 的 SEND_ENABLE / MCP_TOKEN 从"运行时权威"降级为"首次播种源"。
  repo.seedRuntime(config.sendEnabled, config.mcpToken);
  const tokens = new TokenService(log.child("token"));
  const registry = new BotRegistry({
    db,
    seed: { apps: config.apps, allowGroups: config.allowGroups },
    verify: async (app) => {
      // 两级凭据校验：token 接口（appid/secret 正确性）+ 网关地址接口（IP 白名单 11298 等
      // 网关入口问题——token 接口不校验白名单，只验 token 会出现"添加成功但连不上"）
      const token = await tokens.getAccessToken(app);
      await fetchGatewayUrl(token);
    },
  });
  const sender = new Sender({
    config,
    log,
    db,
    repo,
    tokenManager: tokens.sdk,
    bots: registry,
  });

  // 各 bot 网关状态快照（/healthz 无关；qq_list_bots 与 /ui/api/bootstrap 展示用）
  const statuses = new Map<string, GatewayStatus>();

  let eventCount = 0;
  let storedCount = 0;

  // 事件接入器：WS 出站长连接，逐 bot 连接官方网关（共享 tokens；运行时可经 UI 增删）
  const gateway = new GatewaySupervisor({
    config,
    log,
    db,
    tokens,
    bots: registry,
    handlers: {
      onEvent: (e) => {
        // 硬约束：日志不含消息正文，只记事件类型与来源
        eventCount += 1;
        try {
          handleGatewayEvent(repo, e);
          storedCount += 1;
        } catch (err) {
          log.error("event handle failed", {
            botId: e.botId,
            type: e.type,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        log.debug("event", {
          botId: e.botId,
          type: e.type,
          total: eventCount,
          stored: storedCount,
        });
      },
      onStatus: (s) => {
        statuses.set(s.botId, s);
        log.info("gateway status", {
          botId: s.botId,
          state: s.state,
          detail: s.detail,
        });
      },
    },
  });

  const app = buildServer({
    config,
    log,
    db,
    repo,
    sender,
    version: VERSION,
    registry,
    supervisor: gateway,
    tokens,
    botStatuses: () => [...statuses.values()],
  });

  const purgeOld = (): void => {
    try {
      const removed = repo.purgeOldMessages(config.retentionDays);
      if (removed > 0) log.info(t("retention_purged", { removed }));
    } catch (e) {
      log.error("retention purge failed", {
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  };
  purgeOld();
  const retentionTimer = setInterval(purgeOld, 24 * 60 * 60 * 1000);
  retentionTimer.unref();

  const gatewayStart = gateway.start();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info("shutdown", { signal, events: eventCount, stored: storedCount });
    try {
      gateway.stop();
      await gatewayStart.catch(() => undefined); // 等连接排空（含会话落盘）
      await app.close();
      db.close();
      log.info(t("shutdown_done"));
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const addr = `${config.host}:${config.port}`;
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (e) {
    log.fatal(
      t("boot_listen_fail", {
        addr,
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
    process.exit(1);
  }
  log.info(
    t("boot_ok", {
      addr,
      bots: registry.list().length,
      dataDir: config.dataDir,
      send: config.sendEnabled ? "on" : "off",
    }),
  );
}

main().catch((e) => {
  process.stderr.write(
    "fatal: " +
      (e instanceof Error ? (e.stack ?? e.message) : String(e)) +
      "\n",
  );
  process.exit(1);
});
