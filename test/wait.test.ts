// /wait 长轮询事件端点验收：
// 鉴权（401/403）、参数校验（400）、唤醒链路（filter 真值表全场景）、超时、
// 客户端中止清理、并发上限、防抖聚合、/docs 文档面、ingest tap 端到端集成。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry } from "@qsense/connector-sdk";
import { createQqConnector } from "@qsense/connector-qq";
import { buildServer } from "../src/server/http";
import { createLogger } from "../src/utils/logger";
import { WaitHub, matchFacts } from "../src/server/wait";
import { createIngestPipeline } from "../src/connectors/ingest";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";

const GROUP = "GROUP_OPENID_G1";
const PEER = "PEER_OPENID_U1"; // 私聊对端 openid（=私聊会话 id）
const APPID = "10001";

interface Fixture {
  baseUrl: string;
  agentToken: string;
  hub: WaitHub;
  repo: Repo;
  db: DB;
  close: () => Promise<void>;
}

/** 群/私聊消息事实发布（测试直接驱动 hub；等价于 ingest tap 的行为） */
function publishOf(hub: WaitHub, repo: Repo) {
  return (opts: {
    scope: "group" | "chat";
    scopeId: string;
    msgId?: string;
    author?: string;
    atMe?: boolean;
    mentions?: number;
    text?: string;
  }): void => {
    repo.saveMessage({
      botId: APPID,
      scope: opts.scope,
      scopeId: opts.scopeId,
      msgId: opts.msgId ?? `M-${Math.random().toString(36).slice(2)}`,
      authorOpenid: opts.author ?? "U_A",
      ts: Date.now(),
      text: opts.text ?? "hello",
      content: opts.text ?? "hello",
      quote: null,
      records: [],
      mentions: Array.from({ length: opts.mentions ?? 0 }, (_, i) => ({
        id: `MENTION_${i}`,
      })),
      ...(opts.atMe !== undefined ? { atMe: opts.atMe } : {}),
      attachments: [],
      rawJson: "{}",
    });
    hub.publish({
      botId: APPID,
      scope: opts.scope,
      scopeId: opts.scopeId,
      atMe: opts.atMe,
      mentionCount: opts.mentions ?? 0,
      authorOpenid: opts.author ?? "U_A",
    });
  };
}

async function setupFixture(opts: { maxWaitersPerBot?: number } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-wait-test-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  repo.ensureRuntime();
  repo.setGroupSwitch(APPID, GROUP, true); // 群注册表：listConversations 群侧权威源
  const registry = new BotRegistry({ db });
  await registry.add({
    credentials: { appid: APPID, secret: "s" },
    name: "t",
    allowGroups: [GROUP],
  });
  const agentToken = registry.rotateToken(APPID);
  const hub = new WaitHub({
    repo,
    log: createLogger("error"),
    debounceMs: 30,
    ...(opts.maxWaitersPerBot !== undefined
      ? { maxWaitersPerBot: opts.maxWaitersPerBot }
      : {}),
  });
  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    registry,
    version: "0.1.0",
    wait: hub,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    agentToken,
    hub,
    repo,
    db,
    close: async () => {
      app.server.closeAllConnections?.(); // 断掉 undici keep-alive 连接，close 即刻返回
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

function waitOf(
  fx: Fixture,
  body: unknown,
  agentToken = fx.agentToken,
): Promise<Response> {
  return fetch(`${fx.baseUrl}/wait`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function responseJson(resp: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await resp.text()) as Record<string, unknown>;
}

test("W-1 无 token / 错 token → 401", async () => {
  const fx = await setupFixture();
  try {
    const noAuth = await fetch(`${fx.baseUrl}/wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(noAuth.status, 401);
    const bad = await waitOf(fx, {}, "wrong-token");
    assert.equal(bad.status, 401);
  } finally {
    await fx.close();
  }
});

test("W-2 mcp_enabled=0 → 403（与 /mcp 同闸）", async () => {
  const fx = await setupFixture();
  try {
    const reg = new BotRegistry({ db: fx.db });
    reg.setMcpEnabled(APPID, false);
    const resp = await waitOf(fx, { hold: 1 });
    assert.equal(resp.status, 403);
    const body = await responseJson(resp);
    assert.match(String(body["error"] ?? ""), /MCP 访问/);
  } finally {
    await fx.close();
  }
});

test("W-3 参数校验：未知字段/非法 scope/非法 hold/坏 id 数组 → 400", async () => {
  const fx = await setupFixture();
  try {
    const cases: Array<Record<string, unknown>> = [
      { foo: 1 },
      { filter: { bad_key: true } },
      { filter: { scope: "dm" } },
      { hold: 0 },
      { hold: 700 },
      { hold: 1.5 },
      { filter: { sessions: [] } },
      { filter: { sessions: [""] } },
      { filter: [] },
      { filter: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] }, // 11 项超限
    ];
    for (const body of cases) {
      const resp = await waitOf(fx, body);
      assert.equal(resp.status, 400, `body=${JSON.stringify(body)}`);
    }
  } finally {
    await fx.close();
  }
});

test("W-4 缺省 filter：群消息即醒，返回事件 + 未读快照", async () => {
  const fx = await setupFixture();
  try {
    const publish = publishOf(fx.hub, fx.repo);
    const pending = waitOf(fx, { hold: 5 });
    publish({ scope: "group", scopeId: GROUP, text: "今晚开会" });
    const resp = await pending;
    assert.equal(resp.status, 200);
    const body = await responseJson(resp);
    assert.equal(body["timeout"], false);
    const events = body["events"] as Array<Record<string, unknown>>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!["id"], GROUP);
    const unread = body["unread"] as Array<Record<string, unknown>>;
    assert.ok(unread.length >= 1);
    assert.equal(unread[0]!["id"], GROUP);
  } finally {
    await fx.close();
  }
});

test("W-5 scope=chat：群消息不醒，私聊醒", async () => {
  const fx = await setupFixture();
  try {
    const publish = publishOf(fx.hub, fx.repo);
    const pending = waitOf(fx, { filter: { scope: "chat" }, hold: 1 });
    publish({ scope: "group", scopeId: GROUP, text: "群里说话" });
    const resp = await pending;
    const body = await responseJson(resp);
    assert.equal(body["timeout"], true);

    const pending2 = waitOf(fx, { filter: { scope: "chat" }, hold: 5 });
    publish({ scope: "chat", scopeId: PEER, text: "私聊来了" });
    const resp2 = await pending2;
    const body2 = await responseJson(resp2);
    assert.equal(body2["timeout"], false);
    const events = body2["events"] as Array<Record<string, unknown>>;
    assert.equal(events[0]!["id"], PEER);
  } finally {
    await fx.close();
  }
});

test("W-6 sessions=私聊openid：私聊命中；同一作者在群聊发言不命中（会话/作者维度正交）", async () => {
  const fx = await setupFixture();
  try {
    const publish = publishOf(fx.hub, fx.repo);
    const pending = waitOf(fx, {
      filter: { sessions: [PEER] },
      hold: 1,
    });
    // 同一作者在群里发言——群是另一个 session，不得触发
    publish({ scope: "group", scopeId: GROUP, author: PEER, text: "群里冒泡" });
    const resp = await pending;
    assert.equal((await responseJson(resp))["timeout"], true);

    const pending2 = waitOf(fx, { filter: { sessions: [PEER] }, hold: 5 });
    publish({ scope: "chat", scopeId: PEER, text: "私聊" });
    const resp2 = await pending2;
    const body2 = await responseJson(resp2);
    assert.equal(body2["timeout"], false);
  } finally {
    await fx.close();
  }
});

test("W-7 mention 口径：atMe=true 命中；未知+含@从宽命中；未知无@不命中；atMe=false 不命中", async () => {
  const fx = await setupFixture();
  try {
    const publish = publishOf(fx.hub, fx.repo);

    // QQ AT 事件（atMe=true）
    const p1 = waitOf(fx, { filter: { scope: "group", mention: true }, hold: 5 });
    publish({ scope: "group", scopeId: GROUP, atMe: true, mentions: 1 });
    assert.equal((await responseJson(await p1))["timeout"], false);

    // 全量群消息 @ 归属未知但含 @（从宽）
    const p2 = waitOf(fx, { filter: { mention: true }, hold: 5 });
    publish({ scope: "group", scopeId: GROUP, mentions: 2 });
    assert.equal((await responseJson(await p2))["timeout"], false);

    // 全量群消息无 @（不命中）
    const p3 = waitOf(fx, { filter: { mention: true }, hold: 1 });
    publish({ scope: "group", scopeId: GROUP });
    assert.equal((await responseJson(await p3))["timeout"], true);

    // Telegram 权威否定（atMe=false，即使含 @ 实体）
    const p4 = waitOf(fx, { filter: { mention: true }, hold: 1 });
    publish({ scope: "group", scopeId: GROUP, atMe: false, mentions: 3 });
    assert.equal((await responseJson(await p4))["timeout"], true);

    // 私聊天然命中 mention
    const p5 = waitOf(fx, { filter: { mention: true }, hold: 5 });
    publish({ scope: "chat", scopeId: PEER });
    assert.equal((await responseJson(await p5))["timeout"], false);
  } finally {
    await fx.close();
  }
});

test("W-8 authors：指定作者任意会话命中；他人不命中", async () => {
  const fx = await setupFixture();
  try {
    const publish = publishOf(fx.hub, fx.repo);
    const pending = waitOf(fx, { filter: { authors: ["U_BOSS"] }, hold: 1 });
    publish({ scope: "group", scopeId: GROUP, author: "U_OTHER" });
    assert.equal((await responseJson(await pending))["timeout"], true);

    const p2 = waitOf(fx, { filter: { authors: ["U_BOSS"] }, hold: 5 });
    publish({ scope: "chat", scopeId: PEER, author: "U_BOSS" });
    assert.equal((await responseJson(await p2))["timeout"], false);
  } finally {
    await fx.close();
  }
});

test("W-9 DNF：数组 filter 跨对象 OR", async () => {
  const fx = await setupFixture();
  try {
    const publish = publishOf(fx.hub, fx.repo);
    const dnf = [
      { scope: "group", mention: true },
      { scope: "chat", authors: ["U_X"] },
    ];
    const p1 = waitOf(fx, { filter: dnf, hold: 1 });
    publish({ scope: "group", scopeId: GROUP }); // 群里普通消息：两项都不命中
    assert.equal((await responseJson(await p1))["timeout"], true);

    const p2 = waitOf(fx, { filter: dnf, hold: 5 });
    publish({ scope: "chat", scopeId: PEER, author: "U_X" }); // 第 2 项命中
    assert.equal((await responseJson(await p2))["timeout"], false);
  } finally {
    await fx.close();
  }
});

test("W-10 hold 到点无命中 → timeout:true（响应可 JSON 解析）", async () => {
  const fx = await setupFixture();
  try {
    const resp = await waitOf(fx, { hold: 1 });
    assert.equal(resp.status, 200);
    const body = await responseJson(resp);
    assert.equal(body["timeout"], true);
    assert.deepEqual(body["events"], []);
  } finally {
    await fx.close();
  }
});

test("W-11 客户端中止：连接关闭后 waiter 即时清理（不泄漏）", async () => {
  const fx = await setupFixture();
  try {
    const ac = new AbortController();
    const pending = fetch(`${fx.baseUrl}/wait`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fx.agentToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hold: 30 }),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fx.hub.waiterCountOf(APPID), 1);
    ac.abort();
    await pending.catch(() => {});
    // close 钩子异步触发——轮询等待清理完成
    for (let i = 0; i < 50 && fx.hub.waiterCountOf(APPID) > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(fx.hub.waiterCountOf(APPID), 0);
  } finally {
    await fx.close();
  }
});

test("W-12 每 bot waiter 并发上限 → 429", async () => {
  const fx = await setupFixture({ maxWaitersPerBot: 2 });
  try {
    const a = waitOf(fx, { hold: 30 });
    const b = waitOf(fx, { hold: 30 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fx.hub.waiterCountOf(APPID), 2);
    const c = await waitOf(fx, { hold: 1 });
    assert.equal(c.status, 429);
    const body = await responseJson(c);
    assert.match(String(body["error"] ?? ""), /超上限/);
    // 释放挂起连接（避免 close 时不必要的 socket 残留）
    a.catch(() => {});
    b.catch(() => {});
  } finally {
    await fx.close();
  }
});

test("W-13 防抖聚合：同会话窗口内两条消息只醒一次", async () => {
  const fx = await setupFixture();
  try {
    const publish = publishOf(fx.hub, fx.repo);
    const pending = waitOf(fx, { hold: 5 });
    publish({ scope: "group", scopeId: GROUP, msgId: "D1", text: "1/2" });
    publish({ scope: "group", scopeId: GROUP, msgId: "D2", text: "2/2" });
    const resp = await pending;
    const body = await responseJson(resp);
    assert.equal(body["timeout"], false);
    const events = body["events"] as unknown[];
    assert.equal(events.length, 1);
    const unread = body["unread"] as Array<{ id: string; unread: number }>;
    const row = unread.find((u) => u.id === GROUP);
    assert.ok(row !== undefined && row.unread >= 2);
  } finally {
    await fx.close();
  }
});

test("W-14 GET /docs：markdown 契约（含 /wait 调用方法）", async () => {
  const fx = await setupFixture();
  try {
    const resp = await fetch(`${fx.baseUrl}/docs`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") ?? "", /text\/markdown/);
    const text = await resp.text();
    for (const needle of ["/wait", "filter", "get_new", "Bearer", "hold"]) {
      assert.ok(text.includes(needle), `docs 缺少 ${needle}`);
    }
  } finally {
    await fx.close();
  }
});

test("W-15 ingest tap 端到端：真 QQ 插件 normalize AT 事件 → hub 唤醒（atMe 传递）", async () => {
  const fx = await setupFixture();
  try {
    const plugins = new ConnectorRegistry();
    plugins.register(createQqConnector({ log: createLogger("error") }));
    const pipeline = createIngestPipeline({
      repo: fx.repo,
      log: createLogger("error"),
      plugins,
      tap: ({ messages }) => {
        for (const m of messages) {
          if (m.direction === 1) continue;
          fx.hub.publish({
            botId: m.botId,
            scope: m.scope,
            scopeId: m.scopeId,
            atMe: m.atMe,
            mentionCount: m.mentions.length,
            authorOpenid: m.authorOpenid,
          });
        }
      },
    });
    // 真机形状（2026-11-19 实证）：官方 mentions[].is_you 是 @归属权威判定，
    // AT 事件与全量事件一致——@本bot is_you=true；@他人（含别的bot）false。
    const atEvent = {
      platform: "qq",
      type: "GROUP_AT_MESSAGE_CREATE",
      data: {
        id: "AT_MSG_1",
        group_openid: GROUP,
        member_openid: "U_AT",
        content: "<@ME_OPENID> 在吗",
        timestamp: new Date().toISOString(),
        mentions: [
          {
            bot: true,
            id: "ME_OPENID",
            is_you: true,
            member_nickname: "雅南",
            member_openid: "ME_OPENID",
            member_role: "member",
            scope: "single",
            username: "雅南",
          },
        ],
      },
    };
    const pending = waitOf(fx, { filter: { scope: "group", mention: true }, hold: 5 });
    pipeline({ botId: APPID, payload: atEvent });
    const resp = await pending;
    const body = await responseJson(resp);
    assert.equal(body["timeout"], false, "AT 事件（is_you=true）应命中 mention 过滤");
    const events = body["events"] as Array<Record<string, unknown>>;
    assert.equal(events[0]!["id"], GROUP);

    // 姊妹断言（2026-11-19 bug 回归）：全量群消息 @他人（is_you=false）不得唤醒
    // mention 过滤——旧 parser 漏读 is_you 导致 atMe=undefined 而误触发从宽兜底。
    const notMeEvent = {
      platform: "qq",
      type: "GROUP_MESSAGE_CREATE",
      data: {
        id: "AT_MSG_2",
        group_openid: GROUP,
        member_openid: "U_OTHER",
        content: "<@FRIEND_OPENID> 在哪的",
        timestamp: new Date().toISOString(),
        mentions: [
          {
            bot: false,
            id: "FRIEND_OPENID",
            is_you: false,
            member_nickname: "Venti",
            member_openid: "FRIEND_OPENID",
            member_role: "admin",
            scope: "single",
            username: "Venti",
          },
        ],
      },
    };
    const notMe = waitOf(fx, { filter: { mention: true }, hold: 1 });
    pipeline({ botId: APPID, payload: notMeEvent });
    assert.equal(
      (await responseJson(await notMe))["timeout"],
      true,
      "@他人（is_you=false）不应命中 mention 过滤",
    );
  } finally {
    await fx.close();
  }
});

// —— matchFacts 单元（纯函数，直测边界组合） ——

test("W-16 matchFacts：undefined atMe + 0 mention 与 false atMe 的边界", () => {
  const base = {
    botId: APPID,
    scope: "group" as const,
    scopeId: GROUP,
    mentionCount: 0,
    authorOpenid: "U_A",
  };
  assert.equal(matchFacts({ ...base, atMe: undefined }, [{ mention: true }]), false);
  assert.equal(matchFacts({ ...base, atMe: true }, [{ mention: true }]), true);
  assert.equal(
    matchFacts({ ...base, atMe: undefined, mentionCount: 1 }, [{ mention: true }]),
    true,
  );
  assert.equal(matchFacts({ ...base, atMe: false, mentionCount: 5 }, [{ mention: true }]), false);
  assert.equal(matchFacts({ ...base, atMe: false, mentionCount: 5 }, [{}]), true);
});
