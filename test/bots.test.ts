// M8 验收（注册表）：bots 表唯一存储、agent_token 生命周期（生成/轮换/反查）、
// 每 bot 白名单、旧 kv bots:dynamic:v1 迁移、env seed 幂等、
// qq_register_bot / qq_token_refresh 工具面与 token 绑定 bot 强校验。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry, BotRegistryError } from "../src/bots";
import type { Config } from "../src/config";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import { runTool, ToolError, UNTRUSTED_NOTICE, type ToolContext } from "../src/tools/defs";

const SEED = { appid: "10001", secret: "s1", name: "主bot" };
const GROUP_A = "GROUP_A";

const TEST_CONFIG: Config = {
  apps: [],
  mcpToken: "x".repeat(20),
  host: "127.0.0.1",
  port: 0,
  dataDir: ".",
  sendEnabled: false,
  allowGroups: [],
  logContent: false,
  logLevel: "error",
  retentionDays: 90,
  authLevel: "uncertified",
};

function setupDb(): { db: DB; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-m8-bots-"));
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

function newRegistry(db: DB, verify?: (app: { appid: string }) => Promise<void>): BotRegistry {
  return new BotRegistry({
    db,
    seed: { apps: [SEED], allowGroups: [GROUP_A] },
    ...(verify ? { verify } : {}),
  });
}

function ctxOf(db: DB, reg: BotRegistry, botId: string): ToolContext {
  return { repo: new Repo(db), config: TEST_CONFIG, bots: reg, botId };
}

test("M8-B1 env seed：构造即灌表（幂等），token/白名单就位，重启不丢不重", () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    assert.deepEqual(
      reg.list().map((a) => a.appid),
      ["10001"],
    );
    assert.deepEqual(reg.allowGroupsOf("10001"), [GROUP_A]);
    // 重启（新实例）：不重复播种、数据不丢
    const reg2 = newRegistry(fx.db);
    assert.equal(reg2.list().length, 1);
    assert.equal(reg2.get("10001")?.secret, "s1");
  } finally {
    fx.close();
  }
});

test("M8-B2 add：verify → 落库 + 生成 token（仅返回一次语义），重启恢复", async () => {
  const fx = setupDb();
  try {
    const verified: string[] = [];
    const reg = newRegistry(fx.db, async (app) => {
      verified.push(app.appid);
    });
    const added = await reg.add({ appid: "20002", secret: "s2", name: "二号" });
    assert.deepEqual(verified, ["20002"]);
    assert.equal(added.app.appid, "20002");
    assert.match(added.agentToken, /^[0-9a-f]{48}$/); // 24 字节随机 hex
    assert.equal(reg.appIdByToken(added.agentToken), "20002");
    assert.deepEqual(reg.allowGroupsOf("20002"), []); // 新注册默认无白名单（安全默认）

    const reg2 = newRegistry(fx.db);
    assert.equal(reg2.get("20002")?.name, "二号");
  } finally {
    fx.close();
  }
});

test("M8-B3 add：重复 appid / 空参数 / verify 失败 → 明确报错且不入库", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    await assert.rejects(
      () => reg.add({ appid: "10001", secret: "x" }),
      /已存在/,
    );
    await assert.rejects(() => reg.add({ appid: "", secret: "x" }), /不能为空/);
    const bad = new BotRegistry({
      db: fx.db,
      seed: { apps: [], allowGroups: [] },
      verify: async () => {
        throw new Error("接口访问源IP不在白名单(code 11298)");
      },
    });
    await assert.rejects(() => bad.add({ appid: "30003", secret: "s3" }), /11298/);
    assert.equal(reg.get("30003"), undefined); // 校验失败不入库
  } finally {
    fx.close();
  }
});

test("M8-B4 轮换：旧 token 立即失效、新 token 反查命中；未注册报错", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const added = await reg.add({ appid: "20002", secret: "s2" });
    const fresh = reg.rotateToken("20002");
    assert.notEqual(fresh, added.agentToken);
    assert.equal(reg.appIdByToken(added.agentToken), null);
    assert.equal(reg.appIdByToken(fresh), "20002");
    assert.throws(() => reg.rotateToken("99999"), /不在注册表中/);
  } finally {
    fx.close();
  }
});

test("M8-B5 白名单：setAllowGroups 即时生效，remove 后反查全空", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const added = await reg.add({ appid: "20002", secret: "s2" });
    reg.setAllowGroups("20002", [GROUP_A, "GROUP_B"]);
    assert.deepEqual(reg.allowGroupsOf("20002"), [GROUP_A, "GROUP_B"]);
    const removed = reg.remove("20002");
    assert.equal(removed.appid, "20002");
    assert.equal(reg.appIdByToken(added.agentToken), null); // 移除连带 token 失效
    assert.deepEqual(reg.allowGroupsOf("20002"), []);
    assert.throws(() => reg.remove("20002"), /不在注册表中/);
  } finally {
    fx.close();
  }
});

test("M8-B6 旧 kv bots:dynamic:v1 迁移：灌表 + 删键", () => {
  const fx = setupDb();
  try {
    fx.db
      .prepare("INSERT INTO kv(k, v) VALUES ('bots:dynamic:v1', ?)")
      .run(JSON.stringify([{ appid: "30003", secret: "s3", name: "旧动态" }]));
    const reg = newRegistry(fx.db); // 构造时迁移
    assert.equal(reg.get("30003")?.name, "旧动态");
    assert.equal(
      fx.db.prepare("SELECT v FROM kv WHERE k = 'bots:dynamic:v1'").get(),
      undefined,
    );
    // 二次构造：无旧键、无重复行
    const reg2 = newRegistry(fx.db);
    assert.equal(reg2.list().length, 2);
  } finally {
    fx.close();
  }
});

test("M8-B7 qq_register_bot：返回一次 token + 表内可反查；重复注册拒绝", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const ctx = ctxOf(fx.db, reg, "10001");
    const raw = await runTool(
      "qq_register_bot",
      { appid: "40004", secret: "s4", name: "四号" },
      ctx,
    );
    assert.equal(raw.isError, undefined);
    const out = JSON.parse(raw.text.split("\n").slice(1).join("\n")) as Record<
      string,
      unknown
    >;
    assert.match(String(out.agent_token), /^[0-9a-f]{48}$/);
    assert.equal(reg.appIdByToken(String(out.agent_token)), "40004");
    const dup = await runTool(
      "qq_register_bot",
      { appid: "40004", secret: "s4" },
      ctx,
    );
    assert.equal(dup.isError, true);
  } finally {
    fx.close();
  }
});

test("M8-B8 qq_token_refresh：换发新 token，旧 token 立即失效", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const added = await reg.add({ appid: "20002", secret: "s2" });
    const ctx = ctxOf(fx.db, reg, "20002");
    const raw = await runTool("qq_token_refresh", {}, ctx);
    const out = JSON.parse(raw.text.split("\n").slice(1).join("\n")) as Record<
      string,
      unknown
    >;
    const fresh = String(out.agent_token);
    assert.notEqual(fresh, added.agentToken);
    assert.equal(reg.appIdByToken(added.agentToken), null);
    assert.equal(reg.appIdByToken(fresh), "20002");
  } finally {
    fx.close();
  }
});

test("M8-B9 token 绑定：bot 参数跨 bot → ToolError；qq_list_bots 已移除", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const ctx = ctxOf(fx.db, reg, "10001");
    // runTool 把 ToolError 转成 isError 返回（不向外抛），断言返回体
    const cross = await runTool("qq_list_groups", { bot: "20002" }, ctx);
    assert.equal(cross.isError, true);
    assert.match(cross.text, /绑定/);
    assert.equal(
      (await runTool("qq_list_groups", { bot: "10001" }, ctx)).isError,
      undefined,
    );
    const gone = await runTool("qq_list_bots", {}, ctx);
    assert.equal(gone.isError, true);
    assert.match(gone.text, /未知工具/);
  } finally {
    fx.close();
  }
});
