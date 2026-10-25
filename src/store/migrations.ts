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
    name: "kv",
    up: `
      CREATE TABLE kv(
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "business-tables",
    // 全量业务表，权威定义见 DESIGN.md §3.3。
    // 偏差说明：FTS 用 trigram 而非 unicode61——unicode61 不分词中文（整句成单 token），
    // qq_search 关键词检索对中文不可用；trigram 支持子串匹配（better-sqlite3 内置 SQLite ≥ 3.34）。
    up: `
      CREATE TABLE groups(
        bot_id TEXT NOT NULL,
        group_openid TEXT NOT NULL,
        full_msg_enabled INTEGER NOT NULL DEFAULT 1,
        added_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY(bot_id, group_openid)
      );

      CREATE TABLE members(
        bot_id TEXT NOT NULL,
        group_openid TEXT NOT NULL,
        member_openid TEXT NOT NULL,
        username TEXT,
        member_role TEXT,
        first_seen INTEGER,
        last_seen INTEGER,
        msg_count INTEGER DEFAULT 0,
        PRIMARY KEY(bot_id, group_openid, member_openid)
      );

      CREATE TABLE messages(
        bot_id TEXT NOT NULL,
        group_openid TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        author_openid TEXT,
        author_name TEXT,
        author_role TEXT,
        ts INTEGER,
        content TEXT,
        mentions_json TEXT,
        elements_json TEXT,
        attachments_json TEXT,
        ark_json TEXT,
        raw_json TEXT,
        PRIMARY KEY(bot_id, group_openid, msg_id)
      );
      CREATE INDEX idx_msg_ts ON messages(bot_id, group_openid, ts);

      CREATE TABLE c2c_messages(
        bot_id TEXT NOT NULL,
        user_openid TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        author_openid TEXT,
        author_name TEXT,
        author_role TEXT,
        ts INTEGER,
        content TEXT,
        mentions_json TEXT,
        elements_json TEXT,
        attachments_json TEXT,
        ark_json TEXT,
        raw_json TEXT,
        PRIMARY KEY(bot_id, user_openid, msg_id)
      );
      CREATE INDEX idx_c2c_ts ON c2c_messages(bot_id, user_openid, ts);

      CREATE TABLE sends(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT,
        target_openid TEXT,
        kind TEXT,
        reply_msg_id TEXT,
        msg_seq INTEGER,
        payload_hash TEXT,
        provider_msg_id TEXT,
        status TEXT,
        error_code INTEGER,
        created_at INTEGER
      );

      CREATE TABLE quota_daily(
        bot_id TEXT,
        target_openid TEXT,
        date TEXT,
        proactive_count INTEGER DEFAULT 0,
        PRIMARY KEY(bot_id, target_openid, date)
      );
    `,
  },
  {
    version: 3,
    name: "fts-indexes",
    // external-content FTS5 + 触发器同步（ messages / c2c_messages 的 content 列 ）
    up: `
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content, content='messages', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE VIRTUAL TABLE c2c_messages_fts USING fts5(
        content, content='c2c_messages', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER c2c_messages_fts_ai AFTER INSERT ON c2c_messages BEGIN
        INSERT INTO c2c_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER c2c_messages_fts_ad AFTER DELETE ON c2c_messages BEGIN
        INSERT INTO c2c_messages_fts(c2c_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER c2c_messages_fts_au AFTER UPDATE OF content ON c2c_messages BEGIN
        INSERT INTO c2c_messages_fts(c2c_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO c2c_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `,
  },
  {
    version: 4,
    name: "message-direction",
    // 本机外发标记：0=网关接收（默认），1=发送成功后本地补记（官方不回推 bot 自发消息，
    // 不落库则 WebUI 刷新后发送记录消失）。两张消息表同构，保持 messageParams 单一来源。
    up: `
      ALTER TABLE messages ADD COLUMN direction INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE c2c_messages ADD COLUMN direction INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 5,
    name: "bots-registry",
    // M8 机器人注册表：唯一 bot 权威存储（.env QQ_APPS / 旧 kv bots:dynamic:v1 只作首次播种源）。
    // agent_token 明文存储（2026-10-25 用户拍板：单机管理面，不做加密）；每个 token 只绑定一个 bot，
    // WebUI 设置页 / qq_token_refresh 可轮换，旧 token 立即失效，新值仅返回一次。
    up: `
      CREATE TABLE bots(
        appid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        agent_token TEXT NOT NULL UNIQUE,
        allow_groups TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "bots-auth-level",
    // M9：认证等级 per-bot 落库（env QQ_AUTH_LEVEL 全局档位退役）。
    // 主动消息 bot 级频控预算：certified=60qpm / uncertified=30qpm，缺省未认证（保守）。
    up: `ALTER TABLE bots ADD COLUMN auth_level TEXT NOT NULL DEFAULT 'uncertified';`,
  },
];
