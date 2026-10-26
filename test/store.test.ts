// M0 验收：SQLite 打开/WAL/迁移框架——建表、版本记录、幂等重跑、增量迁移。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";

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
