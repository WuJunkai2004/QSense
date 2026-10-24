// 缓存仓储：规范化产物的 SQLite 写入与查询原语（M3 工具面在此基础上组装）。
// 写路径全部幂等：messages 主键去重、roster upsert、开关状态幂等更新。

import type Database from 'better-sqlite3';
import type { DB } from './db';
import type { NormalizedMessage } from '../normalize/types';

/** 语句的匿名绑定参数元组类型（better-sqlite3 prepare 泛型默认值会退化为单元素元组，需显式声明） */
type Stmt<P extends unknown[] = unknown[]> = Database.Statement<P>;

export class Repo {
  private readonly insertGroupMsg: Stmt<[Record<string, unknown>]>;
  private readonly insertC2cMsg: Stmt<[Record<string, unknown>]>;
  private readonly upsertGroupStmt: Stmt<[Record<string, unknown>]>;
  private readonly ensureGroupStmt: Stmt<[Record<string, unknown>]>;
  private readonly setGroupSwitchStmt: Stmt<[Record<string, unknown>]>;
  private readonly deleteGroupStmt: Stmt<[string, string]>;
  private readonly upsertMemberStmt: Stmt<[Record<string, unknown>]>;
  private readonly kvGetStmt: Stmt<[string]>;
  private readonly kvSetStmt: Stmt<[string, string]>;
  private readonly purgeGroupStmt: Stmt<[number]>;
  private readonly purgeC2cStmt: Stmt<[number]>;

  constructor(private readonly db: DB) {
    this.insertGroupMsg = db.prepare(`
      INSERT OR IGNORE INTO messages(
        bot_id, group_openid, msg_id, author_openid, author_name, author_role,
        ts, content, mentions_json, elements_json, attachments_json, ark_json, raw_json
      ) VALUES (
        @bot_id, @group_openid, @msg_id, @author_openid, @author_name, @author_role,
        @ts, @content, @mentions_json, @elements_json, @attachments_json, @ark_json, @raw_json
      )
    `);
    this.insertC2cMsg = db.prepare(`
      INSERT OR IGNORE INTO c2c_messages(
        bot_id, user_openid, msg_id, author_openid, author_name, author_role,
        ts, content, mentions_json, elements_json, attachments_json, ark_json, raw_json
      ) VALUES (
        @bot_id, @user_openid, @msg_id, @author_openid, @author_name, @author_role,
        @ts, @content, @mentions_json, @elements_json, @attachments_json, @ark_json, @raw_json
      )
    `);
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
      'DELETE FROM groups WHERE bot_id = ? AND group_openid = ?',
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
    this.kvGetStmt = db.prepare('SELECT v FROM kv WHERE k = ?');
    this.kvSetStmt = db.prepare(
      'INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    );
    this.purgeGroupStmt = db.prepare('DELETE FROM messages WHERE ts < ?');
    this.purgeC2cStmt = db.prepare('DELETE FROM c2c_messages WHERE ts < ?');
  }

  /** 群消息入库；返回 false = msg_id 重复（官方重推），幂等忽略 */
  saveGroupMessage(m: NormalizedMessage): boolean {
    const run = this.db.transaction(() => {
      const info = this.insertGroupMsg.run(messageParams(m, 'group_openid', m.scopeId));
      if (m.authorOpenid !== '') {
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
    const info = this.insertC2cMsg.run(messageParams(m, 'user_openid', m.scopeId));
    return info.changes > 0;
  }

  /** GROUP_ADD_ROBOT：注册表新增（full_msg_enabled=0 未确认，等 RECEIVE/REJECT 事件修正） */
  addGroup(botId: string, groupOpenid: string): void {
    this.upsertGroupStmt.run({ bot_id: botId, group_openid: groupOpenid, full_msg_enabled: 0, now: Date.now() });
  }

  /**
   * 群保底在册（INSERT OR IGNORE，已存在不覆盖开关状态）：
   * fullMsgEnabled=null 表示开关未知，仅在新建行时落 0。
   */
  ensureGroup(botId: string, groupOpenid: string, fullMsgEnabled: 0 | 1 | null): void {
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
    this.kvSetStmt.run(`c2c:switch:${botId}:${userOpenid}`, enabled ? '1' : '0');
  }

  getC2cSwitch(botId: string, userOpenid: string): boolean | null {
    const row = this.kvGetStmt.get(`c2c:switch:${botId}:${userOpenid}`) as { v: string } | undefined;
    if (!row) return null;
    return row.v === '1';
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
}

function messageParams(
  m: NormalizedMessage,
  scopeKey: 'group_openid' | 'user_openid',
  scopeId: string,
): Record<string, unknown> {
  return {
    bot_id: m.botId,
    [scopeKey]: scopeId,
    msg_id: m.msgId,
    author_openid: m.authorOpenid !== '' ? m.authorOpenid : null,
    author_name: m.authorName ?? null,
    author_role: m.authorRole ?? null,
    ts: m.ts,
    content: m.content,
    mentions_json: m.mentions.length > 0 ? JSON.stringify(m.mentions) : null,
    elements_json: m.elements !== undefined ? JSON.stringify(m.elements) : null,
    attachments_json: m.attachments.length > 0 ? JSON.stringify(m.attachments) : null,
    ark_json: m.ark !== undefined ? JSON.stringify(m.ark) : null,
    raw_json: JSON.stringify(m.raw),
  };
}
