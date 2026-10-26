// 缓存仓储：规范化产物的 SQLite 写入与查询原语（M3 工具面在此基础上组装）。
// 写路径全部幂等：messages 主键去重、roster upsert、开关状态幂等更新。

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { DB } from "./db";
import type { NormalizedMessage } from "../normalize/types";

/** 语句的匿名绑定参数元组类型（better-sqlite3 prepare 泛型默认值会退化为单元素元组，需显式声明） */
type Stmt<P extends unknown[] = unknown[]> = Database.Statement<P>;

/** 消息查询行：rid = rowid（插入序，作增量游标） */
export interface MsgRow {
  rid: number;
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
  elements_json: string | null;
  attachments_json: string | null;
  ark_json: string | null;
  raw_json: string | null;
  [k: string]: unknown;
}

/** 发送账本行（sends 表）：status = reserved|sent|failed|pending_audit|audit_pass|audit_reject */
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
  created_at: number | null;
  [k: string]: unknown;
}

export class Repo {
  private readonly insertGroupMsg: Stmt<[Record<string, unknown>]>;
  private readonly insertC2cMsg: Stmt<[Record<string, unknown>]>;
  /** 引用回溯：msg_idx 令牌 → 被引消息行（resolveQuotes 专用） */
  private readonly msgIdxStmt: Stmt<[string, string, string]>;
  private readonly upsertGroupStmt: Stmt<[Record<string, unknown>]>;
  private readonly ensureGroupStmt: Stmt<[Record<string, unknown>]>;
  private readonly setGroupSwitchStmt: Stmt<[Record<string, unknown>]>;
  private readonly deleteGroupStmt: Stmt<[string, string]>;
  private readonly upsertMemberStmt: Stmt<[Record<string, unknown>]>;
  private readonly kvGetStmt: Stmt<[string]>;
  private readonly kvSetStmt: Stmt<[string, string]>;
  private readonly purgeGroupStmt: Stmt<[number]>;
  private readonly purgeC2cStmt: Stmt<[number]>;
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
    this.insertGroupMsg = db.prepare(`
      INSERT OR IGNORE INTO messages(
        bot_id, group_openid, msg_id, author_openid, author_name, author_role,
        ts, content, mentions_json, elements_json, attachments_json, ark_json, raw_json,
        direction, msg_idx
      ) VALUES (
        @bot_id, @group_openid, @msg_id, @author_openid, @author_name, @author_role,
        @ts, @content, @mentions_json, @elements_json, @attachments_json, @ark_json, @raw_json,
        @direction, @msg_idx
      )
    `);
    this.insertC2cMsg = db.prepare(`
      INSERT OR IGNORE INTO c2c_messages(
        bot_id, user_openid, msg_id, author_openid, author_name, author_role,
        ts, content, mentions_json, elements_json, attachments_json, ark_json, raw_json,
        direction, msg_idx
      ) VALUES (
        @bot_id, @user_openid, @msg_id, @author_openid, @author_name, @author_role,
        @ts, @content, @mentions_json, @elements_json, @attachments_json, @ark_json, @raw_json,
        @direction, @msg_idx
      )
    `);
    this.msgIdxStmt = db.prepare(
      "SELECT author_name, content AS body FROM messages WHERE bot_id = ? AND group_openid = ? AND msg_idx = ? ORDER BY rowid DESC LIMIT 1",
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
    this.upsertMemberStmt = db.prepare(`
      INSERT INTO members(bot_id, group_openid, member_openid, username, member_role, first_seen, last_seen, msg_count)
      VALUES (@bot_id, @group_openid, @member_openid, @username, @member_role, @now, @now, 1)
      ON CONFLICT(bot_id, group_openid, member_openid) DO UPDATE SET
        username = COALESCE(excluded.username, members.username),
        member_role = COALESCE(excluded.member_role, members.member_role),
        last_seen = excluded.last_seen,
        msg_count = members.msg_count + 1
    `);
    this.kvGetStmt = db.prepare("SELECT v FROM kv WHERE k = ?");
    this.kvSetStmt = db.prepare(
      "INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
    this.purgeGroupStmt = db.prepare("DELETE FROM messages WHERE ts < ?");
    this.purgeC2cStmt = db.prepare("DELETE FROM c2c_messages WHERE ts < ?");
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

  /** 群消息入库；返回 false = msg_id 重复（官方重推），幂等忽略 */
  saveGroupMessage(m: NormalizedMessage): boolean {
    const run = this.db.transaction(() => {
      const info = this.insertGroupMsg.run(
        messageParams(m, "group_openid", m.scopeId),
      );
      if (m.authorOpenid !== "") {
        this.upsertMemberStmt.run({
          bot_id: m.botId,
          group_openid: m.scopeId,
          member_openid: m.authorOpenid,
          username: m.authorName ?? null,
          member_role: m.authorRole ?? null,
          now: Date.now(),
        });
      }
      return info.changes > 0;
    });
    return run() as boolean;
  }

  /** 单聊消息入库（无名册表，单聊无群成员概念） */
  saveC2cMessage(m: NormalizedMessage): boolean {
    const info = this.insertC2cMsg.run(
      messageParams(m, "user_openid", m.scopeId),
    );
    return info.changes > 0;
  }

  /**
   * 本机外发消息补记（官方不回推 bot 自发消息，发送成功后调用）。
   * 与接收共用 messages 表；不写成员名册（作者是自己）。msg_id 重复=幂等重放，静默忽略。
   */
  saveOutgoingGroupMessage(p: {
    botId: string;
    groupOpenid: string;
    msgId: string;
    content: string;
    ts: number;
    authorName: string | null;
  }): boolean {
    const info = this.insertGroupMsg.run({
      bot_id: p.botId,
      group_openid: p.groupOpenid,
      msg_id: p.msgId,
      author_openid: null,
      author_name: p.authorName,
      author_role: null,
      ts: p.ts,
      content: p.content,
      mentions_json: null,
      elements_json: null,
      attachments_json: null,
      ark_json: null,
      raw_json: null,
      direction: 1,
      msg_idx: null,
    });
    return info.changes > 0;
  }

  /** GROUP_ADD_ROBOT：注册表新增（full_msg_enabled=0 未确认，等 RECEIVE/REJECT 事件修正） */
  addGroup(botId: string, groupOpenid: string): void {
    this.upsertGroupStmt.run({
      bot_id: botId,
      group_openid: groupOpenid,
      full_msg_enabled: 0,
      now: Date.now(),
    });
  }

  /**
   * 群保底在册（INSERT OR IGNORE，已存在不覆盖开关状态）：
   * fullMsgEnabled=null 表示开关未知，仅在新建行时落 0。
   */
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

  /** 保留策略：清理早于 keepDays 天的缓存消息（raw_json 随行删除） */
  purgeOldMessages(keepDays: number): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const run = this.db.transaction(() => {
      const a = this.purgeGroupStmt.run(cutoff).changes;
      const b = this.purgeC2cStmt.run(cutoff).changes;
      return a + b;
    });
    return run() as number;
  }

  // —— M3 只读查询（群聊为主；单聊查询 M3.5 按需加） ——

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

  /** WebUI 会话列表：群 + 成员数 + 最后一条消息摘要（rowid 最大者） */
  listGroupsWithLast(botId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `
        SELECT g.group_openid, g.full_msg_enabled, g.added_at, g.updated_at,
               (SELECT COUNT(*) FROM members m WHERE m.bot_id = g.bot_id AND m.group_openid = g.group_openid) AS member_count,
               lm.ts AS last_ts, lm.content AS last_content, lm.author_name AS last_author
        FROM groups g
        LEFT JOIN messages lm ON lm.rowid = (
          SELECT MAX(x.rowid) FROM messages x WHERE x.bot_id = g.bot_id AND x.group_openid = g.group_openid
        )
        WHERE g.bot_id = ?
        ORDER BY COALESCE(lm.ts, g.updated_at, g.added_at) DESC
      `,
      )
      .all(botId) as Array<Record<string, unknown>>;
  }

  /**
   * 群会话列表（agent 视角）：openid + 最后消息时间 + 未读数。
   * 未读 = 已读水位（kv cursor:*）之后的行数；无水位 = 全部算未读。
   */
  listGroupConversations(
    botId: string,
  ): Array<{ group_openid: string; unread: number; last_ts: number | null }> {
    const unreadStmt = this.db.prepare(
      "SELECT COALESCE(SUM(rowid > ?), 0) AS unread, MAX(ts) AS last_ts FROM messages WHERE bot_id = ? AND group_openid = ?",
    );
    return this.listGroups(botId).map((g) => {
      const gid = g.group_openid as string;
      const mark = this.getCursor(botId, gid);
      const row = unreadStmt.get(
        mark === null ? 0 : Number(mark),
        botId,
        gid,
      ) as { unread: number; last_ts: number | null };
      return { group_openid: gid, unread: row.unread, last_ts: row.last_ts };
    });
  }

  /** 私聊会话列表（自建于 c2c_messages 聚合；当前 bot 无单聊事件，恒为空） */
  listChatConversations(
    botId: string,
  ): Array<{ user_openid: string; unread: number; last_ts: number | null }> {
    const rows = this.db
      .prepare(
        "SELECT user_openid, MAX(ts) AS last_ts FROM c2c_messages WHERE bot_id = ? GROUP BY user_openid",
      )
      .all(botId) as Array<{ user_openid: string; last_ts: number | null }>;
    const unreadStmt = this.db.prepare(
      "SELECT COALESCE(SUM(rowid > ?), 0) AS unread FROM c2c_messages WHERE bot_id = ? AND user_openid = ?",
    );
    return rows.map((r) => {
      const mark = this.getCursor(botId, `c2c:${r.user_openid}`);
      const unread = (
        unreadStmt.get(
          mark === null ? 0 : Number(mark),
          botId,
          r.user_openid,
        ) as { unread: number }
      ).unread;
      return { user_openid: r.user_openid, unread, last_ts: r.last_ts };
    });
  }

  listMembers(
    botId: string,
    groupOpenid: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `
        SELECT member_openid, username, member_role, first_seen, last_seen, msg_count
        FROM members WHERE bot_id = ? AND group_openid = ?
        ORDER BY msg_count DESC, last_seen DESC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, limit) as Array<Record<string, unknown>>;
  }

  getMessagesAfter(
    botId: string,
    groupOpenid: string,
    afterRowid: number,
    limit: number,
  ): MsgRow[] {
    return this.db
      .prepare(
        `
        SELECT rowid AS rid, * FROM messages
        WHERE bot_id = ? AND group_openid = ? AND rowid > ?
        ORDER BY rowid ASC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, afterRowid, limit) as MsgRow[];
  }

  getMessageByMsgId(
    botId: string,
    groupOpenid: string,
    msgId: string,
  ): MsgRow | null {
    const row = this.db
      .prepare(
        "SELECT rowid AS rid, * FROM messages WHERE bot_id = ? AND group_openid = ? AND msg_id = ?",
      )
      .get(botId, groupOpenid, msgId) as MsgRow | undefined;
    return row ?? null;
  }

  /**
   * 引用解析（读取时）：content 里的 `[引用 msg_idx=X]` 令牌行按 X 查缓存——官方在每条消息的
   * message_scene.ext 携带 msg_idx，引用元素（103）以此为锚指向被引消息。命中则内联被引作者与
   * 正文（行加 "> " 前缀）；未命中（未缓存/已过保留期/历史行无令牌）原样保留。
   * ingest 时 103 元素会把被引原文展开成紧跟结构行的文本行（FTS 检索面不丢内容）——命中时该行
   * 与内联正文重复，逐行比对一致才吞掉（防误删用户恰好相同的正文）。MCP 与 WebUI 序列化共用。
   */
  resolveQuotes(
    botId: string,
    groupOpenid: string,
    content: string | null,
  ): string {
    const text = content ?? "";
    if (!text.includes("[引用 msg_idx=")) return text;
    const lines = text.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const m = line.match(/^\s*\[引用 msg_idx=([^\]]+)\]\s*$/);
      if (m === null) {
        out.push(line);
        continue;
      }
      const row = this.msgIdxStmt.get(botId, groupOpenid, m[1]!) as
        | { author_name: string | null; body: string | null }
        | undefined;
      if (row === undefined) {
        out.push(line);
        continue;
      }
      const body = (row.body ?? "").trim();
      const bodyLines = body === "" ? [] : body.split("\n");
      // 吞掉紧跟的 ingest 展开行：与被引正文逐行一致才消费
      let j = i + 1;
      for (const bl of bodyLines) {
        if (lines[j] !== undefined && lines[j]!.trim() === bl.trim()) j += 1;
        else break;
      }
      out.push(`[引用 @${row.author_name ?? "未知成员"}]`);
      for (const bl of bodyLines) out.push(`> ${bl}`);
      i = j - 1;
    }
    return out.join("\n");
  }

  /** 时间轴翻页：锚点(含同秒)以 rowid 决胜负，保证严格有序不重不漏 */
  browseBefore(
    botId: string,
    groupOpenid: string,
    ts: number,
    rowid: number,
    limit: number,
  ): MsgRow[] {
    return this.db
      .prepare(
        `
        SELECT rowid AS rid, * FROM messages
        WHERE bot_id = ? AND group_openid = ? AND (ts < ? OR (ts = ? AND rowid < ?))
        ORDER BY ts DESC, rowid DESC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, ts, ts, rowid, limit) as MsgRow[];
  }

  browseAfter(
    botId: string,
    groupOpenid: string,
    ts: number,
    rowid: number,
    limit: number,
  ): MsgRow[] {
    return this.db
      .prepare(
        `
        SELECT rowid AS rid, * FROM messages
        WHERE bot_id = ? AND group_openid = ? AND (ts > ? OR (ts = ? AND rowid > ?))
        ORDER BY ts ASC, rowid ASC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, ts, ts, rowid, limit) as MsgRow[];
  }

  browseLatest(botId: string, groupOpenid: string, limit: number): MsgRow[] {
    return this.db
      .prepare(
        `
        SELECT rowid AS rid, * FROM messages
        WHERE bot_id = ? AND group_openid = ?
        ORDER BY ts DESC, rowid DESC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, limit) as MsgRow[];
  }

  /** WebUI 消息流翻页：beforeRid=null 取最新一页；返回按 rowid 升序（气泡渲染序） */
  messagesPageBefore(
    botId: string,
    groupOpenid: string,
    beforeRid: number | null,
    limit: number,
  ): MsgRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT rowid AS rid, * FROM messages
        WHERE bot_id = ? AND group_openid = ? AND (? IS NULL OR rowid < ?)
        ORDER BY rowid DESC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, beforeRid, beforeRid ?? 0, limit) as MsgRow[];
    return rows.reverse();
  }

  /**
   * 关键词检索：≥3 字符走 FTS trigram（短语引号包裹防语法注入），否则 LIKE 子串扫描；
   * FTS 语法异常一律回退 LIKE。
   */
  searchMessages(
    botId: string,
    groupOpenid: string,
    query: string,
    limit: number,
  ): MsgRow[] {
    const q = query.trim();
    if (q === "") return [];
    if ([...q].length >= 3) {
      try {
        const phrase = `"${q.replace(/"/g, '""')}"`;
        return this.db
          .prepare(
            `
            SELECT m.rowid AS rid, m.* FROM messages_fts f
            JOIN messages m ON m.rowid = f.rowid
            WHERE messages_fts MATCH ? AND m.bot_id = ? AND m.group_openid = ?
            ORDER BY m.ts DESC, m.rowid DESC LIMIT ?
          `,
          )
          .all(phrase, botId, groupOpenid, limit) as MsgRow[];
      } catch {
        // FTS 语法问题 → LIKE 兜底
      }
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(
        `
        SELECT rowid AS rid, * FROM messages
        WHERE bot_id = ? AND group_openid = ? AND content LIKE ? ESCAPE '\\'
        ORDER BY ts DESC, rowid DESC LIMIT ?
      `,
      )
      .all(botId, groupOpenid, like, limit) as MsgRow[];
  }

  /** 某消息前后文：锚点前 radius 条 + 锚点后 radius 条，按时间轴升序返回 */
  contextMessages(
    botId: string,
    groupOpenid: string,
    anchor: MsgRow,
    radius: number,
  ): MsgRow[] {
    const before = this.browseBefore(
      botId,
      groupOpenid,
      anchor.ts ?? 0,
      anchor.rid,
      radius,
    );
    const after = this.browseAfter(
      botId,
      groupOpenid,
      anchor.ts ?? 0,
      anchor.rid,
      radius,
    );
    return [...before, anchor, ...after].sort(
      (a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.rid - b.rid,
    );
  }

  /**
   * 已读水位（kv cursor:*）：某会话已被拉取到的 rowid 位置。
   * 语义 = "拉取即已读"：get_new 成功后由服务端自动推进，不暴露给 MCP 工具面。
   * null = 从未拉取（全部消息算未读）。群 scope 为 groupOpenid，私聊为 `c2c:{userOpenid}`。
   */
  getCursor(botId: string, groupOpenid: string): string | null {
    const row = this.kvGetStmt.get(`cursor:${botId}:${groupOpenid}`) as
      { v: string } | undefined;
    return row ? row.v : null;
  }

  /** 推进已读水位（服务端内部状态，get_new 专用；agent 不可见不可改） */
  setCursor(botId: string, groupOpenid: string, cursor: string): void {
    this.kvSetStmt.run(`cursor:${botId}:${groupOpenid}`, cursor);
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

  /** WebUI 发送记录：某 bot 对某群的最近账本行（含审核回填状态，无消息内容） */
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

  // —— M4 发送账本（sends 表）与主动额度（quota_daily 表） ——

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

  /** MESSAGE_AUDIT 回填：定位该群最早的 pending_audit 行，落到 pass/reject */
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

  // —— M6 合规退出：forget ——

  /**
   * 删除某群全部缓存：消息（FTS 触发器随行清理）、名册、注册表、已读水位。
   * sends 发送账本保留（运维审计；不含消息内容）。返回各类删除行数。
   * 原为 MCP 工具 forget，现仅经 WebUI（/ui/api DELETE /groups/:id，admin token + 人工确认）触发。
   */
  purgeGroupAll(
    botId: string,
    groupOpenid: string,
  ): { messages: number; members: number; groups: number; cursors: number } {
    const run = this.db.transaction(() => ({
      messages: this.db
        .prepare("DELETE FROM messages WHERE bot_id = ? AND group_openid = ?")
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
    return run() as {
      messages: number;
      members: number;
      groups: number;
      cursors: number;
    };
  }

  // —— M8 运行时设置（kv）：bots 表归 BotRegistry 管，这里只管非 bot 维度设置 ——

  /** 发送总开关（kv settings:runtime:v1）。缺省=关闭（安全默认），.env SEND_ENABLE 仅作首次播种 */
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
   * env 的 SEND_ENABLE / MCP_TOKEN 播种通道已退役——一切以库为准。
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

function newAdminToken(): string {
  // 与 agent_token 同规格（48hex）；生成后仅存 kv，首次生成时打印一次
  return randomBytes(24).toString("hex");
}

function messageParams(
  m: NormalizedMessage,
  scopeKey: "group_openid" | "user_openid",
  scopeId: string,
): Record<string, unknown> {
  return {
    bot_id: m.botId,
    [scopeKey]: scopeId,
    msg_id: m.msgId,
    author_openid: m.authorOpenid !== "" ? m.authorOpenid : null,
    author_name: m.authorName ?? null,
    author_role: m.authorRole ?? null,
    ts: m.ts,
    content: m.content,
    mentions_json: m.mentions.length > 0 ? JSON.stringify(m.mentions) : null,
    elements_json: m.elements !== undefined ? JSON.stringify(m.elements) : null,
    attachments_json:
      m.attachments.length > 0 ? JSON.stringify(m.attachments) : null,
    ark_json: m.ark !== undefined ? JSON.stringify(m.ark) : null,
    raw_json: JSON.stringify(m.raw),
    direction: m.direction ?? 0,
    msg_idx: m.msgIdx ?? null,
  };
}
