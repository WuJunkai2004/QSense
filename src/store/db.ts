// SQLite 打开 + WAL + 版本化迁移框架（better-sqlite3 同步 API，单进程足够）。
// 表结构权威定义见 DESIGN.md §3.3。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { t } from '../i18n';
import type { Migration } from './migrations';

export type DB = Database.Database;

export function openDatabase(dataDir: string, filename = 'qqbot.db'): DB {
  const path = join(dataDir, filename);
  try {
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    return db;
  } catch (e) {
    throw new Error(t('boot_db_fail', { path, reason: e instanceof Error ? e.message : String(e) }));
  }
}

/** 执行待应用迁移；每个迁移独立事务（DDL 与版本记录同成败），重复调用幂等。 */
export function runMigrations(db: DB, list: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  const pending = [...list]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));
  const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.up);
      insert.run(m.version, m.name, Date.now());
    })();
  }
}
