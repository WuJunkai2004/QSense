// v13 迁移演练：对一份生产库副本跑 runMigrations，打印前后对账数据。
// 用法：npx tsx scripts/v13-rehearsal.mts <副本目录或副本db路径>
// 对账关卡：connectors 表删除、bots/sessions/messages/kv connector 状态键完好、版本=13。
// 副本制作（服务停止后）：cp data/qqbot.db* <临时目录>/（含 -wal/-shm）。
// 声明平移提示：v12 connectors 行的 (platform, package) 需手工落进 config.toml
//（本仓已带 qq/telegram 两声明；表数据仅作打印对账，不做自动写文件）。

import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";

const arg = process.argv[2];
if (arg === undefined || arg === "") {
  console.error("用法：npx tsx scripts/v13-rehearsal.mts <副本目录或副本db路径>");
  process.exit(1);
}

const isFile = /\.(db|sqlite)$/i.test(arg);
const dir = isFile
  ? arg.slice(0, Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\")))
  : arg;
const filename = isFile ? arg.split(/[\\/]/).pop() : undefined;
const db = openDatabase(dir, filename);

const version = (
  db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number;
  }
).v;
console.log(`[pre] schema_version=${version}`);
if (version >= 13) {
  console.log("已是 v13，无需演练。");
  process.exit(0);
}

// —— 演练前对账 ——
const connsPre = db
  .prepare("SELECT platform, package FROM connectors ORDER BY platform")
  .all() as Array<{ platform: string; package: string }>;
console.log("[pre] connectors 声明行（平移清单）：", JSON.stringify(connsPre));
const botsPre = db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number };
const sessPre = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
const msgPre = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
const kvPre = db
  .prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'connector:%'")
  .get() as { n: number };
console.log(
  `[pre] bots=${botsPre.n} sessions=${sessPre.n} messages=${msgPre.n} connector状态键=${kvPre.n}`,
);

runMigrations(db, migrations);

// —— 演练后对账 ——
const versionPost = (
  db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number;
  }
).v;
const tableGone = db
  .prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='connectors'",
  )
  .get() as { n: number };
const botsPost = db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number };
const sessPost = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
const msgPost = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
const kvPost = db
  .prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'connector:%'")
  .get() as { n: number };

const ok =
  versionPost === 13 &&
  tableGone.n === 0 &&
  botsPost.n === botsPre.n &&
  sessPost.n === sessPre.n &&
  msgPost.n === msgPre.n &&
  kvPost.n === kvPre.n;

console.log(`[post] schema_version=${versionPost}`);
console.log(`[post] connectors 表残留=${tableGone.n}（应为 0）`);
console.log(
  `[post] bots=${botsPost.n} sessions=${sessPost.n} messages=${msgPost.n} connector状态键=${kvPost.n}`,
);
console.log(ok ? "[演练通过] 业务数据零丢失，拓扑已归 config.toml。" : "[演练失败] 对账不平，禁止升级生产库！");
db.close();
process.exit(ok ? 0 : 1);
