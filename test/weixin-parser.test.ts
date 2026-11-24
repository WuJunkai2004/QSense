// 微信 parser + ingest 管线测试（P4；契约 v2：parser 归 connector-weixin 包）：
// WeixinMessage → NormalizedMessage 映射形状、富化图落附件 url、各类媒体的占位约定、
// 引用快照 / ID-only 引用的正文线索 / 被引媒体归属 / 局部引用、非消费面丢弃、
// 私聊 opt-in 等价映射；入库路径走真管线（表驱动路由 → 插件 normalize → 效应落地 → 引用懒补）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectorRegistry,
  assertNormalizedInbound,
  type ConnectorLogger,
} from "@qsense/connector-sdk";
import { createQqConnector } from "@qsense/connector-qq";
import { createTelegramConnector } from "@qsense/connector-telegram";
import {
  MessageItemType,
  MessageType,
  createWeixinConnector,
  normalizeWeixinInbound,
  normalizeWeixinMessage,
  type WeixinInboundPayload,
  type WeixinMessage,
} from "@qsense/connector-weixin";
import { createIngestPipeline } from "../src/connectors/ingest";
import { Repo } from "../src/store/repo";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";

const BOT = "b0f5860fdecb-im-bot";
const USER = "f2d8a1c4b7e9@im.wechat";
const TS = 1795497600000;

function textMsg(over: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: "7656119901234567890",
    from_user_id: USER,
    to_user_id: "b0f5860fdecb@im.bot",
    message_type: MessageType.USER,
    message_state: 2,
    create_time_ms: TS,
    context_token: "ctx-secret-token",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "你好，雅南" } }],
    ...over,
  };
}

function payloadOf(
  message: WeixinMessage,
  extra: Partial<WeixinInboundPayload> = {},
): WeixinInboundPayload {
  return { platform: "weixin", message, ...extra };
}

/** 表驱动 ingest 台架：qq / telegram / weixin 三插件并存，信封各归各的 parser */
function makePipeline(repo: Repo) {
  const plugins = new ConnectorRegistry();
  plugins.register(createQqConnector());
  plugins.register(createTelegramConnector());
  plugins.register(createWeixinConnector());
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => log,
  } as unknown as ConnectorLogger;
  return createIngestPipeline({ repo, log: log as never, plugins });
}

function openDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "wx-parser-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  return { db, dir };
}

function closeDb(db: DB, dir: string): void {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
}

// —— 文本 ——

test("parser：文本消息 → NormalizedMessage 形状（chat/会话 id/锚/时间戳/raw 打码）", () => {
  const m = normalizeWeixinMessage(BOT, payloadOf(textMsg()));
  assert.ok(m);
  assert.equal(m.scope, "chat");
  assert.equal(m.scopeId, USER);
  assert.equal(m.msgId, "7656119901234567890");
  assert.equal(m.authorOpenid, USER);
  assert.equal(m.authorName, undefined); // 平台消息体不含昵称
  assert.equal(m.ts, TS);
  assert.equal(m.text, "你好，雅南");
  assert.equal(m.content, "你好，雅南");
  assert.equal(m.quote, null);
  assert.deepEqual(m.records, []);
  assert.deepEqual(m.mentions, []);
  assert.deepEqual(m.attachments, []);
  // 被引锚 = 自己的消息 id：他人引用本条时 core 懒补作者
  assert.equal(m.msgIdx, "7656119901234567890");
  // context_token 是出站回带凭据：入库前打码（rawJson 文本读回校验）
  const rawParsed: { context_token: string } = JSON.parse(m.rawJson);
  assert.equal(rawParsed.context_token, "<redacted>");
  assert.equal(m.atMe, undefined); // 单聊不标 atMe
  // normalize 产物过契约形状断言
  const inbound = normalizeWeixinInbound(BOT, payloadOf(textMsg()));
  assert.ok(inbound);
  assertNormalizedInbound(inbound);
  // 私聊 opt-in 等价映射
  assert.deepEqual(inbound.effects, [{ kind: "chat-opt", scopeId: USER, allow: true }]);
});

// —— 媒体 ——

const IMG_MID = {
  encrypt_query_param: "EQP_MID",
  aes_key: "MDEyMzQ1Njc4OWFiY2RlZg==",
  encrypt_type: 1,
};
const IMG_THUMB = {
  encrypt_query_param: "EQP_THUMB",
  aes_key: "MDEyMzQ1Njc4OWFiY2RlZg==",
};

test("parser：图片消息 → ![附件1] 占位 + 富化 data:URL 落附件 url；媒体前置正文随后", () => {
  const msg = textMsg({
    message_id: "200",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: { media: IMG_MID, thumb_media: IMG_THUMB, mid_size: 183552 },
      },
      { type: MessageItemType.TEXT, text_item: { text: "看这张" } },
    ],
  });
  const m = normalizeWeixinMessage(
    BOT,
    payloadOf(msg, { mediaBlobs: { "0": "data:image/jpeg;base64,/9j/QUJD" } }),
  );
  assert.ok(m);
  assert.equal(m.content, "![附件1]\n看这张");
  assert.equal(m.text, "看这张");
  assert.deepEqual(m.attachments, [
    {
      kind: "image",
      url: "data:image/jpeg;base64,/9j/QUJD",
      size: 183552,
      content_type: "image/jpeg",
    },
  ]);
  // 富化缺失（解密失败）：url 空串，仍保留元数据（get_media 给可操作错误）
  const bare = normalizeWeixinMessage(BOT, payloadOf(msg));
  assert.ok(bare);
  assert.equal(bare.attachments[0]!.url, "");
  assert.equal(bare.attachments[0]!.kind, "image");
});

test("parser：语音 → 占位带（转写：…），转写不进 text 检索列；时长秒", () => {
  const m = normalizeWeixinMessage(
    BOT,
    payloadOf(
      textMsg({
        message_id: "201",
        item_list: [
          {
            type: MessageItemType.VOICE,
            voice_item: { media: IMG_MID, playtime: 2400, text: "明天几点出发" },
          },
        ],
      }),
    ),
  );
  assert.ok(m);
  assert.equal(m.content, "![附件1]（转写：明天几点出发）");
  assert.equal(m.text, ""); // ASR 只进渲染占位符（与 QQ 语音同约定）
  assert.equal(m.attachments[0]!.kind, "voice");
  assert.equal(m.attachments[0]!.duration, 2);
  assert.equal(m.attachments[0]!.asr_refer_text, "明天几点出发");
  // 无转写的语音：纯占位
  const silent = normalizeWeixinMessage(
    BOT,
    payloadOf(
      textMsg({
        message_id: "202",
        item_list: [
          { type: MessageItemType.VOICE, voice_item: { media: IMG_MID, playtime: 900 } },
        ],
      }),
    ),
  );
  assert.equal(silent?.content, "![附件1]");
});

test("parser：文件 → [附件n 文件名 (大小)]，文件名进 text 可检索；视频只留元数据", () => {
  const f = normalizeWeixinMessage(
    BOT,
    payloadOf(
      textMsg({
        message_id: "203",
        item_list: [
          {
            type: MessageItemType.FILE,
            file_item: { media: IMG_MID, file_name: "数学建模.pdf", len: "724084" },
          },
        ],
      }),
    ),
  );
  assert.ok(f);
  assert.equal(f.content, "[附件1 数学建模.pdf (707KB)]");
  assert.equal(f.text, "数学建模.pdf");
  assert.equal(f.attachments[0]!.content_type, "application/pdf");
  assert.equal(f.attachments[0]!.size, 724084);
  const v = normalizeWeixinMessage(
    BOT,
    payloadOf(
      textMsg({
        message_id: "204",
        item_list: [
          {
            type: MessageItemType.VIDEO,
            video_item: { media: IMG_MID, video_size: 5_000_000, thumb_width: 720, thumb_height: 1280 },
          },
        ],
      }),
    ),
  );
  assert.ok(v);
  assert.equal(v.content, "![附件1]");
  assert.equal(v.attachments[0]!.kind, "video");
  assert.equal(v.attachments[0]!.width, 720);
});

// —— 引用 ——

test("parser：引用（服务端快照）→ quote（msgIdx=msgId=svr_id，body=快照原文）；被引文字不进正文", () => {
  const m = normalizeWeixinMessage(
    BOT,
    payloadOf(
      textMsg({
        message_id: "301",
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text: "这条说得对" },
            ref_msg: {
              svr_id: "300",
              message_item: { type: MessageItemType.TEXT, text_item: { text: "被引的原文" } },
            },
          },
        ],
      }),
    ),
  );
  assert.ok(m);
  assert.equal(m.text, "这条说得对");
  assert.equal(m.content, "这条说得对");
  assert.deepEqual(m.quote, { msgIdx: "300", msgId: "300", body: "被引的原文" });
});

test("parser：ID-only 引用 → 正文取实例侧本地缓存线索；无线索给占位；锚点仍在", () => {
  const mk = (extra: Partial<WeixinInboundPayload>) =>
    normalizeWeixinMessage(
      BOT,
      payloadOf(
        textMsg({
          message_id: "311",
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: "？" },
              ref_msg: { svr_id: "310" },
            },
          ],
        }),
        extra,
      ),
    );
  assert.deepEqual(mk({ quoteText: "缓存里的被引正文" })?.quote, {
    msgIdx: "310",
    msgId: "310",
    body: "缓存里的被引正文",
  });
  // 无线索：占位 + 锚点（agent 可凭 msg_id 调 context 读取）
  assert.deepEqual(mk({})?.quote, {
    msgIdx: "310",
    msgId: "310",
    body: "[引用消息内容未缓存]",
  });
  // title 摘要兜底（旧版客户端给摘要不给正文）
  const titled = normalizeWeixinMessage(
    BOT,
    payloadOf(
      textMsg({
        message_id: "312",
        item_list: [
          { type: MessageItemType.TEXT, text_item: { text: "嗯" }, ref_msg: { svr_id: "310", title: "摘要文字" } },
        ],
      }),
    ),
  );
  assert.equal(titled?.quote?.body, "摘要文字");
});

test("parser：被引图片归 quote.attachments（不混本条正文/附件）——与 QQ 103 被引图同语义", () => {
  const m = normalizeWeixinMessage(
    BOT,
    payloadOf(
      textMsg({
        message_id: "321",
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text: "这是什么图" },
            ref_msg: {
              svr_id: "320",
              message_item: { type: MessageItemType.IMAGE, image_item: { media: IMG_MID } },
            },
          },
        ],
      }),
      { mediaBlobs: { quote: "data:image/png;base64,QUJD" } },
    ),
  );
  assert.ok(m);
  assert.equal(m.content, "这是什么图");
  assert.equal(m.attachments.length, 0);
  assert.equal(m.quote?.body, "[图片]");
  assert.equal(m.quote?.attachments?.[0]?.url, "data:image/png;base64,QUJD");
  assert.equal(m.quote?.attachments?.[0]?.content_type, "image/png");
});

test("parser：局部引用（选区）在可得正文里定位；定位失败回落整条", () => {
  const mk = (partial: Record<string, unknown>) =>
    normalizeWeixinMessage(
      BOT,
      payloadOf(
        textMsg({
          message_id: "331",
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: "这句什么意思" },
              ref_msg: { svr_id: "330", partial_text: partial as never },
            },
          ],
        }),
        { quoteText: "今天天气怎么样？明天呢？今天下雨了。" },
      ),
    );
  const hit = mk({ start: "今天", end: "下雨", startindex: 0, endindex: 0 });
  assert.equal(hit?.quote?.body, "今天天气怎么样？明天呢？今天下雨");
  // 锚文本不在正文：回落整条（不丢引用）
  const miss = mk({ start: "不存在的开头", end: "下雨", startindex: 0, endindex: 0 });
  assert.equal(miss?.quote?.body, "今天天气怎么样？明天呢？今天下雨了。");
});

// —— 非消费面 ——

test("parser：非消费面 → null（机器人回声/群消息/已删除/无法定位）；信封形状违规声明面拒绝", () => {
  assert.equal(normalizeWeixinMessage(BOT, payloadOf(textMsg({ message_type: MessageType.BOT }))), null);
  assert.equal(normalizeWeixinMessage(BOT, payloadOf(textMsg({ group_id: "g1@im.bizchat" }))), null);
  assert.equal(normalizeWeixinMessage(BOT, payloadOf(textMsg({ delete_time_ms: TS + 1000 }))), null);
  assert.equal(normalizeWeixinMessage(BOT, payloadOf(textMsg({ from_user_id: "" }))), null);
  assert.equal(
    normalizeWeixinMessage(BOT, payloadOf(textMsg({ message_id: undefined, client_id: undefined }))),
    null,
  );
  // B⁺ T5：信封形状归声明面 schema 把关（safeParse 失败 = 可观测丢弃 + warn）。
  // 非 object / 错平台信封经 JSON.parse 边界进入（模拟动态形状）。
  const plugin = createWeixinConnector();
  assert.equal(
    plugin.normalize(BOT, JSON.parse('{"platform":"qq","data":{}}')),
    null,
  );
  assert.equal(plugin.normalize(BOT, JSON.parse("null")), null);
  assert.equal(
    plugin.normalize(BOT, JSON.parse('{"platform":"weixin","message":"x"}')),
    null,
  );
  // 数字 id（未经无损解析的载荷）：schema 违规，边界拒绝（传输层 parseWeixinJson 保证线上恒字符串）
  assert.equal(
    plugin.normalize(
      BOT,
      payloadOf(textMsg({ message_id: undefined, item_list: [{ type: 1, msg_id: 42 as unknown as string, text_item: { text: "x" } }] })),
    ),
    null,
  );
});

// —— 真管线 ——

test("真管线：入库行/会话注册表/opt-in + raw 打码 + 引用懒补（msgIdx=message_id）+ 幂等", () => {
  const { db, dir } = openDb();
  try {
    const repo = new Repo(db);
    const pipeline = makePipeline(repo);
    pipeline({ botId: BOT, payload: payloadOf(textMsg({ message_id: "100" })) });
    assert.equal(repo.detectSessionKind(BOT, USER), "chat");
    assert.equal(repo.getC2cSwitch(BOT, USER), true);
    const row = db
      .prepare(
        "SELECT scope, scope_id, msg_id, msg_idx, raw_json FROM messages WHERE bot_id = ? AND msg_id = '100'",
      )
      .get(BOT) as { scope: string; scope_id: string; msg_id: string; msg_idx: string; raw_json: string };
    assert.deepEqual(
      { scope: row.scope, scope_id: row.scope_id, msg_id: row.msg_id, msg_idx: row.msg_idx },
      { scope: "chat", scope_id: USER, msg_id: "100", msg_idx: "100" },
    );
    assert.equal(JSON.parse(row.raw_json).context_token, "<redacted>");
    // 第二条以 ID-only 引用第一条 → core 懒补被引作者/消息 id
    pipeline({
      botId: BOT,
      payload: payloadOf(
        textMsg({
          message_id: "101",
          item_list: [
            { type: MessageItemType.TEXT, text_item: { text: "你刚说什么？" }, ref_msg: { svr_id: "100" } },
          ],
        }),
      ),
    });
    const q = repo.quoteOf(repo.getMessageByMsgId(BOT, "chat", USER, "101")!);
    assert.equal(q?.id, USER);
    assert.equal(q?.msgId, "100");
    // 幂等：同消息重放不重复入库
    pipeline({ botId: BOT, payload: payloadOf(textMsg({ message_id: "100" })) });
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ?")
      .get(BOT) as { n: number };
    assert.equal(Number(n.n), 2);
  } finally {
    closeDb(db, dir);
  }
});

test("多平台并存：weixin 信封只进 weixin parser（qq / telegram 插件同注册表不受扰）", () => {
  const { db, dir } = openDb();
  try {
    const repo = new Repo(db);
    const pipeline = makePipeline(repo);
    pipeline({
      botId: "QQBOT",
      payload: {
        platform: "qq",
        type: "GROUP_MESSAGE_CREATE",
        data: { id: "q1", content: "qq", group_openid: "G", author: { member_openid: "u1" } },
      },
    });
    pipeline({ botId: BOT, payload: payloadOf(textMsg({ message_id: "1" })) });
    assert.equal(repo.detectSessionKind("QQBOT", "G"), "group");
    assert.equal(repo.detectSessionKind(BOT, USER), "chat");
  } finally {
    closeDb(db, dir);
  }
});
