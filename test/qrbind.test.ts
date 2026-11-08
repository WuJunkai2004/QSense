// 扫码绑定（q.qq.com lite）验收：
// - 单元：AES-256-GCM 解密往返 / 密文篡改与格式错误 / create-poll 状态映射（假 fetch）
// - 集成（假上游 HTTP 端点）：create → poll(pending) → 模拟扫码确认 → poll(created
//   联动既有注册管线：官方两级凭据校验 + 落库 + supervisor 拉起 + agent_token 一次性返回)
//   → 任务即焚（再 poll 同一 task_id = expired）→ 未知 task_id = expired → bot 重复扫码 400

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry } from "../src/bots";
import type { GatewaySupervisor } from "../src/gateway";
import type { TokenService } from "../src/gateway/token";
import { createLogger } from "../src/logger";
import {
  QrBindError,
  createQrBindTask,
  decryptBindSecret,
  pollQrBind,
  type QrBindDeps,
} from "../src/qrbind";
import { buildServer } from "../src/server/http";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";

const TOKEN = "qr-test-admin-token-0123456789abcdef";

function fakeFetch(
  handler: (path: string, body: Record<string, unknown>) => unknown,
): typeof fetch & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(_url);
    const path = url.slice(url.indexOf("/", 8));
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    const payload = handler(path, body as Record<string, unknown>);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return Object.assign(impl, { calls }) as typeof fetch & {
    calls: Array<{ path: string; body: unknown }>;
  };
}

/** 用 bindKey 加密 AppSecret（模拟官方 bot_encrypt_secret：nonce12‖ct‖tag16 的 base64） */
function encryptFor(bindKey: string, secret: string): string {
  const key = Buffer.from(bindKey, "base64");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

test("qrbind 单元：解密往返、篡改拒绝、格式错误", () => {
  const bindKey = randomBytes(32).toString("base64");
  const enc = encryptFor(bindKey, "S3cret-密文");
  assert.equal(decryptBindSecret(enc, bindKey), "S3cret-密文");

  // 篡改密文（换一个密钥加密的密文）→ GCM 校验失败
  const otherKey = randomBytes(32).toString("base64");
  assert.throws(
    () => decryptBindSecret(encryptFor(otherKey, "x"), bindKey),
    QrBindError,
  );
  // 格式错误：非 base64 / 过短
  assert.throws(() => decryptBindSecret("!!", bindKey), QrBindError);
  assert.throws(() => decryptBindSecret(enc.slice(0, 8), bindKey), QrBindError);
});

test("qrbind 单元：create/poll 状态映射（假 fetch，bind_key 上交且不出模块）", async () => {
  // 有状态假上游：create 记 key；poll 按 status 给形状
  let storedKey = "";
  let upstreamStatus = 1;
  const fetchImpl = fakeFetch((path, body) => {
    if (path === "/lite/create_bind_task") {
      storedKey = String(body.key);
      return {
        retcode: 0,
        msg: "success",
        data: { task_id: "TID-1" },
      };
    }
    if (path === "/lite/poll_bind_result") {
      assert.equal(body.task_id, "TID-1");
      return {
        retcode: 0,
        data: {
          status: upstreamStatus,
          bot_appid: upstreamStatus === 2 ? "20001" : "0",
          bot_encrypt_secret:
            upstreamStatus === 2 ? encryptFor(storedKey, "sec-1") : "",
          user_openid: upstreamStatus === 2 ? "U_SCANNER" : "",
        },
      };
    }
    return { retcode: 404 };
  });
  const deps: QrBindDeps = { fetchImpl, host: "mock.invalid" };

  const task = await createQrBindTask(deps);
  assert.equal(task.taskId, "TID-1");
  assert.equal(
    task.connectUrl,
    "https://mock.invalid/qqbot/openclaw/connect.html?task_id=TID-1&_wv=2",
  );
  // create 时上交 32 字节 base64 密钥
  const sent = fetchImpl.calls[0].body as { key: string };
  assert.equal(Buffer.from(sent.key, "base64").length, 32);
  assert.equal(sent.key, task.bindKey);

  assert.deepEqual(await pollQrBind(task, deps), { status: "pending" });
  upstreamStatus = 3;
  assert.deepEqual(await pollQrBind(task, deps), { status: "expired" });
  upstreamStatus = 2;
  const done = await pollQrBind(task, deps);
  assert.equal(done.status, "completed");
  if (done.status === "completed") {
    assert.equal(done.appid, "20001");
    assert.equal(done.secret, "sec-1"); // 用我方 bind_key 解出的明文
    assert.equal(done.userOpenid, "U_SCANNER");
  }
  // 上游 retcode!=0 → QrBindError（提示可手动添加）
  const failing = fakeFetch(() => ({ retcode: 11297, msg: "频繁" }));
  await assert.rejects(
    createQrBindTask({ fetchImpl: failing, host: "mock.invalid" }),
    /retcode=11297/,
  );
});

// —— 集成：/ui/api/qr-bind/* 全流程（假上游 + 真注册管线） ——

const TOKEN_ADMIN = TOKEN;
const SECRET = "qr-secret-1";

interface QrFixture {
  baseUrl: string;
  added: string[];
  upstream: { key: string; scanned: boolean };
  close: () => Promise<void>;
}

async function setupQrServer(seedAppid?: string): Promise<QrFixture> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-qr-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  repo.ensureRuntime();
  repo.setAdminToken(TOKEN_ADMIN);
  const registry = new BotRegistry({
    db,
    verify: async (app) => {
      if (app.secret === "bad") throw new Error("401 invalid credentials");
    },
  });
  if (seedAppid !== undefined) {
    await registry.add({ appid: seedAppid, secret: "already-there", name: "已有" });
  }
  const added: string[] = [];
  const supervisor = {
    addBot: (app: { appid: string }) => {
      added.push(app.appid);
    },
    removeBot: () => {},
  } as unknown as GatewaySupervisor;
  const tokens = { clear: () => {} } as unknown as TokenService;

  // 有状态假上游：create 存 key；扫码置位后 poll 给 completed（真加密）
  const upstream = { key: "", scanned: false };
  let taskIdN = 0;
  const fetchImpl = fakeFetch((path, body) => {
    if (path === "/lite/create_bind_task") {
      upstream.key = String(body.key);
      upstream.scanned = false;
      taskIdN += 1;
      return { retcode: 0, data: { task_id: `T-${taskIdN}` } };
    }
    const done = upstream.scanned;
    return {
      retcode: 0,
      data: {
        status: done ? 2 : 1,
        bot_appid: done ? "30001" : "0",
        bot_encrypt_secret: done ? encryptFor(upstream.key, SECRET) : "",
        user_openid: done ? "U_QR" : "",
      },
    };
  });

  const uiDir = join(dir, "fake-ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>qr-ui</title>");
  process.env.UI_DIST_DIR = uiDir;

  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    version: "0.2.0",
    registry,
    supervisor,
    tokens,
    botStatuses: () => [],
    qrBind: { fetchImpl, host: "mock.invalid" },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    added,
    upstream,
    close: async () => {
      delete process.env.UI_DIST_DIR;
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
  Authorization: `Bearer ${TOKEN_ADMIN}`,
  "Content-Type": "application/json",
});

test("qrbind 集成：扫码→pending→created 全流程（注册落库 + 任务即焚 + 未知任务 expired）", async () => {
  const fx = await setupQrServer();
  try {
    // admin token 过不了 /mcp 但必须通 /ui/api；create 拿到连接 URL
    const createRes = await fetch(`${fx.baseUrl}/ui/api/qr-bind/create`, {
      method: "POST",
      headers: auth(),
      body: "{}",
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as {
      task_id: string;
      connect_url: string;
      interval_s: number;
    };
    assert.match(created.connect_url, /task_id=T-1/);
    assert.equal(created.interval_s, 2);

    // 未扫码 → pending
    const poll1 = await fetch(`${fx.baseUrl}/ui/api/qr-bind/poll`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ task_id: created.task_id }),
    });
    assert.deepEqual(await poll1.json(), { status: "pending" });

    // 模拟用户手机 QQ 扫码确认（真加密：密钥只在服务端内存）
    fx.upstream.scanned = true;
    const poll2 = await fetch(`${fx.baseUrl}/ui/api/qr-bind/poll`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ task_id: created.task_id }),
    });
    assert.equal(poll2.status, 200);
    const done = (await poll2.json()) as {
      status: string;
      bot: { appid: string; name: string };
      agent_token: string;
    };
    assert.equal(done.status, "created");
    assert.equal(done.bot.appid, "30001");
    assert.equal(done.agent_token.length, 48);
    assert.deepEqual(fx.added, ["30001"]); // supervisor 已拉起

    // 任务即焚：同 task_id 再轮询 → expired（防重放拿 token）
    const poll3 = await fetch(`${fx.baseUrl}/ui/api/qr-bind/poll`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ task_id: created.task_id }),
    });
    assert.deepEqual(await poll3.json(), { status: "expired" });

    // 未知 task_id → expired
    const poll4 = await fetch(`${fx.baseUrl}/ui/api/qr-bind/poll`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ task_id: "NOPE" }),
    });
    assert.deepEqual(await poll4.json(), { status: "expired" });

    // 无鉴权请求被拒
    const anon = await fetch(`${fx.baseUrl}/ui/api/qr-bind/create`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(anon.status, 401);
  } finally {
    await fx.close();
  }
});

test("qrbind 集成：扫码添加重复 appid → 400 可操作错误，不落库不拉起", async () => {
  const fx = await setupQrServer("30001"); // 预注册，扫码完成的 appid 与之重复
  try {
    const createRes = await fetch(`${fx.baseUrl}/ui/api/qr-bind/create`, {
      method: "POST",
      headers: auth(),
      body: "{}",
    });
    const created = (await createRes.json()) as { task_id: string };
    fx.upstream.scanned = true;
    const poll = await fetch(`${fx.baseUrl}/ui/api/qr-bind/poll`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ task_id: created.task_id }),
    });
    assert.equal(poll.status, 400);
    const body = (await poll.json()) as { error: string };
    assert.match(body.error, /已存在/);
    assert.deepEqual(fx.added, []); // 未拉起网关
  } finally {
    await fx.close();
  }
});

test("qrbind 集成：上游不可达 → 502 且提示可手动添加", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-qr502-"));
  try {
    const db = openDatabase(dir);
    runMigrations(db, migrations);
    const repo = new Repo(db);
    repo.ensureRuntime();
    repo.setAdminToken(TOKEN_ADMIN);
    const registry = new BotRegistry({ db });
    const app = buildServer({
      log: createLogger("error"),
      db,
      repo,
      version: "0.2.0",
      registry,
      supervisor: {} as unknown as GatewaySupervisor,
      tokens: {} as unknown as TokenService,
      botStatuses: () => [],
      qrBind: {
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        host: "mock.invalid",
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ui/api/qr-bind/create`, {
        method: "POST",
        headers: auth(),
        body: "{}",
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /手动方式添加/);
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
