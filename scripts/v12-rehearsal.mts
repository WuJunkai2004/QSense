// v12 迁移演练：对一份生产库副本跑 runMigrations，打印前后对账数据。
// 用法：npx tsx scripts/v12-rehearsal.mts <副本db路径>
// 对账关卡：bots 凭据回填（secret 脱敏）、gw:session 键平移、sessions 登记数量、版本=12。
// 副本制作（服务停止后）：cp data/qqbot.db* <临时目录>/（含 -wal/-shm）。

import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";

const path = process.argv[2];
if (path === undefined || path === "") {
  console.error("用法：npx tsx scripts/v12-rehearsal.mts <副本db路径>");
  process.exit(1);
}

const dir = path.includes("/") || path.includes("\\")
  ? path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")))
  : ".";
const db = openDatabase(dir, path.split(/[\\/]/).pop());

const version = (
  db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number;
  }
).v;
console.log(`[pre] schema_version=${version}`);
if (version >= 12) {
  console.log("已是 v12，无需演练。");
  process.exit(0);
}

// —— 演练前对账 ——
const botsPre = db
  .prepare("SELECT COUNT(*) AS n FROM bots")
  .get() as { n: number };
const oldKeys = db
  .prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'gw:session:%'")
  .get() as { n: number };
const conv = db
  .prepare(
    "SELECT COUNT(DISTINCT bot_id || ':' || scope || ':' || scope_id) AS n FROM messages",
  )
  .get() as { n: number };
const groupsN = db.prepare("SELECT COUNT(*) AS n FROM groups").get() as {
  n: number;
};
const c2cKeys = db
  .prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'c2c:switch:%'")
  .get() as { n: number };
console.log(
  `[pre] bots=${botsPre.n} gw:session旧键=${oldKeys.n} 消息会话数=${conv.n} groups=${groupsN.n} c2c开关键=${c2cKeys.n}`,
);

runMigrations(db, migrations);

// —— 演练后对账（凭据只打印键名，绝不打印值） ——
const version2 = (
  db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number;
  }
).v;
const bots = db
  .prepare("SELECT appid, platform, credentials_json FROM bots")
  .all() as Array<{
  appid: string;
  platform: string;
  credentials_json: string;
}>;
const sessionsN = db
  .prepare("SELECT COUNT(*) AS n FROM sessions")
  .get() as { n: number };
const newKeys = db
  .prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'connector:qq:%:gw:session'")
  .get() as { n: number };
const oldLeft = db
  .prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'gw:session:%'")
  .get() as { n: number };

console.log(`[post] schema_version=${version2}`);
for (const b of bots) {
  const keys = Object.keys(JSON.parse(b.credentials_json) as object);
  console.log(`[post] bot=${b.appid} platform=${b.platform} 凭据键=[${keys.join(",")}]`);
}
console.log(
  `[post] sessions=${sessionsN.n}（预期 ≥ 消息会话数 ${conv.n}） connector:qq:*:gw:session=${newKeys.n}（预期 ${oldKeys.n}） gw:session残留=${oldLeft.n}（预期 0）`,
);

// 关卡断言
const fail: string[] = [];
if (version2 !== 12) fail.push("版本未到 12");
if (oldLeft.n !== 0) fail.push("gw:session 旧键残留");
if (newKeys.n !== oldKeys.n) fail.push("gw:session 平移数量不符");
for (const b of bots) {
  // JSON.parse 返回 any（库签名）：只读 appid 一列做回填核对
  const creds = JSON.parse(b.credentials_json) as { appid?: string };
  if ((creds.appid ?? "") !== b.appid) fail.push(`bot ${b.appid} 凭据回填 appid 不符`);
}
if (sessionsN.n < conv.n) fail.push("sessions 登记数量少于消息会话数");
if (fail.length > 0) {
  console.error(`[演练失败] ${fail.join("；")}`);
  process.exit(1);
}
console.log("[演练通过] 三重回填/平移全部符合预期，可对生产库升级。");
