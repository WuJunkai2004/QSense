// M0 验收：SQLite 打开/WAL/迁移框架——建表、版本记录、幂等重跑、增量迁移。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import type { NormalizedMessage } from "../src/normalize/types";

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

    // 版本已记录（…/ v6 bot 认证等级 / v7 msg_idx 引用回溯列）
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
    ]);
    // 幂等：重跑不报错、不重复记录
    runMigrations(db, migrations);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
          n: number;
        }
      ).n,
      7,
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
      { version: 99 },
    ]);
    // 新表可用
    db.prepare("INSERT INTO future_t(k) VALUES ('x')").run();
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

test("单聊作者名映射：入站单聊从本 bot 群聊名册反查昵称；openid 按 bot 隔离不串名", () => {
  const dir = tempDbDir();
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);

    const base: NormalizedMessage = {
      botId: "",
      scope: "c2c",
      scopeId: "",
      msgId: "",
      authorOpenid: "",
      ts: Date.now(),
      content: "你好",
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    };

    // bot A 名册里有 USER_A（群聊消息积累；单聊载荷本身无昵称）
    db.prepare(
      "INSERT INTO members(bot_id, group_openid, member_openid, username, member_role, first_seen, last_seen, msg_count) VALUES ('BOT_A','G_A','USER_A','小肥鱼','member',?, ?, 1)",
    ).run(Date.now(), Date.now());

    // bot A 收到 USER_A 单聊 → 反查补名
    repo.saveC2cMessage({
      ...base,
      botId: "BOT_A",
      scopeId: "USER_A",
      authorOpenid: "USER_A",
      msgId: "M1",
    });
    const m1 = repo.getC2cMessageByMsgId("BOT_A", "USER_A", "M1");
    assert.equal(m1?.author_name, "小肥鱼");

    // openid 按 bot 维度隔离：同一 openid 字面量在 bot B 名册无记录 → 不串名
    repo.saveC2cMessage({
      ...base,
      botId: "BOT_B",
      scopeId: "USER_A",
      authorOpenid: "USER_A",
      msgId: "M2",
    });
    const m2 = repo.getC2cMessageByMsgId("BOT_B", "USER_A", "M2");
    assert.equal(m2?.author_name, null);

    // 名册未命中（对方未与 bot 在任何群互动过）→ 保持 null，展示层回落 openid
    repo.saveC2cMessage({
      ...base,
      botId: "BOT_A",
      scopeId: "USER_X",
      authorOpenid: "USER_X",
      msgId: "M3",
    });
    const m3 = repo.getC2cMessageByMsgId("BOT_A", "USER_X", "M3");
    assert.equal(m3?.author_name, null);
  } finally {
    cleanupDir(dir);
  }
});
