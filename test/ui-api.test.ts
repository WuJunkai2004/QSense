// M7 验收（WebUI API）：/ui 静态托管（未构建 503 / 正常 / 防目录穿越）、/ui/api 鉴权、
// bootstrap/groups/messages 分页与增量/message 详情/members/sends/quota、
// 运行时添加移除 bot（联动 supervisor 与 token/会话清理）、发送端点与门禁。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry } from "../src/bots";
import type { GatewaySupervisor } from "../src/gateway";
import type { TokenService } from "../src/gateway/token";
import { createLogger } from "../src/logger";
import { Sender, type SendApi } from "../src/sender";
import { buildServer } from "../src/server/http";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";

const TOKEN = "m7-test-token-0123456789abcdef";
const BOT = "10001";
const GROUP = "G1";

interface MockApi {
  calls: Array<{
    scope: string;
    targetId: string;
    body: Record<string, unknown>;
  }>;
}

function makeApiMock(): MockApi & SendApi {
  const calls: MockApi["calls"] = [];
  return {
    calls,
    async sendRaw(
      scope: "group" | "c2c",
      targetId: string,
      _creds: { appId: string; clientSecret: string },
      body: Record<string, unknown>,
    ) {
      calls.push({ scope, targetId, body });
      return { id: `PROVIDER_${calls.length}` };
    },
    async recallMessage() {},
  } as never;
}

interface Fixture {
  baseUrl: string;
  api: MockApi & SendApi;
  db: import("../src/store/db").DB;
  repo: Repo;
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
      repo.saveGroupMessage({
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
        elements: undefined,
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
    verify: async (app) => {
      if (app.secret === "bad") throw new Error("401 invalid credentials");
    },
  });
  await registry.add({
    appid: BOT,
    secret: "s1",
    name: "基座",
    allowGroups: [GROUP],
  });

  const api = makeApiMock();
  const sender = new Sender({
    log: createLogger("error"),
    db,
    repo,
    bots: registry,
    tokenManager: {} as never,
    apiFor: () => api,
  });

  const added: string[] = [];
  const removed: string[] = [];
  const cleared: string[] = [];
  const supervisor = {
    addBot: (app: { appid: string }) => {
      added.push(app.appid);
    },
    removeBot: (appid: string) => {
      removed.push(appid);
    },
  } as unknown as GatewaySupervisor;
  const tokens = {
    clear: (app: { appid: string }) => {
      cleared.push(app.appid);
    },
  } as unknown as TokenService;

  // 假 UI 产物：index.html + assets/app.js
  const uiDir = join(dir, "fake-ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(
    join(uiDir, "index.html"),
    "<!doctype html><title>m7-fake-ui</title>",
  );
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log('m7');\n");
  process.env.UI_DIST_DIR = uiDir;

  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    sender,
    version: "0.2.0",
    registry,
    supervisor,
    tokens,
    botStatuses: () => [{ botId: BOT, state: "ready" }],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    api,
    db,
    repo,
    added,
    removed,
    cleared,
    close: async () => {
      delete process.env.UI_DIST_DIR;
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
      }>;
    };
    assert.equal(body.version, "0.2.0");
    assert.equal(body.send_enabled, true);
    // M8：白名单按 bot 落库（bots 表），不再是顶层全局字段；M9：含 auth_level
    assert.deepEqual(body.bots, [
      {
        appid: BOT,
        name: "基座",
        allow_groups: [GROUP],
        auth_level: "uncertified",
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
    assert.equal(fx.api.calls.length, 1);
    assert.equal(fx.api.calls[0].targetId, GROUP);

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

// —— M10 单聊（C2C）：WebUI 会话合并 / 镜像读取 / 发送与补记 ——

test("M10 UI 单聊：type=all 合并会话（名册反查昵称）+ type=chat 镜像读取 + 发送走 c2c scope", async () => {
  const fx = await setupServer();
  try {
    const USER = "C2C_USER_1";
    // 名册（映射源）：该用户在本 bot 群里发过言；单聊载荷本身无昵称
    fx.db
      .prepare(
        "INSERT INTO members(bot_id, group_openid, member_openid, username, member_role, first_seen, last_seen, msg_count) VALUES (?, ?, ?, 'Venti', 'member', ?, ?, 1)",
      )
      .run(BOT, GROUP, USER, Date.now(), Date.now());
    fx.repo.saveC2cMessage({
      botId: BOT,
      scope: "c2c",
      scopeId: USER,
      msgId: "C1",
      authorOpenid: USER,
      ts: Date.now() - 60_000,
      content: "你好",
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    });
    fx.repo.saveC2cMessage({
      botId: BOT,
      scope: "c2c",
      scopeId: USER,
      msgId: "C2",
      authorOpenid: USER,
      ts: Date.now(),
      content: "nih",
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    });

    // ① 会话列表（type=all 缺省）：单聊条目合并，最后消息作者=名册映射名
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
    assert.equal(chat.last?.author, "Venti");
    assert.equal(chat.last?.snippet, "nih");
    assert.equal(
      sessions.groups.find((g) => g.type === "group")?.group_openid,
      GROUP,
      "群聊条目不受影响",
    );

    // ② 消息镜像：type=chat 读 c2c_messages（升序），作者名已映射
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

    // ③ 发送：type=chat → 官方调用 scope=c2c（C2 在 60 分钟被动窗内，免 opt-in）
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
    assert.equal(fx.api.calls.length, 1);
    assert.equal(fx.api.calls[0].scope, "c2c");
    assert.equal(fx.api.calls[0].targetId, USER);

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
