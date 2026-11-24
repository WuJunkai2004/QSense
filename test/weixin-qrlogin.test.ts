// 微信扫码登录测试（P4；B⁺ T4.2 起 FakeNetKit 驱动）：插件 webui 路由（create/poll）
// + 后台状态机全状态——零真实网络。
// 覆盖：创建任务（local_token_list / 令牌不下发）、wait→scaned→confirmed 出凭据
// （appid 安全形式 / baseurl / owner_id）、binded_redirect、need_verifycode /
// verify_code_blocked、expired、IDC 重定向、凭据不完整、上游连续失败、TTL 过期。

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ConnectorLogger,
  PluginContext,
  StatePort,
  WebuiRouteOut,
} from "@qsense/connector-sdk";
import {
  FakeNetKit,
  NetError,
  createNetKit,
  jsonResponse,
} from "@qsense/connector-sdk";
import {
  WeixinError,
  createWeixinConnector,
  type QrLoginManagerDeps,
  type WeixinConnectorPlugin,
} from "@qsense/connector-weixin";

const QR_CONTENT = "https://weixin.qq.com/q/ABC";
const BASE = "https://ilinkai.weixin.qq.com";

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

function fakeHost(): PluginContext {
  const noop = (): void => undefined;
  return {
    log: noopLog(),
    state: {
      async get<T = unknown>() {
        return null as T;
      },
      async set() {},
      async delete() {},
    } satisfies StatePort,
    ingest: noop,
    reportStatus: noop,
    net: createNetKit(),
  };
}

/** 延迟应答句柄：测试在「挂起中」时推进时钟/改条件后再放行 */
interface Deferred {
  kind: "deferred";
  promise: Promise<Record<string, unknown>>;
  resolve: (v: Record<string, unknown>) => void;
}

function deferred(): Deferred {
  let resolve!: (v: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((r) => {
    resolve = r;
  });
  return { kind: "deferred", promise, resolve };
}

type Step = Record<string, unknown> | Error | Deferred;

/** create 应答 wire 形状（iLink get_bot_qrcode 实际消费字段） */
interface QrCreateResp {
  qrcode: string;
  qrcode_img_content: string;
}

interface QrFake {
  kit: FakeNetKit;
  /** 状态查询脚本（按调用序出队；耗尽后永久挂起——不占事件循环句柄） */
  steps: Step[];
  createStatus: number;
  createBody: QrCreateResp;
  createError: Error | null;
}

function qrFake(): QrFake {
  const kit = new FakeNetKit();
  const fx: QrFake = {
    kit,
    steps: [],
    createStatus: 200,
    createBody: { qrcode: "QR-TOKEN", qrcode_img_content: QR_CONTENT },
    createError: null,
  };
  kit.onMatch(
    (u) => u.includes("/get_bot_qrcode") || u.includes("/get_qrcode_status"),
    async (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/get_bot_qrcode")) {
        if (fx.createError !== null) throw fx.createError;
        return jsonResponse(fx.createBody, { status: fx.createStatus });
      }
      // get_qrcode_status：脚本出队；耗尽后挂起（模拟服务端长轮询，无句柄不阻塞退出）
      const next = fx.steps.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) return new Promise<never>(() => undefined);
      if ("promise" in next) {
        // Deferred.promise 声明即 Record 形状（测试自产自销，断言收口一次）
        const payload: Record<string, unknown> = (await next.promise) as Record<string, unknown>;
        return jsonResponse(payload);
      }
      return jsonResponse(next);
    },
  );
  return fx;
}

interface QrTestPlugin extends WeixinConnectorPlugin {
  createQr(): Promise<{ task_id: string; connect_url: string; interval_s: number }>;
  pollQr(taskId: string): Promise<Record<string, unknown>>;
}

type QrOpts = Pick<
  QrLoginManagerDeps,
  "ttlMs" | "pollTimeoutMs" | "retryDelayMs" | "maxFailures"
>;

function makePlugin(fx: QrFake, qr: Partial<QrOpts> = {}): QrTestPlugin {
  const plugin = createWeixinConnector({
    net: fx.kit,
    qr: { retryDelayMs: 5, ...qr },
  });
  const route = (path: string) =>
    plugin.webui!.find((r) => r.method === "POST" && r.path === path)!;
  // 控制反转：webui 路由经 handle 输入调用（body = JSON 文本跨界）
  const call = async (
    path: string,
    body?: { task_id?: string },
  ): Promise<WebuiRouteOut> =>
    route(path).handle({
      path,
      params: {},
      query: {},
      rawBody: body === undefined ? undefined : JSON.stringify(body),
      configOf: () => ({}),
      stateOf: () => fakeStatePort(),
    });
  return Object.assign(plugin, {
    createQr: async () =>
      (await call("/login/qr/create")) as {
        task_id: string;
        connect_url: string;
        interval_s: number;
      },
    pollQr: async (taskId: string) =>
      (await call("/login/qr/poll", { task_id: taskId })) as Record<string, unknown>,
  });
}

/** 测试假 StatePort（值 = JSON 文本，与 StatePort B⁺ T6 契约一致） */
function fakeStatePort(): StatePort {
  return {
    async get() {
      return null;
    },
    async set() {},
    async delete() {},
  };
}

const CONFIRMED = {
  status: "confirmed",
  bot_token: "BOT-TOKEN-XYZ",
  ilink_bot_id: "abc123@im.bot",
  baseurl: "https://ilink-sh.weixin.qq.com",
  ilink_user_id: "u1@im.wechat",
};

function statusCalls(fx: QrFake) {
  return fx.kit.requests.filter((r) => r.url.includes("/get_qrcode_status"));
}

/** 经 poll 路由轮询直到任务进入指定状态（failed 以抛错形式呈现） */
async function waitStatus(
  plugin: QrTestPlugin,
  taskId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    let actual: string;
    try {
      actual = String((await plugin.pollQr(taskId))["status"]);
    } catch (e) {
      if (!(e instanceof WeixinError)) throw e;
      actual = "failed";
    }
    if (actual === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`waitStatus 超时：期望 ${expected}，实际 ${actual}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitCalls(fx: QrFake, n: number): Promise<void> {
  const deadline = Date.now() + 4000;
  while (statusCalls(fx).length < n) {
    if (Date.now() > deadline) throw new Error(`waitCalls 超时：期望 ≥${n} 次状态查询`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ——

test("create：get_bot_qrcode（bot_type=3）→ task_id + 二维码内容；轮询令牌不下发", async () => {
  const fx = qrFake();
  const plugin = makePlugin(fx);
  const out = await plugin.createQr();
  assert.equal(typeof out.task_id, "string");
  assert.equal(out.connect_url, QR_CONTENT);
  assert.equal(out.interval_s, 2);
  const call = fx.kit.requests[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, `${BASE}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.deepEqual(JSON.parse(String(call.body)), { local_token_list: [] });
  // qrcode（轮询令牌）只留服务端内存
  assert.equal(JSON.stringify(out).includes("QR-TOKEN"), false);
  assert.equal(call.headers["authorization"], undefined);
});

test("create：local_token_list = 本端已注册 bot 的 token（至多 10 个；forget 即注销）", async () => {
  const fx = qrFake();
  const plugin = makePlugin(fx);
  const reg = (botId: string, token: string) =>
    plugin.create(fakeHost(), {
      botId,
      platform: "weixin",
      credential: { appid: botId, token },
    });
  reg("b1", "t1");
  reg("b2", "t2");
  reg("b3", ""); // 空 token 不带
  for (let i = 4; i <= 12; i += 1) reg(`b${i}`, `t${i}`);
  plugin.forget("b2");
  await plugin.createQr();
  const list = (JSON.parse(String(fx.kit.requests[0]!.body)) as { local_token_list: string[] })
    .local_token_list;
  assert.equal(list.length, 10); // 上限 10
  assert.equal(list.includes("t2"), false); // 已 forget
  assert.equal(list.at(-1), "t12"); // 最新在后
  assert.equal(list.includes("t1"), true);
});

test("状态机：wait → scaned → confirmed → completed 出凭据（appid 安全形式 / baseurl / owner_id）", async () => {
  const fx = qrFake();
  fx.steps.push({ status: "wait" }, { status: "scaned" }, CONFIRMED);
  const plugin = makePlugin(fx);
  const { task_id } = await plugin.createQr();
  await waitStatus(plugin, task_id, "completed");
  const out = await plugin.pollQr(task_id);
  assert.deepEqual(out, {
    status: "completed",
    credential: {
      appid: "abc123-im-bot", // ilink_bot_id 的 @ → -
      token: "BOT-TOKEN-XYZ",
      base_url: "https://ilink-sh.weixin.qq.com",
      owner_id: "u1@im.wechat",
    },
  });
  // 终态后任务保留到 TTL（重复 poll 幂等返回同一终态）
  assert.deepEqual(await plugin.pollQr(task_id), out);
});

test("状态机：等待中 poll 回 pending；已扫码回 pending（scanned=true 不外露差异）", async () => {
  const fx = qrFake();
  const gate = deferred();
  fx.steps.push({ status: "scaned" }, gate);
  const plugin = makePlugin(fx);
  const { task_id } = await plugin.createQr();
  await waitCalls(fx, 2); // 第二次查询挂起中
  assert.deepEqual(await plugin.pollQr(task_id), { status: "pending" });
  // 收尾：放行挂起的查询并让任务走到终态（不遗留后台状态机）
  gate.resolve({ status: "expired" });
  await waitStatus(plugin, task_id, "expired");
});

test("终态失败映射：binded_redirect / need_verifycode / blocked / 凭据不完整 → 带状态的可操作错误", async () => {
  const cases: Array<[Record<string, unknown>, number, RegExp]> = [
    [{ status: "binded_redirect" }, 409, /已绑定/],
    [{ status: "need_verifycode" }, 409, /配对码/],
    [{ status: "confirmed_but_need_verifycode" }, 409, /配对码/], // beta 新态
    [{ status: "verify_code_blocked" }, 409, /锁定/],
    [{ status: "confirmed", ilink_bot_id: "x@im.bot" }, 502, /完整凭据/], // 缺 token
  ];
  for (const [step, status, pattern] of cases) {
    const fx = qrFake();
    fx.steps.push(step);
    const plugin = makePlugin(fx);
    const { task_id } = await plugin.createQr();
    await waitStatus(plugin, task_id, "failed");
    await assert.rejects(() => plugin.pollQr(task_id), (e: unknown) => {
      assert.ok(e instanceof WeixinError, "应为 WeixinError");
      assert.equal(e.status, status);
      assert.match(e.message, pattern);
      return true;
    });
  }
});

test("expired 与未知任务：poll 回 {status:\"expired\"}（前端据此重开任务）", async () => {
  const fx = qrFake();
  fx.steps.push({ status: "expired" });
  const plugin = makePlugin(fx);
  const { task_id } = await plugin.createQr();
  await waitStatus(plugin, task_id, "expired");
  assert.deepEqual(await plugin.pollQr(task_id), { status: "expired" });
  assert.deepEqual(await plugin.pollQr("no-such-task"), { status: "expired" });
  assert.deepEqual(await plugin.pollQr(""), { status: "expired" });
});

test("IDC 重定向：scaned_but_redirect 后续查询切到 https://{redirect_host}；非法主机名忽略", async () => {
  {
    const fx = qrFake();
    fx.steps.push(
      { status: "scaned_but_redirect", redirect_host: "ilink-sh.weixin.qq.com" },
      CONFIRMED,
    );
    const plugin = makePlugin(fx);
    const { task_id } = await plugin.createQr();
    await waitStatus(plugin, task_id, "completed");
    const calls = statusCalls(fx);
    assert.equal(calls[0]!.url.startsWith(`${BASE}/`), true);
    assert.equal(calls[1]!.url.startsWith("https://ilink-sh.weixin.qq.com/"), true);
  }
  {
    // 非法主机名（带路径/查询）：不切换入口
    const fx = qrFake();
    fx.steps.push(
      { status: "scaned_but_redirect", redirect_host: "evil.example/x?y=1" },
      CONFIRMED,
    );
    const plugin = makePlugin(fx);
    const { task_id } = await plugin.createQr();
    await waitStatus(plugin, task_id, "completed");
    assert.equal(
      statusCalls(fx)[1]!.url.startsWith(`${BASE}/`),
      true,
    );
  }
});

test("容错：未知状态按等待继续；可重试失败达上限 → failed；TTL 到期 → expired", async () => {
  // 未知状态（协议漂移容忍）→ 继续直到 confirmed
  {
    const fx = qrFake();
    fx.steps.push({ status: "brand_new_status" }, CONFIRMED);
    const plugin = makePlugin(fx);
    const { task_id } = await plugin.createQr();
    await waitStatus(plugin, task_id, "completed");
    assert.equal(statusCalls(fx).length, 2);
  }
  // 连续网络失败达上限（NetError network 经真 api 层分档 → WeixinApiError network）
  {
    const fx = qrFake();
    fx.steps.push(
      new NetError("network", "fetch failed"),
      new NetError("network", "fetch failed"),
    );
    const plugin = makePlugin(fx, { maxFailures: 2 });
    const { task_id } = await plugin.createQr();
    await waitStatus(plugin, task_id, "failed");
    await assert.rejects(() => plugin.pollQr(task_id), /连续失败/);
  }
  // 单次网络失败后重试成功
  {
    const fx = qrFake();
    fx.steps.push(new NetError("network", "fetch failed"), CONFIRMED);
    const plugin = makePlugin(fx);
    const { task_id } = await plugin.createQr();
    await waitStatus(plugin, task_id, "completed");
  }
  // TTL：fake 时钟推进超过存活上限 → expired
  {
    const fx = qrFake();
    const gate = deferred();
    fx.steps.push({ status: "wait" }, gate);
    const plugin = makePlugin(fx, { ttlMs: 60_000 });
    const { task_id } = await plugin.createQr();
    await waitCalls(fx, 2); // 第二次查询挂起中
    fx.kit.tick(61_000); // fake 时钟推进（net.now()）
    gate.resolve({ status: "wait" });
    await waitStatus(plugin, task_id, "expired");
  }
});

test("create 上游失败：HTTP 5xx / 缺字段 / 网络异常 → 502 可操作错误", async () => {
  const setups: Array<(fx: QrFake) => void> = [
    (fx) => {
      fx.createStatus = 500;
    },
    (fx) => {
      fx.createBody = { qrcode: "only-token", qrcode_img_content: "" };
    },
    (fx) => {
      fx.createError = new NetError("network", "fetch failed");
    },
  ];
  for (const setup of setups) {
    const fx = qrFake();
    setup(fx);
    const plugin = makePlugin(fx);
    await assert.rejects(() => plugin.createQr(), (e: unknown) => {
      assert.ok(e instanceof WeixinError, "应为 WeixinError");
      assert.equal(e.status, 502);
      return true;
    });
  }
});

test("声明面：login 为 qr-pair 且 create/poll 路由真实存在（加载闸门 validateLoginFlow）", () => {
  const plugin = createWeixinConnector({});
  assert.deepEqual(plugin.login, {
    kind: "qr-pair",
    create: "/login/qr/create",
    poll: "/login/qr/poll",
  });
  const paths = plugin.webui!.map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(paths, ["POST /login/qr/create", "POST /login/qr/poll"]);
});
