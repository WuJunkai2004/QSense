// Telegram 连接器单测（P3.5 试金石；B⁺ T4.1 起 FakeNetKit 驱动，零真实网络）：
// 轮询生命周期（offset 持久化/至少一次摄取/401 与 409 fatal/退避重试）、
// net 原语（sendMessage 形状/引用映射/媒体 multipart/句柄单次使用/上限拒绝）、
// 缩略图富化真链路（getFile + 文件下载）、verifyCredential 三档、
// Sender caps 感知路由（passiveWindow=false 恒主动通道）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeNetKit,
  type ConnectorLogger,
  type ConnectorStatus,
  type FakeReply,
  type HostApi,
  type StatePort,
} from "@qsense/connector-sdk";
import {
  createTelegramApi,
  createTelegramConnector,
  type TelegramUpdate,
} from "../packages/connector-telegram/src/index";
import { createTelegramInstance } from "../packages/connector-telegram/src/instance";

const BASE = "https://api.telegram.org";
const TOKEN = "9167497677:AAGtest00000000000000000000000000";
const BOT = "9167497677";
const botUrl = (method: string): string => `${BASE}/bot${TOKEN}/${method}`;

// —— 假宿主（StatePort=Map；ingest/statuses 记录） ——

function fakeHost(): {
  host: HostApi;
  ingested: Array<{ botId: string; payload: unknown }>;
  statuses: ConnectorStatus[];
  state: Map<string, unknown>;
} {
  const state = new Map<string, unknown>();
  const ingested: Array<{ botId: string; payload: unknown }> = [];
  const statuses: ConnectorStatus[] = [];
  const host: HostApi = {
    log: noopLog(),
    state: {
      async get<T = unknown>(key: string) {
        return (state.get(key) as T) ?? null;
      },
      async set(key: string, value: unknown) {
        state.set(key, value);
      },
      async delete(key: string) {
        state.delete(key);
      },
    } satisfies StatePort,
    ingest: (e) => ingested.push(e),
    reportStatus: (s) => statuses.push(s),
  };
  return { host, ingested, statuses, state };
}

function noopLog(): ConnectorLogger {
  const noop = (): void => undefined;
  const logger: ConnectorLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

// —— FakeNetKit 台架：getUpdates 出队脚本（耗尽后挂起，模拟真长轮询） ——
//
// 驱动的空批空转走 FakeNetKit.sleep（立即返回）——脚本耗尽若回空批会变成
// 微任务热循环饿死测试计时器；挂起 + release() 放行是唯一能让 start() 在
// stop() 后安静退出的形态（等价真实现：挂起中的长轮询被服务端应答唤醒）。

interface PollScript {
  /** 预置 getUpdates 出队脚本（元素=批次 / 完整假应答 / 要抛的错误） */
  queue(items: Array<TelegramUpdate[] | FakeReply | Error>): void;
  /** 放行挂起中的 getUpdates（空批）——配合 inst.stop() 让驱动观察到 abort */
  release(): void;
}

function scriptPoll(kit: FakeNetKit): PollScript {
  let script: Array<TelegramUpdate[] | FakeReply | Error> = [];
  let release: ((r: FakeReply) => void) | undefined;
  kit.on(botUrl("getUpdates"), (): FakeReply | Error | Promise<FakeReply> => {
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) {
      return next instanceof Array ? { body: { ok: true, result: next } } : next;
    }
    // 脚本耗尽：挂起（模拟真实长轮询挂起；release() 放行空批）
    return new Promise<FakeReply>((resolve) => {
      release = resolve;
    });
  });
  return {
    queue: (items) => {
      script = items;
    },
    release: () => release?.({ body: { ok: true, result: [] } }),
  };
}

/** 实例台架：FakeNetKit + 真 api 工厂 + 假宿主（ctx 注入） */
function makeInstance(
  kit: FakeNetKit,
  fx: ReturnType<typeof fakeHost>,
): ReturnType<typeof createTelegramInstance> {
  const api = createTelegramApi(kit.http({ timeoutMs: 30_000 }), TOKEN);
  return createTelegramInstance({
    ctx: { ...fx.host, net: kit },
    botId: BOT,
    api,
  });
}

function textUpdate(updateId: number, chatId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: 42, first_name: "Venti" },
      chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
      date: 1700000000,
      text,
    },
  };
}

function jsonBody(log: { body?: string | Uint8Array | FormData }): Record<string, unknown> {
  assert.equal(typeof log.body, "string");
  return JSON.parse(log.body as string) as Record<string, unknown>;
}

// —— 轮询生命周期 ——

test("轮询：首批摄取 + offset 持久化 + 二轮带 offset；停服即时返回", async () => {
  const fx = fakeHost();
  const kit = new FakeNetKit();
  const poll = scriptPoll(kit);
  poll.queue([[
    textUpdate(5, -100999, "hello"),
    textUpdate(7, -100999, "world"),
  ]]);
  const inst = makeInstance(kit, fx);
  const start = inst.start();
  await waitFor(() => fx.state.get("poll:offset") !== undefined, "offset persisted");
  assert.equal(fx.state.get("poll:offset"), 8); // last update_id + 1
  assert.equal(fx.ingested.length, 2);
  assert.equal(
    (fx.ingested[0]!.payload as { platform: string }).platform,
    "telegram",
  );
  assert.equal(fx.statuses.some((s) => s.state === "ready"), true);
  // 二轮 getUpdates 携带 offset=8
  const calls = kit.requests.filter((r) => r.url === botUrl("getUpdates"));
  assert.equal(calls.length >= 2, true);
  assert.equal(jsonBody(calls[1]!)["offset"], 8);
  inst.stop();
  poll.release(); // 放行挂起的 getUpdates → 驱动观察到 abort 安静退出
  await Promise.race([
    start,
    new Promise((_, rej) => setTimeout(() => rej(new Error("stop 未即时返回")), 2000)),
  ]);
});

test("缩略图富化：photo 消息走真链路（getFile + 文件下载）摄取携带 mediaBlobs", async () => {
  const fx = fakeHost();
  const kit = new FakeNetKit();
  const poll = scriptPoll(kit);
  kit.on(botUrl("getFile"), () => ({
    body: { ok: true, result: { file_id: "thumb-fid", file_path: "photos/thumb.jpg" } },
  }));
  kit.on(`${BASE}/file/bot${TOKEN}/photos/thumb.jpg`, () => ({ body: "QUJD" }));
  const upd: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 11,
      from: { id: 42, first_name: "Venti" },
      chat: { id: -100999, type: "supergroup" },
      date: 1700000000,
      photo: [
        { file_id: "thumb-fid", width: 90, height: 90 },
        { file_id: "big-fid", width: 1280, height: 960 },
      ],
    },
  };
  poll.queue([[upd]]);
  const inst = makeInstance(kit, fx);
  const start = inst.start();
  await waitFor(() => fx.ingested.length > 0, "ingested");
  const payload = fx.ingested[0]!.payload as { mediaBlobs?: Record<string, string> };
  const blob = payload.mediaBlobs?.["thumb-fid"];
  assert.match(blob ?? "", /^data:image\/jpeg;base64,/);
  assert.equal(kit.count(`${BASE}/file/bot${TOKEN}/photos/thumb.jpg`), 1);
  inst.stop();
  poll.release();
  await start;
});

test("401 → fatal 不重试；409 → fatal；500 → 退避后成功 ready", async () => {
  for (const [reply, expectFatal] of [
    [{ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }, true],
    [{ status: 409, body: { ok: false, error_code: 409, description: "Conflict" } }, true],
  ] as const) {
    const fx = fakeHost();
    const kit = new FakeNetKit();
    const poll = scriptPoll(kit);
    poll.queue([reply]);
    const inst = makeInstance(kit, fx);
    const start = inst.start();
    await Promise.race([
      start,
      new Promise((_, rej) => setTimeout(() => rej(new Error("fatal 后未退出")), 2000)),
    ]);
    assert.equal(fx.statuses.at(-1)?.state, expectFatal ? "fatal" : "ready");
  }
  // 500 → disconnected → 重试成功 → ready
  const fx = fakeHost();
  const kit = new FakeNetKit();
  const poll = scriptPoll(kit);
  poll.queue([
    { status: 500, body: { ok: false, error_code: 500, description: "boom" } },
    { body: { ok: true, result: [] } },
  ]);
  const inst = makeInstance(kit, fx);
  const start = inst.start();
  await waitFor(
    () => fx.statuses.some((s) => s.state === "ready"),
    "ready after retry",
  );
  assert.equal(fx.statuses.some((s) => s.state === "disconnected"), true);
  inst.stop();
  poll.release();
  await start;
});

// —— net 原语 ——

test("net.proactive 文本：sendMessage 形状 + 引用映射 reply_parameters", async () => {
  const fx = fakeHost();
  const kit = new FakeNetKit();
  kit.on(botUrl("sendMessage"), () => ({
    body: { ok: true, result: { message_id: 901 } },
  }));
  const inst = makeInstance(kit, fx);
  const receipt = await inst.net.proactive!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    content: "hi",
  });
  assert.equal(receipt.providerMsgId, "901");
  const sends = kit.requests.filter((r) => r.url === botUrl("sendMessage"));
  assert.equal(jsonBody(sends[0]!)["chat_id"], -100999); // 数字 id 侧转数字
  assert.equal(jsonBody(sends[0]!)["text"], "hi");
  await inst.net.proactive!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    content: "hi2",
    quoteMsgId: "77",
  });
  const quoted = jsonBody(
    kit.requests.filter((r) => r.url === botUrl("sendMessage"))[1]!,
  );
  assert.deepEqual(quoted["reply_parameters"], {
    message_id: 77,
    allow_sending_without_reply: false,
  });
});

test("net 媒体：uploadMedia 物化 → sendPhoto multipart → 句柄单次使用；voice 走 sendVoice", async () => {
  const fx = fakeHost();
  const kit = new FakeNetKit();
  kit.on(botUrl("sendPhoto"), () => ({
    body: { ok: true, result: { message_id: 902 } },
  }));
  kit.on(botUrl("sendVoice"), () => ({
    body: { ok: true, result: { message_id: 903 } },
  }));
  const inst = makeInstance(kit, fx);
  const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const up = await inst.net.uploadMedia!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    kind: "image",
    source: { kind: "b64", data: TINY_PNG_B64 },
  });
  await inst.net.proactive!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    content: "cap",
    media: { kind: "image", handle: up.handle },
  });
  const photoReqs = kit.requests.filter((r) => r.url === botUrl("sendPhoto"));
  assert.equal(photoReqs.length, 1);
  const form = photoReqs[0]!.body as FormData;
  assert.equal(form.get("caption"), "cap");
  assert.equal(form.get("chat_id"), "-100999");
  const file = form.get("photo") as File;
  assert.deepEqual(
    Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString("hex"),
    "89504e47",
  ); // PNG 魔数原样透传
  // 句柄单次使用（同 request_upload 票据纪律）
  await assert.rejects(
    () =>
      inst.net.proactive!({
        botId: BOT,
        target: "-100999",
        scope: "group",
        content: "",
        media: { kind: "image", handle: up.handle },
      }),
    /句柄/,
  );
  // voice → sendVoice（multipart 字段名 = voice；OggS 魔数嗅探 audio/ogg）
  const up2 = await inst.net.uploadMedia!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    kind: "voice",
    source: { kind: "b64", data: "T0dnUw==" }, // OggS 头
  });
  await inst.net.proactive!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    content: "",
    media: { kind: "voice", handle: up2.handle },
  });
  const voiceForm = kit.requests.find(
    (r) => r.url === botUrl("sendVoice"),
  )!.body as FormData;
  assert.equal(voiceForm.get("voice") !== null, true);
});

test("net.recall：deleteMessage 数字 id；上限拒绝（4096 文本/1024 caption）", async () => {
  const fx = fakeHost();
  const kit = new FakeNetKit();
  kit.on(botUrl("deleteMessage"), () => ({
    body: { ok: true, result: true },
  }));
  const inst = makeInstance(kit, fx);
  await inst.net.recall!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    providerMsgId: "901",
  });
  const call = kit.requests.find((r) => r.url === botUrl("deleteMessage"));
  assert.deepEqual(jsonBody(call!), { chat_id: -100999, message_id: 901 });

  await assert.rejects(
    () =>
      inst.net.proactive!({
        botId: BOT,
        target: "-100999",
        scope: "group",
        content: "a".repeat(4097),
      }),
    /4096/,
  );
  const up = await inst.net.uploadMedia!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    kind: "image",
    source: { kind: "b64", data: "aGk=" },
  });
  await assert.rejects(
    () =>
      inst.net.proactive!({
        botId: BOT,
        target: "-100999",
        scope: "group",
        content: "b".repeat(1025),
        media: { kind: "image", handle: up.handle },
      }),
    /1024/,
  );
});

// —— verifyCredential ——

test("verifyCredential：形制错/401/appid 不匹配/全对（FakeNetKit 假端点）", async () => {
  const plugin = createTelegramConnector();
  const verify = plugin.hooks!.verifyCredential!;
  await assert.rejects(
    () => verify({ appid: "9167497677", token: "bad" }),
    /形制/,
  );
  // getMe 401（真实 401 走不到——形制检查先挡；构造合法形制 + 假 401 端点）
  const kit401 = new FakeNetKit();
  kit401.onMatch((u) => u.endsWith("/getMe"), () => ({
    status: 401,
    body: { ok: false, error_code: 401, description: "Unauthorized" },
  }));
  const reject = createTelegramConnector({ net: kit401 });
  await assert.rejects(
    () =>
      reject.hooks!.verifyCredential!({
        appid: "9167497677",
        token: "9167497677:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      }),
    /BotFather/,
  );
  // appid 与 getMe id 不一致
  const kitOk = new FakeNetKit();
  kitOk.onMatch((u) => u.endsWith("/getMe"), () => ({
    body: { ok: true, result: { id: 9167497677 } },
  }));
  const mismatch = createTelegramConnector({ net: kitOk });
  await assert.rejects(
    () =>
      mismatch.hooks!.verifyCredential!({
        appid: "1111111111",
        token: "9167497677:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      }),
    /不匹配/,
  );
  // 全对
  await createTelegramConnector({ net: kitOk }).hooks!.verifyCredential!({
    appid: "9167497677",
    token: "9167497677:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  });
});

// —— Sender caps 感知路由（核心接线行为） ——

function setupDb(): { db: import("../src/store/db").DB; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tg-sender-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  return {
    db,
    close: () => {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* best-effort */
      }
    },
  };
}

test("Sender caps 路由：passiveWindow=false 恒主动通道（旧消息也直接发，无窗口报错）", async () => {
  const fx = setupDb();
  try {
    const repo = new Repo(fx.db);
    repo.ensureRuntime();
    repo.setSendEnable(true);
    const registry = new BotRegistry({ db: fx.db });
    await registry.add({ credentials: { appid: BOT, token: "t" } });
    registry.setAllowGroups(BOT, ["-100999"]);

    const fxh = fakeHost();
    const kit = new FakeNetKit();
    kit.on(botUrl("sendMessage"), () => ({
      body: { ok: true, result: { message_id: 901 } },
    }));
    const inst = makeInstance(kit, fxh);
    const plugin = createTelegramConnector();
    const sender = new Sender({
      log: createLoggerCompat(),
      repo,
      bots: registry,
      transportFor: () => inst.net,
      capsFor: (botId) => (botId === BOT ? plugin.caps : undefined),
    });

    // 无缓存消息 → QQ 路径会因无绑定走主动；此处断言 channel=proactive
    const r1 = await sender.sendAuto(BOT, "-100999", "hello tg");
    assert.equal(r1.channel, "proactive");
    assert.equal(r1.status, "sent");
    // 引用一条不存在的消息 → 可操作错误（引用校验仍生效）
    await assert.rejects(
      () => sender.sendAuto(BOT, "-100999", "x", "99999"),
      /引用目标消息不在缓存/,
    );
  } finally {
    fx.close();
  }
});

// —— 工具 ——

import { Sender } from "../src/sender";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";

function createLoggerCompat(): import("../src/utils/logger").Logger {
  // eslint 不涉足测试文件；直接构造结构兼容的静默 logger
  const noop = (): void => undefined;
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger as unknown as import("../src/utils/logger").Logger;
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
