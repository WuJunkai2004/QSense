// M0 验收：SQLite 打开/WAL/迁移框架——建表、版本记录、幂等重跑、增量迁移。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations } from '../src/store/db';
import { migrations } from '../src/store/migrations';

function tempDbDir(): string {
  return mkdtempSync(join(tmpdir(), 'qqbot-mcp-test-'));
}

test('迁移框架：建表、版本记录、WAL 生效、重复执行幂等', () => {
  const dir = tempDbDir();
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);

    // kv 表可用
    db.prepare("INSERT INTO kv(k, v) VALUES ('a', '1')").run();
    assert.equal((db.prepare("SELECT v FROM kv WHERE k = 'a'").get() as { v: string }).v, '1');

    // WAL 生效
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');

    // 版本已记录
    const rows = db.prepare('SELECT version, name FROM schema_migrations').all();
    assert.deepEqual(rows, [{ version: 1, name: 'kv' }]);

    // 幂等：重跑不报错、不重复记录
    runMigrations(db, migrations);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, 1);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('追加迁移只执行增量', () => {
  const dir = tempDbDir();
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);
    const v2 = [{ version: 2, name: 'kv2', up: 'CREATE TABLE kv2(k TEXT PRIMARY KEY);' }];
    runMigrations(db, [...migrations, ...v2]);

    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(rows, [{ version: 1 }, { version: 2 }]);
    // 新表可用
    db.prepare("INSERT INTO kv2(k) VALUES ('x')").run();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDatabase 自动创建数据目录', () => {
  const parent = tempDbDir();
  const dir = join(parent, 'nested', 'data');
  try {
    const db = openDatabase(dir);
    assert.ok(db.open);
    db.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
