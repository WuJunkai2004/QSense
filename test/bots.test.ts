// M8/M9 验收（注册表）：bots 表唯一存储、agent_token 生命周期（生成/轮换/反查）、
// 每 bot 白名单、每 bot 认证等级（M9 落库）、注册制（M9 起无任何 env/kv 播种——
// bot 只能经 add/注册端点进表）与 token 绑定 bot 强校验。注册入口的 HTTP 面验收
// （POST /register）在 register.test.ts。
// P3 多平台中立化（2026-11-16）：platform 列 + 凭据 JSON 化（凭据形状由连接器声明权威）。
// 注：token 轮换已收归 WebUI（2026-10-27 工具面缩窄），域层 rotateToken 保留、本文件直测。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry, BotRegistryError } from "../src/bots";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import { runTool, type ToolContext } from "../src/tools/defs";

const SEED_APPID = "10001";
const SEED = {
  credentials: { appid: SEED_APPID, secret: "s1" },
  name: "主bot",
};
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
  verify?: (
    platform: string,
    credentials: Record<string, string>,
  ) => Promise<void>,
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
  input: {
    credentials: Record<string, string>;
    name?: string;
  } = SEED,
): Promise<ToolContext> {
  await reg.add(input);
  return { repo: new Repo(db), bots: reg, botId: input.credentials["appid"]! };
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
        .map((a) => a.botId),
      ["10001"], // 重启不丢、也不重复
    );
  } finally {
    fx.close();
  }
});

test("M8-B2 add：verify → 落库 + 生成 token（仅返回一次语义），重启恢复", async () => {
  const fx = setupDb();
  try {
    const verified: Array<[string, string]> = [];
    const reg = newRegistry(fx.db, async (platform, credentials) => {
      verified.push([platform, credentials["appid"] ?? ""]);
    });
    const added = await reg.add({
      credentials: { appid: "20002", secret: "s2" },
      name: "二号",
    });
    assert.deepEqual(verified, [["qq", "20002"]]);
    assert.equal(added.bot.botId, "20002");
    assert.equal(added.bot.platform, "qq"); // 缺省平台
    assert.match(added.agentToken, /^[0-9a-f]{48}$/); // 24 字节随机 hex
    assert.equal(reg.appIdByToken(added.agentToken), "20002");
    assert.deepEqual(reg.allowGroupsOf("20002"), []); // 新注册默认无白名单（安全默认）
    assert.equal(reg.authLevelOf("20002"), "uncertified"); // 默认未认证（保守）

    const reg2 = newRegistry(fx.db);
    assert.equal(reg2.get("20002")?.name, "二号");
    // P3：凭据 JSON 化回读（secret 物理列退役，权威在 credentials_json）
    assert.deepEqual(reg2.get("20002")?.credentials, {
      appid: "20002",
      secret: "s2",
    });
    assert.equal(
      (
        fx.db
          .prepare("SELECT secret FROM bots WHERE appid = '20002'")
          .get() as { secret: string }
      ).secret,
      "",
    );
  } finally {
    fx.close();
  }
});

test("M8-B3 add：重复账号 / 空凭据 / verify 失败 → 明确报错且不入库", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    await reg.add(SEED);
    await assert.rejects(
      () => reg.add({ credentials: { appid: "10001", secret: "x" } }),
      /已存在/,
    );
    await assert.rejects(
      () => reg.add({ credentials: { appid: "", secret: "x" } }),
      /账号标识/,
    );
    const bad = new BotRegistry({
      db: fx.db,
      verify: async () => {
        throw new Error("接口访问源IP不在白名单(code 11298)");
      },
    });
    await assert.rejects(
      () => bad.add({ credentials: { appid: "30003", secret: "s3" } }),
      /11298/,
    );
    assert.equal(reg.get("30003"), undefined); // 校验失败不入库
  } finally {
    fx.close();
  }
});

test("P3 多平台：platform/credentials_json 落库回读、platformOf 解析", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    await reg.add({
      platform: "telegram",
      credentials: { id: "7123456", token: "7123456:AA-TEST-TOKEN" },
      name: "tg-bot",
    });
    assert.equal(reg.platformOf("7123456"), "telegram");
    assert.equal(reg.platformOf(SEED_APPID), null);
    const rec = reg.get("7123456");
    assert.equal(rec?.platform, "telegram");
    assert.deepEqual(rec?.credentials, {
      id: "7123456",
      token: "7123456:AA-TEST-TOKEN",
    });
    assert.equal(rec?.botId, "7123456"); // 账号 id 键=凭据 id
    // QQ 与非 QQ 并存：互不干扰（list 序按 created_at，本测试断言集合等价）
    await reg.add(SEED);
    assert.equal(reg.platformOf(SEED_APPID), "qq");
    assert.deepEqual(
      reg
        .list()
        .map((b) => [b.platform, b.botId])
        .sort(),
      [
        ["qq", SEED_APPID],
        ["telegram", "7123456"],
      ].sort(),
    );
  } finally {
    fx.close();
  }
});

test("M9-B3b add：auth_level 落库（缺省 uncertified），非法值拒绝", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    await reg.add({ ...SEED, authLevel: "certified" });
    assert.equal(reg.authLevelOf(SEED_APPID), "certified");
    const b = await reg.add({ credentials: { appid: "20002", secret: "s2" } });
    assert.equal(reg.authLevelOf("20002"), "uncertified");
    reg.setAuthLevel("20002", "certified");
    assert.equal(reg.authLevelOf("20002"), "certified");
    reg.setAuthLevel("20002", "uncertified");
    assert.equal(reg.authLevelOf("20002"), "uncertified");
    await assert.rejects(
      () =>
        reg.add({
          credentials: { appid: "30003", secret: "s3" },
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
    const added = await reg.add({ credentials: { appid: "20002", secret: "s2" } });
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
    const added = await reg.add({ credentials: { appid: "20002", secret: "s2" } });
    reg.setAllowGroups("20002", [GROUP_A, "GROUP_B"]);
    assert.deepEqual(reg.allowGroupsOf("20002"), [GROUP_A, "GROUP_B"]);
    const removed = reg.remove("20002");
    assert.equal(removed.botId, "20002");
    assert.equal(reg.appIdByToken(added.agentToken), null); // 移除连带 token 失效
    assert.deepEqual(reg.allowGroupsOf("20002"), []);
    assert.throws(() => reg.remove("20002"), /不在注册表中/);
  } finally {
    fx.close();
  }
});

test("M8-B8 token 轮换（域层，MCP 工具面已收归 WebUI）：换发新 token，旧 token 立即失效", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    const added = await reg.add({ credentials: { appid: "20002", secret: "s2" } });
    const fresh = reg.rotateToken("20002");
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
    const ignored = await runTool(
      "list_all",
      JSON.stringify({ bot: "20002" }),
      ctx,
    );
    assert.equal(ignored.isError, undefined);
    // 无 botId 的 ctx（鉴权缺失）仍硬拒绝
    const unbound = await runTool("list_all", "{}", { repo: new Repo(fx.db) });
    assert.equal(unbound.isError, true);
    assert.match(unbound.text, /未绑定/);
    const gone = await runTool("list_bots", "{}", ctx);
    assert.equal(gone.isError, true);
    assert.match(gone.text, /未知工具/);
  } finally {
    fx.close();
  }
});

test("B10 每 bot 开关：接收消息 / MCP 访问缺省开、可独立落库，重启保持；未知 appid 报错", async () => {
  const fx = setupDb();
  try {
    const reg = newRegistry(fx.db);
    await reg.add(SEED);
    // 迁移默认值：既有与新建 bot 均开启，升级不改行为
    assert.equal(reg.receiveEnabledOf(SEED_APPID), true);
    assert.equal(reg.mcpEnabledOf(SEED_APPID), true);

    reg.setReceiveEnabled(SEED_APPID, false);
    assert.equal(reg.receiveEnabledOf(SEED_APPID), false);
    assert.equal(reg.mcpEnabledOf(SEED_APPID), true); // 两把开关互不影响

    // 重启（新实例）后仍是禁用态
    const reg2 = newRegistry(fx.db);
    assert.equal(reg2.receiveEnabledOf(SEED_APPID), false);
    reg2.setMcpEnabled(SEED_APPID, false);
    assert.equal(newRegistry(fx.db).mcpEnabledOf(SEED_APPID), false);

    assert.throws(
      () => reg.setMcpEnabled("99999", false),
      /不在注册表中/,
    );
    // 未知 bot 保守不接入 / 不放行
    assert.equal(reg.receiveEnabledOf("99999"), false);
    assert.equal(reg.mcpEnabledOf("99999"), false);
  } finally {
    fx.close();
  }
});
