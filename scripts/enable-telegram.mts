// Telegram 平台一次性上线脚本（P3.5 试金石真机进场；P5 随 v13 迁移改声明来源）：
// ① BotRegistry.add 注册 bot（走真实 verifyCredential=getMe 两级校验，未过不入库）
// ② 顺带把库迁移推到当前版本（v13+，connectors 表已退役）
//
// 平台声明现在走 config.toml（[connectors.telegram]），本脚本不再写表——
// 若尚无声明，启动会 fail-fast，请先在 config.toml 补：
//   [connectors.telegram]
//   package = "@qsense/connector-telegram"
//
// 用法（服务必须停止——SQLite 单写者）：
//   TELEGRAM_APPID=9167497677 TELEGRAM_TOKEN=<token> npx tsx scripts/enable-telegram.mts
// agent_token 仅此一次打印（注册即焚纪律），调用方立即保存。
// 密钥经环境变量传入，不落任何文件/git。

import { loadConfig } from "../src/config";
import { createTelegramConnector } from "@qsense/connector-telegram";
import { BotRegistry, BotRegistryError } from "../src/bots";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";

// data_dir 来自 config.toml（唯一配置权威；env 已退役）
const dataDir = loadConfig("config.toml").dataDir;

// TELEGRAM_APPID / TELEGRAM_TOKEN 是本次调用的入参（凭据经环境变量传入，不落任何文件/git）
const appid = process.env.TELEGRAM_APPID ?? "";
const token = process.env.TELEGRAM_TOKEN ?? "";
if (appid === "" || token === "") {
  console.error(
    "用法：TELEGRAM_APPID=<bot数字id> TELEGRAM_TOKEN=<BotFather token> npx tsx scripts/enable-telegram.mts",
  );
  process.exit(1);
}

const db = openDatabase(dataDir);
runMigrations(db, migrations);

// ② 注册（真实 verify：token 形制 + getMe + appid 一致性）
const plugin = createTelegramConnector();
const registry = new BotRegistry({
  db,
  verify: async (platform, credentials) => {
    const verify = plugin.hooks?.verifyCredential;
    if (verify === undefined) throw new Error("telegram 插件钩子缺失");
    if (platform !== "telegram") throw new Error(`平台不匹配：${platform}`);
    await verify(credentials);
  },
});
try {
  const registered = await registry.add({
    platform: "telegram",
    credentials: { appid, token },
  });
  console.log(`[注册] bot=${registered.bot.botId} platform=${registered.bot.platform} name=${registered.bot.name}`);
  console.log(
    `\n[agent_token 仅此一次打印，请立即保存用于 /mcp 接入]：\n  ${registered.agentToken}\n`,
  );
} catch (e) {
  if (e instanceof BotRegistryError) {
    console.error(`[注册失败] ${e.message}`);
  } else {
    throw e;
  }
  process.exit(1);
}
console.log("[完成] 下次 npm start：config.toml 声明制加载 telegram 插件，多平台 bot 并行接入。");
