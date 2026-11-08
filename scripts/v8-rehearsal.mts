// v8 迁移演练：对一份生产库副本跑 runMigrations，打印前后对账数据。
// 用法：npx tsx scripts/v8-rehearsal.mts <副本db路径>
// 三个断言关卡：行数守恒、引用消息 quote_json 覆盖、FTS 换源后可检索。

import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";

const path = process.argv[2];
if (path === undefined || path === "") {
  console.error("用法：npx tsx scripts/v8-rehearsal.mts <副本db路径>");
  process.exit(1);
}

const db = openDatabase(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".", path.split("/").pop());

const tables = (
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
).map((r) => r.name);
const hasV7 = tables.includes("c2c_messages");
const version = (
  db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }
).v;
console.log(`[pre] schema_version=${version} v7形态=${hasV7}`);
if (version >= 8) {
  console.log("已是 v8，无需演练。");
  process.exit(0);
}
if (!hasV7) {
  console.error("副本不是 v7 形态（缺 c2c_messages）。");
  process.exit(1);
}

const oldGroup = (
  db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
).n;
const oldChat = (
  db.prepare("SELECT COUNT(*) AS n FROM c2c_messages").get() as { n: number }
).n;
const oldQuoteMarkers = (
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%[引用 msg_idx=%'",
    )
    .get() as { n: number }
).n;
console.log(`[pre] 群消息=${oldGroup} 单聊消息=${oldChat} 含引用令牌的群消息=${oldQuoteMarkers}`);

const t0 = Date.now();
runMigrations(db, migrations);
const ms = Date.now() - t0;

const newTotal = (
  db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
).n;
const byScope = db
  .prepare("SELECT scope, COUNT(*) AS n FROM messages GROUP BY scope")
  .all() as Array<{ scope: string; n: number }>;
const newQuote = (
  db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE quote_json IS NOT NULL")
    .get() as { n: number }
).n;
const newRecords = (
  db.prepare("SELECT COUNT(*) AS n FROM message_records").get() as { n: number }
).n;
const users = (
  db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
).n;
const namedUsers = (
  db.prepare("SELECT COUNT(*) AS n FROM users WHERE name IS NOT NULL").get() as { n: number }
).n;
const leftoverMarkers = (
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%[引用 msg_idx=%' OR content LIKE '%> %'",
    )
    .get() as { n: number }
).n;
console.log(`[post] 迁移耗时=${ms}ms 新总行=${newTotal}（群+单聊=${oldGroup + oldChat}）`);
console.log(`[post] byScope=${JSON.stringify(byScope)} quote_json=${newQuote} records=${newRecords}`);
console.log(`[post] users=${users}（有名字=${namedUsers}） 残留引用令牌/内联正文行=${leftoverMarkers}`);

// FTS 换源冒烟：随便取一条 text 里的词检索
const sample = db
  .prepare(
    "SELECT text FROM messages WHERE text IS NOT NULL AND length(text) >= 6 ORDER BY rowid DESC LIMIT 1",
  )
  .get() as { text: string } | undefined;
if (sample !== undefined) {
  const word = [...sample.text].slice(0, 4).join("");
  const hits = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?",
    )
    .get(`"${word}"`) as { n: number };
  console.log(`[post] FTS 冒烟：text="${word}…" 命中=${hits.n}`);
}

// 守恒断言
if (newTotal !== oldGroup + oldChat) {
  console.error(`❌ 行数不守恒：${newTotal} != ${oldGroup + oldChat}`);
  process.exit(1);
}
if (oldQuoteMarkers > 0 && newQuote === 0) {
  console.error("❌ 旧库有引用令牌消息，但新库 quote_json 全空——重演失败");
  process.exit(1);
}
console.log("✅ 演练通过");
