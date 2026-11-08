// 仓储层：SQLite 状态的唯一读写口（better-sqlite3 同步 API，单进程）。
// 2026-11-08 存储重构（用户定案）：
// - messages 群/私聊合一（scope 列 group|chat），c2c_messages 镜像表退役——sender 早已统一，
//   存储终于对齐；repo 层 *C2c 镜像方法全灭，一套方法吃 scope 参数
// - users 表 = QQ 昵称唯一权威（openid 对同一 bot 不变，昵称 last-write-wins）；
//   members 只存群成员关系事实（砍 username 列——群昵称只在 mention 里出现且一人多昵称，
//   当身份名必然混乱），展示名一律 join users
// - 引用结构化（quote_json，ingest 提取 + 缓存 enrich + 读取懒补），resolveQuotes 内联/逐行
//   比对家族全灭；聊天记录拍平（message_records 表）
// - 热路径 stmt 构造器缓存（对齐既定模式）；管理面低频操作 inline prepare

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { NormalizedMessage, MsgScope } from "../normalize/types";
import type { TtsConfig } from "../tts";
import type { DB } from "./db";

type Stmt<P extends unknown[] = unknown[]> = Database.Statement<P>;

export interface MsgRow {
  rid: number;
  bot_id: string;
  scope: MsgScope;
  scope_id: string;
  msg_id: string;
  author_openid: string | null;
  author_name: string | null;
  author_role: string | null;
  ts: number | null;
  text: string | null;
  content: string | null;
  quote_json: string | null;
  records_count: number;
  mentions_json: string | null;
  attachments_json: string | null;
  ark_json: string | null;
  raw_json: string | null;
  direction: number;
  msg_idx: string | null;
}

export interface RecordRow {
  ord: number;
  depth: number;
  author_openid: string | null;
  author_name: string | null;
  ts: number | null;
  text: string | null;
  quote_json: string | null;
  attachments_json: string | null;
}

export interface SendRow {
  id: number;
  bot_id: string;
  target_openid: string;
  kind: string;
  reply_msg_id: string | null;
  msg_seq: number | null;
  payload_hash: string | null;
  provider_msg_id: string | null;
  status: string;
  error_code: number | null;
  created_at: number;
}

/** quote_msg 数据（供工具面组装 quote_msg 字段）：body 已按「首行 + ≤50 字符」截断 */
export interface QuoteMsgData {
  id: string | null;
  msgId: string | null;
  body: string;
}

export class Repo {
  // —— 热路径 stmt（构造器缓存） ——
  private readonly insertMsgStmt: Stmt<[Record<string, unknown>]>;
  private readonly insertRecordStmt: Stmt<[Record<string, unknown>]>;
  private readonly upsertUserStmt: Stmt<[Record<string, unknown>]>;
  private readonly userNameStmt: Stmt<[string, string]>;
  private readonly afterStmt: Stmt<[string, string, string, number, number]>;
  private readonly byMsgIdStmt: Stmt<[string, string, string, string]>;
  private readonly latestStmt: Stmt<[string, string, string, number]>;
  private readonly beforeTsStmt: Stmt<
    [string, string, string, number, number, number, number]
  >;
  private afterTsStmt: Stmt<
    [string, string, string, number, number, number, number]
  >;
  private pageBeforeStmt: Stmt<
    [string, string, string, number | null, number, number]
  >;
  private readonly ftsStmt: Stmt<[string, string, string, string, number]>;
  private readonly unreadStmt: Stmt<[number, string, string, string]>;
  private readonly listChatsStmt: Stmt<[string]>;
  private readonly msgIdxStmt: Stmt<[string, string, string, string]>;
  private readonly quoteUpdateStmt: Stmt<[string, number]>;
  private readonly recordsStmt: Stmt<[string, string, string, string]>;
  private readonly detectGroupMsgStmt: Stmt<[string, string]>;
  private readonly detectChatMsgStmt: Stmt<[string, string]>;
  private readonly detectGroupRegStmt: Stmt<[string, string]>;
  private readonly upsertGroupStmt: Stmt<[Record<string, unknown>]>;
  private readonly ensureGroupStmt: Stmt<[Record<string, unknown>]>;
  private readonly setGroupSwitchStmt: Stmt<[Record<string, unknown>]>;
  private readonly deleteGroupStmt: Stmt<[string, string]>;
  private readonly upsertMemberStmt: Stmt<[Record<string, unknown>]>;
  private readonly kvGetStmt: Stmt<[string]>;
  private readonly kvSetStmt: Stmt<[string, string]>;
  private readonly insertSendStmt: Stmt<
    [
      string,
      string,
      string,
      string | null,
      number | null,
      string | null,
      string,
      number,
    ]
  >;
  private readonly updateSendStmt: Stmt<
    [string, string | null, number | null, number]
  >;
  private readonly incrQuotaStmt: Stmt<[string, string, string]>;

  constructor(private readonly db: DB) {
    this.insertMsgStmt = db.prepare(`
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
    this.insertRecordStmt = db.prepare(`
      INSERT OR IGNORE INTO message_records(
        bot_id, scope, scope_id, msg_id, ord, depth,
        author_openid, author_name, ts, text, quote_json, attachments_json
      ) VALUES (
        @bot_id, @scope, @scope_id, @msg_id, @ord, @depth,
        @author_openid, @author_name, @ts, @text, @quote_json, @attachments_json
      )
    `);
    // QQ 昵称唯一权威：openid 不变、昵称 last-write-wins（载荷没给名字时保留旧值）
    this.upsertUserStmt = db.prepare(`
      INSERT INTO users(bot_id, openid, name, first_seen, last_seen)
      VALUES (@bot_id, @openid, @name, @now, @now)
      ON CONFLICT(bot_id, openid) DO UPDATE SET
        name = COALESCE(excluded.name, users.name),
        last_seen = MAX(users.last_seen, excluded.last_seen)
    `);
    this.userNameStmt = db.prepare(
      "SELECT name FROM users WHERE bot_id = ? AND openid = ?",
    );
    this.afterStmt = db.prepare(`
      SELECT rowid AS rid, * FROM messages
      WHERE bot_id = ? AND scope = ? AND scope_id = ? AND rowid > ?
      ORDER BY rowid ASC LIMIT ?
    `);
    this.byMsgIdStmt = db.prepare(
      "SELECT rowid AS rid, * FROM messages WHERE bot_id = ? AND scope = ? AND scope_id = ? AND msg_id = ?",
    );
    this.latestStmt = db.prepare(`
      SELECT rowid AS rid, * FROM messages
      WHERE bot_id = ? AND scope = ? AND scope_id = ?
      ORDER BY ts DESC, rowid DESC LIMIT ?
    `);
    this.beforeTsStmt = db.prepare(`
      SELECT rowid AS rid, * FROM messages
      WHERE bot_id = ? AND scope = ? AND scope_id = ? AND (ts < ? OR (ts = ? AND rowid < ?))
      ORDER BY ts DESC, rowid DESC LIMIT ?
    `);
    this.afterTsStmt = db.prepare(`
      SELECT rowid AS rid, * FROM messages
      WHERE bot_id = ? AND scope = ? AND scope_id = ? AND (ts > ? OR (ts = ? AND rowid > ?))
      ORDER BY ts ASC, rowid ASC LIMIT ?
    `);
    this.pageBeforeStmt = db.prepare(`
      SELECT rowid AS rid, * FROM messages
      WHERE bot_id = ? AND scope = ? AND scope_id = ? AND (? IS NULL OR rowid < ?)
      ORDER BY rowid DESC LIMIT ?
    `);
    this.ftsStmt = db.prepare(`
      SELECT m.rowid AS rid, m.* FROM messages_fts f
      JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND m.bot_id = ? AND m.scope = ? AND m.scope_id = ?
      ORDER BY m.ts DESC, m.rowid DESC LIMIT ?
    `);
    this.unreadStmt = db.prepare(
      "SELECT COALESCE(SUM(rowid > ?), 0) AS unread, MAX(ts) AS last_ts FROM messages WHERE bot_id = ? AND scope = ? AND scope_id = ?",
    );
    this.listChatsStmt = db.prepare(`
      SELECT c.scope_id AS user_openid, MAX(lm.ts) AS last_ts
      FROM (SELECT scope_id, MAX(rowid) AS rid FROM messages WHERE bot_id = ? AND scope = 'chat' GROUP BY scope_id) c
      JOIN messages lm ON lm.rowid = c.rid
      GROUP BY c.scope_id
      ORDER BY last_ts DESC
    `);
    // 引用 enrich（ingest + 读取懒补共用）：msg_idx 锚 → 被引消息身份
    this.msgIdxStmt = db.prepare(
      "SELECT author_openid, msg_id, author_name FROM messages WHERE bot_id = ? AND scope = ? AND scope_id = ? AND msg_idx = ? ORDER BY rowid DESC LIMIT 1",
    );
    this.quoteUpdateStmt = db.prepare(
      "UPDATE messages SET quote_json = ? WHERE rowid = ?",
    );
    this.recordsStmt = db.prepare(`
      SELECT ord, depth, author_openid, author_name, ts, text, quote_json, attachments_json
      FROM message_records WHERE bot_id = ? AND scope = ? AND scope_id = ? AND msg_id = ?
      ORDER BY ord ASC
    `);
    // 侧别探测三件套（detectSessionKind 专用——全部读写工具的必经热路径）
    this.detectGroupMsgStmt = db.prepare(
      "SELECT 1 FROM messages WHERE bot_id = ? AND scope = 'group' AND scope_id = ? LIMIT 1",
    );
    this.detectChatMsgStmt = db.prepare(
      "SELECT 1 FROM messages WHERE bot_id = ? AND scope = 'chat' AND scope_id = ? LIMIT 1",
    );
    this.detectGroupRegStmt = db.prepare(
      "SELECT 1 FROM groups WHERE bot_id = ? AND group_openid = ? LIMIT 1",
    );
    this.upsertGroupStmt = db.prepare(`
      INSERT INTO groups(bot_id, group_openid, full_msg_enabled, added_at, updated_at)
      VALUES (@bot_id, @group_openid, @full_msg_enabled, @now, @now)
      ON CONFLICT(bot_id, group_openid) DO UPDATE SET
        full_msg_enabled = @full_msg_enabled,
        updated_at = @now
    `);
    this.ensureGroupStmt = db.prepare(`
      INSERT OR IGNORE INTO groups(bot_id, group_openid, full_msg_enabled, added_at, updated_at)
      VALUES (@bot_id, @group_openid, @full_msg_enabled, @now, @now)
    `);
    this.setGroupSwitchStmt = db.prepare(`
      INSERT INTO groups(bot_id, group_openid, full_msg_enabled, added_at, updated_at)
      VALUES (@bot_id, @group_openid, @full_msg_enabled, @now, @now)
      ON CONFLICT(bot_id, group_openid) DO UPDATE SET
        full_msg_enabled = @full_msg_enabled,
        updated_at = @now
    `);
    this.deleteGroupStmt = db.prepare(
      "DELETE FROM groups WHERE bot_id = ? AND group_openid = ?",
    );
    // members 只存成员关系事实（无 username 列——名字权威在 users 表）
    this.upsertMemberStmt = db.prepare(`
      INSERT INTO members(bot_id, group_openid, member_openid, member_role, first_seen, last_seen, msg_count)
      VALUES (@bot_id, @group_openid, @member_openid, @member_role, @now, @now, 1)
      ON CONFLICT(bot_id, group_openid, member_openid) DO UPDATE SET
        member_role = COALESCE(excluded.member_role, members.member_role),
        last_seen = excluded.last_seen,
        msg_count = members.msg_count + 1
    `);
    this.kvGetStmt = db.prepare("SELECT v FROM kv WHERE k = ?");
    this.kvSetStmt = db.prepare(
      "INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
    this.insertSendStmt = db.prepare(`
      INSERT INTO sends(bot_id, target_openid, kind, reply_msg_id, msg_seq, payload_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateSendStmt = db.prepare(
      "UPDATE sends SET status = ?, provider_msg_id = COALESCE(?, provider_msg_id), error_code = ? WHERE id = ?",
    );
    this.incrQuotaStmt = db.prepare(`
      INSERT INTO quota_daily(bot_id, target_openid, date, proactive_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(bot_id, target_openid, date) DO UPDATE SET proactive_count = proactive_count + 1
    `);
  }

  // —— 消息入库 ——

  /**
   * 消息入库（群/私聊统一；scope 由 normalize 给出）。事务内四件事：
   * ① 消息行（quote_json 由 ingest 提取，缓存命中即补被引身份）；② 记录子消息拍平行；
   * ③ 群侧成员名册（关系事实，无名字）；④ users 身份 upsert（QQ 昵称 last-write-wins）。
   * 返回 false = msg_id 重复（官方重推），幂等忽略。
   */
  saveMessage(m: NormalizedMessage): boolean {
    const run = this.db.transaction(() => {
      let quote = m.quote;
      if (
        quote !== null &&
        quote.msgIdx !== undefined &&
        (quote.authorOpenid ?? null) === null
      ) {
        const hit = this.msgIdxStmt.get(
          m.botId,
          m.scope,
          m.scopeId,
          quote.msgIdx,
        ) as
          | {
              author_openid: string | null;
              msg_id: string;
              author_name: string | null;
            }
          | undefined;
        if (hit !== undefined) {
          quote = {
            ...quote,
            authorOpenid: hit.author_openid,
            msgId: hit.msg_id,
            authorName: hit.author_name,
          };
        }
      }
      const info = this.insertMsgStmt.run({
        bot_id: m.botId,
        scope: m.scope,
        scope_id: m.scopeId,
        msg_id: m.msgId,
        author_openid: m.authorOpenid !== "" ? m.authorOpenid : null,
        author_name: m.authorName ?? null,
        author_role: m.authorRole ?? null,
        ts: m.ts,
        text: m.text,
        content: m.content,
        quote_json: quote !== null ? JSON.stringify(quote) : null,
        records_count: m.records.length,
        mentions_json:
          m.mentions.length > 0 ? JSON.stringify(m.mentions) : null,
        attachments_json:
          m.attachments.length > 0 ? JSON.stringify(m.attachments) : null,
        ark_json: m.ark !== undefined ? JSON.stringify(m.ark) : null,
        raw_json: JSON.stringify(m.raw),
        direction: m.direction ?? 0,
        msg_idx: m.msgIdx ?? null,
      });
      for (const rec of m.records) {
        this.insertRecordStmt.run({
          bot_id: m.botId,
          scope: m.scope,
          scope_id: m.scopeId,
          msg_id: m.msgId,
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
      if (m.scope === "group" && m.authorOpenid !== "") {
        this.upsertMemberStmt.run({
          bot_id: m.botId,
          group_openid: m.scopeId,
          member_openid: m.authorOpenid,
          member_role: m.authorRole ?? null,
          now: Date.now(),
        });
      }
      if (m.authorOpenid !== "") {
        this.upsertUserStmt.run({
          bot_id: m.botId,
          openid: m.authorOpenid,
          name: m.authorName ?? null,
          now: Date.now(),
        });
      }
      return info.changes > 0;
    });
    return run() as boolean;
  }

  /**
   * 本机外发消息补记（官方不回推 bot 自发消息，发送成功后调用）。
   * 与接收共用 messages 表；不写成员名册/users（作者是自己）。msg_id 重复=幂等重放，静默忽略。
   */
  saveOutgoing(p: {
    botId: string;
    scope: MsgScope;
    scopeId: string;
    msgId: string;
    content: string;
    ts: number;
    authorName: string | null;
  }): boolean {
    const info = this.insertMsgStmt.run({
      bot_id: p.botId,
      scope: p.scope,
      scope_id: p.scopeId,
      msg_id: p.msgId,
      author_openid: null,
      author_name: p.authorName,
      author_role: null,
      ts: p.ts,
      text: p.content,
      content: p.content,
      quote_json: null,
      records_count: 0,
      mentions_json: null,
      attachments_json: null,
      ark_json: null,
      raw_json: null,
      direction: 1,
      msg_idx: null,
    });
    return info.changes > 0;
  }

  /**
   * quote_msg 数据（读取端）：quote_json 直读，被引晚到（只有锚没有身份）时查缓存懒补并回写。
   * body 已按「首行 + ≤50 字符（码点计，超出加 …）」截断——被引原文是别人的话，不整段进上下文。
   */
  quoteOf(row: MsgRow): QuoteMsgData | null {
    if (row.quote_json === null) return null;
    let q: {
      msgIdx?: string;
      body?: string;
      authorOpenid?: string | null;
      authorName?: string | null;
      msgId?: string | null;
    };
    try {
      q = JSON.parse(row.quote_json) as typeof q;
    } catch {
      return null;
    }
    let { authorOpenid, authorName, msgId } = q;
    if (q.msgIdx !== undefined && (authorOpenid ?? null) === null) {
      const hit = this.msgIdxStmt.get(
        row.bot_id,
        row.scope,
        row.scope_id,
        q.msgIdx,
      ) as
        | {
            author_openid: string | null;
            msg_id: string;
            author_name: string | null;
          }
        | undefined;
      if (hit !== undefined) {
        authorOpenid = hit.author_openid;
        msgId = hit.msg_id;
        authorName = hit.author_name;
        this.quoteUpdateStmt.run(
          JSON.stringify({ ...q, authorOpenid, authorName, msgId }),
          row.rid,
        );
      }
    }
    const first = (q.body ?? "").split("\n")[0] ?? "";
    const cps = Array.from(first);
    return {
      id: authorOpenid ?? null,
      msgId: msgId ?? null,
      body: cps.length > 50 ? `${cps.slice(0, 50).join("")}…` : first,
    };
  }

  // —— 身份（users 表，QQ 昵称唯一权威） ——

  /** 最新 QQ 昵称；users 未收录返回 null（读取端回落行快照 author_name） */
  userNameOf(botId: string, openid: string): string | null {
    const row = this.userNameStmt.get(botId, openid) as
      { name: string | null } | undefined;
    return row?.name ?? null;
  }

  // —— 群注册表 / 成员名册 ——

  addGroup(botId: string, groupOpenid: string): void {
    this.upsertGroupStmt.run({
      bot_id: botId,
      group_openid: groupOpenid,
      full_msg_enabled: 0,
      now: Date.now(),
    });
  }

  /** 群保底在册（INSERT OR IGNORE，已存在不覆盖开关状态）；fullMsgEnabled=null 仅新建时落 0 */
  ensureGroup(
    botId: string,
    groupOpenid: string,
    fullMsgEnabled: 0 | 1 | null,
  ): void {
    this.ensureGroupStmt.run({
      bot_id: botId,
      group_openid: groupOpenid,
      full_msg_enabled: fullMsgEnabled ?? 0,
      now: Date.now(),
    });
  }

  /** GROUP_MSG_RECEIVE / GROUP_MSG_REJECT：全量消息开关状态 */
  setGroupSwitch(botId: string, groupOpenid: string, enabled: boolean): void {
    this.setGroupSwitchStmt.run({
      bot_id: botId,
      group_openid: groupOpenid,
      full_msg_enabled: enabled ? 1 : 0,
      now: Date.now(),
    });
  }

  /** GROUP_DEL_ROBOT：被移出群 → 注册表失效（缓存历史保留，名册独立存在） */
  removeGroup(botId: string, groupOpenid: string): void {
    this.deleteGroupStmt.run(botId, groupOpenid);
  }

  /** C2C_MSG_RECEIVE / C2C_MSG_REJECT：用户级"允许主动发送"开关（kv 存储） */
  setC2cSwitch(botId: string, userOpenid: string, enabled: boolean): void {
    this.kvSetStmt.run(
      `c2c:switch:${botId}:${userOpenid}`,
      enabled ? "1" : "0",
    );
  }

  getC2cSwitch(botId: string, userOpenid: string): boolean | null {
    const row = this.kvGetStmt.get(`c2c:switch:${botId}:${userOpenid}`) as
      { v: string } | undefined;
    if (!row) return null;
    return row.v === "1";
  }

  // —— TTS（语音合成发送）——
  // 全局服务配置：kv tts:config:v1（OpenAI 兼容 /audio/speech 四字段，JSON）；
  // 每 bot 使用开关：kv tts:<appid>（"enable"/"disable"，无键=关——新 bot 缺省禁用）。

  /** 全局 TTS 配置；null=未配置（send_media tts: 将被可操作拒绝） */
  getTtsConfig(): TtsConfig | null {
    const row = this.kvGetStmt.get(TTS_CONFIG_KEY) as
      { v: string } | undefined;
    if (row === undefined) return null;
    try {
      const cfg = JSON.parse(row.v) as Partial<TtsConfig>;
      if (
        typeof cfg.base_url !== "string" ||
        cfg.base_url === "" ||
        typeof cfg.model !== "string" ||
        cfg.model === "" ||
        typeof cfg.voice !== "string" ||
        cfg.voice === "" ||
        typeof cfg.api_key !== "string"
      ) {
        return null;
      }
      return cfg as TtsConfig;
    } catch {
      return null; // 坏数据按未配置处理（安全默认）
    }
  }

  setTtsConfig(cfg: TtsConfig): void {
    this.kvSetStmt.run(TTS_CONFIG_KEY, JSON.stringify(cfg));
  }

  getTtsEnabled(botId: string): boolean {
    const row = this.kvGetStmt.get(`tts:${botId}`) as
      { v: string } | undefined;
    return row?.v === "enable";
  }

  setTtsEnabled(botId: string, enabled: boolean): void {
    this.kvSetStmt.run(`tts:${botId}`, enabled ? "enable" : "disable");
  }

  listGroups(botId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `
        SELECT g.group_openid, g.full_msg_enabled, g.added_at, g.updated_at,
               (SELECT COUNT(*) FROM members m WHERE m.bot_id = g.bot_id AND m.group_openid = g.group_openid) AS member_count
        FROM groups g WHERE g.bot_id = ? ORDER BY g.updated_at DESC
      `,
      )
      .all(botId) as Array<Record<string, unknown>>;
  }

  /** WebUI 群会话列表：群 + 成员数 + 最后一条消息摘要（作者名以 users 最新昵称为准） */
  listGroupsWithLast(botId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `
        SELECT g.group_openid, g.full_msg_enabled, g.added_at, g.updated_at,
               (SELECT COUNT(*) FROM members m WHERE m.bot_id = g.bot_id AND m.group_openid = g.group_openid) AS member_count,
               lm.ts AS last_ts, lm.content AS last_content,
               COALESCE(u.name, lm.author_name) AS last_author
        FROM groups g
        LEFT JOIN messages lm ON lm.rowid = (
          SELECT MAX(x.rowid) FROM messages x
          WHERE x.bot_id = g.bot_id AND x.scope = 'group' AND x.scope_id = g.group_openid
        )
        LEFT JOIN users u ON u.bot_id = lm.bot_id AND u.openid = lm.author_openid
        WHERE g.bot_id = ?
        ORDER BY COALESCE(lm.ts, g.updated_at, g.added_at) DESC
      `,
      )
      .all(botId) as Array<Record<string, unknown>>;
  }

  /** WebUI 单聊会话列表：openid + 最后一条消息摘要（名字=users 权威，旧名册反查 hack 已死） */
  listChatsWithLast(botId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `
        SELECT c.scope_id AS user_openid, lm.ts AS last_ts, lm.content AS last_content,
               COALESCE(u.name, lm.author_name) AS last_author
        FROM (
          SELECT scope_id, MAX(rowid) AS rid FROM messages
          WHERE bot_id = ? AND scope = 'chat' GROUP BY scope_id
        ) c
        JOIN messages lm ON lm.rowid = c.rid
        LEFT JOIN users u ON u.bot_id = lm.bot_id AND u.openid = lm.author_openid
        ORDER BY lm.ts DESC
      `,
      )
      .all(botId) as Array<Record<string, unknown>>;
  }

  /** 成员名册（关系事实）：名字 join users 取 QQ 昵称，未收录回落 openid */
  listMembers(
    botId: string,
    groupOpenid: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `
        SELECT m.member_openid, COALESCE(u.name, m.member_openid) AS username,
               m.member_role, m.first_seen, m.last_seen, m.msg_count
        FROM members m
        LEFT JOIN users u ON u.bot_id = m.bot_id AND u.openid = m.member_openid
        WHERE m.bot_id = ? AND m.group_openid = ?
        ORDER BY m.msg_count DESC, m.last_seen DESC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, limit) as Array<Record<string, unknown>>;
  }

  // —— 会话列表（agent 视角，群/私聊统一） ——

  /**
   * 会话列表（统一群/私聊）：群侧由注册表驱动，单聊侧由消息聚合自建。
   * 未读 = 已读水位之后的行数；无水位 = 全部算未读。
   */
  listConversations(
    botId: string,
  ): Array<{
    scope: MsgScope;
    scopeId: string;
    unread: number;
    last_ts: number | null;
  }> {
    const out: Array<{
      scope: MsgScope;
      scopeId: string;
      unread: number;
      last_ts: number | null;
    }> = [];
    for (const g of this.listGroups(botId)) {
      const gid = g.group_openid as string;
      const mark = this.getCursor(botId, gid);
      const row = this.unreadStmt.get(
        mark === null ? 0 : Number(mark),
        botId,
        "group",
        gid,
      ) as { unread: number; last_ts: number | null };
      out.push({
        scope: "group",
        scopeId: gid,
        unread: row.unread,
        last_ts: row.last_ts,
      });
    }
    const chats = this.listChatsStmt.all(botId) as Array<{
      user_openid: string;
      last_ts: number | null;
    }>;
    for (const c of chats) {
      const mark = this.getCursor(botId, `c2c:${c.user_openid}`);
      const row = this.unreadStmt.get(
        mark === null ? 0 : Number(mark),
        botId,
        "chat",
        c.user_openid,
      ) as { unread: number; last_ts: number | null };
      out.push({
        scope: "chat",
        scopeId: c.user_openid,
        unread: row.unread,
        last_ts: row.last_ts,
      });
    }
    return out;
  }

  // —— 读取五件套（群/私聊统一，scope 参数化） ——

  /** get_new 增量拉取：锚点后按 rowid 升序 */
  getMessagesAfter(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    afterRowid: number,
    limit: number,
  ): MsgRow[] {
    return this.afterStmt.all(
      botId,
      scope,
      scopeId,
      afterRowid,
      limit,
    ) as MsgRow[];
  }

  /** 锚点定位（browse/context/get_media/get_records 共用） */
  getMessageByMsgId(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    msgId: string,
  ): MsgRow | null {
    const row = this.byMsgIdStmt.get(botId, scope, scopeId, msgId) as
      MsgRow | undefined;
    return row ?? null;
  }

  /**
   * 会话侧别自动探测（读写工具的 type 参数退役后的裁决源）：
   * openid 是权威定位标识（群 openid 与用户 openid 命名空间互斥、不可能同值），
   * 按缓存归属即可唯一裁决。group 证据=群消息缓存或群注册表；
   * chat 证据=单聊消息缓存或 C2C 开关 kv 记录（开关事件可先行于首条缓存消息——
   * 用户已同意接收但尚无消息时仍可裁决，主动消息门禁亦依赖该记录）；null=两侧均无。
   */
  detectSessionKind(botId: string, id: string): "group" | "chat" | null {
    const inGroup =
      this.detectGroupMsgStmt.get(botId, id) !== undefined ||
      this.detectGroupRegStmt.get(botId, id) !== undefined;
    if (inGroup) return "group";
    const inChat =
      this.detectChatMsgStmt.get(botId, id) !== undefined ||
      this.getC2cSwitch(botId, id) !== null;
    return inChat ? "chat" : null;
  }

  /** 时间轴翻页：锚点(含同秒)以 rowid 决胜负，保证严格有序不重不漏 */
  browseBefore(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    ts: number,
    rowid: number,
    limit: number,
  ): MsgRow[] {
    return this.beforeTsStmt.all(
      botId,
      scope,
      scopeId,
      ts,
      ts,
      rowid,
      limit,
    ) as MsgRow[];
  }

  browseAfter(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    ts: number,
    rowid: number,
    limit: number,
  ): MsgRow[] {
    return this.afterTsStmt.all(
      botId,
      scope,
      scopeId,
      ts,
      ts,
      rowid,
      limit,
    ) as MsgRow[];
  }

  browseLatest(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    limit: number,
  ): MsgRow[] {
    return this.latestStmt.all(botId, scope, scopeId, limit) as MsgRow[];
  }

  /** WebUI 消息流翻页：beforeRid=null 取最新一页；返回按 rowid 升序（气泡渲染序） */
  messagesPageBefore(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    beforeRid: number | null,
    limit: number,
  ): MsgRow[] {
    const rows = this.pageBeforeStmt.all(
      botId,
      scope,
      scopeId,
      beforeRid,
      beforeRid ?? 0,
      limit,
    ) as MsgRow[];
    return rows.reverse();
  }

  /**
   * 关键词检索：≥3 字符走 FTS trigram（短语引号包裹防语法注入），否则 LIKE 子串扫描；
   * FTS 语法异常一律回退 LIKE。检索源=text 列（本条纯文本——被引原文/记录转写不污染命中）。
   */
  searchMessages(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    query: string,
    limit: number,
  ): MsgRow[] {
    const q = query.trim();
    if (q === "") return [];
    if ([...q].length >= 3) {
      try {
        const phrase = `"${q.replace(/"/g, '""')}"`;
        return this.ftsStmt.all(
          phrase,
          botId,
          scope,
          scopeId,
          limit,
        ) as MsgRow[];
      } catch {
        // FTS 语法问题 → LIKE 兜底
      }
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(
        `
        SELECT rowid AS rid, * FROM messages
        WHERE bot_id = ? AND scope = ? AND scope_id = ? AND text LIKE ? ESCAPE '\\'
        ORDER BY ts DESC, rowid DESC LIMIT ?
      `,
      )
      .all(botId, scope, scopeId, like, limit) as MsgRow[];
  }

  /** 某消息前后文：锚点前 radius 条 + 锚点后 radius 条，按时间轴升序返回 */
  contextMessages(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    anchor: MsgRow,
    radius: number,
  ): MsgRow[] {
    const before = this.browseBefore(
      botId,
      scope,
      scopeId,
      anchor.ts ?? 0,
      anchor.rid,
      radius,
    );
    const after = this.browseAfter(
      botId,
      scope,
      scopeId,
      anchor.ts ?? 0,
      anchor.rid,
      radius,
    );
    return [...before, anchor, ...after].sort(
      (a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.rid - b.rid,
    );
  }

  /** 聊天记录子消息（拍平行，按 ord 升序） */
  getRecords(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    msgId: string,
  ): RecordRow[] {
    return this.recordsStmt.all(botId, scope, scopeId, msgId) as RecordRow[];
  }

  /**
   * 记录子行引用解析：msg_idx 锚查缓存补被引身份（不回写子行）；body 同 quoteOf 截断。
   */
  resolveQuoteRef(
    botId: string,
    scope: MsgScope,
    scopeId: string,
    q: {
      msgIdx?: string;
      body?: string;
      authorOpenid?: string | null;
      msgId?: string | null;
    },
  ): QuoteMsgData {
    let authorOpenid = q.authorOpenid ?? null;
    let msgId = q.msgId ?? null;
    if (q.msgIdx !== undefined && authorOpenid === null) {
      const hit = this.msgIdxStmt.get(botId, scope, scopeId, q.msgIdx) as
        | {
            author_openid: string | null;
            msg_id: string;
            author_name: string | null;
          }
        | undefined;
      if (hit !== undefined) {
        authorOpenid = hit.author_openid;
        msgId = hit.msg_id;
      }
    }
    const first = (q.body ?? "").split("\n")[0] ?? "";
    const cps = Array.from(first);
    return {
      id: authorOpenid,
      msgId,
      body: cps.length > 50 ? `${cps.slice(0, 50).join("")}…` : first,
    };
  }

  // —— 已读水位（kv cursor:*） ——

  /**
   * 已读水位：某会话已被拉取到的 rowid 位置。语义 = "拉取即已读"：get_new 成功后由服务端
   * 自动推进，不暴露给 MCP 工具面。null = 从未拉取（全部消息算未读）。
   * 键延续历史：群 scope 为 groupOpenid，私聊为 `c2c:{userOpenid}`（保持存量水位连续性）。
   */
  getCursor(botId: string, key: string): string | null {
    const row = this.kvGetStmt.get(`cursor:${botId}:${key}`) as
      { v: string } | undefined;
    return row ? row.v : null;
  }

  /** 推进已读水位（服务端内部状态，get_new 专用；agent 不可见不可改） */
  setCursor(botId: string, key: string, cursor: string): void {
    this.kvSetStmt.run(`cursor:${botId}:${key}`, cursor);
  }

  // —— M6 合规退出：整群删除（唯一人工清理通道，仅 WebUI 触发） ——

  /**
   * 删除某群全部缓存：消息（FTS 触发器随行清理）、记录子消息、名册、注册表、已读水位。
   * sends 发送账本保留（运维审计）；users 身份**不删**（跨会话存续）。返回各类删除行数。
   * 原为 MCP 工具 forget，现仅经 WebUI（/ui/api DELETE /groups/:id，admin token + 人工确认）触发。
   */
  purgeGroupAll(
    botId: string,
    groupOpenid: string,
  ): { messages: number; members: number; groups: number; cursors: number } {
    const run = this.db.transaction(() => ({
      messages: this.db
        .prepare(
          "DELETE FROM messages WHERE bot_id = ? AND scope = 'group' AND scope_id = ?",
        )
        .run(botId, groupOpenid).changes,
      records: this.db
        .prepare(
          "DELETE FROM message_records WHERE bot_id = ? AND scope = 'group' AND scope_id = ?",
        )
        .run(botId, groupOpenid).changes,
      members: this.db
        .prepare("DELETE FROM members WHERE bot_id = ? AND group_openid = ?")
        .run(botId, groupOpenid).changes,
      groups: this.db
        .prepare("DELETE FROM groups WHERE bot_id = ? AND group_openid = ?")
        .run(botId, groupOpenid).changes,
      cursors: this.db
        .prepare("DELETE FROM kv WHERE k = ?")
        .run(`cursor:${botId}:${groupOpenid}`).changes,
    }));
    const r = run() as {
      messages: number;
      records: number;
      members: number;
      groups: number;
      cursors: number;
    };
    return {
      messages: r.messages,
      members: r.members,
      groups: r.groups,
      cursors: r.cursors,
    };
  }

  // —— 发送账本（sends 表）与主动额度（quota_daily 表） ——

  /** 幂等重放查询：同 回复目标+payload 且已受理（sent/pending_audit）的首次记录 */
  findSendReplay(
    botId: string,
    kind: string,
    replyMsgId: string,
    payloadHash: string,
  ): SendRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sends WHERE bot_id = ? AND kind = ? AND reply_msg_id = ? AND payload_hash = ?
         AND status IN ('sent', 'pending_audit') ORDER BY id ASC LIMIT 1`,
      )
      .get(botId, kind, replyMsgId, payloadHash) as SendRow | undefined;
    return row ?? null;
  }

  /** 被动窗口已用次数：除 failed（官方未受理）外的全部账本行 */
  countPassiveSends(botId: string, replyMsgId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sends WHERE bot_id = ? AND kind = 'passive' AND reply_msg_id = ? AND status != 'failed'",
      )
      .get(botId, replyMsgId) as { n: number };
    return row.n;
  }

  /** 下一个 msg_seq：账本内单调递增（含 failed 行，保证不复用官方可能已受理的序号） */
  nextMsgSeq(botId: string, replyMsgId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(msg_seq), 0) AS m FROM sends WHERE bot_id = ? AND kind = 'passive' AND reply_msg_id = ?",
      )
      .get(botId, replyMsgId) as { m: number };
    return row.m + 1;
  }

  /** 预订账本行（reservation 先行）：返回 rowid */
  insertSend(p: {
    bot_id: string;
    target_openid: string;
    kind: string;
    reply_msg_id: string | null;
    msg_seq: number | null;
    payload_hash: string | null;
    status: string;
  }): number {
    const info = this.insertSendStmt.run(
      p.bot_id,
      p.target_openid,
      p.kind,
      p.reply_msg_id,
      p.msg_seq,
      p.payload_hash,
      p.status,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  }

  updateSendStatus(
    id: number,
    status: string,
    providerMsgId?: string,
    errorCode?: number,
  ): void {
    this.updateSendStmt.run(
      status,
      providerMsgId ?? null,
      errorCode ?? null,
      id,
    );
  }

  /** 单群当日主动消息已发数（北京自然日，见 sender.beijingDate） */
  proactiveCountFor(botId: string, targetOpenid: string, date: string): number {
    const row = this.db
      .prepare(
        "SELECT proactive_count AS n FROM quota_daily WHERE bot_id = ? AND target_openid = ? AND date = ?",
      )
      .get(botId, targetOpenid, date) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** 当日额度记账 +1（无行则建） */
  incrQuotaDaily(botId: string, targetOpenid: string, date: string): void {
    this.incrQuotaStmt.run(botId, targetOpenid, date);
  }

  /** 当日主动消息已发总量（M4 写路径负责记账，此处只读水位） */
  proactiveSentToday(botId: string, dateStr: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(proactive_count), 0) AS n FROM quota_daily WHERE bot_id = ? AND date = ?",
      )
      .get(botId, dateStr) as { n: number };
    return row.n;
  }

  /** WebUI 发送记录：某 bot 对某会话的最近账本行（含审核回填状态，无消息内容） */
  recentSends(botId: string, targetOpenid: string, limit: number): SendRow[] {
    return this.db
      .prepare(
        `
        SELECT id, bot_id, target_openid, kind, reply_msg_id, msg_seq,
               payload_hash, provider_msg_id, status, error_code, created_at
        FROM sends WHERE bot_id = ? AND target_openid = ?
        ORDER BY id DESC LIMIT ?
      `,
      )
      .all(botId, targetOpenid, limit) as SendRow[];
  }

  /** MESSAGE_AUDIT 回填：定位该目标最早的 pending_audit 行，落到 pass/reject */
  applyAuditResult(
    botId: string,
    targetOpenid: string,
    status: "audit_pass" | "audit_reject",
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM sends WHERE bot_id = ? AND target_openid = ? AND status = 'pending_audit' ORDER BY id ASC LIMIT 1",
      )
      .get(botId, targetOpenid) as { id: number } | undefined;
    if (row === undefined) return false;
    this.updateSendStatus(row.id, status);
    return true;
  }

  // —— M8 运行时设置（kv）：bots 表归 BotRegistry 管，这里只管非 bot 维度设置 ——

  /** 发送总开关（kv settings:runtime:v1）。缺省=关闭（安全默认） */
  getSendEnable(): boolean {
    const row = this.kvGetStmt.get(SETTINGS_KEY) as { v: string } | undefined;
    if (row === undefined) return false;
    try {
      return (
        (JSON.parse(row.v) as { sendEnable?: boolean }).sendEnable === true
      );
    } catch {
      return false; // 坏数据按关闭处理（安全默认）
    }
  }

  setSendEnable(v: boolean): void {
    this.kvSetStmt.run(SETTINGS_KEY, JSON.stringify({ sendEnable: v }));
  }

  /**
   * M9 启动引导（幂等）：发送总开关缺省 false（硬约束4：写操作默认关）；
   * admin token 缺失时现场生成（48hex，与 agent_token 同规格），created=true 时
   * 调用方必须打印一次（仅此一次，之后只存 kv admin:token:v1）。
   */
  ensureRuntime(): { adminToken: string; adminCreated: boolean } {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO kv(k, v) VALUES (?, ?)",
    );
    insert.run(SETTINGS_KEY, JSON.stringify({ sendEnable: false }));
    const existing = this.kvGetStmt.get(ADMIN_TOKEN_KEY) as
      { v: string } | undefined;
    if (existing !== undefined) {
      return { adminToken: existing.v, adminCreated: false };
    }
    const token = newAdminToken();
    insert.run(ADMIN_TOKEN_KEY, token);
    return { adminToken: token, adminCreated: true };
  }

  /** admin token（kv admin:token:v1）：WebUI/设置页管理凭证。null=尚未播种 */
  getAdminToken(): string | null {
    const row = this.kvGetStmt.get(ADMIN_TOKEN_KEY) as
      { v: string } | undefined;
    return row?.v ?? null;
  }

  setAdminToken(v: string): void {
    this.kvSetStmt.run(ADMIN_TOKEN_KEY, v);
  }
}

const SETTINGS_KEY = "settings:runtime:v1";
const ADMIN_TOKEN_KEY = "admin:token:v1";
const TTS_CONFIG_KEY = "tts:config:v1";

function newAdminToken(): string {
  // 与 agent_token 同规格（48hex）；生成后仅存 kv，首次生成时打印一次
  return randomBytes(24).toString("hex");
}
