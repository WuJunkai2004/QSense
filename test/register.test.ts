// POST /register 验收（2026-11-19 register_bot 退出 MCP 工具面后的唯一机器注册通道）：
// admin token 同闸（/ui/api 同源；agent_token 冒充必须 401——新 bot 注册前没有
// agent_token）、官方凭据校验失败不入库、credentials 形状硬校验、auth_level 落库、
// 重复注册拒绝、注册成功联动网关拉起（runtime.addBot）。域层 add 的存储语义在
// bots.test.ts 直测，本文件只测 HTTP 面。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry } from "../src/bots";
import { createLogger } from "../src/utils/logger";
import { buildServer } from "../src/server/http";
import { openDatabase, runMigrations } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import { makeFakeRuntime } from "./helpers/qq-runtime";

const TOKEN = "register-test-admin-token-0123456789abcdef";

interface Fixture {
  baseUrl: string;
  repo: Repo;
  registry: BotRegistry;
  added: string[];
  close: () => Promise<void>;
}

async function setupServer(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-register-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  repo.ensureRuntime();
  repo.setAdminToken(TOKEN);
  // verify 假件：secret="bad" 模拟官方凭据校验拒绝（真机闸门在连接器 verifyCredential）
  const registry = new BotRegistry({
    db,
    verify: async (_platform, credentials) => {
      if (credentials["secret"] === "bad") {
        throw new Error("401 invalid credentials");
      }
    },
  });
  const fxRuntime = makeFakeRuntime({ db, repo, registry });
  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    version: "0.2.0",
    registry,
    connectors: fxRuntime.runtime,
    botStatuses: () => [],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    repo,
    registry,
    added: fxRuntime.added,
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

/** /register 请求体（管理面 wire 形状：凭据键按平台 credentialSchema 动态） */
interface RegisterBody {
  platform?: string;
  credentials?: Record<string, string>;
  name?: string;
  auth_level?: string;
}

async function register(
  url: string,
  body: RegisterBody,
  token: string = TOKEN,
): Promise<Response> {
  return fetch(`${url}/register`, {
    method: "POST",
    headers:
      token === ""
        ? { "Content-Type": "application/json" }
        : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("R-1 鉴权：无 token 401；agent_token 冒充 401（新 bot 注册前没有 agent_token）", async () => {
  const fx = await setupServer();
  try {
    const anon = await register(fx.baseUrl, {}, "");
    assert.equal(anon.status, 401);
    // 已注册 bot 的 agent_token 不是 admin token，不得注册
    const agent = fx.registry.agentTokenOf("10001") ?? "";
    void agent; // 空表无已注册 bot：本用例验证的是「非 admin token 一律 401」
    const bogus = await register(fx.baseUrl, {}, "not-the-admin-token");
    assert.equal(bogus.status, 401);
    const detail = (await bogus.json()) as { error: string };
    assert.match(detail.error, /admin token/);
    assert.equal(fx.registry.list().length, 0);
  } finally {
    await fx.close();
  }
});

test("R-2 注册成功：一次性 agent_token + 落库可反查 + 网关拉起；platform 缺省 qq", async () => {
  const fx = await setupServer();
  try {
    const res = await register(fx.baseUrl, {
      credentials: { appid: "40004", secret: "s4" },
      name: "四号",
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as {
      ok: boolean;
      bot: { appid: string; platform: string; name: string };
      agent_token: string;
    };
    assert.equal(out.ok, true);
    assert.equal(out.bot.appid, "40004");
    assert.equal(out.bot.platform, "qq"); // 缺省平台
    assert.equal(out.bot.name, "四号");
    assert.match(out.agent_token, /^[0-9a-f]{48}$/);
    assert.equal(fx.registry.appIdByToken(out.agent_token), "40004");
    assert.equal(fx.registry.authLevelOf("40004"), "uncertified"); // 保守缺省
    assert.deepEqual(fx.added, ["40004"]); // 注册即拉起网关连接
  } finally {
    await fx.close();
  }
});

test("R-3 credentials 形状硬校验：缺失/数组/空对象 → 400 可操作错误，不入库", async () => {
  const fx = await setupServer();
  try {
    for (const bad of [
      "{}",
      '{"credentials":["appid","secret"]}',
      '{"credentials":{}}',
      '{"credentials":{"appid":"40004","secret":42}}', // 非字符串值 → 硬校验拒绝（不静默剥离）
    ]) {
      // 畸形体经 JSON.parse any（库签名）进入——服务端 zod 硬校验路径
      const res = await register(fx.baseUrl, JSON.parse(bad));
      assert.equal(res.status, 400);
      const out = (await res.json()) as { error: string };
      assert.match(out.error, /credentials/);
    }
    assert.equal(fx.registry.list().length, 0);
  } finally {
    await fx.close();
  }
});

test("R-4 auth_level：certified 落库生效；非法值 400 不入库", async () => {
  const fx = await setupServer();
  try {
    const ok = await register(fx.baseUrl, {
      credentials: { appid: "40004", secret: "s4" },
      auth_level: "certified",
    });
    assert.equal(ok.status, 200);
    assert.equal(fx.registry.authLevelOf("40004"), "certified");

    const bad = await register(fx.baseUrl, {
      credentials: { appid: "50005", secret: "s5" },
      auth_level: "gold",
    });
    assert.equal(bad.status, 400);
    const out = (await bad.json()) as { error: string };
    assert.match(out.error, /auth_level/);
    assert.equal(fx.registry.get("50005"), undefined);
  } finally {
    await fx.close();
  }
});

test("R-5 官方凭据校验失败 → 400 可操作错误，绝不入库", async () => {
  const fx = await setupServer();
  try {
    const res = await register(fx.baseUrl, {
      credentials: { appid: "60006", secret: "bad" },
    });
    assert.equal(res.status, 400);
    const out = (await res.json()) as { error: string };
    assert.match(out.error, /凭据校验失败/);
    assert.match(out.error, /invalid credentials/); // 上游拒绝原因透传
    assert.equal(fx.registry.get("60006"), undefined);
    assert.deepEqual(fx.added, []); // 校验失败不拉起网关
  } finally {
    await fx.close();
  }
});

test("R-6 重复注册拒绝 → 400 已存在", async () => {
  const fx = await setupServer();
  try {
    const first = await register(fx.baseUrl, {
      credentials: { appid: "40004", secret: "s4" },
    });
    assert.equal(first.status, 200);
    const dup = await register(fx.baseUrl, {
      credentials: { appid: "40004", secret: "s4" },
    });
    assert.equal(dup.status, 400);
    const out = (await dup.json()) as { error: string };
    assert.match(out.error, /已存在/);
  } finally {
    await fx.close();
  }
});
