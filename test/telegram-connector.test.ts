// Telegram 连接器单测（P3.5 试金石）：零真实网络——
// 轮询生命周期（offset 持久化/至少一次摄取/401 与 409 fatal/退避重试）、
// net 原语（sendMessage 形状/引用映射/媒体 multipart/句柄单次使用/上限拒绝）、
// verifyCredential 三档、Sender caps 感知路由（passiveWindow=false 恒主动通道）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConnectorLogger,
  ConnectorStatus,
  HostApi,
  StatePort,
} from "@qsense/connector-sdk";
import { TelegramApiError, type TelegramApi, type TelegramUpdate } from "../packages/connector-telegram/src/api";
import { createTelegramInstance } from "../packages/connector-telegram/src/instance";
import { createTelegramConnector } from "../packages/connector-telegram/src/plugin";
import { Sender } from "../src/sender";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";

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

// —— 假 TelegramApi：记录调用；getUpdates 按脚本出队，脚本耗尽后挂起到 abort ——

interface FakeApi {
  api: TelegramApi;
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  uploads: Array<{
    method: string;
    file: { buffer: Buffer; filename: string; mime: string };
    field: string;
    fields: Record<string, string>;
  }>;
  /** 追加 getUpdates 出队脚本（元素=批次或要抛的错误） */
  queue(items: Array<TelegramUpdate[] | Error>): void;
}

function fakeApi(): FakeApi {
  const calls: FakeApi["calls"] = [];
  const uploads: FakeApi["uploads"] = [];
  let script: Array<TelegramUpdate[] | Error> = [];
  const api: TelegramApi = {
    async call(method, body = {}, opts) {
      calls.push({ method, body });
      if (method === "getUpdates") {
        const next = script.shift();
        if (next === undefined) {
          // 脚本耗尽：挂起到 abort（模拟真实长轮询；停服即时返回而非空转）
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          throw new TelegramApiError("aborted", 0);
        }
        if (next instanceof Error) throw next;
        return next as unknown as never;
      }
      if (method === "getMe") return { id: 9167497677 } as never;
      if (method === "sendMessage") return { message_id: 901 } as never;
      if (method === "deleteMessage") return true as never;
      return {} as never;
    },
    async upload(method, file, field, fields) {
      uploads.push({ method, file, field, fields });
      return { message_id: 902 } as never;
    },
    fileUrl(path) {
      return `https://fake/file/${path}`;
    },
  };
  return { api, calls, uploads, queue: (items) => (script = items) };
}

const BOT = "9167497677";

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

// —— 轮询生命周期 ——

test("轮询：首批摄取 + offset 持久化 + 二轮带 offset；停服即时返回", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  fake.queue([[textUpdate(5, -100999, "hello"), textUpdate(7, -100999, "world")], []]);
  const inst = createTelegramInstance({
    host: fx.host,
    botId: BOT,
    api: fake.api,
  });
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
  const second = fake.calls.filter((c) => c.method === "getUpdates")[1];
  assert.equal(second?.body["offset"], 8);
  inst.stop();
  await Promise.race([
    start,
    new Promise((_, rej) => setTimeout(() => rej(new Error("stop 未即时返回")), 2000)),
  ]);
});

test("缩略图富化：photo 消息摄取携带 mediaBlobs（overrides.enrich 注入）", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
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
  fake.queue([[upd], []]);
  const inst = createTelegramInstance({
    host: fx.host,
    botId: BOT,
    api: fake.api,
    overrides: {
      enrich: async () => ({ "thumb-fid": "data:image/jpeg;base64,QUJD" }),
    },
  });
  const start = inst.start();
  await waitFor(() => fx.ingested.length > 0, "ingested");
  const payload = fx.ingested[0]!.payload as { mediaBlobs?: Record<string, string> };
  assert.equal(payload.mediaBlobs?.["thumb-fid"], "data:image/jpeg;base64,QUJD");
  inst.stop();
  await start;
});

test("401 → fatal 不重试；409 → fatal；500 → 退避后成功 ready", async () => {
  for (const [err, expectFatal] of [
    [new TelegramApiError("Unauthorized", 401), true],
    [new TelegramApiError("Conflict", 409), true],
  ] as const) {
    const fx = fakeHost();
    const fake = fakeApi();
    fake.queue([err]);
    const inst = createTelegramInstance({ host: fx.host, botId: BOT, api: fake.api });
    const start = inst.start();
    await Promise.race([
      start,
      new Promise((_, rej) => setTimeout(() => rej(new Error("fatal 后未退出")), 2000)),
    ]);
    assert.equal(fx.statuses.at(-1)?.state, expectFatal ? "fatal" : "ready");
  }
  // 500 → disconnected → 重试成功 → ready
  const fx = fakeHost();
  const fake = fakeApi();
  fake.queue([new TelegramApiError("boom", 500), []]);
  const inst = createTelegramInstance({ host: fx.host, botId: BOT, api: fake.api });
  const start = inst.start();
  await waitFor(
    () => fx.statuses.some((s) => s.state === "ready"),
    "ready after retry",
  );
  assert.equal(fx.statuses.some((s) => s.state === "disconnected"), true);
  inst.stop();
  await start;
});

// —— net 原语 ——

test("net.proactive 文本：sendMessage 形状 + 引用映射 reply_parameters", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  const inst = createTelegramInstance({ host: fx.host, botId: BOT, api: fake.api });
  const receipt = await inst.net.proactive!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    content: "hi",
  });
  assert.equal(receipt.providerMsgId, "901");
  const call = fake.calls.find((c) => c.method === "sendMessage");
  assert.equal(call?.body["chat_id"], -100999); // 数字 id 侧转数字
  assert.equal(call?.body["text"], "hi");
  await inst.net.proactive!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    content: "hi2",
    quoteMsgId: "77",
  });
  const quoted = fake.calls.filter((c) => c.method === "sendMessage")[1];
  assert.deepEqual(quoted?.body["reply_parameters"], {
    message_id: 77,
    allow_sending_without_reply: false,
  });
});

test("net 媒体：uploadMedia 物化 → sendPhoto multipart → 句柄单次使用；voice 走 sendVoice", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  const inst = createTelegramInstance({ host: fx.host, botId: BOT, api: fake.api });
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
  const up1 = fake.uploads[0]!;
  assert.equal(up1.method, "sendPhoto");
  assert.equal(up1.field, "photo");
  assert.equal(up1.fields["caption"], "cap");
  assert.equal(up1.fields["chat_id"], "-100999");
  assert.deepEqual(
    Buffer.from(up1.file.buffer).subarray(0, 4).toString("hex"),
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
  // voice → sendVoice（fields.file 字段名 = voice）
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
  assert.equal(fake.uploads[1]!.method, "sendVoice");
  assert.equal(fake.uploads[1]!.field, "voice");
});

test("net.recall：deleteMessage 数字 id；上限拒绝（4096 文本/1024 caption）", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  const inst = createTelegramInstance({ host: fx.host, botId: BOT, api: fake.api });
  await inst.net.recall!({
    botId: BOT,
    target: "-100999",
    scope: "group",
    providerMsgId: "901",
  });
  const call = fake.calls.find((c) => c.method === "deleteMessage");
  assert.deepEqual(call?.body, { chat_id: -100999, message_id: 901 });

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

test("verifyCredential：形制错/401/appid 不匹配/全对", async () => {
  const plugin = createTelegramConnector({});
  const verify = plugin.hooks!.verifyCredential!;
  await assert.rejects(
    () => verify({ appid: "9167497677", token: "bad" }),
    /形制/,
  );
  // getMe 401（真实 401 走不到——形制检查先挡；构造合法形制 + 假 401 fetch）
  const reject = createTelegramConnector({
    apiOverrides: {
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    },
  });
  await assert.rejects(
    () =>
      reject.hooks!.verifyCredential!({
        appid: "9167497677",
        token: "9167497677:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      }),
    /BotFather/,
  );
  // appid 与 getMe id 不一致
  const mismatch = createTelegramConnector({
    apiOverrides: {
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: true, result: { id: 9167497677 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    },
  });
  await assert.rejects(
    () =>
      mismatch.hooks!.verifyCredential!({
        appid: "1111111111",
        token: "9167497677:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      }),
    /不匹配/,
  );
  // 全对
  const ok = createTelegramConnector({
    apiOverrides: {
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: true, result: { id: 9167497677 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    },
  });
  await ok.hooks!.verifyCredential!({
    appid: "9167497677",
    token: "9167497677:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  });
});

// —— Sender caps 感知路由（核心接线行为） ——

function setupDb(): { db: DB; close: () => void } {
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
    const fake = fakeApi();
    const inst = createTelegramInstance({ host: fxh.host, botId: BOT, api: fake.api });
    const plugin = createTelegramConnector({});
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
