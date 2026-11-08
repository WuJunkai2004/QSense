// M2 验收：事件规范化 + 缓存 + 名册 + 开关状态（灌官方样例形状 + 自造合并转发/语音/卡片事件，SQL 查回断言）。
// 2026-11-08 存储重构后：text/content 分列、引用结构化（quote）、聊天记录拍平（records）、
// 附件 kind 归一、群/私聊合一（scope 列）、users 身份权威（QQ 昵称 last-write-wins）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decomposeElements } from "../src/normalize/expand";
import { normalizeMessage } from "../src/normalize";
import { handleGatewayEvent } from "../src/normalize/handler";
import type { RawEvent } from "../src/gateway";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";

function setupDb(): { dir: string; db: DB; repo: Repo } {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-m2-test-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  return { dir, db, repo: new Repo(db) };
}

function cleanup(dir: string, db: DB): void {
  db.close();
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    /* Windows 句柄延迟，best-effort */
  }
}

const ev = (type: string, data: unknown, botId = "10001"): RawEvent => ({
  botId,
  type,
  data,
});

/** 官方 GROUP_MESSAGE_CREATE 事件形状（依据 API-FACTS.md #2 字段表） */
const groupMsgShape = {
  id: "MSGID_1",
  author: {
    id: "author-openid-union",
    user_openid: "",
    member_openid: "MEMBER_OPENID_A",
    username: "小明",
    member_role: "member",
  },
  group_openid: "GROUP_OPENID_G1",
  content: "今晚一起<@MEMBER_OPENID_B>开会吗",
  timestamp: "2026-10-24T20:00:00+08:00",
  mentions: [{ id: "MEMBER_OPENID_B", username: "小红" }],
  attachments: [],
};

test("M2-1 元素树分解：文本/卡片/并行/引用结构化/记录拍平（嵌套 depth）/未知兜底", () => {
  const tree = [
    { message_type: 0, content: "看这个" },
    { message_type: 103, msg_idx: "REFIDX_x", content: "这是被引用的那条消息" },
    {
      message_type: 102,
      title: "群的聊天记录",
      children: [
        { message_type: 0, content: "转发里的第一条" },
        {
          message_type: 102,
          title: "嵌套记录",
          children: [{ message_type: 0, content: "二层转发" }],
        },
      ],
    },
    { message_type: 101, children: [{ message_type: 0, content: "并行分支" }] },
    { message_type: 3, title: "投票卡片" },
    { message_type: 999, content: "未知类型兜底文本" },
  ];
  const d = decomposeElements(tree);
  // 本条文本：官方文本行；被引原文与记录转写不进 text
  assert.ok(d.textLines.includes("看这个"));
  assert.ok(d.textLines.includes("并行分支"), "101 并行子文本属本条文本");
  assert.ok(d.textLines.includes("未知类型兜底文本"));
  assert.ok(
    !d.textLines.some((l) => l.includes("被引用的那条消息")),
    "被引原文不进本条文本",
  );
  assert.ok(!d.textLines.some((l) => l.includes("转发里的第一条")));
  // 渲染行：结构标记 + 记录条数标记；无 [引用] 令牌
  assert.ok(d.renderLines.includes("[卡片] 投票卡片"));
  assert.ok(d.renderLines.some((l) => l === "[群的聊天记录·2条]"));
  assert.ok(
    !d.renderLines.some((l) => l.includes("[引用")),
    "渲染行无引用令牌",
  );
  // 顶层引用结构化
  assert.equal(d.quote?.msgIdx, "REFIDX_x");
  assert.equal(d.quote?.body, "这是被引用的那条消息");
  // 记录拍平：嵌套记录下钻，depth 表达层级，ord 递增
  assert.equal(d.records.length, 2);
  assert.equal(d.records[0].text, "转发里的第一条");
  assert.equal(d.records[0].depth, 1);
  assert.equal(d.records[0].ord, 0);
  assert.equal(d.records[1].text, "二层转发");
  assert.equal(d.records[1].depth, 2);
  assert.equal(d.records[1].ord, 1);
});

test("M2-2 迁移 v8：业务表齐全（合一消息/users/records），FTS 挂 text 可检索", () => {
  const { dir, db, repo } = setupDb();
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of [
      "groups",
      "members",
      "messages",
      "users",
      "message_records",
      "sends",
      "quota_daily",
      "kv",
    ]) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
    assert.ok(!tables.includes("c2c_messages"), "c2c_messages 镜像表已退役");
    assert.ok(!tables.includes("messages_v7"), "旧表已清理");
    // FTS：插入 → trigram 检索中文子串命中（源=text 列）
    repo.saveMessage({
      botId: "b",
      scope: "group",
      scopeId: "g",
      msgId: "m1",
      authorOpenid: "u1",
      ts: Date.now(),
      text: "今晚一起开会讨论项目排期",
      content: "今晚一起开会讨论项目排期",
      mentions: [],
      attachments: [],
      records: [],
      quote: null,
      raw: {},
    });
    const hits = db
      .prepare(
        "SELECT msg_id FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '开会讨论')",
      )
      .all() as Array<{ msg_id: string }>;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].msg_id, "m1");
  } finally {
    cleanup(dir, db);
  }
});

test("M2-3 官方形状群消息：规范化入库（scope 合一）、msg_id 幂等", () => {
  const { dir, db, repo } = setupDb();
  try {
    const m = normalizeMessage(ev("GROUP_MESSAGE_CREATE", groupMsgShape));
    assert.ok(m !== null);
    assert.equal(m!.scope, "group");
    assert.equal(m!.scopeId, "GROUP_OPENID_G1");
    assert.equal(m!.msgId, "MSGID_1");
    assert.equal(m!.authorOpenid, "MEMBER_OPENID_A");
    assert.equal(m!.authorName, "小明");
    assert.equal(m!.authorRole, "member");
    assert.equal(m!.ts, Date.parse("2026-10-24T20:00:00+08:00"));
    assert.deepEqual(m!.mentions, [{ id: "MEMBER_OPENID_B", name: "小红" }]);
    assert.equal(m!.text, "今晚一起<@MEMBER_OPENID_B>开会吗");
    assert.equal(m!.content, "今晚一起<@MEMBER_OPENID_B>开会吗");

    assert.equal(repo.saveMessage(m!), true, "首次入库成功");
    assert.equal(repo.saveMessage(m!), false, "重复 msg_id 幂等拒绝");

    const row = db
      .prepare(
        "SELECT * FROM messages WHERE bot_id='10001' AND scope='group' AND scope_id='GROUP_OPENID_G1' AND msg_id='MSGID_1'",
      )
      .get() as Record<string, unknown>;
    assert.equal(row.author_openid, "MEMBER_OPENID_A");
    assert.equal(row.text, "今晚一起<@MEMBER_OPENID_B>开会吗");
    assert.deepEqual(JSON.parse(row.mentions_json as string), [
      { id: "MEMBER_OPENID_B", name: "小红" },
    ]);
    assert.equal(row.ts, Date.parse("2026-10-24T20:00:00+08:00"));
    assert.equal(
      JSON.parse(row.raw_json as string).group_openid,
      "GROUP_OPENID_G1",
    );
    assert.equal(row.records_count, 0);
    assert.equal(row.quote_json, null);
  } finally {
    cleanup(dir, db);
  }
});

test("M2-4 语音附件：kind 归一 voice，wav 转写地址与 ASR 文本保留", () => {
  const { dir, db, repo } = setupDb();
  try {
    const m = normalizeMessage(
      ev("GROUP_MESSAGE_CREATE", {
        ...groupMsgShape,
        id: "MSGID_VOICE",
        content: "",
        attachments: [
          {
            url: "https://multimedia.qq.com/voice/x.silk",
            filename: "voice.silk",
            content_type: "voice",
            voice_wav_url: "https://multimedia.qq.com/voice/x.wav",
            asr_refer_text: "明天下午三点开会",
          },
        ],
      }),
    );
    assert.ok(m !== null);
    assert.equal(m!.attachments.length, 1);
    assert.equal(m!.attachments[0].kind, "voice");
    // ASR 是转引内容：渲染进占位符，但不进 text 检索列
    assert.equal(m!.content, "![附件1]（转写：明天下午三点开会）");
    assert.equal(m!.text, "");
    repo.saveMessage(m!);
    const row = db
      .prepare("SELECT attachments_json FROM messages WHERE msg_id='MSGID_VOICE'")
      .get() as { attachments_json: string };
    const saved = JSON.parse(row.attachments_json) as Array<{
      kind?: string;
      asr_refer_text?: string;
    }>;
    assert.equal(saved[0].kind, "voice");
    assert.equal(saved[0].asr_refer_text, "明天下午三点开会");
  } finally {
    cleanup(dir, db);
  }
});

test("M2-5 成员名册 upsert（关系事实）+ users 昵称 last-write-wins", () => {
  const { dir, db, repo } = setupDb();
  try {
    handleGatewayEvent(repo, ev("GROUP_MESSAGE_CREATE", groupMsgShape));
    handleGatewayEvent(
      repo,
      ev("GROUP_MESSAGE_CREATE", {
        ...groupMsgShape,
        id: "MSGID_2",
        author: {
          ...groupMsgShape.author,
          username: "明明",
          member_role: "admin",
        },
      }),
    );
    // 名册：msg_count/角色随消息更新；username 列已砍（名字权威在 users）
    const row = db
      .prepare(
        "SELECT * FROM members WHERE bot_id='10001' AND group_openid='GROUP_OPENID_G1' AND member_openid='MEMBER_OPENID_A'",
      )
      .get() as Record<string, unknown>;
    assert.equal(row.msg_count, 2);
    assert.equal(row.member_role, "admin");
    assert.ok(!("username" in row), "members 不再存名字列");
    // users：QQ 昵称最新值
    const u = db
      .prepare(
        "SELECT name FROM users WHERE bot_id='10001' AND openid='MEMBER_OPENID_A'",
      )
      .get() as { name: string };
    assert.equal(u.name, "明明");
    assert.equal(repo.userNameOf("10001", "MEMBER_OPENID_A"), "明明");
  } finally {
    cleanup(dir, db);
  }
});

test("M2-6 群注册表生命周期：ADD(0) → 全量消息(1) → REJECT(0) → DEL_ROBOT(移除)", () => {
  const { dir, db, repo } = setupDb();
  try {
    const flag = (): number | undefined =>
      (
        db
          .prepare(
            "SELECT full_msg_enabled AS f FROM groups WHERE bot_id='10001' AND group_openid='G1'",
          )
          .get() as { f: number } | undefined
      )?.f;

    handleGatewayEvent(repo, ev("GROUP_ADD_ROBOT", { group_openid: "G1" }));
    assert.equal(flag(), 0, "ADD 时开关未确认=0");

    handleGatewayEvent(repo, ev("GROUP_MSG_RECEIVE", { group_openid: "G1" }));
    assert.equal(flag(), 1, "群主开启全量");

    handleGatewayEvent(repo, ev("GROUP_MSG_REJECT", { group_openid: "G1" }));
    assert.equal(flag(), 0, "群主关闭全量");

    // 未开全量的群来 @ 消息：ensureGroup 不改开关
    handleGatewayEvent(
      repo,
      ev("GROUP_AT_MESSAGE_CREATE", {
        id: "AT1",
        group_openid: "G1",
        content: "@bot 在吗",
        author: { member_openid: "U1" },
      }),
    );
    assert.equal(flag(), 0, "@消息不篡改开关");

    handleGatewayEvent(repo, ev("GROUP_DEL_ROBOT", { group_openid: "G1" }));
    assert.equal(flag(), undefined, "DEL_ROBOT 后注册表移除");
  } finally {
    cleanup(dir, db);
  }
});

test("M2-7 C2C 单聊入库（scope=chat 合一表）+ 用户级主动消息开关（kv）", () => {
  const { dir, db, repo } = setupDb();
  try {
    handleGatewayEvent(
      repo,
      ev("C2C_MESSAGE_CREATE", {
        id: "C1",
        content: "私聊你好",
        timestamp: "2026-10-24T21:00:00+08:00",
        // 官方真实载荷：user_openid 仅在 author 内，无顶层 user_openid
        author: { id: "C2C_OPENID_U1", user_openid: "C2C_OPENID_U1" },
      }),
    );
    const row = db
      .prepare(
        "SELECT scope, scope_id, content FROM messages WHERE bot_id='10001' AND msg_id='C1'",
      )
      .get() as { scope: string; scope_id: string; content: string };
    assert.equal(row.scope, "chat");
    assert.equal(row.scope_id, "C2C_OPENID_U1");
    assert.equal(row.content, "私聊你好");

    assert.equal(repo.getC2cSwitch("10001", "C2C_OPENID_U1"), null);
    handleGatewayEvent(
      repo,
      ev("C2C_MSG_REJECT", { user_openid: "C2C_OPENID_U1" }),
    );
    assert.equal(repo.getC2cSwitch("10001", "C2C_OPENID_U1"), false);
    handleGatewayEvent(
      repo,
      ev("C2C_MSG_RECEIVE", { user_openid: "C2C_OPENID_U1" }),
    );
    assert.equal(repo.getC2cSwitch("10001", "C2C_OPENID_U1"), true);
  } finally {
    cleanup(dir, db);
  }
});

test("M2-9 元素消息分解落库：记录标记+records；畸形容器不炸", () => {
  const { dir, db, repo } = setupDb();
  try {
    const m = normalizeMessage(
      ev("GROUP_MESSAGE_CREATE", {
        ...groupMsgShape,
        id: "MSGID_FW",
        content: "转发给你看",
        msg_elements: [
          { message_type: 0, content: "转发的正文" },
          {
            message_type: 102,
            children: [{ message_type: 0, content: "记录内容" }],
          },
        ],
      }),
    );
    assert.ok(m !== null);
    assert.equal(m!.content, "转发给你看\n转发的正文\n[聊天记录·1条]");
    assert.equal(m!.text, "转发给你看\n转发的正文");
    assert.equal(m!.records.length, 1);
    assert.equal(m!.records[0].text, "记录内容");
    repo.saveMessage(m!);

    // 畸形事件：缺 id / 缺 group_openid / data 非对象 → 安全丢弃
    handleGatewayEvent(repo, ev("GROUP_MESSAGE_CREATE", { content: "no id" }));
    handleGatewayEvent(repo, ev("GROUP_MESSAGE_CREATE", { id: "X" }));
    handleGatewayEvent(repo, ev("GROUP_MESSAGE_CREATE", "string-data"));
    handleGatewayEvent(
      repo,
      ev("UNKNOWN_EVENT", { id: "Y", group_openid: "G9" }),
    );
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
    ).n;
    assert.equal(n, 1, "畸形与未知事件不入库");
  } finally {
    cleanup(dir, db);
  }
});

test("M2-10 媒体占位符与引用结构化：媒体前置/103 内嵌媒体收集/msg_idx 提取", () => {
  // 纯图消息（无 elements，真机形状）：content = 占位符
  const img = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_IMG",
      content: "",
      attachments: [
        {
          url: "https://cdn.example/x.png",
          filename: "x.png",
          content_type: "image/png",
          width: 100,
          height: 80,
        },
      ],
    }),
  );
  assert.ok(img !== null);
  assert.equal(img!.content, "![附件1]");
  assert.equal(img!.attachments.length, 1);
  assert.equal(img!.attachments[0].kind, "image");

  // 图文消息（无 elements）：约定媒体前置，顺序可见
  const mix = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_MIX",
      content: "图片和文字",
      attachments: [
        { url: "https://cdn.example/y.png", content_type: "image/png" },
      ],
    }),
  );
  assert.ok(mix !== null);
  assert.equal(mix!.content, "![附件1]\n图片和文字");

  // 引用元素（真机 103 形状）：原文结构化进 quote；被引图片照常收集占位
  const quote = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_QUOTE",
      content: "我引用了一条消息",
      msg_elements: [
        {
          message_type: 103,
          msg_idx: "REFIDX_A",
          content: "被引的原文",
          attachments: [
            { url: "https://cdn.example/q.png", content_type: "image/png" },
          ],
        },
      ],
    }),
  );
  assert.ok(quote !== null);
  assert.equal(quote!.content, "我引用了一条消息\n![附件1]");
  assert.equal(quote!.text, "我引用了一条消息");
  assert.equal(quote!.quote?.msgIdx, "REFIDX_A");
  assert.equal(quote!.quote?.body, "被引的原文");
  assert.equal(quote!.attachments.length, 1);
  assert.equal(quote!.attachments[0]!.url, "https://cdn.example/q.png");

  // msg_idx 从 message_scene.ext 提取（本条自己的锚，落 msg_idx 列）；无 103 元素不构成引用
  const idx = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_IDX",
      message_scene: { ext: ["msg_idx=REFIDX_X9", "auth_token=t"] },
    }),
  );
  assert.ok(idx !== null);
  assert.equal(idx!.msgIdx, "REFIDX_X9");
  assert.equal(idx!.quote, null, "仅 scene.ext 锚不构成引用");

  // 顶层与树内同 URL 去重：只收一次、编号一致
  const dupe = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_DUPE",
      content: "看",
      attachments: [{ url: "https://cdn.example/d.png" }],
      msg_elements: [
        {
          message_type: 103,
          msg_idx: "REFIDX_D",
          content: "引",
          attachments: [{ url: "https://cdn.example/d.png" }],
        },
      ],
    }),
  );
  assert.ok(dupe !== null);
  assert.equal(dupe!.attachments.length, 1, "同 URL 只收一次");
  assert.ok(dupe!.content.includes("![附件1]"));
});

test("M2-11 文件附件：kind=file，占位符带文件名/大小，文件名进 text 可检索", () => {
  const m = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_FILE",
      content: "",
      attachments: [
        {
          url: "https://njc-download.ftn.qq.com/x.pdf",
          filename: "数学建模省一.pdf",
          size: 724084,
          content_type: "file",
        },
      ],
    }),
  );
  assert.ok(m !== null);
  assert.equal(m!.attachments[0].kind, "file");
  assert.equal(m!.content, "[附件1 数学建模省一.pdf (707KB)]");
  assert.equal(m!.text, "数学建模省一.pdf", "文件名属本条内容，进检索列");
});

test("M2-12 官方合并转发无元素树形状（message_type=102）：转写解析进 records，宿主只留标记", () => {
  // 真机 2026-11-08 形状：消息级 message_type=102，content 直带全文转写，无 msg_elements
  const m = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_REC",
      message_type: 102,
      content:
        "[群聊的聊天记录]\n=== 消息 1 ===\n[消息内容]  你人呢，怎么不活跃了\n[发送者] Venti\n\n=== 消息 2 ===\n[消息内容] 在呢在呢 刚睡醒 你们聊到哪了\n[发送者] 小肥鱼",
    }),
  );
  assert.ok(m !== null);
  assert.equal(m!.content, "[群聊的聊天记录·2条]", "宿主只留条数标记");
  assert.equal(m!.text, "", "转写是转引内容，不进检索列");
  assert.equal(m!.records.length, 2);
  assert.equal(m!.records[0].ord, 0);
  assert.equal(m!.records[0].depth, 0);
  assert.equal(m!.records[0].authorName, "Venti");
  assert.equal(m!.records[0].text, "你人呢，怎么不活跃了");
  assert.equal(m!.records[1].authorName, "小肥鱼");
  // 非记录消息不受影响：普通 content 开头相同词不误伤
  const plain = normalizeMessage(
    ev("GROUP_MESSAGE_CREATE", {
      ...groupMsgShape,
      id: "MSGID_PLAIN",
      content: "[群聊的聊天记录] 其实我在聊这个话题",
    }),
  );
  assert.ok(plain !== null);
  assert.equal(plain!.records.length, 0, "无消息块结构不误判");
  assert.equal(plain!.text, "[群聊的聊天记录] 其实我在聊这个话题");
});
