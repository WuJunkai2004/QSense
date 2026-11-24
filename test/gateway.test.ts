// M1 验收（mock 网关端到端，不依赖真实QQ消息）——P1 收口后经 connector-qq 实例 + core 运行时：
// 1. IDENTIFY 携带 "QQBot {token}" 与本项目 intents，READY 后会话持久化到 kv
// 2. 心跳携带最新 s 并收 ACK
// 3. dispatch 事件经 core ingest 管线上行（去重→入库）+ 消息级 id 去重
// 4. 断线 → RESUME 补发，事件不丢不重
// 5. op9 Invalid Session → 清会话重新 IDENTIFY
// 6. 4004 → 触发 clearTokenCache
// 7. 进程重启（新连接实例 + 同一 kv）→ 直接 RESUME 恢复
// 8. 接收开关与运行时接入（runtime.addBot）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry, FakeNetKit } from "@qsense/connector-sdk";
import { createQqConnector } from "@qsense/connector-qq";
import {
  ConnectorRuntime,
  type GatewayStatus,
} from "../src/connectors/runtime";
import { createIngestPipeline } from "../src/connectors/ingest";
import type { NormalizedMessage } from "@qsense/connector-sdk";
import { BotRegistry } from "../src/bots";
import { createLogger } from "../src/utils/logger";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import { MockGateway } from "./helpers/mock-gateway";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** tap 观测点的消息拍平（契约 v2：tap 收 {messages, effects}，重复事件消息被滤空） */
const flatMsgs = (
  captured: Array<{ messages: NormalizedMessage[] }>,
): NormalizedMessage[] => captured.flatMap((c) => c.messages);

async function waitFor(
  fn: () => boolean,
  what: string,
  ms = 8000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`waitFor 超时: ${what}`);
}

interface Ctx {
  dir: string;
  db: DB;
  gw: MockGateway;
  registry: BotRegistry;
  captured: Array<{ messages: NormalizedMessage[]; effects: unknown[] }>;
  statuses: GatewayStatus[];
  runtime: ConnectorRuntime;
  cleared: () => number;
}

async function setup(
  opts?: ConstructorParameters<typeof MockGateway>[0],
  behavior?: { receiveEnabled?: boolean },
): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-gw-test-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const gw = new MockGateway({ heartbeatIntervalMs: 40, ...opts });
  await gw.listen();

  // M9：无 config 回落——bot 经注册表入表后由运行时连接
  const registry = new BotRegistry({ db });
  await registry.add({
    credentials: { appid: "10001", secret: "secret-value" },
    name: "t",
  });
  if (behavior?.receiveEnabled === false) {
    registry.setReceiveEnabled("10001", false); // 模拟 WebUI 已禁用后再启动
  }
  const repo = new Repo(db);
  const captured: Array<{ messages: NormalizedMessage[]; effects: unknown[] }> = [];
  const statuses: GatewayStatus[] = [];
  let clearCount = 0;
  // /gateway 控制请求脚本化（原 getGatewayUrl 测试缝的形态收口）：网关地址指向本地 mock
  const kit = new FakeNetKit();
  kit.on("https://api.bot.qq.com/gateway", () => ({ body: { url: gw.url } }));
  const plugins = new ConnectorRegistry();
  plugins.register(
    createQqConnector({
      log: createLogger("error"),
      net: kit,
      overrides: {
        getAccessToken: async () => "test-access-token",
        clearTokenCache: () => {
          clearCount += 1;
        },
        reconnect: { delays: [50], maxAttempts: 100 },
      },
    }),
  );
  // 事件经 core ingest 管线（表驱动路由→去重→tap→入库）；tap 为测试观测点
  const ingest = createIngestPipeline({
    repo,
    log: createLogger("error"),
    plugins,
    tap: (e) => captured.push(e),
  });
  const runtime = new ConnectorRuntime({
    log: createLogger("error"),
    db,
    repo,
    bots: registry,
    plugins,
    ingest,
    onStatus: (s) => statuses.push(s),
  });
  void runtime.start();
  return {
    dir,
    db,
    gw,
    registry,
    captured,
    statuses,
    runtime,
    cleared: () => clearCount,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  ctx.runtime.stop();
  await ctx.runtime.start().catch(() => undefined); // 等连接循环退出
  await ctx.gw.close();
  ctx.db.close();
  try {
    rmSync(ctx.dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    /* Windows 句柄延迟，best-effort */
  }
}

const readyAt = (ctx: Ctx): Promise<void> =>
  waitFor(() => ctx.statuses.some((s) => s.state === "ready"), "READY");

test("M1-1 IDENTIFY 携带 QQBot token 与本项目 intents；READY 后会话持久化到 kv", async () => {
  const ctx = await setup();
  try {
    await readyAt(ctx);
    const id = ctx.gw.identifies[0];
    assert.ok(
      id.token.startsWith("QQBot test-access-token"),
      `token 格式错: ${id.token}`,
    );
    assert.equal(id.intents, (1 << 25) | (1 << 27));

    // P3：StatePort 物理键统一 connector:{platform}:{botId}:{key}（v12 已平移旧键）
    const row = ctx.db
      .prepare("SELECT v FROM kv WHERE k = 'connector:qq:10001:gw:session'")
      .get() as { v: string };
    const sess = JSON.parse(row.v) as { sessionId: string; lastSeq: number };
    assert.equal(sess.sessionId, "sess-1");
    assert.equal(sess.lastSeq, 1); // READY 自身 s=1
  } finally {
    await teardown(ctx);
  }
});

test("M1-2 心跳携带最新 s 并收到 ACK（连接保持）", async () => {
  const ctx = await setup();
  try {
    await readyAt(ctx);
    await waitFor(() => ctx.gw.heartbeats.length >= 2, "heartbeat");
    assert.equal(ctx.gw.heartbeats[0], 1); // 首跳 d = 最新 s（READY 的 1）
    assert.ok(
      ctx.statuses.every(
        (s) => s.state !== "disconnected" && s.state !== "fatal",
      ),
      "心跳期间不应断线",
    );
  } finally {
    await teardown(ctx);
  }
});

test("M1-3 dispatch 事件上行 + 同 id 重复事件去重", async () => {
  const ctx = await setup();
  try {
    await readyAt(ctx);
    const msg = {
      id: "m1",
      content: "hello",
      group_openid: "g1",
      author: { member_openid: "u1" },
    };
    ctx.gw.sendDispatch("GROUP_MESSAGE_CREATE", msg);
    await waitFor(
      () => flatMsgs(ctx.captured).some((m) => m.msgId === "m1"),
      "事件上行",
    );
    assert.equal(flatMsgs(ctx.captured).length, 1);
    assert.equal(flatMsgs(ctx.captured)[0]!.botId, "10001");
    assert.deepEqual(flatMsgs(ctx.captured)[0]!.raw, msg);

    // 官方重复推送同一消息 id → 去重器丢弃
    ctx.gw.sendDispatch("GROUP_MESSAGE_CREATE", { ...msg });
    await sleep(120);
    assert.equal(flatMsgs(ctx.captured).length, 1, "重复事件应被去重");
  } finally {
    await teardown(ctx);
  }
});

test("M1-4 断线 → RESUME 按序补发遗漏事件，不丢不重；心跳续用新 s", async () => {
  const ctx = await setup();
  try {
    await readyAt(ctx);
    const first = {
      id: "m1",
      content: "before",
      group_openid: "g1",
      author: { member_openid: "u1" },
    };
    ctx.gw.sendDispatch("GROUP_MESSAGE_CREATE", first);
    await waitFor(() => flatMsgs(ctx.captured).length === 1, "首条事件");

    // 异常断开（1006，会话保留），断线期间官方缓存两条
    ctx.gw.killSocket();
    ctx.gw.sendDispatch("GROUP_MESSAGE_CREATE", {
      id: "m2",
      content: "gap1",
      group_openid: "g1",
      author: { member_openid: "u1" },
    });
    ctx.gw.sendDispatch("GROUP_MESSAGE_CREATE", {
      id: "m3",
      content: "gap2",
      group_openid: "g1",
      author: { member_openid: "u1" },
    });

    await waitFor(
      () => ctx.statuses.some((s) => s.state === "resumed"),
      "RESUMED",
    );
    const r = ctx.gw.resumes[0];
    assert.equal(r.session_id, "sess-1");
    assert.equal(r.seq, 2, "RESUME seq 应为最后收到的 s（READY s=1 + m1 s=2）");

    await waitFor(() => flatMsgs(ctx.captured).length === 3, "补发到位");
    const ids = flatMsgs(ctx.captured).map((m) => (m.raw as { id: string }).id);
    assert.deepEqual(ids, ["m1", "m2", "m3"]);

    // 补发后 RESUMED s=5，心跳应携带新 s
    await waitFor(() => ctx.gw.heartbeats.some((h) => h === 5), "心跳新s");
  } finally {
    await teardown(ctx);
  }
});

test("M1-5 op9 Invalid Session → 清会话重新 IDENTIFY（不 RESUME）", async () => {
  const ctx = await setup({ invalidSessionOnFirstIdentify: true });
  try {
    await waitFor(
      () => ctx.gw.identifies.length >= 2,
      "第二次 IDENTIFY",
      10000,
    );
    await readyAt(ctx);
    assert.equal(
      ctx.gw.resumes.length,
      0,
      "op9(d=false) 后必须走全新 IDENTIFY",
    );
    assert.equal(ctx.gw.identifies[1].intents, (1 << 25) | (1 << 27));
  } finally {
    await teardown(ctx);
  }
});

test("M1-6 4004 token 失效 → 触发 clearTokenCache，会话保留并 RESUME 重连", async () => {
  const ctx = await setup();
  try {
    await readyAt(ctx);
    ctx.gw.closeWithCode(4004);
    await waitFor(() => ctx.cleared() >= 1, "clearTokenCache");
    // SDK 语义：4004 清 token 缓存但保留会话 → RESUME 重连（若服务端会话已失效会再经 4006/4009 回退全新 IDENTIFY）
    await waitFor(() => ctx.gw.resumes.length === 1, "4004 后 RESUME 重连");
    assert.equal(ctx.gw.resumes[0].session_id, "sess-1");
  } finally {
    await teardown(ctx);
  }
});

test("M1-7 进程重启（新连接实例 + 同一 kv）→ 直接 RESUME 恢复会话", async () => {
  const ctx = await setup();
  const log = createLogger("error");
  try {
    await readyAt(ctx);
    ctx.runtime.stop();
    await ctx.runtime.start().catch(() => undefined);

    // 模拟重启：同一 mock（持有 sess-1）+ 同一 kv，新运行时实例
    const statuses2: GatewayStatus[] = [];
    const kit2 = new FakeNetKit();
    kit2.on("https://api.bot.qq.com/gateway", () => ({ body: { url: ctx.gw.url } }));
    const plugins2 = new ConnectorRegistry();
    plugins2.register(
      createQqConnector({
        log,
        net: kit2,
        overrides: {
          getAccessToken: async () => "test-access-token",
          reconnect: { delays: [50], maxAttempts: 100 },
        },
      }),
    );
    const runtime2 = new ConnectorRuntime({
      log,
      db: ctx.db,
      repo: new Repo(ctx.db),
      bots: ctx.registry,
      plugins: plugins2,
      ingest: createIngestPipeline({ repo: new Repo(ctx.db), log, plugins: plugins2 }),
      onStatus: (s) => statuses2.push(s),
    });
    void runtime2.start();
    try {
      await waitFor(() => ctx.gw.resumes.length === 1, "RESUME");
      assert.equal(ctx.gw.resumes[0].session_id, "sess-1");
      assert.equal(ctx.gw.resumes[0].seq, 1);
      await waitFor(
        () => statuses2.some((s) => s.state === "resumed"),
        "RESUMED",
      );
    } finally {
      runtime2.stop();
      await runtime2.start().catch(() => undefined);
    }
  } finally {
    await teardown(ctx);
  }
});

test("M1-8 接收开关：启动时跳过禁用 bot；运行中启用 → addBot 接入网关", async () => {
  const ctx = await setup(undefined, { receiveEnabled: false });
  try {
    await sleep(300);
    assert.equal(ctx.gw.identifies.length, 0, "禁用 bot 不应发起 IDENTIFY");
    assert.equal(ctx.statuses.length, 0, "禁用 bot 不应产生网关状态");

    // WebUI 启用：落库 + addBot（运行时接入）
    ctx.registry.setReceiveEnabled("10001", true);
    const app = ctx.registry.get("10001");
    assert.ok(app);
    ctx.runtime.addBot(app);
    await readyAt(ctx);
    assert.equal(ctx.gw.identifies.length, 1);
  } finally {
    await teardown(ctx);
  }
});
