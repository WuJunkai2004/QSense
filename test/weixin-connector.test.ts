// 微信连接器单测（P4；B⁺ T4.2 起 FakeNetKit / policy 驱动）：零真实网络——
// 轮询生命周期（游标后推进/续拉 resumed/超时=正常出口/-14 与 401 fatal/断线恢复/
// 旧游标持续报错清空重拉/停服即时返回 + notifystop）、入站 context_token 与引用线索
// 与图片解密富化真链路、net 原语（sendmessage 线格式/配文+媒体两条同 run_id/上限/
// 句柄/节流/recall 可操作错误）、verifyCredential 分档、Sender caps 感知路由、
// SDK conformance harness 与工具面 13。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_TOOL_NAMES,
  FakeNetKit,
  NetError,
  ToolRouter,
  runConformance,
  createNetKit,
  type ConnectorInstance,
  type ConnectorLogger,
  type ConnectorPlugin,
  type ConnectorStatus,
  type PluginContext,
  type StatePort,
} from "@qsense/connector-sdk";
import { jsonResponse } from "@qsense/connector-sdk";
import {
  MessageItemType,
  MessageType,
  STALE_TOKEN_ERRCODE,
  WeixinApiError,
  aesEcbPaddedSize,
  createWeixinConnector,
  createWeixinInstance,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
  type GetUpdatesResp,
  type WeixinApi,
  type WeixinMessage,
} from "@qsense/connector-weixin";
import { Sender } from "../src/sender";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";

const BOT = "b0f5860fdecb-im-bot";
const USER = "f2d8a1c4b7e9@im.wechat";
const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const AES_KEY = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

// —— 假宿主（StatePort=Map；ingest/statuses 记录） ——

function fakeHost(): {
  host: PluginContext;
  ingested: Array<{ botId: string; payload: unknown }>;
  statuses: ConnectorStatus[];
  state: Map<string, string>;
} {
  // StatePort B⁺ T6 字符串化：值 = JSON 文本（实例侧 stringify/parseJsonWith 直通）
  const state = new Map<string, string>();
  const ingested: Array<{ botId: string; payload: unknown }> = [];
  const statuses: ConnectorStatus[] = [];
  const host: PluginContext = {
    log: noopLog(),
    state: {
      async get(key: string) {
        return state.get(key) ?? null;
      },
      async set(key: string, value: string) {
        state.set(key, value);
      },
      async delete(key: string) {
        state.delete(key);
      },
    } satisfies StatePort,
    ingest: (e) => ingested.push(e),
    reportStatus: (s) => statuses.push(s),
    net: createNetKit(),
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

// —— 假 iLink api：记录调用；getUpdates 按脚本出队，脚本耗尽后挂起到 abort ——

interface Call {
  method: string;
  args: unknown;
}

interface FakeApi {
  api: WeixinApi;
  calls: Call[];
  queue(items: Array<GetUpdatesResp | Error>): void;
}

function fakeApi(): FakeApi {
  const calls: Call[] = [];
  let script: Array<GetUpdatesResp | Error> = [];
  let sent = 0;
  const api: WeixinApi = {
    baseUrl: "https://ilinkai.weixin.qq.com",
    async getUpdates(buf, opts) {
      calls.push({ method: "getUpdates", args: { buf } });
      const next = script.shift();
      if (next === undefined) {
        // 脚本耗尽：挂起到 abort（模拟真实长轮询；停服即时返回而非空转）
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new WeixinApiError("请求已取消", "aborted");
      }
      if (next instanceof Error) throw next;
      return next;
    },
    async sendMessage(message) {
      calls.push({ method: "sendMessage", args: message });
      sent += 1;
      return { message_id: String(9000 + sent), ret: 0 };
    },
    async getUploadUrl(req) {
      calls.push({ method: "getUploadUrl", args: req });
      return { upload_full_url: "https://cdn.example/up" };
    },
    async notifyStart() {
      calls.push({ method: "notifyStart", args: undefined });
    },
    async notifyStop() {
      calls.push({ method: "notifyStop", args: undefined });
    },
    async getBotQrcode() {
      return { qrcode: "", qrcode_img_content: "" };
    },
    async getQrcodeStatus() {
      return { status: "wait" };
    },
  };
  return { api, calls, queue: (items) => (script = items) };
}

function pollsOf(fake: FakeApi): string[] {
  return fake.calls
    .filter((c) => c.method === "getUpdates")
    .map((c) => (c.args as { buf: string }).buf);
}

function sendsOf(fake: FakeApi): WeixinMessage[] {
  return fake.calls
    .filter((c) => c.method === "sendMessage")
    .map((c) => c.args as WeixinMessage);
}

function msg(
  id: string,
  text: string,
  contextToken?: string,
  extra: Partial<WeixinMessage> = {},
): WeixinMessage {
  return {
    message_id: id,
    from_user_id: USER,
    message_type: MessageType.USER,
    create_time_ms: 1795497600000 + Number(id),
    ...(contextToken !== undefined ? { context_token: contextToken } : {}),
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    ...extra,
  };
}

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_B64, "base64");

/** 跑一轮：入队批次 → start → 等摄取完成 → stop */
async function feed(
  inst: ConnectorInstance,
  fx: ReturnType<typeof fakeHost>,
  fake: FakeApi,
  msgs: WeixinMessage[],
  buf = "BUF-NEXT",
): Promise<void> {
  fake.queue([{ ret: 0, msgs, get_updates_buf: buf }, {}]);
  const start = inst.start();
  await waitFor(() => fx.ingested.length >= msgs.length, "ingested");
  inst.stop();
  await start;
}

// —— 轮询生命周期 ——

test("轮询：notifystart → 批次摄取（context_token/引用线索/图片解密富化真链路）→ 游标后推进 → 二轮带游标；停服 notifystop", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  // 入站图片解密富化走真链路：CDN 密文（AES-128-ECB）经 FakeNetKit 二进制应答
  const kit = new FakeNetKit();
  kit.on(`${CDN_BASE}/download`, () => new Response(new Uint8Array(encryptAesEcb(PNG, AES_KEY))));
  const inst = createWeixinInstance({
    ctx: { ...fx.host, net: kit },
    botId: BOT,
    api: fake.api,
    sendMinIntervalMs: 0,
  });
  const second = msg("2", "第二条", "CTX-B", {
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: "第二条" }, ref_msg: { svr_id: "1" } },
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: { encrypt_query_param: "M", aes_key: AES_KEY.toString("base64") },
        },
      },
    ],
  });
  await feed(inst, fx, fake, [msg("1", "第一条", "CTX-A"), second], "BUF1");

  assert.equal(fake.calls[0]!.method, "notifyStart");
  // 摄取完成时游标已推进（批次全摄取后才推进：至少一次语义）
  assert.equal(fx.state.get("poll:buf"), JSON.stringify("BUF1")); // JSON 文本值域
  // 前两次轮询：空游标 → 回带新游标（其后脚本耗尽、循环挂起等待停服）
  assert.deepEqual(pollsOf(fake).slice(0, 2), ["", "BUF1"]);
  // 入站载荷：platform 章 + 原始消息；第二条带引用线索与解密图（键 = item 下标）
  assert.equal(fx.ingested[0]!.botId, BOT);
  const p1 = fx.ingested[0]!.payload as Record<string, unknown>;
  assert.equal(p1.platform, "weixin");
  assert.equal((p1.message as WeixinMessage).message_id, "1");
  assert.equal(p1.mediaBlobs, undefined);
  const p2 = fx.ingested[1]!.payload as Record<string, unknown>;
  assert.equal(p2.quoteText, "第一条");
  assert.deepEqual(p2.mediaBlobs, {
    "1": `data:image/png;base64,${PNG.toString("base64")}`,
  });
  // context_token 按对端缓存并持久化（最新者胜）
  assert.deepEqual(JSON.parse(fx.state.get("ctx-tokens") ?? "null"), { [USER]: "CTX-B" });
  // 引用缓存：两条消息摘要入库（供后续 ID-only 引用解析）
  const quotes = JSON.parse(fx.state.get("quote-cache") ?? "null") as { q: Array<[string, string]> };
  assert.deepEqual(quotes.q, [["1", "第一条"], ["2", "第二条 | [图片]"]]);
  // 状态：首轮成功 ready
  assert.equal(fx.statuses.some((s) => s.state === "ready"), true);
  // 停服：notifystop 收尾
  assert.equal(fake.calls.at(-1)!.method, "notifyStop");
});

test("续拉：持久化游标与 context_token 存活 → 首轮带游标，状态 resumed", async () => {
  const fx = fakeHost();
  fx.state.set("poll:buf", JSON.stringify("OLD-CURSOR"));
  fx.state.set("ctx-tokens", JSON.stringify({ [USER]: "CTX-SAVED" }));
  const fake = fakeApi();
  const inst = createWeixinInstance({
    ctx: fx.host,
    botId: BOT,
    api: fake.api,
    sendMinIntervalMs: 0,
  });
  fake.queue([{}]);
  const start = inst.start();
  await waitFor(() => fx.statuses.some((s) => s.state === "resumed"), "resumed");
  assert.equal(pollsOf(fake)[0], "OLD-CURSOR");
  // 重启后出站仍能回带重启前的 context_token
  await inst.net.proactive!({ botId: BOT, target: USER, scope: "chat", content: "hi" });
  assert.equal(sendsOf(fake)[0]!.context_token, "CTX-SAVED");
  inst.stop();
  await start;
});

test("长轮询超时 = 正常出口：不报 disconnected，首轮即 ready", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  fake.queue([new WeixinApiError("请求超时", "timeout")]);
  const inst = createWeixinInstance({ ctx: fx.host, botId: BOT, api: fake.api });
  const start = inst.start();
  await waitFor(() => fx.statuses.some((s) => s.state === "ready"), "ready after timeout");
  assert.equal(fx.statuses.some((s) => s.state === "disconnected"), false);
  inst.stop();
  await start;
});

test("token 失效（errcode -14）→ fatal 退出不重试；HTTP 401 同样 fatal", async () => {
  {
    const fx = fakeHost();
    const fake = fakeApi();
    fake.queue([{ ret: 0, errcode: STALE_TOKEN_ERRCODE, errmsg: "stale" }]);
    const inst = createWeixinInstance({ ctx: fx.host, botId: BOT, api: fake.api });
    await Promise.race([
      inst.start(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("fatal 后未退出")), 2000)),
    ]);
    assert.equal(fx.statuses.at(-1)?.state, "fatal");
    assert.match(fx.statuses.at(-1)?.detail ?? "", /-14/);
    assert.equal(pollsOf(fake).length, 1);
  }
  // 401：网关层拒绝（FakeNetKit 假端点回 401）
  const fx = fakeHost();
  const kit = new FakeNetKit();
  kit.onMatch((u) => u.includes("/ilink/bot/"), (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/getupdates")) return new Response("no", { status: 401 });
    return jsonResponse({ ret: 0 }); // notifystart / notifystop
  });
  const plugin = createWeixinConnector({ net: kit });
  const inst = plugin.create({ ...fx.host, net: kit }, {
    botId: BOT,
    platform: "weixin",
    credential: { appid: BOT, token: "t" },
  });
  await Promise.race([
    inst.start(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("401 后未退出")), 4000)),
  ]);
  assert.equal(fx.statuses.at(-1)?.state, "fatal");
  assert.match(fx.statuses.at(-1)?.detail ?? "", /token|401/);
});

test("网络失败 → disconnected → 退避后恢复 ready；旧游标持续业务报错 → 清空重拉", async () => {
  {
    const fx = fakeHost();
    const fake = fakeApi();
    fake.queue([new WeixinApiError("网络请求失败", "network"), {}]);
    const inst = createWeixinInstance({
      ctx: fx.host,
      botId: BOT,
      api: fake.api,
      policy: { retryMs: 5 },
    });
    const start = inst.start();
    await waitFor(() => fx.statuses.at(-1)?.state === "ready", "ready after network error");
    assert.equal(fx.statuses.some((s) => s.state === "disconnected"), true);
    inst.stop();
    await start;
  }
  {
    const fx = fakeHost();
    fx.state.set("poll:buf", JSON.stringify("OLD"));
    const fake = fakeApi();
    fake.queue([{ ret: 1 }, { ret: 1 }, {}]);
    const inst = createWeixinInstance({
      ctx: fx.host,
      botId: BOT,
      api: fake.api,
      policy: { retryMs: 5 },
    });
    const start = inst.start();
    await waitFor(() => pollsOf(fake).length >= 3, "third poll");
    inst.stop();
    await start;
    // 旧游标连报两次 → 第 3 次起空游标重拉（驱动 resetCursor，maxFailures=2）
    assert.deepEqual(pollsOf(fake).slice(0, 3), ["OLD", "OLD", ""]);
    assert.equal(fx.state.has("poll:buf"), false);
  }
});

// —— net 原语 ——

test("net.proactive 文本：sendmessage 线格式（BOT/FINISH/单 item/context_token 回带/client_id 形制）", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  const inst = createWeixinInstance({
    ctx: fx.host,
    botId: BOT,
    api: fake.api,
    sendMinIntervalMs: 0,
  });
  await feed(inst, fx, fake, [msg("1", "你好", "CTX-1")]);
  const receipt = await inst.net.proactive!({
    botId: BOT,
    target: USER,
    scope: "chat",
    content: "收到",
  });
  assert.equal(receipt.providerMsgId, "9001");
  const sent = sendsOf(fake)[0]!;
  assert.equal(sent.from_user_id, "");
  assert.equal(sent.to_user_id, USER);
  assert.equal(sent.message_type, MessageType.BOT);
  assert.equal(sent.message_state, 2);
  assert.deepEqual(sent.item_list, [
    { type: MessageItemType.TEXT, text_item: { text: "收到" } },
  ]);
  assert.equal(sent.context_token, "CTX-1"); // 原样回带入站令牌
  assert.match(sent.client_id!, /^qsense-weixin:\d+-[0-9a-f]{8}$/);
  assert.match(sent.run_id!, /^[0-9a-f-]{36}$/);
  assert.equal("message_id" in sent, false);
  // 自发消息进引用缓存（供用户引用 bot 消息时解析正文）
  const quotes = JSON.parse(fx.state.get("quote-cache") ?? "null") as { q: Array<[string, string]> };
  assert.ok(quotes.q.some(([id, t]) => id === "9001" && t === "收到"));
});

test("net 媒体：uploadMedia 加密直传 → 无状态句柄 → 配文与图片分两条（同 run_id），图片 item 形状", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  // CDN 直传走 ctx.net（FakeNetKit）：记录密文体，回下载参数回执
  const kit = new FakeNetKit();
  const bodies: Uint8Array[] = [];
  kit.on("https://cdn.example/up", (req) => {
    bodies.push(req.body as Uint8Array);
    return new Response(undefined, { headers: { "x-encrypted-param": "DL-PARAM" } });
  });
  const inst = createWeixinInstance({
    ctx: { ...fx.host, net: kit },
    botId: BOT,
    api: fake.api,
    sendMinIntervalMs: 0,
  });
  const up = await inst.net.uploadMedia!({
    botId: BOT,
    target: USER,
    scope: "chat",
    kind: "image",
    source: { kind: "b64", data: PNG_B64 },
  });
  assert.match(up.handle, /^wxm1\./);
  // getuploadurl 入参
  const req = fake.calls.find((c) => c.method === "getUploadUrl")!.args as {
    to_user_id: string;
    media_type: number;
    rawsize: number;
    filesize: number;
    aeskey: string;
    no_need_thumb?: boolean;
  };
  assert.equal(req.to_user_id, USER);
  assert.equal(req.media_type, 1);
  assert.equal(req.rawsize, PNG.length);
  assert.equal(req.filesize, aesEcbPaddedSize(PNG.length));
  assert.equal(req.no_need_thumb, true);
  // CDN 直传的是密文：可按请求里的 aeskey 解回明文
  assert.equal(bodies.length, 1);
  assert.deepEqual(decryptAesEcb(Buffer.from(bodies[0]!), Buffer.from(req.aeskey, "hex")), PNG);

  const receipt = await inst.net.proactive!({
    botId: BOT,
    target: USER,
    scope: "chat",
    content: "配文",
    media: { kind: "image", handle: up.handle },
  });
  const sends = sendsOf(fake);
  assert.equal(sends.length, 2);
  assert.equal(sends[0]!.item_list![0]!.type, MessageItemType.TEXT);
  assert.equal(sends[1]!.item_list![0]!.type, MessageItemType.IMAGE);
  assert.equal(sends[0]!.run_id, sends[1]!.run_id); // 同一 run_id 串联
  assert.equal(receipt.providerMsgId, "9002"); // 回执取末条（媒体）的消息 id
  const img = sends[1]!.item_list![0]!.image_item!;
  assert.equal(img.media!.encrypt_query_param, "DL-PARAM");
  assert.equal(img.media!.encrypt_type, 1);
  assert.equal(img.mid_size, aesEcbPaddedSize(PNG.length));
  // aes_key = base64(hex 文本)，可解回 16 字节 key
  assert.deepEqual(parseAesKey(img.media!.aes_key!), Buffer.from(req.aeskey, "hex"));
  // 坏句柄：可操作错误
  await assert.rejects(
    () =>
      inst.net.proactive!({
        botId: BOT,
        target: USER,
        scope: "chat",
        content: "x",
        media: { kind: "image", handle: "FILEINFO_X" },
      }),
    /句柄/,
  );
});

test("net 限制与错误：4000 字上限 / 空内容 / 空 target / recall 可操作错误 / 媒体来源失败", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  const kit = new FakeNetKit();
  const inst = createWeixinInstance({
    ctx: { ...fx.host, net: kit },
    botId: BOT,
    api: fake.api,
    sendMinIntervalMs: 0,
  });
  await assert.rejects(
    () =>
      inst.net.proactive!({
        botId: BOT,
        target: USER,
        scope: "chat",
        content: "字".repeat(4001),
      }),
    /4000/,
  );
  await assert.rejects(
    () => inst.net.proactive!({ botId: BOT, target: USER, scope: "chat", content: "" }),
    /为空/,
  );
  await assert.rejects(
    () => inst.net.proactive!({ botId: BOT, target: " ", scope: "chat", content: "x" }),
    /目标会话 id/,
  );
  // 恰 4000 字可发（码点计：emoji 也按 1 计）
  await inst.net.proactive!({
    botId: BOT,
    target: USER,
    scope: "chat",
    content: "😀".repeat(4000),
  });
  assert.equal(sendsOf(fake).length, 1);
  await assert.rejects(() =>
    inst.net.recall!({
      botId: BOT,
      target: USER,
      scope: "chat",
      providerMsgId: "9001",
    }),
  );
  // 媒体来源读不到：可操作错误，且不触达 CDN（FakeNetKit 无 materialize 脚本）
  await assert.rejects(
    () =>
      inst.net.uploadMedia!({
        botId: BOT,
        target: USER,
        scope: "chat",
        kind: "image",
        source: { kind: "url", url: "https://cdn.example/missing.png" },
      }),
    /来源读取失败/,
  );
  await assert.rejects(
    () =>
      inst.net.uploadMedia!({
        botId: BOT,
        target: USER,
        scope: "chat",
        kind: "image",
        source: { kind: "b64", data: "" },
      }),
    /为空/,
  );
});

test("net 错误翻译：平台错误 → 可操作文案（-14 失效 / 网络不可达 / 其它）", async () => {
  const mk = (error: Error) =>
    createWeixinInstance({
      ctx: fakeHost().host,
      botId: BOT,
      api: {
        ...fakeApi().api,
        sendMessage: async () => {
          throw error;
        },
      },
      sendMinIntervalMs: 0,
    });
  const wire = { botId: BOT, target: USER, scope: "chat" as const, content: "x" };
  await assert.rejects(
    () => mk(new WeixinApiError("sendMessage ret=… errcode=-14", "biz", { code: -14 })).net.proactive!(wire),
    /已失效/,
  );
  await assert.rejects(
    () => mk(new WeixinApiError("网络请求失败：boom", "network")).net.proactive!(wire),
    /不可达/,
  );
  await assert.rejects(
    () =>
      mk(new WeixinApiError("HTTP 401", "http", { status: 401 })).net.proactive!(wire),
    /token 无效/,
  );
  await assert.rejects(
    () =>
      mk(new WeixinApiError("sendMessage ret=500001 errcode=- errmsg=x", "biz", { code: 500001 })).net.proactive!(
        wire,
      ),
    /发送失败.*500001/,
  );
});

test("发送节流：同一对端两次发送间隔 ≥ sendMinIntervalMs", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  const inst = createWeixinInstance({
    ctx: fx.host,
    botId: BOT,
    api: fake.api,
    sendMinIntervalMs: 120,
  });
  const t0 = Date.now();
  await inst.net.proactive!({ botId: BOT, target: USER, scope: "chat", content: "a" });
  await inst.net.proactive!({ botId: BOT, target: USER, scope: "chat", content: "b" });
  assert.ok(Date.now() - t0 >= 100, `间隔 ${Date.now() - t0}ms`);
});

test("无 context_token 的对端：照发不带 context_token 键", async () => {
  const fx = fakeHost();
  const fake = fakeApi();
  const inst = createWeixinInstance({
    ctx: fx.host,
    botId: BOT,
    api: fake.api,
    sendMinIntervalMs: 0,
  });
  await inst.net.proactive!({ botId: BOT, target: USER, scope: "chat", content: "hi" });
  assert.equal("context_token" in sendsOf(fake)[0]!, false);
});

// —— verifyCredential ——

test("verifyCredential：缺凭据 / appid 形制 / 不可达 / 401 / -14 / 通过（FakeNetKit 假端点）", async () => {
  const seen: Array<{ url: string; auth: string | undefined; type: string | undefined }> = [];
  const respond = (status: number, body: string) => {
    const kit = new FakeNetKit();
    kit.onMatch(() => true, (req) => {
      seen.push({
        url: req.url,
        auth: req.headers["authorization"],
        type: req.headers["authorizationtype"],
      });
      return new Response(body, { status });
    });
    return createWeixinConnector({ net: kit }).hooks!.verifyCredential!;
  };
  const verify = respond(200, JSON.stringify({ ret: 0 }));
  await assert.rejects(() => verify({ appid: BOT, token: "" }), /凭据缺失/);
  await assert.rejects(() => verify({ appid: "abc@im.bot", token: "tok" }), /形制/);
  // 不可达（网络档）：假端点抛 NetError network
  const deadKit = new FakeNetKit();
  deadKit.onMatch(() => true, () => new NetError("network", "connection refused"));
  await assert.rejects(
    () =>
      createWeixinConnector({ net: deadKit }).hooks!.verifyCredential!({
        appid: BOT,
        token: "tok",
      }),
    /不可达/,
  );
  await assert.rejects(() => respond(401, "no")({ appid: BOT, token: "tok" }), /token 无效/);
  await assert.rejects(
    () =>
      respond(200, JSON.stringify({ errcode: -14, errmsg: "stale" }))({
        appid: BOT,
        token: "tok",
      }),
    /token 无效/,
  );
  await verify({ appid: BOT, token: "tok" });
  // 探活走 notifystart（不用 getupdates：空游标长轮询可能取走消息却被丢弃）
  assert.equal(seen.at(-1)!.url, "https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystart");
  assert.equal(seen.at(-1)!.auth, "Bearer tok");
  assert.equal(seen.at(-1)!.type, "ilink_bot_token");
});

test("verifyCredential：凭据 base_url 校验（仅 https；非法回退缺省入口）", async () => {
  const seen: string[] = [];
  const kit = new FakeNetKit();
  kit.onMatch(() => true, (req) => {
    seen.push(req.url);
    return jsonResponse({ ret: 0 });
  });
  const verify = createWeixinConnector({ net: kit }).hooks!.verifyCredential!;
  await verify({ appid: BOT, token: "tok", base_url: "http://evil.example" });
  assert.equal(seen.at(-1)!.startsWith("https://ilinkai.weixin.qq.com/"), true);
  await verify({ appid: BOT, token: "tok", base_url: "https://ilink-sh.example.qq.com/sub/" });
  assert.equal(seen.at(-1)!.startsWith("https://ilink-sh.example.qq.com/sub/"), true);
});

test("插件声明面：caps / credentialSchema / login / 无扩展工具 → 工具面 = 基座 13", () => {
  const plugin = createWeixinConnector({});
  assert.equal(plugin.id, "weixin");
  assert.deepEqual(plugin.caps, {
    scopes: ["chat"],
    media: { image: true, voice: true, video: true, file: true },
    recall: false,
    passiveWindow: false,
    quota: false,
    proactiveOptIn: false,
  });
  assert.deepEqual(plugin.credentialSecrets, ["token"]);
  assert.deepEqual(plugin.login, {
    kind: "qr-pair",
    create: "/login/qr/create",
    poll: "/login/qr/poll",
  });
  assert.deepEqual(
    Object.keys(plugin.credentialSchema.properties as Record<string, unknown>),
    ["appid", "token", "base_url", "owner_id"],
  );
  const router = new ToolRouter(BASE_TOOL_NAMES);
  router.registerPlugin(plugin);
  assert.deepEqual(router.names(), [...BASE_TOOL_NAMES].sort());
});

// —— Sender caps 感知路由（核心接线行为） ——

function setupDb(): { db: DB; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wx-sender-"));
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

test("Sender caps 路由：passiveWindow=false 恒主动通道（新鲜入站消息也不绑被动）；私聊门禁要求 opt-in", async () => {
  const fx = setupDb();
  try {
    const repo = new Repo(fx.db);
    repo.ensureRuntime();
    repo.setSendEnable(true);
    const registry = new BotRegistry({ db: fx.db });
    await registry.add({ platform: "weixin", credentials: { appid: BOT, token: "t" } });
    repo.saveMessage({
      botId: BOT,
      scope: "chat",
      scopeId: USER,
      msgId: "in-1",
      authorOpenid: USER,
      ts: Date.now(), // 新鲜消息：QQ 路径会绑被动窗口
      text: "在吗",
      content: "在吗",
      quote: null,
      records: [],
      mentions: [],
      attachments: [],
      rawJson: "{}",
    });
    const fxh = fakeHost();
    const fake = fakeApi();
    const inst = createWeixinInstance({
      ctx: fxh.host,
      botId: BOT,
      api: fake.api,
      sendMinIntervalMs: 0,
    });
    const plugin = createWeixinConnector({});
    const sender = new Sender({
      log: createLoggerCompat(),
      repo,
      bots: registry,
      transportFor: () => inst.net,
      capsFor: (botId) => (botId === BOT ? plugin.caps : undefined),
    });
    // proactiveOptIn=false（2026-11-24 caps 化）：opt-in 开关从未置位也放行——
    // iLink 无 opt 事件概念，「能对话即能发」；chat-opt 等价映射仍由插件入站落地
    const r0 = await sender.sendAuto(BOT, USER, "hi", undefined, "chat");
    assert.equal(r0.channel, "proactive");
    assert.equal(r0.status, "sent");
    assert.equal(sendsOf(fake).length, 1);
    // chat-opt 置位后照常发送，恒走主动通道
    repo.setC2cSwitch(BOT, USER, true);
    const r = await sender.sendAuto(BOT, USER, "hello wx", undefined, "chat");
    assert.equal(r.channel, "proactive");
    assert.equal(r.status, "sent");
    assert.equal(r.provider_msg_id, "9002");
    // 自发消息本地补记（direction=1，作者标 yourself）
    const outgoing = repo.getMessageByMsgId(BOT, "chat", USER, "9002");
    assert.ok(outgoing);
    assert.equal(Number(outgoing.direction), 1);
  } finally {
    fx.close();
  }
});

// —— SDK conformance harness ——

test("conformance harness：声明闸门 / 生命周期 / 原语齐备 / normalize 形状 / 探针（FakeNetKit）", async () => {
  const calls: string[] = [];
  const kit = new FakeNetKit();
  kit.onMatch((u) => u.includes("/ilink/bot/"), async (req) => {
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (path.endsWith("/getupdates")) {
      // 每次长轮询 20ms 后回空批次（真定时器：既模拟服务端挂起，又让出事件循环）
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse({ ret: 0, msgs: [] });
    }
    if (path.endsWith("/sendmessage")) {
      return jsonResponse({ ret: 0, message_id: 777 });
    }
    return jsonResponse({ ret: 0 }); // notifystart / notifystop
  });
  const plugin = createWeixinConnector({ net: kit, qr: { pollTimeoutMs: 40 } });
  // 生命周期适配：实例 start() 按宿主纪律阻塞到停服，而 harness 的 `await start()`
  // 需要「就绪即返回」——包一层：首轮 ready 后返回，轮询循环继续后台跑直到 stop()
  const adapted: ConnectorPlugin = {
    ...plugin,
    create: (host, creds) => {
      const statuses: ConnectorStatus[] = [];
      const wrapped: PluginContext = {
        ...host,
        reportStatus: (s) => {
          statuses.push(s);
          host.reportStatus(s);
        },
      };
      const real = plugin.create(wrapped, creds);
      return {
        net: real.net,
        stop: () => real.stop(),
        start: async () => {
          void real.start().catch(() => undefined);
          await waitFor(() => statuses.some((s) => s.state === "ready"), "ready");
        },
      };
    },
  };
  const report = await runConformance(adapted, {
    net: kit,
    creds: {
      botId: "bot-wx",
      platform: "weixin",
      credential: { appid: "bot-wx", token: "t" },
    },
    normalizeSample: { platform: "weixin", message: msg("1", "样本") },
    probe: async (_host, instance) => {
      const receipt = await instance.net.proactive!({
        botId: "bot-wx",
        target: USER,
        scope: "chat",
        content: "probe",
      });
      assert.equal(receipt.providerMsgId, "777");
    },
  });
  assert.equal(report.passed, true, JSON.stringify(report.checks));
  assert.deepEqual(
    report.checks.map((c) => c.name),
    [
      "declaration-gates",
      "lifecycle",
      "host-state-roundtrip",
      "net-primitives",
      "normalize-shape",
      "probe",
    ],
  );
  assert.ok(calls.includes("/ilink/bot/msg/notifystart"));
  assert.ok(calls.includes("/ilink/bot/msg/notifystop"));
});

function createLoggerCompat(): import("../src/utils/logger").Logger {
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
  const deadline = Date.now() + 4000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
