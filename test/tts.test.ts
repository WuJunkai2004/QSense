// TTS（语音合成发送）验收：
// - 单元：endpoint 拼接（/v1 补齐/不重复/尾斜杠）、请求体与鉴权头、mp3 魔数校验、
//   空文本/超长拒绝、上游 500/非音频响应的可操作错误
// - HTTP 集成（buildServer + 假 TTS fetch）：config 保存/打码回显/空 key 保留旧值、
//   test 试听（草稿优先/回退/上游 502）、settings 的 tts_enabled 批量开关
// - 工具层集成（runTool + 真 Sender + apiFor mock）：send_media "tts:<文本>" 全链路
//   （双闸门：未配置/未启用的可操作拒绝；合成产物按语音条上传发送）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry } from "../src/bots";
import type { GatewaySupervisor } from "../src/gateway";
import type { TokenService } from "../src/gateway/token";
import { createLogger } from "../src/logger";
import { Sender } from "../src/sender";
import { buildServer } from "../src/server/http";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import { TtsError, synthesizeSpeech, ttsEndpoint, type TtsDeps } from "../src/tts";
import { runTool } from "../src/tools/defs";

const BOT = "10001";
const GROUP = "G1";

/** ID3 头的最小 mp3 假体（魔数校验通过即可） */
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16)]);

function fakeTts(
  handler: (url: string, body: Record<string, unknown>, headers: Record<string, string>) => Response,
): typeof fetch & { calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const impl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body, headers });
    return handler(String(url), body, headers);
  };
  return Object.assign(impl, { calls }) as typeof fetch & {
    calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;
  };
}

function okMp3(): Response {
  return new Response(MP3, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
}

test("tts 单元：endpoint 拼接（补 /v1、不重复、尾斜杠）", () => {
  assert.equal(
    ttsEndpoint("https://api.openai.com"),
    "https://api.openai.com/v1/audio/speech",
  );
  assert.equal(
    ttsEndpoint("https://api.openai.com/"),
    "https://api.openai.com/v1/audio/speech",
  );
  assert.equal(
    ttsEndpoint("https://api.siliconflow.cn/v1"),
    "https://api.siliconflow.cn/v1/audio/speech",
  );
  assert.equal(
    ttsEndpoint("http://127.0.0.1:8000/v1/"),
    "http://127.0.0.1:8000/v1/audio/speech",
  );
});

test("tts 单元：合成成功（请求体/鉴权头/返回字节）与参数拒绝", async () => {
  const fetchImpl = fakeTts((_url, _body, headers) => {
    assert.equal(headers.Authorization, "Bearer sk-test");
    return okMp3();
  });
  const deps: TtsDeps = { fetchImpl };
  const cfg = {
    base_url: "https://tts.example.com/v1",
    api_key: "sk-test",
    model: "tts-1",
    voice: "alloy",
  };
  const { buf, mime } = await synthesizeSpeech(cfg, "  你好呀  ", deps);
  assert.equal(mime, "audio/mpeg");
  assert.equal(buf.subarray(0, 3).toString("latin1"), "ID3");
  const c = fetchImpl.calls[0]!;
  assert.equal(c.url, "https://tts.example.com/v1/audio/speech");
  assert.deepEqual(c.body, {
    model: "tts-1",
    input: "你好呀", // trim 过
    voice: "alloy",
    response_format: "mp3",
  });

  // api_key 空 = 不带 Authorization 头（自建无鉴权网关）
  const anon = fakeTts(() => okMp3());
  await synthesizeSpeech({ ...cfg, api_key: "" }, "x", { fetchImpl: anon });
  assert.equal(anon.calls[0]!.headers.Authorization, undefined);

  // 空文本 / 超长
  await assert.rejects(
    synthesizeSpeech(cfg, "   ", { fetchImpl: anon }),
    /没有内容/,
  );
  await assert.rejects(
    synthesizeSpeech(cfg, "长".repeat(1001), { fetchImpl: anon }),
    /1000/,
  );
});

test("tts 单元：上游 500 与非音频响应 → 可操作 TtsError", async () => {
  const cfg = { base_url: "https://tts.example.com", api_key: "k", model: "m", voice: "v" };
  const fail = fakeTts(() => new Response("upstream boom", { status: 500 }));
  await assert.rejects(
    synthesizeSpeech(cfg, "hi", { fetchImpl: fail }),
    (e: unknown) => e instanceof TtsError && e.message.includes("500") && e.message.includes("boom"),
  );
  const html = fakeTts(() => new Response("<html>gateway</html>", { status: 200 }));
  await assert.rejects(
    synthesizeSpeech(cfg, "hi", { fetchImpl: html }),
    /不是音频/,
  );
});

// —— HTTP 集成：/ui/api/tts/* 与 settings 的 tts_enabled ——

const TOKEN = "tts-test-admin-token-0123456789abc";

interface HttpFixture {
  baseUrl: string;
  tts: typeof fetch & { calls: Array<{ url: string; body: Record<string, unknown> }> };
  repo: Repo;
  close: () => Promise<void>;
}

async function setupHttp(): Promise<HttpFixture> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-tts-http-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  repo.ensureRuntime();
  repo.setAdminToken(TOKEN);
  const registry = new BotRegistry({ db });
  await registry.add({ appid: BOT, secret: "s1", name: "tts-bot" });
  const tts = fakeTts(() => okMp3());
  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    version: "0.2.0",
    registry,
    supervisor: {} as unknown as GatewaySupervisor,
    tokens: {} as unknown as TokenService,
    botStatuses: () => [],
    ttsDeps: { fetchImpl: tts as unknown as typeof fetch },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tts,
    repo,
    close: async () => {
      await app.close();
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* best-effort */
      }
    },
  };
}

const auth = (): Record<string, string> => ({
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
});

test("tts 集成：config 保存/打码回显/空 key 保留旧值；缺字段 400", async () => {
  const fx = await setupHttp();
  try {
    const put = (body: Record<string, unknown>): Promise<Response> =>
      fetch(`${fx.baseUrl}/ui/api/tts/config`, {
        method: "PUT",
        headers: auth(),
        body: JSON.stringify(body),
      });

    const r1 = await put({
      base_url: "https://tts.example.com/v1",
      api_key: "sk-secret-9999",
      model: "tts-1",
      voice: "alloy",
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), {
      ok: true,
      configured: true,
      api_key_masked: "sk-s…9999",
    });

    const got = await fetch(`${fx.baseUrl}/ui/api/tts/config`, { headers: auth() });
    const cfg = (await got.json()) as Record<string, unknown>;
    assert.equal(cfg.configured, true);
    assert.equal(cfg.base_url, "https://tts.example.com/v1");
    assert.equal(cfg.api_key_masked, "sk-s…9999"); // 打码，绝不回原文
    assert.ok(!("api_key" in cfg), "响应不得含 api_key 原文");

    // api_key 留空 = 保留已存值；其余字段更新
    const r2 = await put({
      base_url: "http://127.0.0.1:8000/v1",
      api_key: "",
      model: "fish",
      voice: "wanwan",
    });
    assert.equal(r2.status, 200);
    const stored = fx.repo.getTtsConfig();
    assert.equal(stored?.api_key, "sk-secret-9999");
    assert.equal(stored?.model, "fish");

    // 缺 voice → 400 可操作
    const r3 = await put({ base_url: "x", model: "m" });
    assert.equal(r3.status, 400);
  } finally {
    await fx.close();
  }
});

test("tts 集成：test 试听（草稿优先/回退已存/未配置 400/上游 502）", async () => {
  const fx = await setupHttp();
  try {
    const post = (body: Record<string, unknown>): Promise<Response> =>
      fetch(`${fx.baseUrl}/ui/api/tts/test`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify(body),
      });

    // 未配置任何东西 → 400
    const r0 = await post({});
    assert.equal(r0.status, 400);
    assert.match(((await r0.json()) as { error: string }).error, /尚未配置完整/);

    // 存一份基准配置
    fx.repo.setTtsConfig({
      base_url: "https://stored.example.com/v1",
      api_key: "sk-stored",
      model: "stored-model",
      voice: "alloy",
    });

    // 全空请求体 → 回退已存配置（断言上游收到 stored-model）
    const r1 = await post({});
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("content-type"), "audio/mpeg");
    const bytes = Buffer.from(await r1.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString("latin1"), "ID3");
    assert.equal(fx.tts.calls.at(-1)!.body.model, "stored-model");
    assert.equal(fx.tts.calls.at(-1)!.body.input, "hi"); // 固定试听词

    // 草稿优先：只改 model → 上游收到草稿值，api_key 仍回退已存
    const r2 = await post({ model: "draft-model" });
    assert.equal(r2.status, 200);
    assert.equal(fx.tts.calls.at(-1)!.body.model, "draft-model");
    assert.equal(
      (fx.tts.calls.at(-1)!.body as Record<string, string>).voice,
      "alloy",
    );
  } finally {
    await fx.close();
  }

  // 上游 500 → 502 + 可操作文案
  const dir = mkdtempSync(join(tmpdir(), "qqbot-tts-502-"));
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);
    repo.ensureRuntime();
    repo.setAdminToken(TOKEN);
    repo.setTtsConfig({
      base_url: "https://dead.example.com",
      api_key: "k",
      model: "m",
      voice: "v",
    });
    const registry = new BotRegistry({ db });
    await registry.add({ appid: BOT, secret: "s", name: "n" });
    const app = buildServer({
      log: createLogger("error"),
      db,
      repo,
      version: "0.2.0",
      registry,
      supervisor: {} as unknown as GatewaySupervisor,
      tokens: {} as unknown as TokenService,
      botStatuses: () => [],
      ttsDeps: {
        fetchImpl: fakeTts(() => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ui/api/tts/test`, {
        method: "POST",
        headers: auth(),
        body: "{}",
      });
      assert.equal(res.status, 502);
      assert.match(((await res.json()) as { error: string }).error, /500/);
    } finally {
      await app.close();
      db.close();
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

test("tts 集成：settings 的 tts_enabled 批量开关（回读 + 无效项 400）", async () => {
  const fx = await setupHttp();
  try {
    const put = await fetch(`${fx.baseUrl}/ui/api/settings`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ tts_enabled: [{ appid: BOT, enabled: true }] }),
    });
    assert.equal(put.status, 200);
    const s1 = (await put.json()) as { bots: Array<{ appid: string; tts_enabled: boolean }> };
    assert.equal(s1.bots.find((b) => b.appid === BOT)?.tts_enabled, true);
    assert.equal(fx.repo.getTtsEnabled(BOT), true);

    await fetch(`${fx.baseUrl}/ui/api/settings`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ tts_enabled: [{ appid: BOT, enabled: false }] }),
    });
    assert.equal(fx.repo.getTtsEnabled(BOT), false);

    // 无效 appid / 缺 enabled → 400，配置不落
    const bad = await fetch(`${fx.baseUrl}/ui/api/settings`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ tts_enabled: [{ appid: "NOPE", enabled: true }] }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await fx.close();
  }
});

// —— 工具层集成：send_media "tts:<文本>"（runTool + 真 Sender + apiFor mock）——

interface ToolFixture {
  db: DB;
  repo: Repo;
  registry: BotRegistry;
  sender: Sender;
  uploads: Array<{ mediaType: string; srcKind: string }>;
  calls: Array<{ scope: string; targetId: string; body: Record<string, unknown> }>;
  close: () => void;
}

function setupTool(): ToolFixture {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-tts-tool-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  db.prepare(
    `INSERT INTO bots(appid, name, secret, agent_token, allow_groups, auth_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(BOT, "t", "s", "a".repeat(48), JSON.stringify([GROUP]), "uncertified", Date.now());
  repo.ensureRuntime();
  repo.setSendEnable(true);
  const registry = new BotRegistry({ db });
  const uploads: ToolFixture["uploads"] = [];
  const calls: ToolFixture["calls"] = [];
  const mock = {
    async sendRaw(
      scope: "group" | "chat",
      targetId: string,
      _creds: unknown,
      body: Record<string, unknown>,
    ) {
      calls.push({ scope, targetId, body });
      return { id: `PROVIDER_${calls.length}` };
    },
    async recallMessage() {},
    async uploadMedia(
      scope: "group" | "chat",
      targetId: string,
      _creds: unknown,
      src: { kind: string },
      mediaType: string,
    ) {
      uploads.push({ mediaType, srcKind: src.kind });
      void scope;
      void targetId;
      return "FILEINFO_1";
    },
  };
  const sender = new Sender({
    log: createLogger("error"),
    db,
    repo,
    tokenManager: {} as never,
    bots: registry,
    apiFor: () => mock as never,
  });
  return {
    db,
    repo,
    registry,
    sender,
    uploads,
    calls,
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

test("tts 工具层：send_media tts: 全链路（合成→语音条上传→发送）", async () => {
  const fx = setupTool();
  try {
    fx.repo.setTtsConfig({
      base_url: "https://tts.example.com/v1",
      api_key: "k",
      model: "tts-1",
      voice: "alloy",
    });
    fx.repo.setTtsEnabled(BOT, true);
    const fetchImpl = fakeTts((_url, body) => {
      assert.equal(body.input, "今天天气不错");
      return okMp3();
    });
    const ctx = {
      repo: fx.repo,
      botId: BOT,
      sender: fx.sender,
      bots: fx.registry,
      ttsDeps: { fetchImpl },
    };
    const r = await runTool(
      "send_media",
      { id: GROUP, media: "tts:今天天气不错", text: "语音播报" },
      ctx,
    );
    assert.ok(!r.isError, r.text);
    assert.equal(fx.uploads.length, 1);
    assert.equal(fx.uploads[0]!.mediaType, "voice", "TTS 产物应按语音条上传");
    assert.equal(fx.uploads[0]!.srcKind, "b64");
    assert.equal(fx.calls.length, 1, "应发出一条消息");
  } finally {
    fx.close();
  }
});

test("tts 工具层：双闸门可操作拒绝（未配置 / 未启用）", async () => {
  const fx = setupTool();
  try {
    const ctx = {
      repo: fx.repo,
      botId: BOT,
      sender: fx.sender,
      bots: fx.registry,
      ttsDeps: { fetchImpl: fakeTts(() => okMp3()) },
    };

    // 未配置全局 TTS
    const r1 = await runTool(
      "send_media",
      { id: GROUP, media: "tts:你好" },
      ctx,
    );
    assert.equal(r1.isError, true);
    assert.match(r1.text, /TTS 未配置/);
    assert.match(r1.text, /设置页/);

    // 配置了但该 bot 未启用
    fx.repo.setTtsConfig({
      base_url: "https://tts.example.com/v1",
      api_key: "k",
      model: "tts-1",
      voice: "alloy",
    });
    const r2 = await runTool(
      "send_media",
      { id: GROUP, media: "tts:你好" },
      ctx,
    );
    assert.equal(r2.isError, true);
    assert.match(r2.text, /未启用语音/);
    assert.ok(fx.uploads.length === 0 && fx.calls.length === 0, "拒绝时不得有副作用");

    // TTS 上游失败 → 错误透传（含 TTS 字样），不发送
    fx.repo.setTtsEnabled(BOT, true);
    const badFetch = fakeTts(() => new Response("boom", { status: 500 }));
    const r3 = await runTool(
      "send_media",
      { id: GROUP, media: "tts:你好" },
      { ...ctx, ttsDeps: { fetchImpl: badFetch } },
    );
    assert.equal(r3.isError, true);
    assert.match(r3.text, /TTS/);
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.close();
  }
});
