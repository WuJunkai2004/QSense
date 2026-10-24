// M2 验收：事件规范化 + 缓存 + 名册 + 开关状态（灌官方样例形状 + 自造合并转发/语音/卡片事件，SQL 查回断言）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandElements } from '../src/normalize/expand';
import { normalizeMessage } from '../src/normalize';
import { handleGatewayEvent } from '../src/normalize/handler';
import type { RawEvent } from '../src/gateway';
import { openDatabase, runMigrations, type DB } from '../src/store/db';
import { migrations } from '../src/store/migrations';
import { Repo } from '../src/store/repo';

function setupDb(): { dir: string; db: DB; repo: Repo } {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-m2-test-'));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  return { dir, db, repo: new Repo(db) };
}

function cleanup(dir: string, db: DB): void {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows 句柄延迟，best-effort */
  }
}

const ev = (type: string, data: unknown, botId = '10001'): RawEvent => ({ botId, type, data });

/** 官方 GROUP_MESSAGE_CREATE 事件形状（依据 API-FACTS.md #2 字段表） */
const groupMsgShape = {
  id: 'MSGID_1',
  author: {
    id: 'author-openid-union',
    user_openid: '',
    member_openid: 'MEMBER_OPENID_A',
    username: '小明',
    bot: false,
    member_role: 'member',
  },
  content: '今晚一起<@MEMBER_OPENID_B>开会吗',
  group_openid: 'GROUP_OPENID_G1',
  timestamp: '2026-10-24T20:00:00+08:00',
  mentions: [{ id: 'MEMBER_OPENID_B', username: '小红' }],
  attachments: [],
};

test('M2-1 msg_elements 递归展开：文本/卡片/并行/合并转发多层/引用', () => {
  const tree = [
    { message_type: 0, content: '看这个' },
    { message_type: 103, msg_idx: '3', children: [{ message_type: 0, content: '被引用的原文' }] },
    // 官方真机形状（2026-10-24）：引用原文在本元素 content 字段，children 为空
    { message_type: 103, msg_idx: 'REFIDX_x', content: '这是被引用的那条消息' },
    {
      message_type: 102,
      title: '群的聊天记录',
      children: [
        { message_type: 0, content: '转发里的第一条' },
        {
          message_type: 102,
          title: '嵌套记录',
          children: [{ message_type: 0, content: '二层转发' }],
        },
      ],
    },
    { message_type: 101, children: [{ message_type: 0, content: '并行分支' }] },
    { message_type: 3, title: '投票卡片' },
    { message_type: 999, content: '未知类型兜底文本' },
  ];
  const lines = expandElements(tree);
  const text = lines.join('\n');
  assert.ok(text.includes('看这个'));
  assert.ok(text.includes('[引用 msg_idx=3]'));
  assert.ok(text.includes('被引用的原文'));
  assert.ok(text.includes('这是被引用的那条消息'), '官方真机形状：引用原文取自元素 content 字段');
  assert.ok(text.includes('[群的聊天记录]'));
  assert.ok(text.includes('转发里的第一条'));
  assert.ok(text.includes('[嵌套记录]'));
  assert.ok(text.includes('二层转发'));
  assert.ok(text.includes('[并行消息]'));
  assert.ok(text.includes('并行分支'));
  assert.ok(text.includes('[卡片] 投票卡片'));
  assert.ok(text.includes('未知类型兜底文本'));
  // 缩进体现层级：二层转发比一层深
  const nestedIdx = text.indexOf('二层转发');
  const firstIdx = text.indexOf('转发里的第一条');
  assert.ok(nestedIdx > firstIdx);
});

test('M2-2 迁移 v2/v3：业务表齐全，FTS 触发器同步可检索', () => {
  const { dir, db, repo } = setupDb();
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of ['groups', 'members', 'messages', 'c2c_messages', 'sends', 'quota_daily', 'kv']) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
    // FTS：插入 → trigram 检索中文子串命中
    repo.saveGroupMessage({
      botId: 'b',
      scope: 'group',
      scopeId: 'g',
      msgId: 'm1',
      authorOpenid: 'u1',
      ts: Date.now(),
      content: '今晚一起开会讨论项目排期',
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    });
    const hits = db
      .prepare("SELECT msg_id FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '开会讨论')")
      .all() as Array<{ msg_id: string }>;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].msg_id, 'm1');
  } finally {
    cleanup(dir, db);
  }
});

test('M2-3 官方形状群消息：规范化入库、SQL 查回结构化、msg_id 幂等', () => {
  const { dir, db, repo } = setupDb();
  try {
    const m = normalizeMessage(ev('GROUP_MESSAGE_CREATE', groupMsgShape));
    assert.ok(m !== null);
    assert.equal(m!.scope, 'group');
    assert.equal(m!.scopeId, 'GROUP_OPENID_G1');
    assert.equal(m!.msgId, 'MSGID_1');
    assert.equal(m!.authorOpenid, 'MEMBER_OPENID_A');
    assert.equal(m!.authorName, '小明');
    assert.equal(m!.authorRole, 'member');
    assert.equal(m!.ts, Date.parse('2026-10-24T20:00:00+08:00'));
    assert.deepEqual(m!.mentions, [{ id: 'MEMBER_OPENID_B', name: '小红' }]);

    assert.equal(repo.saveGroupMessage(m!), true, '首次入库成功');
    assert.equal(repo.saveGroupMessage(m!), false, '重复 msg_id 幂等拒绝');

    const row = db
      .prepare("SELECT * FROM messages WHERE bot_id='10001' AND group_openid='GROUP_OPENID_G1' AND msg_id='MSGID_1'")
      .get() as Record<string, unknown>;
    assert.equal(row.author_openid, 'MEMBER_OPENID_A');
    assert.equal(row.content, '今晚一起<@MEMBER_OPENID_B>开会吗');
    assert.deepEqual(JSON.parse(row.mentions_json as string), [{ id: 'MEMBER_OPENID_B', name: '小红' }]);
    assert.equal(row.ts, Date.parse('2026-10-24T20:00:00+08:00'));
    assert.equal(JSON.parse(row.raw_json as string).group_openid, 'GROUP_OPENID_G1');
  } finally {
    cleanup(dir, db);
  }
});

test('M2-4 语音附件元数据保留（voice_wav_url + asr_refer_text）', () => {
  const { dir, db, repo } = setupDb();
  try {
    const m = normalizeMessage(
      ev('GROUP_MESSAGE_CREATE', {
        ...groupMsgShape,
        id: 'MSGID_VOICE',
        content: '',
        attachments: [
          {
            url: 'https://multimedia.qq.com/voice/x.silk',
            filename: 'voice.silk',
            content_type: 'voice',
            voice_wav_url: 'https://multimedia.qq.com/voice/x.wav',
            asr_refer_text: '明天下午三点开会',
          },
        ],
      }),
    );
    assert.ok(m !== null);
    assert.equal(m!.attachments.length, 1);
    assert.equal(m!.attachments[0].voice_wav_url, 'https://multimedia.qq.com/voice/x.wav');
    assert.equal(m!.attachments[0].asr_refer_text, '明天下午三点开会');
    repo.saveGroupMessage(m!);
    const row = db.prepare("SELECT attachments_json FROM messages WHERE msg_id='MSGID_VOICE'").get() as {
      attachments_json: string;
    };
    const saved = JSON.parse(row.attachments_json) as Array<{ asr_refer_text?: string }>;
    assert.equal(saved[0].asr_refer_text, '明天下午三点开会');
  } finally {
    cleanup(dir, db);
  }
});

test('M2-5 成员名册 upsert：同人两条消息 msg_count=2，昵称/角色随消息更新', () => {
  const { dir, db, repo } = setupDb();
  try {
    handleGatewayEvent(repo, ev('GROUP_MESSAGE_CREATE', groupMsgShape));
    handleGatewayEvent(
      repo,
      ev('GROUP_MESSAGE_CREATE', {
        ...groupMsgShape,
        id: 'MSGID_2',
        author: { ...groupMsgShape.author, username: '明明', member_role: 'admin' },
      }),
    );
    const row = db
      .prepare("SELECT * FROM members WHERE bot_id='10001' AND group_openid='GROUP_OPENID_G1' AND member_openid='MEMBER_OPENID_A'")
      .get() as Record<string, unknown>;
    assert.equal(row.msg_count, 2);
    assert.equal(row.username, '明明');
    assert.equal(row.member_role, 'admin');
    assert.ok(Number(row.first_seen) <= Number(row.last_seen));
  } finally {
    cleanup(dir, db);
  }
});

test('M2-6 群注册表生命周期：ADD(0) → 全量消息(1) → REJECT(0) → DEL_ROBOT(移除)', () => {
  const { dir, db, repo } = setupDb();
  try {
    const flag = (): number | undefined =>
      (db.prepare("SELECT full_msg_enabled AS f FROM groups WHERE bot_id='10001' AND group_openid='G1'").get() as { f: number } | undefined)?.f;

    handleGatewayEvent(repo, ev('GROUP_ADD_ROBOT', { group_openid: 'G1' }));
    assert.equal(flag(), 0, 'ADD 时开关未确认=0');

    handleGatewayEvent(repo, ev('GROUP_MSG_RECEIVE', { group_openid: 'G1' }));
    assert.equal(flag(), 1, '群主开启全量');

    handleGatewayEvent(repo, ev('GROUP_MSG_REJECT', { group_openid: 'G1' }));
    assert.equal(flag(), 0, '群主关闭全量');

    // 未开全量的群来 @ 消息：ensureGroup 不改开关
    handleGatewayEvent(
      repo,
      ev('GROUP_AT_MESSAGE_CREATE', { id: 'AT1', group_openid: 'G1', content: '@bot 在吗', author: { member_openid: 'U1' } }),
    );
    assert.equal(flag(), 0, '@消息不篡改开关');

    handleGatewayEvent(repo, ev('GROUP_DEL_ROBOT', { group_openid: 'G1' }));
    assert.equal(flag(), undefined, 'DEL_ROBOT 后注册表移除');
  } finally {
    cleanup(dir, db);
  }
});

test('M2-7 C2C 单聊入库 + 用户级主动消息开关（kv）', () => {
  const { dir, db, repo } = setupDb();
  try {
    handleGatewayEvent(
      repo,
      ev('C2C_MESSAGE_CREATE', {
        id: 'C1',
        user_openid: 'C2C_OPENID_U1',
        content: '私聊你好',
        timestamp: '2026-10-24T21:00:00+08:00',
        author: { user_openid: 'C2C_OPENID_U1' },
      }),
    );
    const row = db
      .prepare("SELECT content FROM c2c_messages WHERE bot_id='10001' AND user_openid='C2C_OPENID_U1' AND msg_id='C1'")
      .get() as { content: string };
    assert.equal(row.content, '私聊你好');

    assert.equal(repo.getC2cSwitch('10001', 'C2C_OPENID_U1'), null);
    handleGatewayEvent(repo, ev('C2C_MSG_REJECT', { user_openid: 'C2C_OPENID_U1' }));
    assert.equal(repo.getC2cSwitch('10001', 'C2C_OPENID_U1'), false);
    handleGatewayEvent(repo, ev('C2C_MSG_RECEIVE', { user_openid: 'C2C_OPENID_U1' }));
    assert.equal(repo.getC2cSwitch('10001', 'C2C_OPENID_U1'), true);
  } finally {
    cleanup(dir, db);
  }
});

test('M2-8 保留策略：只清理超过保留期的消息', () => {
  const { dir, db, repo } = setupDb();
  try {
    const mk = (id: string, ageDays: number) => ({
      botId: 'b',
      scope: 'group' as const,
      scopeId: 'g',
      msgId: id,
      authorOpenid: 'u',
      ts: Date.now() - ageDays * 24 * 60 * 60 * 1000,
      content: `msg ${id}`,
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    });
    repo.saveGroupMessage(mk('old', 100));
    repo.saveGroupMessage(mk('new', 1));
    assert.equal(repo.purgeOldMessages(90), 1);
    const ids = (db.prepare('SELECT msg_id FROM messages').all() as Array<{ msg_id: string }>).map((r) => r.msg_id);
    assert.deepEqual(ids.sort(), ['new']);
  } finally {
    cleanup(dir, db);
  }
});

test('M2-9 元素消息 content 合并官方 content 与展开树；畸形容器不炸', () => {
  const { dir, db, repo } = setupDb();
  try {
    const m = normalizeMessage(
      ev('GROUP_MESSAGE_CREATE', {
        ...groupMsgShape,
        id: 'MSGID_FW',
        content: '转发给你看',
        msg_elements: [
          { message_type: 0, content: '转发的正文' },
          { message_type: 102, children: [{ message_type: 0, content: '记录内容' }] },
        ],
      }),
    );
    assert.ok(m !== null);
    assert.ok(m!.content.includes('转发给你看'));
    assert.ok(m!.content.includes('转发的正文'));
    assert.ok(m!.content.includes('[聊天记录]'));
    repo.saveGroupMessage(m!);

    // 畸形事件：缺 id / 缺 group_openid / data 非对象 → 安全丢弃
    handleGatewayEvent(repo, ev('GROUP_MESSAGE_CREATE', { content: 'no id' }));
    handleGatewayEvent(repo, ev('GROUP_MESSAGE_CREATE', { id: 'X' }));
    handleGatewayEvent(repo, ev('GROUP_MESSAGE_CREATE', 'string-data'));
    handleGatewayEvent(repo, ev('UNKNOWN_EVENT', { id: 'Y', group_openid: 'G9' }));
    const n = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.equal(n, 1, '畸形与未知事件不入库');
  } finally {
    cleanup(dir, db);
  }
});
