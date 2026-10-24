// 迁移定义：version 递增，up 为 DDL（exec 可执行多语句）。
// 新结构一律追加新版本，禁止修改历史迁移（已应用的版本按 version 跳过）。
// M2 的业务表（groups/members/messages/messages_fts/c2c/sends/quota_daily）作为 version 2 追加。

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'kv',
    up: `
      CREATE TABLE kv(
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `,
  },
];
