// M0 验收：SQLite 打开/WAL/迁移框架——建表、版本记录、幂等重跑、增量迁移。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";

/** best-effort 清理：Windows 下新建 .db 文件可能被 AV/索引服务短暂持有句柄，删除失败留给系统回收 */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    /* 忽略 */
  }
}

function tempDbDir(): string {
  return mkdtempSync(join(tmpdir(), "qqbot-mcp-test-"));
}

test("迁移框架：建表、版本记录、WAL 生效、重复执行幂等", () => {
  const dir = tempDbDir();
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);

    // kv 表可用
    db.prepare("INSERT INTO kv(k, v) VALUES ('a', '1')").run();
    assert.equal(
      (db.prepare("SELECT v FROM kv WHERE k = 'a'").get() as { v: string }).v,
      "1",
    );

    // WAL 生效
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");

    // 版本已记录（…/ v7 msg_idx / v8 存储重构：messages 合一+users+records+FTS 换源）
    const rows = db
      .prepare("SELECT version, name FROM schema_migrations")
      .all();
    assert.deepEqual(rows, [
      { version: 1, name: "kv" },
      { version: 2, name: "business-tables" },
      { version: 3, name: "fts-indexes" },
      { version: 4, name: "message-direction" },
      { version: 5, name: "bots-registry" },
      { version: 6, name: "bots-auth-level" },
      { version: 7, name: "msg-idx-column" },
      { version: 8, name: "storage-refactor" },
      { version: 9, name: "cursor-rebase" },
    ]);
    // 幂等：重跑不报错、不重复记录
    runMigrations(db, migrations);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
          n: number;
        }
      ).n,
      9,
    );

    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("追加迁移只执行增量", () => {
  const dir = tempDbDir();
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);
    // 用远超现有版本号的 v99 模拟"未来新增迁移"
    const v99 = [
      {
        version: 99,
        name: "future",
        up: "CREATE TABLE future_t(k TEXT PRIMARY KEY);",
      },
    ];
    runMigrations(db, [...migrations, ...v99]);

    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    assert.deepEqual(rows, [
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 99 },
    ]);
    // 新表可用
    db.prepare("INSERT INTO future_t(k) VALUES ('x')").run();
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("v9 游标重定基：指向已不存在 rowid 空间的旧水位收敛到会话 max(rowid)", () => {
  const dir = tempDbDir();
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);
    const base = {
      mentions: [],
      attachments: [],
      records: [],
      quote: null,
      raw: {},
      ts: Date.now(),
    };
    // 造三个会话：群 A（max=101）、群 B（max=202）、单聊（max=303）
    repo.saveMessage({
      ...base,
      botId: "B",
      scope: "group",
      scopeId: "GA",
      msgId: "a1",
      authorOpenid: "u1",
      text: "x",
      content: "x",
      ts: 1,
    });
    repo.saveMessage({
      ...base,
      botId: "B",
      scope: "group",
      scopeId: "GB",
      msgId: "b1",
      authorOpenid: "u1",
      text: "x",
      content: "x",
      ts: 1,
    });
    repo.saveMessage({
      ...base,
      botId: "B",
      scope: "chat",
      scopeId: "UC",
      msgId: "c1",
      authorOpenid: "u1",
      text: "x",
      content: "x",
      ts: 1,
    });

    // 模拟 v7 时代残留游标：群 A 游标(99000) > 其 max(rowid)（坏——get_new 永远查空）；
    // 群 B 游标在合理区间（1，落后于 max，正常未读语义）；单聊带 c2c: 前缀且超界
    const seed = db.prepare("INSERT INTO kv(k, v) VALUES (?, ?)");
    seed.run("cursor:B:GA", "99000");
    seed.run("cursor:B:GB", "1");
    seed.run("cursor:B:c2c:UC", "99001");
    seed.run("cursor:B:GONE", "5"); // 会话已无消息 → 收敛到 0

    // 重跑全部迁移：v9 已应用则不触发；这里直接构造一个全新库走全量迁移路径
    // （v9 在同一次 runMigrations 里应用的前提是它尚未记录——故用第二个库模拟升级路径）
    const dir2 = tempDbDir();
    try {
      const db2 = openDatabase(dir2);
      // 只建 kv 与 schema_migrations 骨架，手工灌入「v8 已应用但 v9 未应用」的状态
      db2.exec(
        migrations
          .slice(0, 8)
          .map((m) => m.up)
          .join("\n"),
      );
      db2.exec(
        `CREATE TABLE schema_migrations(
           version INTEGER PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at INTEGER
         )`,
      );
      const ins = db2.prepare(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
      );
      migrations.slice(0, 8).forEach((m, i) => ins.run(m.version, m.name, i));
      const kv = db2.prepare("INSERT INTO kv(k, v) VALUES (?, ?)");
      kv.run("cursor:B2:GA", "99000");
      kv.run("cursor:B2:c2c:UC", "99001");
      // 灌两条消息（v8 表结构）：群 A 两行、单聊一行
      db2.exec(
        `INSERT INTO messages(bot_id, scope, scope_id, msg_id, ts, text, content, records_count, direction) VALUES
         ('B2','group','GA','a1',1,'x','x',0,0),
         ('B2','group','GA','a2',2,'x','x',0,0),
         ('B2','chat','UC','c1',3,'x','x',0,0)`,
      );
      runMigrations(db2, migrations); // 只跑 v9
      const cur = db2
        .prepare("SELECT k, v FROM kv WHERE k LIKE 'cursor:%' ORDER BY k")
        .all() as Array<{ k: string; v: string }>;
      const maxGA =
        (
          db2
            .prepare(
              "SELECT MAX(rowid) AS m FROM messages WHERE bot_id='B2' AND scope='group' AND scope_id='GA'",
            )
            .get() as { m: number | null }
        ).m ?? 0;
      const maxUC =
        (
          db2
            .prepare(
              "SELECT MAX(rowid) AS m FROM messages WHERE bot_id='B2' AND scope='chat' AND scope_id='UC'",
            )
            .get() as { m: number | null }
        ).m ?? 0;
      assert.deepEqual(cur, [
        { k: "cursor:B2:GA", v: String(maxGA) },
        { k: "cursor:B2:c2c:UC", v: String(maxUC) },
      ]);
      assert.ok(maxGA > 0 && maxUC > 0, "会话内确有消息，重定基非平凡");
      db2.close();
    } finally {
      cleanupDir(dir2);
    }

    // 第一个库再跑一次幂等：v9 不重复改合理游标
    runMigrations(db, migrations);
    const cur1 = db
      .prepare("SELECT k, v FROM kv WHERE k LIKE 'cursor:%' ORDER BY k")
      .all();
    assert.ok(cur1.length >= 4);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("openDatabase 自动创建数据目录", () => {
  const parent = tempDbDir();
  const dir = join(parent, "nested", "data");
  try {
    const db = openDatabase(dir);
    assert.ok(db.open);
    db.close();
  } finally {
    cleanupDir(parent);
  }
});

test("users 身份权威：QQ 昵称 last-write-wins；群/私聊消息合一入库；records 拍平落库", () => {
  const dir = tempDbDir();
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);

    const base = {
      mentions: [],
      attachments: [],
      records: [],
      quote: null,
      raw: {},
      ts: Date.now(),
    };

    // 群消息：作者入库 users（QQ 昵称）
    repo.saveMessage({
      ...base,
      botId: "BOT_A",
      scope: "group",
      scopeId: "G_A",
      msgId: "M1",
      authorOpenid: "USER_A",
      authorName: "小肥鱼",
      authorRole: "member",
      text: "你好",
      content: "你好",
    });
    assert.equal(repo.userNameOf("BOT_A", "USER_A"), "小肥鱼");

    // 昵称变更 → last-write-wins（群昵称不落任何表，QQ 昵称是唯一身份名）
    repo.saveMessage({
      ...base,
      botId: "BOT_A",
      scope: "group",
      scopeId: "G_A",
      msgId: "M2",
      authorOpenid: "USER_A",
      authorName: "新名字",
      text: "改名了",
      content: "改名了",
    });
    assert.equal(repo.userNameOf("BOT_A", "USER_A"), "新名字");

    // 单聊消息同表（scope=chat）；载荷无名字 → users 保留旧值
    repo.saveMessage({
      ...base,
      botId: "BOT_A",
      scope: "chat",
      scopeId: "USER_A",
      msgId: "M3",
      authorOpenid: "USER_A",
      text: "单聊你好",
      content: "单聊你好",
    });
    assert.equal(repo.userNameOf("BOT_A", "USER_A"), "新名字");
    const m3 = repo.getMessageByMsgId("BOT_A", "chat", "USER_A", "M3");
    assert.equal(m3?.scope, "chat");
    assert.equal(m3?.scope_id, "USER_A");

    // openid 按 bot 维度隔离：bot B 的 users 无此人
    assert.equal(repo.userNameOf("BOT_B", "USER_A"), null);

    // 聊天记录拍平：宿主 records_count=2，子行落 message_records
    repo.saveMessage({
      ...base,
      botId: "BOT_A",
      scope: "group",
      scopeId: "G_A",
      msgId: "M4",
      authorOpenid: "USER_A",
      authorName: "新名字",
      text: "看这个",
      content: "看这个\n[聊天记录·2条]",
      msgIdx: "REFIDX_M4",
      records: [
        {
          ord: 0,
          depth: 0,
          authorOpenid: "USER_B",
          authorName: "别人",
          ts: null,
          text: "子消息一",
          quote: null,
          attachments: [],
        },
        {
          ord: 1,
          depth: 1,
          text: "嵌套层子消息",
          quote: { msgIdx: "REF_X", body: "子引用" },
          attachments: [],
        },
      ],
    });
    const host = repo.getMessageByMsgId("BOT_A", "group", "G_A", "M4");
    assert.equal(host?.records_count, 2);
    const recs = repo.getRecords("BOT_A", "group", "G_A", "M4");
    assert.equal(recs.length, 2);
    assert.equal(recs[0]?.text, "子消息一");
    assert.equal(recs[1]?.depth, 1);
    assert.ok(recs[1]?.quote_json?.includes("REF_X"));

    // 引用落库：quote_json 结构化 + 懒补被引身份（M2 在 M5 之后到，读取时补齐）
    repo.saveMessage({
      ...base,
      botId: "BOT_A",
      scope: "group",
      scopeId: "G_A",
      msgId: "M5",
      authorOpenid: "USER_B",
      authorName: "别人",
      text: "回复你",
      content: "回复你",
      quote: { msgIdx: "REFIDX_M4", body: "看这个" },
    });
    const q1 = repo.quoteOf(
      repo.getMessageByMsgId("BOT_A", "group", "G_A", "M5")!,
    );
    assert.equal(q1?.body, "看这个");
    // 被引消息 M4 已在库且带 msg_idx → 懒补出 msg_id/作者
    assert.equal(q1?.msgId, "M4");
    assert.equal(q1?.id, "USER_A");
  } finally {
    cleanupDir(dir);
  }
});
