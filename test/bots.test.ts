// M8/M9 验收（注册表）：bots 表唯一存储、agent_token 生命周期（生成/轮换/反查）、
// 每 bot 白名单、每 bot 认证等级（M9 落库）、注册制（M9 起无任何 env/kv 播种——
// bot 只能经 add/WebUI 注册进表），register_bot / token_refresh 工具面与
// token 绑定 bot 强校验。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry, BotRegistryError } from "../src/bots";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import {
  runTool,
  ToolError,
  UNTRUSTED_NOTICE,
  type ToolContext,
} from "../src/tools/defs";

const SEED = { appid: "10001", secret: "s1", name: "主bot" };
const GROUP_A = "GROUP_A";

function setupDb(): { db: DB; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-m8-bots-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  return {
    db,
    close: () => {
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

function newRegistry(
  db: DB,
  verify?: (app: { appid: string }) => Promise<void>,
): BotRegistry {
  return new BotRegistry({
    db,
    ...(verify ? { verify } : {}),
  });
}

/** 注册基座 bot 并构造绑定它的 ToolContext（M9：bot 只能经 add 注册进表） */
async function ctxOf(
  db: DB,
  reg: BotRegistry,
  app: { appid: string; secret: string; name?: string } = SEED,
): Promise<ToolContext> {
  await reg.add(app);
  return { repo: new Repo(db), bots: reg, botId: app.appid };
}

test("M9-B1 注册制：空表构造不播种，list 为空；重启后仍是表内数据", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    assert.deepEqual(reg.list(), []); // env/kv 播种已退役
    const reg2 = newRegistry(fx.db);
    await reg2.add(SEED);
    assert.deepEqual(
      newRegistry(fx.db)
        .list()
        .map((a) => a.appid),
      ["10001"], // 重启不丢、也不重复
    );
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
    assert.equal(reg.authLevelOf("20002"), "uncertified"); // 默认未认证（保守）

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
    await reg.add(SEED);
    await assert.rejects(
      () => reg.add({ appid: "10001", secret: "x" }),
      /已存在/,
    );
    await assert.rejects(() => reg.add({ appid: "", secret: "x" }), /不能为空/);
    const bad = new BotRegistry({
      db: fx.db,
      verify: async () => {
        throw new Error("接口访问源IP不在白名单(code 11298)");
      },
    });
    await assert.rejects(
      () => bad.add({ appid: "30003", secret: "s3" }),
      /11298/,
    );
    assert.equal(reg.get("30003"), undefined); // 校验失败不入库
  } finally {
    fx.close();
  }
});

test("M9-B3b add：auth_level 落库（缺省 uncertified），非法值拒绝", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    await reg.add({ ...SEED, authLevel: "certified" });
    assert.equal(reg.authLevelOf("10001"), "certified");
    const b = await reg.add({ appid: "20002", secret: "s2" });
    assert.equal(reg.authLevelOf("20002"), "uncertified");
    reg.setAuthLevel("20002", "certified");
    assert.equal(reg.authLevelOf("20002"), "certified");
    reg.setAuthLevel("20002", "uncertified");
    assert.equal(reg.authLevelOf("20002"), "uncertified");
    await assert.rejects(
      () =>
        reg.add({
          appid: "30003",
          secret: "s3",
          authLevel: "gold" as never,
        }),
      (e: unknown) =>
        e instanceof BotRegistryError && e.message.includes("auth_level"),
    );
    assert.throws(() => reg.setAuthLevel("30003", "certified"), /不在注册表中/);
    assert.equal(reg.authLevelOf("99999"), "uncertified"); // 未注册按保守档
    assert.equal(reg.appIdByToken(b.agentToken), "20002");
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

test("M8-B7 register_bot：返回一次 token + 表内可反查；重复注册拒绝", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const ctx = await ctxOf(fx.db, reg);
    const raw = await runTool(
      "register_bot",
      { appid: "40004", secret: "s4", name: "四号" },
      ctx,
    );
    assert.equal(raw.isError, undefined);
    assert.ok(raw.text.startsWith(UNTRUSTED_NOTICE));
    const out = JSON.parse(raw.text.split("\n").slice(1).join("\n")) as Record<
      string,
      unknown
    >;
    assert.match(String(out.agent_token), /^[0-9a-f]{48}$/);
    assert.equal(reg.appIdByToken(String(out.agent_token)), "40004");
    const dup = await runTool(
      "register_bot",
      { appid: "40004", secret: "s4" },
      ctx,
    );
    assert.equal(dup.isError, true);
  } finally {
    fx.close();
  }
});

test("M9-B7b register_bot：auth_level 参数落库（certified 生效）", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const ctx = await ctxOf(fx.db, reg);
    const raw = await runTool(
      "register_bot",
      { appid: "40004", secret: "s4", auth_level: "certified" },
      ctx,
    );
    assert.equal(raw.isError, undefined);
    assert.equal(reg.authLevelOf("40004"), "certified");
    const bad = await runTool(
      "register_bot",
      { appid: "50005", secret: "s5", auth_level: "gold" },
      ctx,
    );
    assert.equal(bad.isError, true); // runTool 将校验错误转 isError
    assert.equal(reg.get("50005"), undefined);
  } finally {
    fx.close();
  }
});

test("M8-B8 token_refresh：换发新 token，旧 token 立即失效", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const added = await reg.add({ appid: "20002", secret: "s2" });
    const ctx: ToolContext = {
      repo: new Repo(fx.db),
      bots: reg,
      botId: "20002",
    };
    const raw = await runTool("token_refresh", {}, ctx);
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

test("M8-B9 token 绑定：bot 参数已退役（传了也被忽略）；未绑定 ctx 硬拒绝；list_bots 已移除", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const ctx = await ctxOf(fx.db, reg);
    // bot 绑定在 HTTP 层 Bearer→bot 完成，工具层不再校验 bot 参数（多余参数忽略）
    const ignored = await runTool("list_all", { bot: "20002" }, ctx);
    assert.equal(ignored.isError, undefined);
    // 无 botId 的 ctx（鉴权缺失）仍硬拒绝
    const unbound = await runTool("list_all", {}, { repo: new Repo(fx.db) });
    assert.equal(unbound.isError, true);
    assert.match(unbound.text, /未绑定/);
    const gone = await runTool("list_bots", {}, ctx);
    assert.equal(gone.isError, true);
    assert.match(gone.text, /未知工具/);
  } finally {
    fx.close();
  }
});
