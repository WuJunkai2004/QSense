// M7 验收（WebUI API）：/ui 静态托管（未构建 503 / 正常 / 防目录穿越）、/ui/api 鉴权、
// bootstrap/groups/messages 分页与增量/message 详情/members/sends/quota、
// 运行时添加移除 bot（联动 supervisor 与 token/会话清理）、发送端点与门禁。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry } from "../src/bots";
import { createLogger } from "../src/utils/logger";
import { Sender } from "../src/sender";
import { buildServer } from "../src/server/http";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import { makeFakeRuntime } from "./helpers/qq-runtime";
import { ConnectorRegistry } from "@qsense/connector-sdk";
import type { ConnectorNet, ProactiveWire, ReplyWire } from "@qsense/connector-sdk";
import type { ConnectorRuntime } from "../src/connectors/runtime";
import { createWeixinConnector } from "@qsense/connector-weixin";

const TOKEN = "m7-test-token-0123456789abcdef";
const BOT = "10001";
const GROUP = "G1";

interface MockNet {
  replies: ReplyWire[];
  proactives: ProactiveWire[];
}

/** 发送原语假件（ConnectorNet 形状）：记录 reply/proactive wire，回执 PROVIDER_N */
function makeNetMock(): MockNet & ConnectorNet {
  const replies: ReplyWire[] = [];
  const proactives: ProactiveWire[] = [];
  return {
    replies,
    proactives,
    async reply(wire) {
      replies.push(wire);
      return { providerMsgId: `PROVIDER_${replies.length + proactives.length}` };
    },
    async proactive(wire) {
      proactives.push(wire);
      return { providerMsgId: `PROVIDER_${replies.length + proactives.length}` };
    },
    async recall() {},
    async uploadMedia() {
      return { handle: "FILEINFO_1" };
    },
  };
}

interface Fixture {
  baseUrl: string;
  net: MockNet;
  db: import("../src/store/db").DB;
  repo: Repo;
  agentToken: string;
  added: string[];
  removed: string[];
  cleared: string[];
  close: () => Promise<void>;
}

async function setupServer(seedMessages = true): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-m7-ui-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);

  if (seedMessages) {
    for (let i = 1; i <= 5; i += 1) {
      repo.saveMessage({
        botId: BOT,
        scope: "group",
        scopeId: GROUP,
        msgId: `M${i}`,
        authorOpenid: `U_${i}`,
        authorName: `成员${i}`,
        authorRole: i === 1 ? "owner" : "member",
        ts: Date.now() - (6 - i) * 30_000,
        content: `消息正文${i}`,
        mentions: [],
        text: `消息正文${i}`,
        quote: null,
        records: [],
        attachments: [],
        raw: { id: `M${i}`, echoes: true },
      });
    }
    repo.setGroupSwitch(BOT, GROUP, true);
  }

  // M9：注册制台架——admin token 固定为 TOKEN（鉴权用），基座 bot 入表，发送开关走库
  repo.ensureRuntime();
  repo.setAdminToken(TOKEN);
  repo.setSendEnable(true);
  const registry = new BotRegistry({
    db,
    verify: async (_platform, credentials) => {
      if (credentials["secret"] === "bad") throw new Error("401 invalid credentials");
    },
  });
  await registry.add({
    credentials: { appid: BOT, secret: "s1" },
    name: "基座",
    allowGroups: [GROUP],
  });
  // 已有 bot 的 token 反查（MCP 开关测试用）：轮换接口不回显旧值，从域层取当前值
  const agentToken = registry.agentTokenOf(BOT) ?? "";

  const api = makeNetMock();
  const sender = new Sender({
    log: createLogger("error"),
    repo,
    bots: registry,
    transportFor: () => api,
  });

  const fxRuntime = makeFakeRuntime({ db, repo, registry });

  // 假 UI 产物：index.html + assets/app.js
  const uiDir = join(dir, "fake-ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(
    join(uiDir, "index.html"),
    "<!doctype html><title>m7-fake-ui</title>",
  );
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log('m7');\n");

  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    sender,
    version: "0.2.0",
    registry,
    connectors: fxRuntime.runtime,
    botStatuses: () => [{ botId: BOT, state: "ready" }],
    uiDistDir: uiDir,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    net: api,
    db,
    repo,
    agentToken,
    added: fxRuntime.added,
    removed: fxRuntime.removed,
    cleared: fxRuntime.cleared,
    close: async () => {
      await app.close();
      db.close();
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        /* best-effort */
      }
    },
  };
}

function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function get(
  url: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}${path}`, { headers });
}

test("M7-U1 /ui 静态：html 与 asset 正常出、防目录穿越、缺文件 404", async () => {
  const fx = await setupServer();
  try {
    const html = await fetch(`${fx.baseUrl}/ui`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await html.text(), /m7-fake-ui/);

    const js = await fetch(`${fx.baseUrl}/ui/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    const trav = await fetch(`${fx.baseUrl}/ui/..%2f..%2fqqbot.db`, {
      redirect: "manual",
    });
    assert.equal(trav.status, 400);

    const missing = await fetch(`${fx.baseUrl}/ui/nope.js`);
    assert.equal(missing.status, 404);
  } finally {
    await fx.close();
  }
});

test("M7-U2 /ui/api 鉴权：无 token / 错 token 一律 401", async () => {
  const fx = await setupServer(false);
  try {
    assert.equal((await fetch(`${fx.baseUrl}/ui/api/bootstrap`)).status, 401);
    assert.equal(
      (
        await fetch(`${fx.baseUrl}/ui/api/bootstrap`, {
          headers: { Authorization: "Bearer wrong-token-wrong-token" },
        })
      ).status,
      401,
    );
  } finally {
    await fx.close();
  }
});

test("M7-U3 bootstrap：bots 含来源/网关状态，发送与白名单口径正确", async () => {
  const fx = await setupServer(false);
  try {
    const res = await get(fx.baseUrl, "/ui/api/bootstrap", authHeaders());
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version: string;
      send_enabled: boolean;
      bots: Array<{
        appid: string;
        allow_groups: string[];
        gateway: string;
        name: string;
        tts_enabled?: boolean;
      }>;
    };
    assert.equal(body.version, "0.2.0");
    assert.equal(body.send_enabled, true);
    // M8：白名单按 bot 落库（bots 表），不再是顶层全局字段；M9：含 auth_level；
    // TTS（kv 开关）：bootstrap 带 tts_enabled（缺省 false）
    assert.deepEqual(body.bots, [
      {
        appid: BOT,
        name: "基座",
        allow_groups: [GROUP],
        auth_level: "uncertified",
        tts_enabled: false,
        receive_enabled: true,
        mcp_enabled: true,
        gateway: "ready",
      },
    ]);
  } finally {
    await fx.close();
  }
});

test("M7-U4 groups：成员数 + 最后消息摘要", async () => {
  const fx = await setupServer();
  try {
    const res = await get(
      fx.baseUrl,
      `/ui/api/groups?bot=${BOT}`,
      authHeaders(),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      groups: Array<{
        group_openid: string;
        member_count: number;
        last: { snippet: string } | null;
      }>;
    };
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].group_openid, GROUP);
    assert.equal(body.groups[0].member_count, 5);
    assert.match(body.groups[0].last?.snippet ?? "", /消息正文5/);
  } finally {
    await fx.close();
  }
});

test("M7-U5 messages：默认最新页（升序）、before 翻更早、after 增量", async () => {
  const fx = await setupServer();
  try {
    const h = authHeaders();
    const page1 = (await (
      await get(
        fx.baseUrl,
        `/ui/api/messages?bot=${BOT}&group=${GROUP}&limit=2`,
        h,
      )
    ).json()) as {
      messages: Array<{ rid: number; msg_id: string; content: string }>;
      has_more: boolean;
      next_before: number;
    };
    assert.deepEqual(
      page1.messages.map((m) => m.msg_id),
      ["M4", "M5"],
    );
    assert.equal(page1.has_more, true);

    const page2 = (await (
      await get(
        fx.baseUrl,
        `/ui/api/messages?bot=${BOT}&group=${GROUP}&limit=2&before=${page1.next_before}`,
        h,
      )
    ).json()) as typeof page1 & { has_more: boolean };
    assert.deepEqual(
      page2.messages.map((m) => m.msg_id),
      ["M2", "M3"],
    );

    const after = (await (
      await get(
        fx.baseUrl,
        `/ui/api/messages?bot=${BOT}&group=${GROUP}&after=${page1.messages[1].rid}`,
        h,
      )
    ).json()) as { mode: string; messages: Array<{ msg_id: string }> };
    assert.equal(after.mode, "after");
    assert.deepEqual(
      after.messages.map((m) => m.msg_id),
      [],
    );
  } finally {
    await fx.close();
  }
});

test("M7-U6 message 详情：raw/elements 全量透出（智能体视角）", async () => {
  const fx = await setupServer();
  try {
    const res = await get(
      fx.baseUrl,
      `/ui/api/message?bot=${BOT}&group=${GROUP}&msg_id=M1`,
      authHeaders(),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      raw: { echoes: boolean };
      content: string;
    };
    assert.equal(body.raw.echoes, true);
    assert.match(body.content, /消息正文1/);
    assert.equal(
      (
        await get(
          fx.baseUrl,
          `/ui/api/message?bot=${BOT}&group=${GROUP}&msg_id=NOPE`,
          authHeaders(),
        )
      ).status,
      404,
    );
  } finally {
    await fx.close();
  }
});

test("M7-U7 运行时添加 bot：联动 supervisor.addBot、bootstrap 可见、重复与坏凭据 400", async () => {
  const fx = await setupServer(false);
  try {
    const ok = await fetch(`${fx.baseUrl}/ui/api/bots`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ appid: "20002", secret: "s2", name: "二号" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(fx.added, ["20002"]);

    const boot = (await (
      await get(fx.baseUrl, "/ui/api/bootstrap", authHeaders())
    ).json()) as { bots: Array<{ appid: string; dynamic: boolean }> };
    assert.deepEqual(
      boot.bots.map((b) => b.appid),
      [BOT, "20002"],
    );

    const dup = await fetch(`${fx.baseUrl}/ui/api/bots`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ appid: "20002", secret: "s2" }),
    });
    assert.equal(dup.status, 400);

    const badSecret = await fetch(`${fx.baseUrl}/ui/api/bots`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ appid: "30003", secret: "bad" }),
    });
    assert.equal(badSecret.status, 400);
    assert.deepEqual(fx.added, ["20002"]); // 未联动
  } finally {
    await fx.close();
  }
});

test("M7-U8 移除 bot：不存在 → 400（不在注册表）；存在 → 200 且联动 removeBot + token/会话清理", async () => {
  const fx = await setupServer(false);
  try {
    const h = authHeaders({ "Content-Type": "application/json" });
    await fetch(`${fx.baseUrl}/ui/api/bots`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ appid: "20002", secret: "s2" }),
    });
    // M8：bots 表是唯一权威——删除不存在的 appid → 400（env 基座概念已废除）
    const missing = await fetch(`${fx.baseUrl}/ui/api/bots/99999`, {
      method: "DELETE",
      headers: authHeaders(), // DELETE 无 body：不能带 json Content-Type（Fastify 会因空体报 400）
    });
    assert.equal(missing.status, 400);
    assert.match(
      ((await missing.json()) as { error: string }).error,
      /不在注册表中/,
    );

    const del = await fetch(`${fx.baseUrl}/ui/api/bots/20002`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(del.status, 200);
    assert.deepEqual(fx.removed, ["20002"]);
    assert.deepEqual(fx.cleared, ["20002"]);
  } finally {
    await fx.close();
  }
});

test("M7-U12 改备注名：PATCH 即时落库；空名回落 appid；未知 appid → 400", async () => {
  const fx = await setupServer(false);
  try {
    const h = authHeaders({ "Content-Type": "application/json" });
    await fetch(`${fx.baseUrl}/ui/api/bots`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ appid: "20002", secret: "s2" }),
    });

    const renamed = await fetch(`${fx.baseUrl}/ui/api/bots/20002`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "  雅南  " }),
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await renamed.json()) as { bot: { name: string } }, {
      ok: true,
      bot: { appid: "20002", name: "雅南" },
    });
    const settings = (await (
      await fetch(`${fx.baseUrl}/ui/api/settings`, { headers: authHeaders() })
    ).json()) as { bots: Array<{ appid: string; name: string }> };
    assert.equal(
      settings.bots.find((b) => b.appid === "20002")?.name,
      "雅南",
      "settings 即时反映新备注",
    );

    // 空名回落 appid
    const fallback = await fetch(`${fx.baseUrl}/ui/api/bots/20002`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(fallback.status, 200);
    assert.equal(
      ((await fallback.json()) as { bot: { name: string } }).bot.name,
      "20002",
    );

    const missing = await fetch(`${fx.baseUrl}/ui/api/bots/99999`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(missing.status, 400);
    assert.match(
      ((await missing.json()) as { error: string }).error,
      /不在注册表中/,
    );
  } finally {
    await fx.close();
  }
});

test("M7-U13 每 bot 开关：接收消息联动网关增删；MCP 关闭后该 token 一律 403", async () => {
  const fx = await setupServer(false);
  try {
    const h = authHeaders({ "Content-Type": "application/json" });
    const toggle = async (body: unknown): Promise<Response> =>
      fetch(`${fx.baseUrl}/ui/api/settings`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify(body),
      });
    const mcpInit = async (): Promise<Response> =>
      fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${fx.agentToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {},
          id: 1,
        }),
      });

    // 缺省两把开关都开
    const settings = (await (
      await fetch(`${fx.baseUrl}/ui/api/settings`, { headers: authHeaders() })
    ).json()) as {
      bots: Array<{ receive_enabled: boolean; mcp_enabled: boolean }>;
    };
    assert.equal(settings.bots[0].receive_enabled, true);
    assert.equal(settings.bots[0].mcp_enabled, true);

    // 关接收 → 断开该 bot 网关；开接收 → 重新接入
    const off = await toggle({ receive_enabled: [{ appid: BOT, enabled: false }] });
    assert.equal(off.status, 200);
    const offBody = (await off.json()) as {
      bots: Array<{ receive_enabled: boolean }>;
    };
    assert.equal(offBody.bots[0].receive_enabled, false);
    assert.deepEqual(fx.removed, [BOT]);
    const on = await toggle({ receive_enabled: [{ appid: BOT, enabled: true }] });
    assert.equal(on.status, 200);
    assert.deepEqual(fx.added, [BOT]);

    // 关 MCP → 该 bot 的 agent_token 访问 /mcp 一律 403（不触达 transport）
    const mcpOff = await toggle({ mcp_enabled: [{ appid: BOT, enabled: false }] });
    assert.equal(mcpOff.status, 200);
    const denied = await mcpInit();
    assert.equal(denied.status, 403);
    assert.match(
      ((await denied.json()) as { error: { message: string } }).error.message,
      /MCP 访问已在 WebUI 设置页禁用/,
    );

    // 恢复 MCP → 403 闸门解除（后续 400 属 initialize 载荷校验，与本开关无关）
    await toggle({ mcp_enabled: [{ appid: BOT, enabled: true }] });
    assert.notEqual((await mcpInit()).status, 403);

    // 未知 appid → 400 可操作错误
    const bad = await toggle({ receive_enabled: [{ appid: "99999", enabled: false }] });
    assert.equal(bad.status, 400);
    assert.match(
      ((await bad.json()) as { error: string }).error,
      /appid 已注册/,
    );
  } finally {
    await fx.close();
  }
});

test("M7-U11 整群删除（原 MCP forget 迁入）：admin 鉴权门 + 清缓存 + sends 保留", async () => {
  const fx = await setupServer();
  try {
    // 破坏性操作必须过 admin 鉴权
    const noAuth = await fetch(`${fx.baseUrl}/ui/api/groups/${GROUP}`, {
      method: "DELETE",
    });
    assert.equal(noAuth.status, 401);

    const del = await fetch(`${fx.baseUrl}/ui/api/groups/${GROUP}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(del.status, 200);
    const body = (await del.json()) as {
      ok: boolean;
      purged: { messages: number };
    };
    assert.equal(body.ok, true);
    assert.ok(body.purged.messages >= 5, "应删到种子消息");

    // 删除后：群注册表不再含该群
    const groups = (await (
      await get(fx.baseUrl, "/ui/api/groups", authHeaders())
    ).json()) as { groups: Array<{ group_openid: string }> };
    assert.equal(
      groups.groups.some((g) => g.group_openid === GROUP),
      false,
    );
  } finally {
    await fx.close();
  }
});

test("M7-U9 send：被动回复走账本（msg_seq=1、status sent）；非白名单群硬拒绝", async () => {
  const fx = await setupServer();
  try {
    const h = authHeaders({ "Content-Type": "application/json" });
    const ok = await fetch(`${fx.baseUrl}/ui/api/send`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        bot: BOT,
        group: GROUP,
        text: "UI 回复",
        reply_msg_id: "M1",
      }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as {
      result: { status: string; msg_seq?: number };
    };
    assert.equal(body.result.status, "sent");
    assert.equal(body.result.msg_seq, 1);
    assert.equal(fx.net.replies.length, 1);
    assert.equal(fx.net.replies[0]?.target, GROUP);

    // 外发消息补记：messages 里出现 out=true 行，作者=机器人名（不进成员名册）
    const msgs = (await (
      await get(
        fx.baseUrl,
        `/ui/api/messages?bot=${BOT}&group=${GROUP}&limit=50`,
        authHeaders(),
      )
    ).json()) as {
      messages: Array<{
        msg_id: string;
        out: boolean;
        content: string | null;
        author: { name: string | null; role: string | null };
      }>;
    };
    const sent = msgs.messages.find((m) => m.out === true);
    assert.ok(sent !== undefined, "发送后应有 out=true 的外发消息行");
    assert.equal(sent.content, "UI 回复");
    assert.equal(sent.msg_id, "PROVIDER_1");
    assert.equal(sent.author.name, "基座");
    assert.equal(sent.author.role, null);

    const sends = (await (
      await get(
        fx.baseUrl,
        `/ui/api/sends?bot=${BOT}&group=${GROUP}`,
        authHeaders(),
      )
    ).json()) as { sends: Array<{ status: string; kind: string }> };
    assert.equal(sends.sends.length, 1);
    assert.equal(sends.sends[0].status, "sent");

    const gated = await fetch(`${fx.baseUrl}/ui/api/send`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ bot: BOT, group: "NOT_ALLOWED", text: "x" }),
    });
    assert.equal(gated.status, 400);
    assert.match(((await gated.json()) as { error: string }).error, /白名单/);
  } finally {
    await fx.close();
  }
});

test("M7-U11 connectors 声明端点：平台声明面（caps/credentialSchema/login/webui 路由表）", async () => {
  const fx = await setupServer();
  try {
    const res = await get(fx.baseUrl, "/ui/api/connectors", authHeaders());
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      connectors: Array<{
        id: string;
        title: string;
        caps: { scopes: string[]; quota: boolean };
        credential_schema: {
          required: string[];
          properties: Record<string, unknown>;
        };
        credential_secrets: string[];
        login: { kind: string; create?: string; poll?: string };
        webui: Array<{ method: string; path: string }>;
      }>;
    };
    const qq = body.connectors.find((c) => c.id === "qq");
    assert.ok(qq !== undefined, "QQ 平台声明应在列");
    assert.equal(qq.title, "QQ 官方机器人");
    // credentialSchema 驱动「添加机器人」表单（P2 前端消费的字段源）
    assert.deepEqual(qq.credential_schema.required, ["appid", "secret"]);
    assert.ok(qq.credential_schema.properties["appid"] !== undefined);
    assert.deepEqual(qq.credential_secrets, ["secret"]);
    assert.equal(qq.login.kind, "qr-pair");
    assert.equal(qq.login.create, "/login/qr/create");
    assert.equal(qq.login.poll, "/login/qr/poll");
    assert.ok(qq.webui.some((r) => r.path === "/login/qr/create"));
    assert.equal(qq.caps.quota, true);
    // 无鉴权 401
    const anon = await fetch(`${fx.baseUrl}/ui/api/connectors`);
    assert.equal(anon.status, 401);
  } finally {
    await fx.close();
  }
});

test("M7-U10 quota：水位与令牌桶快照", async () => {
  const fx = await setupServer(false);
  try {
    const res = await get(
      fx.baseUrl,
      `/ui/api/quota?bot=${BOT}`,
      authHeaders(),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      send_enabled: boolean;
      proactive_sent_today: number;
      buckets: unknown;
    };
    assert.equal(body.send_enabled, true);
    assert.equal(body.proactive_sent_today, 0);
    assert.ok(body.buckets !== undefined);
  } finally {
    await fx.close();
  }
});

// —— M10 单聊（C2C）：WebUI 会话合并 / 统一消息读取 / 发送与补记 ——

test("M10 UI 单聊：type=all 合并会话（名字=users 权威）+ type=chat 统一读取 + 发送走 chat scope", async () => {
  const fx = await setupServer();
  try {
    const USER = "C2C_USER_1";
    // 身份权威：users 表（QQ 昵称）；单聊载荷本身无昵称，展示名从 users 取
    fx.db
      .prepare(
        "INSERT INTO users(bot_id, openid, name, first_seen, last_seen) VALUES (?, ?, 'Venti', ?, ?)",
      )
      .run(BOT, USER, Date.now(), Date.now());
    // 群注册表在册（会话列表群条目；setupServer 已播种，冲突则忽略）
    fx.db
      .prepare(
        "INSERT OR IGNORE INTO groups(bot_id, group_openid, full_msg_enabled, added_at, updated_at) VALUES (?, ?, 1, ?, ?)",
      )
      .run(BOT, GROUP, Date.now(), Date.now());
    fx.repo.saveMessage({
      botId: BOT,
      scope: "chat",
      scopeId: USER,
      msgId: "C1",
      authorOpenid: USER,
      ts: Date.now() - 60_000,
      content: "你好",
      mentions: [],
      text: "你好",
      quote: null,
      records: [],
      attachments: [],
      raw: {},
    });
    fx.repo.saveMessage({
      botId: BOT,
      scope: "chat",
      scopeId: USER,
      msgId: "C2",
      authorOpenid: USER,
      ts: Date.now(),
      content: "nih",
      mentions: [],
      text: "nih",
      quote: null,
      records: [],
      attachments: [],
      raw: {},
    });

    // ① 会话列表（type=all 缺省）：单聊条目合并，最后消息作者=users 最新昵称
    const sessions = (await (
      await get(fx.baseUrl, `/ui/api/groups?bot=${BOT}`, authHeaders())
    ).json()) as {
      groups: Array<{
        type: string;
        group_openid: string;
        last: { author: string | null; snippet: string } | null;
      }>;
    };
    const chat = sessions.groups.find((g) => g.type === "chat");
    assert.ok(chat !== undefined, "type=all 应合并单聊会话");
    assert.equal(chat.group_openid, USER);
    assert.equal(
      chat.last?.author,
      "Venti",
      "单聊作者名从 users 表取（旧名册反查已退役）",
    );
    assert.equal(chat.last?.snippet, "nih");
    assert.equal(
      sessions.groups.find((g) => g.type === "group")?.group_openid,
      GROUP,
      "群聊条目不受影响",
    );

    // ② 消息读取：type=chat 走合一 messages 表（升序），作者名已按 users 解析
    const msgs = (await (
      await get(
        fx.baseUrl,
        `/ui/api/messages?bot=${BOT}&group=${USER}&type=chat&limit=10`,
        authHeaders(),
      )
    ).json()) as {
      messages: Array<{
        msg_id: string;
        content: string | null;
        author: { name: string | null };
      }>;
    };
    assert.deepEqual(
      msgs.messages.map((m) => m.msg_id),
      ["C1", "C2"],
    );
    assert.equal(msgs.messages[0].author.name, "Venti");

    // ③ 发送：type=chat → wire scope=chat（连接器映射官方 c2c scope；C2 在 60 分钟被动窗内，免 opt-in）
    const ok = await fetch(`${fx.baseUrl}/ui/api/send`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        bot: BOT,
        group: USER,
        type: "chat",
        text: "UI 单聊回复",
        reply_msg_id: "C2",
      }),
    });
    assert.equal(ok.status, 200);
    assert.equal(fx.net.replies.length, 1);
    assert.equal(fx.net.replies[0]?.scope, "chat");
    assert.equal(fx.net.replies[0]?.target, USER);

    // ④ 外发补记落 c2c_messages（direction=1），消息流可见
    const after = (await (
      await get(
        fx.baseUrl,
        `/ui/api/messages?bot=${BOT}&group=${USER}&type=chat&limit=10`,
        authHeaders(),
      )
    ).json()) as {
      messages: Array<{ out: boolean; content: string | null }>;
    };
    const sent = after.messages.find((m) => m.out === true);
    assert.ok(sent !== undefined, "发送后 c2c 镜像应有 out=true 行");
    assert.equal(sent.content, "UI 单聊回复");
  } finally {
    await fx.close();
  }
});

// —— P4 微信：平台中介扫码注册 + 多平台手动添加（/bots 按平台声明取凭据）+ 连接器状态化错误透传 ——

interface WxFixture {
  baseUrl: string;
  registry: BotRegistry;
  added: string[];
  close: () => Promise<void>;
}

const WX_QR_URL = "https://weixin.qq.com/q/ABC";
const WX_CREATE = "/ui/api/platforms/weixin/login/qr/create";
const WX_POLL = "/ui/api/platforms/weixin/login/qr/poll";

/** 真 Fastify 应用 + 真微信插件（假 fetch 脚本化上游，零真实网络）；verify 按 index.ts 同款接到插件钩子 */
async function setupWeixinServer(
  steps: Array<Record<string, unknown>>,
): Promise<WxFixture> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-wx-ui-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  repo.ensureRuntime();
  repo.setAdminToken(TOKEN);
  repo.setSendEnable(true);

  const plugins = new ConnectorRegistry();
  plugins.register(
    createWeixinConnector({
      api: {
        fetch: (async (input: unknown, init?: RequestInit) => {
          const url = new URL(String(input));
          const json = (obj: unknown) =>
            new Response(JSON.stringify(obj), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          if (url.pathname.endsWith("/get_bot_qrcode")) {
            return json({ qrcode: "QR-SECRET-TOKEN", qrcode_img_content: WX_QR_URL });
          }
          if (url.pathname.endsWith("/get_qrcode_status")) {
            const next = steps.shift();
            if (next === undefined) {
              // 脚本耗尽：挂起到请求中止（不空转）
              await new Promise<void>((resolve) => {
                init?.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              return json({ status: "wait" });
            }
            return json(next);
          }
          return json({ ret: 0 }); // notifystart / notifystop 探活
        }) as typeof fetch,
      },
    }),
  );
  const registry = new BotRegistry({
    db,
    verify: async (platform, credentials) => {
      const verify = plugins.get(platform)?.hooks?.verifyCredential;
      if (verify === undefined) {
        throw new Error(`平台 ${platform} 的连接器未装载，无法校验凭据。`);
      }
      await verify(credentials);
    },
  });
  const added: string[] = [];
  const runtime = {
    plugins,
    addBot: (bot: { botId: string }) => added.push(bot.botId),
    removeBot: () => undefined,
  } as unknown as ConnectorRuntime;
  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    version: "0.2.0",
    registry,
    connectors: runtime,
    botStatuses: () => [],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    registry,
    added,
    close: async () => {
      await app.close();
      db.close();
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        /* best-effort */
      }
    },
  };
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("P4 微信扫码中介：声明在列 + create 透传（令牌不下发）；completed → 宿主校验并注册；凭据不出浏览器", async () => {
  const fx = await setupWeixinServer([
    { status: "wait" },
    {
      status: "confirmed",
      bot_token: "WX-TOKEN-1",
      ilink_bot_id: "abc123@im.bot",
      baseurl: "https://ilink-sh.weixin.qq.com",
      ilink_user_id: "u1@im.wechat",
    },
  ]);
  try {
    // 声明面：weixin 在列且为 qr-pair（表单字段/扫码路由由此驱动）
    const decls = (await (
      await get(fx.baseUrl, "/ui/api/connectors", authHeaders())
    ).json()) as {
      connectors: Array<{
        id: string;
        login: { kind: string; create?: string; poll?: string };
        credential_secrets: string[];
      }>;
    };
    const wx = decls.connectors.find((c) => c.id === "weixin");
    assert.ok(wx !== undefined, "weixin 平台声明应在列");
    assert.deepEqual(wx.login, {
      kind: "qr-pair",
      create: "/login/qr/create",
      poll: "/login/qr/poll",
    });
    assert.deepEqual(wx.credential_secrets, ["token"]);

    // create 透传：task_id + 二维码内容；轮询令牌不下发
    const created = await postJson(`${fx.baseUrl}${WX_CREATE}`, {});
    assert.equal(created.status, 200);
    assert.equal(created.body.connect_url, WX_QR_URL);
    assert.equal(created.body.interval_s, 2);
    assert.equal(JSON.stringify(created.body).includes("QR-SECRET-TOKEN"), false);

    // poll：pending → created（宿主中介完成校验+落库+联动接入）
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 200; i += 1) {
      last = await postJson(`${fx.baseUrl}${WX_POLL}`, {
        task_id: created.body.task_id,
      });
      if (last.status !== 200 || last.body.status !== "pending") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(last.status, 200);
    assert.equal(last.body.status, "created");
    const bot = last.body.bot as { appid: string; name: string };
    assert.deepEqual(bot, { appid: "abc123-im-bot", name: "abc123-im-bot" });
    assert.match(String(last.body.agent_token), /^[0-9a-f]{48}$/);
    assert.equal(JSON.stringify(last.body).includes("WX-TOKEN-1"), false); // 凭据不出浏览器
    assert.deepEqual(fx.added, ["abc123-im-bot"]); // 联动运行时接入
    const record = fx.registry.get("abc123-im-bot");
    assert.ok(record);
    assert.equal(record.platform, "weixin");
    assert.deepEqual(record.credentials, {
      appid: "abc123-im-bot",
      token: "WX-TOKEN-1",
      base_url: "https://ilink-sh.weixin.qq.com",
      owner_id: "u1@im.wechat",
    });
  } finally {
    await fx.close();
  }
});

test("P4 微信扫码中介：终态失败 → 连接器状态化错误经 mapError 透传（409 + 可操作文案），不落库", async () => {
  const fx = await setupWeixinServer([{ status: "binded_redirect" }]);
  try {
    const created = await postJson(`${fx.baseUrl}${WX_CREATE}`, {});
    assert.equal(created.status, 200);
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 200; i += 1) {
      last = await postJson(`${fx.baseUrl}${WX_POLL}`, {
        task_id: created.body.task_id,
      });
      if (last.status !== 200) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // 连接器对 SDK 只做类型导入（拿不到 ConnectorError 运行时类）：鸭子类型识别其 status
    assert.equal(last.status, 409);
    assert.match(String(last.body.error), /已绑定/);
    assert.equal(fx.registry.list().length, 0);
    assert.deepEqual(fx.added, []);
    // 未知任务：expired（前端据此重开任务）
    const unknown = await postJson(`${fx.baseUrl}${WX_POLL}`, { task_id: "nope" });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, { status: "expired" });
    // 平台不存在：404
    const missing = await postJson(`${fx.baseUrl}/ui/api/platforms/nope${"/login/qr/create"}`, {});
    assert.equal(missing.status, 404);
  } finally {
    await fx.close();
  }
});

test("P4 多平台手动添加：POST /bots 按 platform 的 credentialSchema 取凭据；未知/未装载平台 400", async () => {
  const fx = await setupWeixinServer([]);
  try {
    const ok = await postJson(`${fx.baseUrl}/ui/api/bots`, {
      platform: "weixin",
      appid: "abc123-im-bot",
      token: "WX-TOKEN-2",
      base_url: "https://ilink-sh.weixin.qq.com",
      owner_id: "u1@im.wechat",
      name: "小雅",
      junk: "不在声明里的键被忽略",
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.bot, { appid: "abc123-im-bot", name: "小雅" });
    const record = fx.registry.get("abc123-im-bot");
    assert.ok(record);
    assert.equal(record.platform, "weixin");
    // 凭据只取声明键；name/junk 不混入
    assert.deepEqual(record.credentials, {
      appid: "abc123-im-bot",
      token: "WX-TOKEN-2",
      base_url: "https://ilink-sh.weixin.qq.com",
      owner_id: "u1@im.wechat",
    });
    assert.deepEqual(fx.added, ["abc123-im-bot"]);

    // 未知平台
    const unknown = await postJson(`${fx.baseUrl}/ui/api/bots`, {
      platform: "nope",
      appid: "x",
      token: "y",
    });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /平台不存在/);
    // 缺省平台 qq：本台架未装载 qq 连接器 → 可操作 400（不落库、不触网）
    const legacy = await postJson(`${fx.baseUrl}/ui/api/bots`, {
      appid: "20002",
      secret: "s2",
    });
    assert.equal(legacy.status, 400);
    assert.match(String(legacy.body.error), /平台不存在/);
    assert.equal(fx.registry.list().length, 1);
  } finally {
    await fx.close();
  }
});
