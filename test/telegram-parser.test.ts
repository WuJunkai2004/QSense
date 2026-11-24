// Telegram parser + ingest 管线测试：Update → NormalizedMessage 映射形状、缩略图
// data: URL 落附件、引用快照、私聊 opt-in 等价映射、群注册表与 sessions 登记。
// 入库路径走真管线（表驱动路由 → 插件 normalize → 效应落地）；测试一律走声明面
// plugin.normalize()。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectorRegistry,
  createMemoryHost,
  FakeNetKit,
  jsonResponse,
  type ConnectorLogger,
  type ConnectorPlugin,
  type NormalizedMessage,
} from "@qsense/connector-sdk";
import { createQqConnector } from "@qsense/connector-qq";
import {
  createTelegramConnector,
  type TelegramInboundPayload,
  type TelegramMessage,
  type TelegramUpdate,
} from "@qsense/connector-telegram";
import { createIngestPipeline } from "../src/connectors/ingest";
import { Repo } from "../src/store/repo";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";

/** 表驱动 ingest 台架：真 telegram 插件（QQ 分支测试另行注册 qq 插件） */
function makePipeline(repo: Repo, withQq = false) {
  const plugins = new ConnectorRegistry();
  plugins.register(createTelegramConnector());
  if (withQq) plugins.register(createQqConnector());
  const log: ConnectorLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => log,
  };
  return createIngestPipeline({ repo, log, plugins });
}

function payloadOf(update: TelegramUpdate): TelegramInboundPayload {
  return { platform: "telegram", update };
}

// —— 声明面 normalize（测试经 plugin.normalize，不直呼 parser 内部函数） ——

const PLUGIN = createTelegramConnector();

/** Update → NormalizedMessage（经 plugin.normalize 声明面；null 透传） */
function normalizeOf(update: TelegramUpdate): NormalizedMessage | null {
  return PLUGIN.normalize("TG", payloadOf(update))?.messages[0] ?? null;
}

const GROUP_TEXT = {
  update_id: 1,
  message: {
    message_id: 42,
    from: { id: 42, first_name: "Venti", last_name: "Barbatos" },
    chat: { id: -100999, type: "supergroup", title: "测试群" },
    date: 1700000000,
    text: "hello @roujia_bot",
    entities: [
      { type: "mention", offset: 6, length: 11 },
    ],
  },
};

test("parser：群文本消息 → NormalizedMessage 形状（scope/会话id/mentions/quote 空）", () => {
  const m = normalizeOf(GROUP_TEXT);
  assert.equal(m?.scope, "group");
  assert.equal(m?.scopeId, "-100999");
  assert.equal(m?.msgId, "42");
  assert.equal(m?.authorOpenid, "42");
  assert.equal(m?.authorName, "Venti Barbatos");
  assert.equal(m?.ts, 1700000000000);
  assert.equal(m?.text, "hello @roujia_bot");
  assert.equal(m?.content, "hello @roujia_bot");
  assert.deepEqual(m?.mentions, [{ id: "@roujia_bot" }]);
  assert.equal(m?.quote, null);
  assert.deepEqual(m?.records, []);
});

test("parser：photo 消息 → ![附件1] 占位 + 缩略图 data:URL 落附件 url；text 列=caption", () => {
  const upd = {
    update_id: 2,
    message: {
      message_id: 43,
      from: { id: 42, first_name: "Venti" },
      chat: { id: -100999, type: "supergroup" },
      date: 1700000001,
      caption: "看这张",
      photo: [
        { file_id: "thumb", width: 90, height: 90 },
        { file_id: "big", width: 1280, height: 960, file_size: 321000 },
      ],
    },
  };
  const p = payloadOf(upd);
  p.mediaBlobs = { thumb: "data:image/jpeg;base64,QUJD" };
  const m = PLUGIN.normalize("TG", p)?.messages[0] ?? null;
  assert.equal(m?.text, "看这张");
  assert.equal(m?.content, "![附件1] 看这张");
  const att = m?.attachments[0]!;
  assert.equal(att.kind, "image");
  assert.equal(att.url, "data:image/jpeg;base64,QUJD"); // 缩略图
  assert.equal(att.width, 1280); // 元数据取最大尺寸
  assert.equal(att.size, 321000);
});

test("parser：reply → quote 快照（msgId/body/作者）；edited_message → null", () => {
  const upd = {
    update_id: 3,
    message: {
      message_id: 44,
      from: { id: 42, first_name: "Venti" },
      chat: { id: -100999, type: "supergroup" },
      date: 1700000002,
      text: "回复一下",
      reply_to_message: {
        message_id: 42,
        from: { id: 99, first_name: "柔嘉" },
        chat: { id: -100999, type: "supergroup" },
        date: 1699999999,
        text: "被引的原文第一行\n第二行",
      },
    },
  };
  const m = normalizeOf(upd);
  const quote = m?.quote;
  assert.equal(quote?.msgId, "42");
  assert.equal(quote?.body, "被引的原文第一行");
  assert.equal(quote?.authorOpenid, "99");
  assert.equal(quote?.authorName, "柔嘉");
  // 仅编辑事件（v1 不消费）
  const edited = { update_id: 4, edited_message: upd.message };
  assert.equal(normalizeOf(edited), null);
});

test("parser：私聊 → scope chat；handler 私聊落 C2C 开关（opt-in 等价映射）", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-parser-"));
  try {
    const db: DB = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);
    const priv = {
      update_id: 5,
      message: {
        message_id: 45,
        from: { id: 42, first_name: "Venti" },
        chat: { id: 42, type: "private" },
        date: 1700000003,
        text: "私聊消息",
      },
    };
    // 入库走真管线（信封 platform 路由 → 插件 normalize → chat-opt 效应落地）
    makePipeline(repo)({ botId: "TG", payload: payloadOf(priv) });
    // 缓存行 + 会话注册表 + opt-in 映射
    assert.equal(repo.detectSessionKind("TG", "42"), "chat");
    assert.equal(repo.getC2cSwitch("TG", "42"), true);
    const row = db
      .prepare(
        "SELECT scope, scope_id, msg_id FROM messages WHERE bot_id='TG'",
      )
      .get() as { scope: string; scope_id: string; msg_id: string };
    assert.deepEqual(row, { scope: "chat", scope_id: "42", msg_id: "45" });
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

test("parser：服务消息 → 括注行（text 留空）；贴纸 → [贴纸] emoji", () => {
  const mk = (extra: Partial<TelegramMessage>) =>
    normalizeOf({
      update_id: 9,
      message: {
        message_id: 50,
        from: { id: 42, first_name: "Venti" },
        chat: { id: -100999, type: "supergroup" },
        date: 1700000010,
        ...extra,
      },
    });
  assert.equal(
    mk({ new_chat_members: [{ id: 7, first_name: "阿尼" }] })?.content,
    "[入群] 阿尼 加入了群聊",
  );
  assert.equal(mk({ new_chat_title: "新群名" })?.content, "[群名] 新群名");
  assert.equal(mk({ new_chat_photo: { file_id: "f", width: 1, height: 1 } })?.content, "[群头像] 已更新");
  assert.equal(mk({ left_chat_member: { id: 8, first_name: "老王" } })?.content, "[退群] 老王 离开了群聊");
  const pinned = mk({
    pinned_message: {
      message_id: 4,
      chat: { id: -100999, type: "supergroup" },
      text: "群规第一版",
    },
  });
  assert.equal(pinned?.content, "[置顶] 群规第一版");
  // 服务消息不进 FTS 检索列
  assert.equal(mk({ new_chat_title: "新群名" })?.text, "");
  // 贴纸
  const sticker = mk({ sticker: { file_id: "s", emoji: "🎉" } });
  assert.equal(sticker?.content, "[贴纸] 🎉");
  assert.equal(sticker?.text, "🎉");
});

test("handler：群消息 → messages + groups 在册（开关=1）+ sessions 登记", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-parser-group-"));
  try {
    const db: DB = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);
    // 群消息经真管线落库 + group-seen 效应（群注册表在册、开关=1）
    makePipeline(repo)({ botId: "TG", payload: payloadOf(GROUP_TEXT) });
    assert.equal(repo.detectSessionKind("TG", "-100999"), "group");
    const grp = db
      .prepare(
        "SELECT full_msg_enabled FROM groups WHERE bot_id='TG' AND group_openid='-100999'",
      )
      .get() as { full_msg_enabled: number };
    assert.equal(grp.full_msg_enabled, 1);
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

test("ingest 管线（表驱动）：telegram / qq 信封各归各的插件 normalize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-ingest-"));
  try {
    const db: DB = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);
    const pipeline = makePipeline(repo, true);
    // telegram 分支
    pipeline({ botId: "TG", payload: payloadOf(GROUP_TEXT) });
    assert.equal(repo.detectSessionKind("TG", "-100999"), "group");
    // QQ 信封分支（platform 盖章 → qq 插件 normalize → 效应落地）
    const qqEnvelope = {
      platform: "qq",
      type: "GROUP_MESSAGE_CREATE",
      data: {
        id: "qqmsg-1",
        content: "qq 内容",
        group_openid: "QQG",
        author: { member_openid: "u1" },
      },
    };
    pipeline({ botId: "QQBOT", payload: qqEnvelope });
    assert.equal(repo.detectSessionKind("QQBOT", "QQG"), "group");
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

test("TG-atMe：mention 实体比对 getMe 身份（精确 true/false；身份未知省略；私聊不标）", async () => {
  // 身份经真实链路进入 normalize：create → getMe（FakeNetKit 假端点）→ 插件 identities 缓存
  const kitA = new FakeNetKit();
  kitA.onMatch((u) => u.endsWith("/getMe"), () => jsonResponse({ ok: true, result: { id: 777, username: "roujia_bot" } }));
  const kitB = new FakeNetKit();
  kitB.onMatch((u) => u.endsWith("/getMe"), () => jsonResponse({ ok: true, result: { id: 777, username: "other_bot" } }));
  const plugA = createTelegramConnector({ net: kitA });
  const plugB = createTelegramConnector({ net: kitB });
  const plugUnknown = createTelegramConnector();
  plugA.create(createMemoryHost({ net: kitA }).host, {
    botId: "TGA",
    platform: "telegram",
    credential: { appid: "777", token: "x" },
  });
  plugB.create(createMemoryHost({ net: kitB }).host, {
    botId: "TGB",
    platform: "telegram",
    credential: { appid: "777", token: "x" },
  });
  const atMeOf = (p: ConnectorPlugin, botId: string): boolean | undefined =>
    p.normalize(botId, payloadOf(GROUP_TEXT))?.messages[0]?.atMe;
  // @roujia_bot 命中自身 username → true（等待 fire-and-forget getMe 完成）
  await waitFor(() => atMeOf(plugA, "TGA") === true, "identity A cached");
  // 其他 username 被提到 → false（权威否定，wait 层严格排除）
  assert.equal(atMeOf(plugB, "TGB"), false);
  // 身份未知（getMe 未回）→ atMe 省略，wait 层从宽兜底
  assert.equal(atMeOf(plugUnknown, "TGX"), undefined);
  // text_mention 数字 id 比对
  const upd = {
    update_id: 2,
    message: {
      ...GROUP_TEXT.message,
      message_id: 43,
      text: "abc",
      entities: [
        {
          type: "text_mention",
          offset: 1,
          length: 1,
          user: { id: 777, first_name: "柔嘉", is_bot: true },
        },
      ],
    },
  };
  assert.equal(
    plugA.normalize("TGA", payloadOf(upd))?.messages[0]?.atMe,
    true,
  );
  // 私聊恒不标 atMe（mention 过滤的私聊命中走 scope 语义）
  const priv = {
    update_id: 3,
    message: {
      message_id: 44,
      from: { id: 888, first_name: "Venti" },
      chat: { id: 888, type: "private", first_name: "Venti" },
      date: 1700000000,
      text: "@roujia_bot 你好",
      entities: [{ type: "mention", offset: 0, length: 11 }],
    },
  };
  assert.equal(
    plugA.normalize("TGA", payloadOf(priv))?.messages[0]?.atMe,
    undefined,
  );
});

// —— 工具 ——

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
