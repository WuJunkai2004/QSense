// M4 验收：发送器——幂等重放（同 msg_seq 只发一条）、被动窗口、额度不足明确报错不重试、
// 双重门禁硬拒绝、304036 降级、304023 审核 pending + MESSAGE_AUDIT 回填、错误码翻译。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger";
import { Sender } from "../src/sender";
import { handleGatewayEvent } from "../src/normalize/handler";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";
import { runTool } from "../src/tools/defs";

const GROUP = "G1";
const BOT = "10001";

/** SDK ApiError 形状的最小仿制（extractBizCode 只读 bizCode 字段） */
class FakeApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly bizCode: number,
    readonly httpStatus = 400,
    readonly bizMessage = "mock",
  ) {
    super(`biz ${bizCode}`);
  }
}

interface Call {
  scope: string;
  targetId: string;
  body: Record<string, unknown>;
}

function makeApiMock(
  script?: (call: Call, n: number) => { id: string } | never,
): {
  calls: Call[];
  recalls: string[];
} & import("../src/sender").SendApi {
  const calls: Call[] = [];
  const recalls: string[] = [];
  return {
    calls,
    recalls,
    async sendRaw(
      scope: "group" | "c2c",
      targetId: string,
      _creds: { appId: string; clientSecret: string },
      body: Record<string, unknown>,
    ) {
      calls.push({ scope, targetId, body });
      const r = script?.({ scope, targetId, body }, calls.length);
      if (r instanceof Error) throw r;
      return r ?? { id: `PROVIDER_${calls.length}` };
    },
    async recallMessage(
      _scope: "group" | "c2c",
      _targetId: string,
      messageId: string,
    ) {
      recalls.push(messageId);
    },
  } as never;
}

interface Fixture {
  db: DB;
  repo: Repo;
  registry: BotRegistry;
  close: () => void;
}

function setupDb(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-m4-test-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  // M9：无 env 播种——基座 bot 直接入 bots 表（白名单含 GROUP，等价旧 ALLOW_GROUPS）；
  // 发送开关走库并置 true（等价旧 SEND_ENABLE=true）。
  db.prepare(
    `INSERT INTO bots(appid, name, secret, agent_token, allow_groups, auth_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    BOT,
    "t",
    "s",
    "a".repeat(48),
    JSON.stringify([GROUP]),
    "uncertified",
    Date.now(),
  );
  repo.ensureRuntime();
  repo.setSendEnable(true);
  const registry = new BotRegistry({ db });
  return {
    registry,
    db,
    repo,
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

function seedInbound(repo: Repo, msgId: string, ageMs = 0): void {
  repo.saveGroupMessage({
    botId: BOT,
    scope: "group",
    scopeId: GROUP,
    msgId,
    authorOpenid: "U1",
    authorName: "小明",
    ts: Date.now() - ageMs,
    content: "收到请回复",
    mentions: [],
    elements: undefined,
    attachments: [],
    raw: {},
  });
}

test("M4-1 幂等重放：同 msg_id+同文本 两次调用只发一条，第二次返回首次结果", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    const first = await sender.reply(BOT, GROUP, "M1", "你好呀");
    assert.equal(first.status, "sent");
    const second = await sender.reply(BOT, GROUP, "M1", "你好呀");
    assert.equal(second.status, "replayed");
    assert.equal(second.provider_msg_id, first.provider_msg_id);
    assert.equal(mock.calls.length, 1, "API 只应被调一次");
    assert.equal(mock.calls[0]!.body.msg_seq, 1);
  } finally {
    fx.close();
  }
});

test("M4-2 不同文本 → 第二次以 msg_seq=2 真实发出（账本落库断言见 M4-8）", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    await sender.reply(BOT, GROUP, "M1", "第一条");
    const second = await sender.reply(BOT, GROUP, "M1", "第二条");
    assert.equal(second.status, "sent");
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1]!.body.msg_seq, 2);
  } finally {
    fx.close();
  }
});

test("M4-2b 引用开关：默认纯被动回复不带 message_reference；quote=true 才携带引用块", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    await sender.reply(BOT, GROUP, "M1", "纯回复（不带引用块）");
    await sender.reply(BOT, GROUP, "M1", "引用回复（带引用块）", false, true);
    assert.equal(mock.calls.length, 2);
    assert.equal(
      mock.calls[0]!.body.message_reference,
      undefined,
      "默认不携带引用块",
    );
    assert.deepEqual(mock.calls[1]!.body.message_reference, {
      message_id: "M1",
      ignore_get_message_error: true,
    });
  } finally {
    fx.close();
  }
});

test("M4-3 窗口过期（>5分钟）→ 明确报错且不发", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "OLD", 6 * 60_000);
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    await assert.rejects(
      () => sender.reply(BOT, GROUP, "OLD", "迟到的回复"),
      /被动回复窗口已过期/,
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    fx.close();
  }
});

test("M4-4 次数耗尽（5次后）→ 明确报错；failed 行不占次数", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    for (let i = 0; i < 5; i++) {
      const id = fx.repo.insertSend({
        bot_id: BOT,
        target_openid: GROUP,
        kind: "passive",
        reply_msg_id: "M1",
        msg_seq: i + 1,
        payload_hash: `h${i}`,
        status: "reserved",
      });
      fx.repo.updateSendStatus(id, "sent", `P${i}`);
    }
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    await assert.rejects(
      () => sender.reply(BOT, GROUP, "M1", "第六次"),
      /次数已用完/,
    );
    assert.equal(mock.calls.length, 0);

    // failed 行不计入窗口次数：4 条 sent + 1 条 failed → 还能发
    for (let i = 0; i < 5; i++)
      fx.db.prepare("DELETE FROM sends WHERE msg_seq = ?").run(i + 1);
    for (let i = 0; i < 4; i++) {
      const id = fx.repo.insertSend({
        bot_id: BOT,
        target_openid: GROUP,
        kind: "passive",
        reply_msg_id: "M1",
        msg_seq: i + 1,
        payload_hash: `h${i}`,
        status: "reserved",
      });
      fx.repo.updateSendStatus(id, "sent", `P${i}`);
    }
    const fid = fx.repo.insertSend({
      bot_id: BOT,
      target_openid: GROUP,
      kind: "passive",
      reply_msg_id: "M1",
      msg_seq: 5,
      payload_hash: "hf",
      status: "failed",
    });
    fx.repo.updateSendStatus(fid, "failed");
    const ok = await sender.reply(BOT, GROUP, "M1", "第五次有效回复");
    assert.equal(ok.status, "sent");
  } finally {
    fx.close();
  }
});

test("M4-5 双重门禁：开关关/白名单外 → 硬拒绝，API 零调用", async () => {
  const fx = setupDb();
  try {
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    // M8：门禁权威在 SQLite（config.sendEnabled 已不参与判定）——落库关开关
    fx.repo.setSendEnable(false);
    await assert.rejects(
      () => sender.proactive(BOT, GROUP, "hi"),
      /SEND_ENABLE/,
    );
    await assert.rejects(
      () => sender.reply(BOT, GROUP, "M1", "hi"),
      /SEND_ENABLE/,
    );
    await assert.rejects(() => sender.recall(BOT, GROUP, "X"), /SEND_ENABLE/);

    // 开关开且白名单含 G1：白名单外群拒绝——区分「空表全拒」与「精确判断某群不在名单」
    fx.repo.setSendEnable(true);
    fx.registry.setAllowGroups(BOT, [GROUP]);
    await assert.rejects(
      () => sender.proactive(BOT, "OTHER_GROUP", "hi"),
      /ALLOW_GROUPS/,
    );
    assert.equal(mock.calls.length, 0, "任何拒绝都不得触发 API 调用");
    // 正向对照：白名单内群放行
    const ok = await sender.proactive(BOT, GROUP, "白名单内放行");
    assert.equal(ok.status, "sent");
    assert.equal(mock.calls.length, 1);
  } finally {
    fx.close();
  }
});

test('M4-6 日额度不足 → 明确报"配额不足"且不重试', async () => {
  const fx = setupDb();
  try {
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      limits: { perGroupDaily: 3 },
      apiFor: () => mock,
    });
    for (let i = 0; i < 3; i++) {
      const r = await sender.proactive(BOT, GROUP, `日报 #${i}`);
      assert.equal(r.status, "sent");
    }
    await assert.rejects(
      () => sender.proactive(BOT, GROUP, "第四条"),
      /日额度不足/,
    );
    assert.equal(mock.calls.length, 3, "额度耗尽后不得再调 API");
  } finally {
    fx.close();
  }
});

test("M4-7 令牌桶：bot 级 qpm 耗尽 → 报频控（含等待秒数）", async () => {
  const fx = setupDb();
  try {
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      limits: { qpm: 2, perRelationQpm: 20, perGroupDaily: 100 },
      apiFor: () => mock,
    });
    await sender.proactive(BOT, GROUP, "a");
    await sender.proactive(BOT, GROUP, "b");
    await assert.rejects(() => sender.proactive(BOT, GROUP, "c"), /bot 级频控/);
    assert.equal(mock.calls.length, 2);
  } finally {
    fx.close();
  }
});

test("M4-8 304036 → Markdown 自动降级纯文本（新 seq，降级结果可查）", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeApiMock((call) => {
      if (call.body.msg_type === 2) throw new FakeApiError(304036);
      return { id: "PLAIN_OK" };
    });
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    const r = await sender.reply(BOT, GROUP, "M1", "# 标题", true);
    assert.equal(r.status, "downgraded");
    assert.equal(r.provider_msg_id, "PLAIN_OK");
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0]!.body.msg_type, 2);
    assert.equal(mock.calls[1]!.body.msg_type, 0);
    // 失败行（304036）不入窗口次数：账本里 1 failed + 1 sent
    const rows = fx.db
      .prepare("SELECT status FROM sends WHERE reply_msg_id='M1'")
      .all() as Array<{ status: string }>;
    assert.deepEqual(rows.map((r) => r.status).sort(), ["failed", "sent"]);
  } finally {
    fx.close();
  }
});

test("M4-9 304023 → pending_audit；MESSAGE_AUDIT_PASS 事件回填 audit_pass", async () => {
  const fx = setupDb();
  try {
    const mock = makeApiMock(() => {
      throw new FakeApiError(304023, 200, "受理待审核");
    });
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    const r = await sender.proactive(BOT, GROUP, "待审核内容");
    assert.equal(r.status, "pending_audit");
    let row = fx.db
      .prepare("SELECT status FROM sends WHERE kind='proactive'")
      .get() as { status: string };
    assert.equal(row.status, "pending_audit");
    // 审核通过事件（经事件路由）
    handleGatewayEvent(fx.repo, {
      botId: BOT,
      type: "MESSAGE_AUDIT_PASS",
      data: { group_openid: GROUP },
    });
    row = fx.db
      .prepare("SELECT status FROM sends WHERE kind='proactive'")
      .get() as { status: string };
    assert.equal(row.status, "audit_pass");
  } finally {
    fx.close();
  }
});

test('M4-10 官方错误码翻译：40054002 → "禁言"可操作文案', async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeApiMock(() => {
      throw new FakeApiError(40054002);
    });
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    await assert.rejects(() => sender.reply(BOT, GROUP, "M1", "hi"), /禁言/);
  } finally {
    fx.close();
  }
});

test("M4-11 撤回：走官方 DELETE，账本记一行", async () => {
  const fx = setupDb();
  try {
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      apiFor: () => mock,
    });
    const r = await sender.recall(BOT, GROUP, "MSG_TO_RECALL");
    assert.equal(r.recalled, "MSG_TO_RECALL");
    assert.deepEqual(mock.recalls, ["MSG_TO_RECALL"]);
    const row = fx.db
      .prepare("SELECT status FROM sends WHERE kind='recall'")
      .get() as { status: string };
    assert.equal(row.status, "sent");
  } finally {
    fx.close();
  }
});

test("M6-13 purgeGroupAll（原 forget 迁 WebUI /ui/api）：清消息/名册/注册表/水位且 FTS 同步，sends 保留", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    fx.repo.setGroupSwitch(BOT, GROUP, true);
    fx.repo.setCursor(BOT, GROUP, "5");
    // 账本行先于 purge 落库：purge 后仍在，才是「sends 保留」的真实检验
    fx.repo.insertSend({
      bot_id: BOT,
      target_openid: GROUP,
      kind: "proactive",
      reply_msg_id: null,
      msg_seq: null,
      payload_hash: "x",
      status: "sent",
    });

    const purged = fx.repo.purgeGroupAll(BOT, GROUP);
    assert.ok(purged.messages >= 1, "应删到消息");
    assert.equal(
      (
        fx.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as {
          n: number;
        }
      ).n,
      0,
    );
    // FTS 触发器随行清理：检索零命中
    assert.equal(
      (
        fx.db
          .prepare(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '收到'",
          )
          .all() as unknown[]
      ).length,
      0,
    );
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM groups").get() as { n: number })
        .n,
      0,
    );
    assert.equal(
      (
        fx.db.prepare("SELECT COUNT(*) AS n FROM members").get() as {
          n: number;
        }
      ).n,
      0,
    );
    assert.equal(fx.repo.getCursor(BOT, GROUP), null);
    // 发送审计账本保留：purge 不清 sends（合规审计要求，行在 purge 前已落库）
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM sends").get() as { n: number })
        .n,
      1,
    );
  } finally {
    fx.close();
  }
});

test("runTool 未知工具名 → isError 快速失败（并发闸集成测试见 mcp.test.ts M6-14）", async () => {
  const fx = setupDb();
  try {
    // runTool 是工具分发层：未知工具名不走任何实现，直接 isError。
    // mcp.ts CallToolRequestSchema 包装层的并发闸（active >= maxConcurrent → 服务繁忙）
    // 由 mcp.test.ts M6-14 以 maxConcurrent=1 + 挂起发送器做真实覆盖。
    const bad = await runTool("no_such_tool", {}, { repo: fx.repo });
    assert.equal(bad.isError, true);
  } finally {
    fx.close();
  }
});

test("M4-12 经 runTool（MCP 工具路径）：额度耗尽报配额不足、快照进 quota", async () => {
  const fx = setupDb();
  try {
    const mock = makeApiMock();
    const sender = new Sender({
      log: createLogger("error"),
      db: fx.db,
      repo: fx.repo,
      tokenManager: {} as never,
      bots: fx.registry,
      limits: { perGroupDaily: 1 },
      apiFor: () => mock,
    });
    const ctx = { repo: fx.repo, botId: BOT, sender };
    const ok = await runTool(
      "send_proactive",
      { group: GROUP, text: "首条" },
      ctx,
    );
    assert.ok(!ok.isError);

    const exceeded = await runTool(
      "send_proactive",
      { group: GROUP, text: "第二条" },
      ctx,
    );
    assert.equal(exceeded.isError, true);
    assert.ok(exceeded.text.includes("日额度不足"));

    const quota = await runTool("quota", {}, ctx);
    assert.ok(quota.text.includes('"today_by_group"'));
    assert.ok(quota.text.includes('"used": 1'));
  } finally {
    fx.close();
  }
});
