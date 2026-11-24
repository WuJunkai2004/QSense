// 入口：dotenv → 配置校验（缺项报可操作错误并退出1）→ 日志 → SQLite 迁移 →
// 运行时引导（发送开关缺省 false；admin token 缺失则现场生成并打印一次）→
// 连接器装配（P5 声明制：config.toml [connectors.*] 声明 → loadModule 动态 import →
// 注册；单平台装载失败不炸启动，但已注册 bot 的平台缺失即 fail-fast 拒启）→
// ConnectorRuntime 逐 bot 创建纯网络实例 → Fastify（/healthz；/mcp；/ui）→ 优雅退出。

import { loadConfig } from "./utils/config";
import { AssetStore } from "./assets";
import { BotRegistry } from "./bots";
import { ConnectorRuntime, type GatewayStatus } from "./connectors/runtime";
import { loadDeclaredConnectors } from "./connectors/loader";
import { missingPlatformBots } from "./connectors/decl";
import { createIngestPipeline } from "./connectors/ingest";
import { t } from "./i18n";
import { createLogger } from "./utils/logger";
import { Sender } from "./sender";
import { buildServer } from "./server/http";
import { WaitHub } from "./server/wait";
import { openDatabase, runMigrations } from "./store/db";
import { migrations } from "./store/migrations";
import { Repo } from "./store/repo";
import { join } from "node:path";

const VERSION = "0.2.0";

async function main(): Promise<void> {
  // 配置（唯一权威 config.toml，env 已退役）：服务参数 + 日志 + 连接器声明一次读齐。
  // 文件缺失/语法/类型错误 → 可操作文案 + exit 1（显态失败优于静默缺省）。
  let config;
  try {
    config = loadConfig("config.toml");
  } catch (e) {
    // 配置错误面向操作者：直接输出可操作文案，退出码 1
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(1);
  }
  const log = createLogger(config.logLevel, "main", config.logFormat).child(
    "main",
  );

  const db = openDatabase(config.dataDir);
  runMigrations(db, migrations);

  // 事件入库（M2）+ 发送器（M4）+ 机器人注册表（M7 运行时动态 bot）：
  // 单一 Repo 实例贯穿缓存/账本/MCP 工具；registry 贯穿网关/发送器/工具面/UI
  const repo = new Repo(db, log.child("repo"));
  // M9 运行时引导（幂等）：发送开关缺省 false；admin token 缺失时现场生成，
  // 仅在首次生成时打印一次（之后只存 kv admin:token:v1，遗失需自行轮换）。
  const boot = repo.ensureRuntime();
  if (boot.adminCreated) {
    process.stdout.write(
      "\n[初始化] 已生成初始 admin token（仅此一次打印，请立即登录 WebUI 并妥善保存）：\n" +
        `  ${boot.adminToken}\n\n`,
    );
    log.warn("initial admin token generated (printed once to stdout)");
  }

  // 连接器装配（P5 决策 #9）：config.toml [connectors.*] 声明（已随上方 loadConfig
  // 一次读齐）→ loadModule(包名) 动态 import → sdkRange 校验 → 注册。声明解析错误
  // 已在 loadConfig 拒启；单平台装载失败先继续起服，但已注册 bot 的平台缺失会在
  // 下方 fail-fast 检查拦截。
  const { plugins, failed } = await loadDeclaredConnectors({
    log,
    declarations: config.connectors,
  });
  if (failed.length > 0) {
    log.warn(
      `connector 加载失败 ${failed.length} 个：${failed
        .map((f) => `${f.platform}(${f.package})`)
        .join(", ")}——详见上方 error 日志。`,
    );
  }

  const registry = new BotRegistry({
    db,
    verify: async (platform, credentials) => {
      // 注册凭据校验由对应平台连接器钩子承担（原 index.ts 内联两级校验已于 P1 迁入
      // connector-qq）：平台插件未装载（= 不在 config.toml 声明）→ 硬拒绝（绝不静默
      // 放行入库；防 IP 白名单 11298 假阳性语义由插件自带核对提示保留）。
      const verify = plugins.get(platform)?.hooks?.verifyCredential;
      if (verify === undefined) {
        throw new Error(
          `平台 ${platform} 的连接器未装载，无法校验凭据。请检查 config.toml [connectors.${platform}] 声明与对应连接器包安装/构建（npm run build）。`,
        );
      }
      await verify(credentials);
    },
  });

  // fail-fast（决策 #9）：已注册 bot 的 platform 必须有声明且装载成功的连接器——
  // 声明改名/整节删除后存量 bot 显态拒启（优于 enabled=0 时代的隐态静默降级）。
  const loadedPlatforms = new Set(plugins.list().map((p) => p.id));
  const orphaned = missingPlatformBots(registry.list(), loadedPlatforms);
  if (orphaned.length > 0) {
    const detail = orphaned
      .map((b) => `${b.botId}(platform=${b.platform})`)
      .join(", ");
    log.fatal(
      `config.toml 声明缺失：以下 bot 的平台无可用连接器，拒绝启动——${detail}。` +
        `请在 config.toml 补回对应 [connectors.*] 声明（package 指向已安装的连接器包），` +
        `或先在 WebUI 移除这些 bot。`,
    );
    process.exit(1);
  }
  const assets = new AssetStore(join(config.dataDir, "assets"));

  // core ingest 管线（契约 v2 表驱动）：connector 上行信封 → payload.platform
  // 路由插件 normalize → 消息级去重 → 入库/效应落地（语义经插件解读，落地全在 core）
  // /wait 发布侧：去重后的入站消息逐条进事件中枢（本机外发补记 direction=1 不是事件）
  const waitHub = new WaitHub({ repo, log });
  const ingest = createIngestPipeline({
    repo,
    log,
    plugins,
    tap: ({ messages }) => {
      for (const m of messages) {
        if (m.direction === 1) continue;
        waitHub.publish({
          botId: m.botId,
          scope: m.scope,
          scopeId: m.scopeId,
          atMe: m.atMe,
          mentionCount: m.mentions.length,
          authorOpenid: m.authorOpenid,
        });
      }
    },
  });

  // 连接器运行时：逐 bot 创建纯网络实例 + 状态聚合 + 插件上下面解析
  const statuses = new Map<string, GatewayStatus>();
  const connectors = new ConnectorRuntime({
    log,
    db,
    repo,
    bots: registry,
    plugins,
    ingest,
    onStatus: (s) => {
      statuses.set(s.botId, s);
      log.info("gateway status", {
        botId: s.botId,
        state: s.state,
        detail: s.detail ?? null,
      });
    },
  });

  const sender = new Sender({
    log,
    repo,
    bots: registry,
    transportFor: (botId) => connectors.netFor(botId),
    capsFor: (botId) => connectors.capsFor(botId),
    sendErrorFor: (botId) => connectors.sendErrorFor(botId),
    hooks: {
      proactiveGate: (botId, target) => connectors.hooksGate(botId, target),
      proactiveRecord: (botId, target) => connectors.hooksRecord(botId, target),
    },
    assets,
  });

  const app = buildServer({
    log,
    db,
    repo,
    sender,
    version: VERSION,
    registry,
    connectors,
    botStatuses: () => [...statuses.values()],
    assets,
    uiDistDir: config.uiDistDir,
    wait: waitHub,
  });

  const gatewayStart = connectors.start();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info("shutdown", { signal });
    try {
      connectors.stop();
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
      send: repo.getSendEnable() ? "on" : "off",
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
