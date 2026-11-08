// 迁移定义：version 递增，up 为 DDL（exec 可执行多语句）；run 为可选 JS 步骤（数据重演，
// v8 起支持——纯 SQL 表达不了的 normalize 重演走这里），与 up 同事务同成败。
// 新结构一律追加新版本，禁止修改历史迁移（已应用的版本按 version 跳过）。
// M2 的业务表（groups/members/messages/messages_fts/c2c/sends/quota_daily）作为 version 2 追加。

import { normalizeMessage } from "../normalize";
import type { MsgScope } from "../normalize/types";
import type { DB } from "./db";

export interface Migration {
  version: number;
  name: string;
  up: string;
  run?: (db: DB) => void;
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
    // search 关键词检索对中文不可用；trigram 支持子串匹配（better-sqlite3 内置 SQLite ≥ 3.34）。
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
    // WebUI 设置页 / token_refresh 可轮换，旧 token 立即失效，新值仅返回一次。
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
  {
    version: 7,
    name: "msg-idx-column",
    // 引用回溯：官方在每条消息的 message_scene.ext 携带 msg_idx 令牌（REFIDX_…），
    // 引用元素（103）以该令牌为锚指向被引消息。入库存列后，读取时 [引用 msg_idx=X]
    // 可 join 缓存内联被引原文（repo.resolveQuotes，MCP 与 WebUI 共用）。
    up: `
      ALTER TABLE messages ADD COLUMN msg_idx TEXT;
      CREATE INDEX idx_msg_msg_idx ON messages(bot_id, group_openid, msg_idx);
      ALTER TABLE c2c_messages ADD COLUMN msg_idx TEXT;
      CREATE INDEX idx_c2c_msg_idx ON c2c_messages(bot_id, user_openid, msg_idx);
    `,
  },
  {
    version: 8,
    name: "storage-refactor",
    // 2026-11-08 存储重构（用户定案「存语义，渲染留派生；身份归身份，内容归内容」）：
    // - messages 群/私聊合一（scope 列），c2c_messages 退役；content 不再糅引用与记录转写，
    //   新增 text（本条纯文本，FTS 唯一检索源）/ quote_json（结构化引用）/ records_count
    // - users 表：QQ 昵称唯一权威（openid 不变、昵称 last-write-wins）；members 砍 username 列
    //   （群昵称只在 mention 里出现且一人多昵称，当身份名必然混乱）
    // - message_records：聊天记录（102）拍平子消息出列，宿主 content 只留条数标记
    // - FTS 换源 text 列；elements_json 废弃（raw_json 有完整元素树，不再存派生副本）
    // - 历史 raw_json 全量重演（normalize 新管线），outgoing 补记行（无 raw）直接平移
    up: `
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TRIGGER IF EXISTS c2c_messages_fts_ai;
      DROP TRIGGER IF EXISTS c2c_messages_fts_ad;
      DROP TRIGGER IF EXISTS c2c_messages_fts_au;
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS c2c_messages_fts;
      DROP INDEX IF EXISTS idx_msg_ts;
      DROP INDEX IF EXISTS idx_msg_msg_idx;
      DROP INDEX IF EXISTS idx_c2c_ts;
      DROP INDEX IF EXISTS idx_c2c_msg_idx;
      ALTER TABLE messages RENAME TO messages_v7;
      ALTER TABLE c2c_messages RENAME TO c2c_messages_v7;

      CREATE TABLE messages(
        bot_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        author_openid TEXT,
        author_name TEXT,
        author_role TEXT,
        ts INTEGER,
        text TEXT,
        content TEXT,
        quote_json TEXT,
        records_count INTEGER NOT NULL DEFAULT 0,
        mentions_json TEXT,
        attachments_json TEXT,
        ark_json TEXT,
        raw_json TEXT,
        direction INTEGER NOT NULL DEFAULT 0,
        msg_idx TEXT,
        PRIMARY KEY(bot_id, scope, scope_id, msg_id)
      );
      CREATE INDEX idx_msg_ts ON messages(bot_id, scope, scope_id, ts);
      CREATE INDEX idx_msg_msg_idx ON messages(bot_id, scope, scope_id, msg_idx);
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text, content='messages', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE TABLE users(
        bot_id TEXT NOT NULL,
        openid TEXT NOT NULL,
        name TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY(bot_id, openid)
      );

      CREATE TABLE message_records(
        bot_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        author_openid TEXT,
        author_name TEXT,
        ts INTEGER,
        text TEXT,
        quote_json TEXT,
        attachments_json TEXT,
        PRIMARY KEY(bot_id, scope, scope_id, msg_id, ord)
      );

      ALTER TABLE members RENAME TO members_v7;
      CREATE TABLE members(
        bot_id TEXT NOT NULL,
        group_openid TEXT NOT NULL,
        member_openid TEXT NOT NULL,
        member_role TEXT,
        first_seen INTEGER,
        last_seen INTEGER,
        msg_count INTEGER DEFAULT 0,
        PRIMARY KEY(bot_id, group_openid, member_openid)
      );
      INSERT INTO members(bot_id, group_openid, member_openid, member_role, first_seen, last_seen, msg_count)
        SELECT bot_id, group_openid, member_openid, member_role, first_seen, last_seen, msg_count
        FROM members_v7;
      DROP TABLE members_v7;
    `,
    run: (db: DB): void => {
      const insertMsg = db.prepare(`
        INSERT OR IGNORE INTO messages(
          bot_id, scope, scope_id, msg_id, author_openid, author_name, author_role,
          ts, text, content, quote_json, records_count, mentions_json,
          attachments_json, ark_json, raw_json, direction, msg_idx
        ) VALUES (
          @bot_id, @scope, @scope_id, @msg_id, @author_openid, @author_name, @author_role,
          @ts, @text, @content, @quote_json, @records_count, @mentions_json,
          @attachments_json, @ark_json, @raw_json, @direction, @msg_idx
        )
      `);
      const insertRecord = db.prepare(`
        INSERT OR IGNORE INTO message_records(
          bot_id, scope, scope_id, msg_id, ord, depth,
          author_openid, author_name, ts, text, quote_json, attachments_json
        ) VALUES (
          @bot_id, @scope, @scope_id, @msg_id, @ord, @depth,
          @author_openid, @author_name, @ts, @text, @quote_json, @attachments_json
        )
      `);
      const upsertUser = db.prepare(`
        INSERT INTO users(bot_id, openid, name, first_seen, last_seen)
        VALUES (@bot_id, @openid, @name, @now, @now)
        ON CONFLICT(bot_id, openid) DO UPDATE SET
          name = COALESCE(excluded.name, users.name),
          last_seen = MAX(users.last_seen, excluded.last_seen)
      `);

      interface V7Row {
        bot_id: string;
        group_openid?: string;
        user_openid?: string;
        msg_id: string;
        author_openid: string | null;
        author_name: string | null;
        author_role: string | null;
        ts: number | null;
        content: string | null;
        mentions_json: string | null;
        attachments_json: string | null;
        ark_json: string | null;
        raw_json: string | null;
        direction: number;
        msg_idx: string | null;
      }

      const migrateRow = (row: V7Row, scope: MsgScope, scopeId: string): void => {
        const base = {
          bot_id: row.bot_id,
          scope,
          scope_id: scopeId,
          msg_id: row.msg_id,
          ts: row.ts,
          mentions_json: row.mentions_json,
          attachments_json: row.attachments_json,
          ark_json: row.ark_json,
          raw_json: row.raw_json,
          direction: row.direction,
        };
        // outgoing 补记行（无 raw_json，官方不回推）：content 即发送文本，直接平移
        if (row.raw_json === null) {
          insertMsg.run({
            ...base,
            author_openid: row.author_openid,
            author_name: row.author_name,
            author_role: row.author_role,
            text: row.content,
            content: row.content,
            quote_json: null,
            records_count: 0,
            msg_idx: row.msg_idx,
          });
          return;
        }
        // 正常行：从 raw_json 全量重演（normalize 新管线产出 text/quote/records/干净 content）
        let m = null;
        try {
          m = normalizeMessage({
            type: scope === "group" ? "GROUP_MESSAGE_CREATE" : "C2C_MESSAGE_CREATE",
            botId: row.bot_id,
            data: JSON.parse(row.raw_json) as Record<string, unknown>,
          });
        } catch {
          m = null; // 坏 raw 不炸迁移：退化为直接平移旧行
        }
        if (m === null) {
          insertMsg.run({
            ...base,
            author_openid: row.author_openid,
            author_name: row.author_name,
            author_role: row.author_role,
            text: row.content,
            content: row.content,
            quote_json: null,
            records_count: 0,
            msg_idx: row.msg_idx,
          });
          return;
        }
        const quote = m.quote ?? null;
        insertMsg.run({
          ...base,
          author_openid: row.author_openid ?? (m.authorOpenid !== "" ? m.authorOpenid : null),
          author_name: row.author_name ?? m.authorName ?? null,
          author_role: row.author_role ?? m.authorRole ?? null,
          text: m.text !== "" ? m.text : row.content,
          content: m.content !== "" ? m.content : row.content,
          quote_json: quote !== null ? JSON.stringify(quote) : null,
          records_count: m.records.length,
          msg_idx: m.msgIdx ?? row.msg_idx,
        });
        for (const rec of m.records) {
          insertRecord.run({
            bot_id: row.bot_id,
            scope,
            scope_id: scopeId,
            msg_id: row.msg_id,
            ord: rec.ord,
            depth: rec.depth,
            author_openid: rec.authorOpenid ?? null,
            author_name: rec.authorName ?? null,
            ts: rec.ts ?? null,
            text: rec.text,
            quote_json:
              rec.quote !== undefined && rec.quote !== null
                ? JSON.stringify(rec.quote)
                : null,
            attachments_json:
              rec.attachments.length > 0 ? JSON.stringify(rec.attachments) : null,
          });
        }
        const openid =
          row.author_openid ?? (m.authorOpenid !== "" ? m.authorOpenid : null);
        if (openid !== null) {
          upsertUser.run({
            bot_id: row.bot_id,
            openid,
            name: row.author_name ?? m.authorName ?? null,
            now: Date.now(),
          });
        }
      };

      const groupRows = db.prepare(
        "SELECT rowid AS rid, * FROM messages_v7",
      ).all() as unknown as V7Row[];
      for (const row of groupRows) {
        migrateRow(row, "group", row.group_openid ?? "");
      }
      const chatRows = db.prepare(
        "SELECT rowid AS rid, * FROM c2c_messages_v7",
      ).all() as unknown as V7Row[];
      for (const row of chatRows) {
        migrateRow(row, "chat", row.user_openid ?? "");
      }

      // quote enrich 二遍扫：被引晚到（quote 只有 msg_idx/body）→ 查缓存补作者与 msg_id
      const enrichSel = db.prepare(
        "SELECT rowid, bot_id, scope, scope_id, quote_json FROM messages WHERE quote_json IS NOT NULL",
      ).all() as Array<{
        rowid: number;
        bot_id: string;
        scope: MsgScope;
        scope_id: string;
        quote_json: string;
      }>;
      const idxLookup = db.prepare(
        "SELECT author_openid, msg_id, author_name FROM messages WHERE bot_id = ? AND scope = ? AND scope_id = ? AND msg_idx = ? ORDER BY rowid DESC LIMIT 1",
      );
      const quoteUpdate = db.prepare(
        "UPDATE messages SET quote_json = ? WHERE rowid = ?",
      );
      for (const row of enrichSel) {
        let q: { msgIdx?: string; body?: string; authorOpenid?: string | null; authorName?: string | null; msgId?: string | null };
        try {
          q = JSON.parse(row.quote_json) as typeof q;
        } catch {
          continue;
        }
        if (q.msgIdx === undefined || (q.authorOpenid ?? null) !== null) continue;
        const hit = idxLookup.get(
          row.bot_id,
          row.scope,
          row.scope_id,
          q.msgIdx,
        ) as
          | { author_openid: string | null; msg_id: string; author_name: string | null }
          | undefined;
        if (hit === undefined) continue;
        q.authorOpenid = hit.author_openid;
        q.msgId = hit.msg_id;
        q.authorName = hit.author_name;
        quoteUpdate.run(JSON.stringify(q), row.rowid);
      }

      // external-content FTS 已由触发器随 INSERT 同步；rebuild 兜底可能的索引漂移
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");

      db.exec("DROP TABLE messages_v7");
      db.exec("DROP TABLE c2c_messages_v7");
    },
  },
  {
    version: 9,
    name: "cursor-rebase",
    // 2026-11-08 真机踩坑：kv 已读水位存的是 messages 表 rowid（get_new 写入 rows[last].rid）。
    // v7 旧表因官方重推（INSERT OR IGNORE 失败仍消耗 rowid）积累了 rowid 空洞，计数器曾到 7882；
    // v8 重建 messages 表后 rowid 从 1 连续重排，而 kv 游标值原样保留——旧游标（如 7881/7882）
    // 大于新表全部 rowid，get_new 永远查空，增量拉取哑火直到 rowid 涨过旧值（真机复现：
    // E8CD87 群 9 条新消息 get_new 返回空）。
    // 修复：游标重定基 = 各会话在新表的当前 MAX(rowid)（历史视为已读；水位键名不变，此后增量恢复）。
    up: "",
    run: (db: DB): void => {
      const rows = db
        .prepare("SELECT k, v FROM kv WHERE k LIKE 'cursor:%'")
        .all() as Array<{ k: string; v: string }>;
      const maxStmt = db.prepare(
        "SELECT MAX(rowid) AS m FROM messages WHERE bot_id = ? AND scope = ? AND scope_id = ?",
      );
      const update = db.prepare("UPDATE kv SET v = ? WHERE k = ?");
      for (const row of rows) {
        // 键格式：cursor:{botId}:{groupOpenid} | cursor:{botId}:c2c:{userOpenid}
        const rest = row.k.slice("cursor:".length);
        const i = rest.indexOf(":");
        if (i < 0) continue;
        const botId = rest.slice(0, i);
        const key = rest.slice(i + 1);
        const isChat = key.startsWith("c2c:");
        const scope: MsgScope = isChat ? "chat" : "group";
        const scopeId = isChat ? key.slice(4) : key;
        const hit = maxStmt.get(botId, scope, scopeId) as {
          m: number | null;
        };
        const maxRid = hit.m ?? 0;
        const cur = Number(row.v);
        if (Number.isFinite(cur) && cur <= maxRid) continue; // 已在合理区间，不动
        update.run(String(maxRid), row.k);
      }
    },
  },
];
