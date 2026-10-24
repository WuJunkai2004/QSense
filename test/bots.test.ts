// M7 验收（注册表）：运行时添加/移除 bot、kv 持久化与重载、env 基座优先、凭据校验失败不入库、
// 多 bot 工具面（qq_list_bots 发现 + resolveBotId 强制指定）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry, BotRegistryError } from "../src/bots";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";
import { runTool, UNTRUSTED_NOTICE, type ToolContext } from "../src/tools/defs";

const BASE = { appid: "10001", secret: "s1", name: "基座" };

function setupDb(): { db: DB; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-m7-bots-"));
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

function kvRaw(db: DB): unknown {
  const row = db.prepare("SELECT v FROM kv WHERE k = 'bots:dynamic:v1'").get() as
    | { v: string }
    | undefined;
  return row === undefined ? null : JSON.parse(row.v);
}

test("M7-B1 add：校验通过 → 列表含动态 bot、kv 持久化、新实例重载恢复", async () => {
  const fx = setupDb();
  try {
    const verifyed: string[] = [];
    const reg = new BotRegistry({
      base: [BASE],
      db: fx.db,
      verify: async (app) => {
        verifyed.push(app.appid);
      },
    });
    const added = await reg.add({ appid: "20002", secret: "s2", name: "二号" });
    assert.equal(added.appid, "20002");
    assert.deepEqual(verifyed, ["20002"]);
    assert.equal(reg.isDynamic("20002"), true);
    assert.equal(reg.list().length, 2);
    assert.deepEqual(kvRaw(fx.db), [{ appid: "20002", secret: "s2", name: "二号" }]);

    // 新实例（模拟重启）从 kv 恢复
    const reg2 = new BotRegistry({ base: [BASE], db: fx.db });
    assert.equal(reg2.get("20002")?.name, "二号");
    assert.equal(reg2.isDynamic("20002"), true);
  } finally {
    fx.close();
  }
});

test("M7-B2 add：重复（env 基座或已存在动态）与空参数 → 明确报错", async () => {
  const fx = setupDb();
  try {
    const reg = new BotRegistry({ base: [BASE], db: fx.db });
    await assert.rejects(
      reg.add({ appid: "10001", secret: "x" }),
      /已注册/,
    );
    await reg.add({ appid: "20002", secret: "s2" });
    await assert.rejects(reg.add({ appid: "20002", secret: "y" }), /已注册/);
    await assert.rejects(
      reg.add({ appid: "", secret: "y" }),
      /不能为空/,
    );
    await assert.rejects(reg.add({ appid: "30003", secret: "  " }), /不能为空/);
  } finally {
    fx.close();
  }
});

test("M7-B3 add：凭据校验失败 → 拒绝且不落库（列表与 kv 均不变）", async () => {
  const fx = setupDb();
  try {
    const reg = new BotRegistry({
      base: [BASE],
      db: fx.db,
      verify: async () => {
        throw new Error("401 Unauthorized from official");
      },
    });
    await assert.rejects(
      reg.add({ appid: "20002", secret: "bad" }),
      (e: unknown) =>
        e instanceof BotRegistryError && /凭据校验失败/.test(e.message),
    );
    assert.equal(reg.list().length, 1);
    assert.equal(kvRaw(fx.db), null);
  } finally {
    fx.close();
  }
});

test("M7-B4 remove：动态可移除并持久化；env 基座/未知 → 明确报错", async () => {
  const fx = setupDb();
  try {
    const reg = new BotRegistry({ base: [BASE], db: fx.db });
    await reg.add({ appid: "20002", secret: "s2", name: "二号" });
    const removed = reg.remove("20002");
    assert.equal(removed.appid, "20002");
    assert.deepEqual(kvRaw(fx.db), []);
    assert.throws(() => reg.remove("10001"), /QQ_APPS/);
    assert.throws(() => reg.remove("99999"), /不在运行时列表/);
  } finally {
    fx.close();
  }
});

test("M7-B5 load：kv 中与 env 基座撞 appid 的残留条目被跳过（env 优先）", () => {
  const fx = setupDb();
  try {
    fx.db
      .prepare("INSERT INTO kv(k, v) VALUES ('bots:dynamic:v1', ?)")
      .run(
        JSON.stringify([
          { appid: "10001", secret: "stale", name: "残影" },
          { appid: "20002", secret: "s2", name: "二号" },
        ]),
      );
    const reg = new BotRegistry({ base: [BASE], db: fx.db });
    assert.equal(reg.get("10001")?.secret, "s1"); // env 权威
    assert.equal(reg.isDynamic("10001"), false);
    assert.equal(reg.get("20002")?.name, "二号");
  } finally {
    fx.close();
  }
});

test("M7-B6 工具面：qq_list_bots 发现（含动态/状态）+ 多 bot 必须显式指定", async () => {
  const fx = setupDb();
  try {
    const repo = new Repo(fx.db);
    const config = loadConfig({
      QQ_APPS: '[{"appid":"10001","secret":"s1","name":"基座"},{"appid":"20002","secret":"s2","name":"二号"}]',
      MCP_TOKEN: "m7-test-token-0123456789abcdef",
      DATA_DIR: "unused",
    });
    const reg = new BotRegistry({
      base: config.apps,
      db: fx.db,
      verify: async () => {}, // 直接种动态 bot（绕过校验，聚焦工具面行为）
    });
    await reg.add({ appid: "30003", secret: "s3", name: "三号" });
    const ctx: ToolContext = {
      repo,
      config,
      bots: reg,
      botStatuses: () => [
        { botId: "10001", state: "ready" },
        { botId: "30003", state: "fatal", detail: "close=4914" },
      ],
    };

    // qq_list_bots：3 个 bot、来源与网关状态正确
    const listed = await runTool("qq_list_bots", {}, ctx);
    assert.equal(listed.isError, undefined);
    const payload = JSON.parse(listed.text.split("\n").slice(1).join("\n")) as {
      count: number;
      bots: Array<{ appid: string; source: string; gateway: string }>;
    };
    assert.equal(payload.count, 3);
    assert.deepEqual(
      payload.bots.map((b) => [b.appid, b.source, b.gateway]),
      [
        ["10001", "config", "ready"],
        ["20002", "config", "unknown"],
        ["30003", "runtime", "fatal"],
      ],
    );

    // 多 bot 不指定 → 报错文案引导 qq_list_bots；指定不存在 → 报错列出全部
    const noBot = await runTool("qq_list_groups", {}, ctx);
    assert.equal(noBot.isError, true);
    assert.match(noBot.text, /qq_list_bots/);
    const badBot = await runTool("qq_list_groups", { bot: "99999" }, ctx);
    assert.equal(badBot.isError, true);
    assert.match(badBot.text, /10001, 20002, 30003/);
    // 首行注入提示恒在
    assert.ok(noBot.text.startsWith(UNTRUSTED_NOTICE));
  } finally {
    fx.close();
  }
});
