// 发送器验收：幂等重放（同 msg_seq 只发一条）、被动窗口、额度不足明确报错不重试、
// 双重门禁硬拒绝、304036 降级、304023 审核 pending + MESSAGE_AUDIT 回填、错误码翻译。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/utils/logger";
import { Sender } from "../src/sender";
import { describeSendError } from "../src/sender/errors";
import { t } from "../src/i18n";
import { normalizeQqEnvelope } from "@qsense/connector-qq";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";
import { runTool } from "../src/tools/defs";
import { createBotHost, configSnapshotOf } from "../src/connectors/host";
import {
  BASE_TOOL_NAMES,
  ToolRouter,
  callPluginTool,
  type ConnectorNet,
  type ProactiveVerdict,
  type ProactiveWire,
  type RecallWire,
  type ReplyWire,
  type ToolPayload,
  type UploadMediaWire,
} from "@qsense/connector-sdk";
import {
  beijingDate,
  createQqConnector,
  dailyCountOf,
  qqSendError,
  type QqConnectorPlugin,
  type QqSendLimits,
} from "@qsense/connector-qq";

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

interface NetMock {
  mock: ConnectorNet;
  replies: ReplyWire[];
  proactives: ProactiveWire[];
  recalls: RecallWire[];
  uploads: UploadMediaWire[];
  /** replies+proactives 总数 */
  sentCount(): number;
}

/** 发送原语假件（ConnectorNet 形状）：记录 wire，回执 PROVIDER_N；script 可注错 */
function makeNetMock(
  script?: (
    kind: "reply" | "proactive",
    wire: ReplyWire | ProactiveWire,
    n: number,
  ) => { providerMsgId: string } | never,
): NetMock {
  const replies: ReplyWire[] = [];
  const proactives: ProactiveWire[] = [];
  const recalls: RecallWire[] = [];
  const uploads: UploadMediaWire[] = [];
  const fail = (r: Error | { providerMsgId: string }): { providerMsgId: string } => {
    if (r instanceof Error) throw r;
    return r;
  };
  const mock: ConnectorNet = {
    reply: async (wire) => {
      replies.push(wire);
      return fail(
        script?.("reply", wire, replies.length) ?? {
          providerMsgId: `PROVIDER_${replies.length + proactives.length}`,
        },
      );
    },
    proactive: async (wire) => {
      proactives.push(wire);
      return fail(
        script?.("proactive", wire, proactives.length) ?? {
          providerMsgId: `PROVIDER_${replies.length + proactives.length}`,
        },
      );
    },
    recall: async (wire) => {
      recalls.push(wire);
    },
    uploadMedia: async (wire) => {
      uploads.push(wire);
      return { handle: `FILEINFO_${uploads.length}` };
    },
  };
  return {
    mock,
    replies,
    proactives,
    recalls,
    uploads,
    sentCount: () => replies.length + proactives.length,
  };
}

/** QQ 额度钩子台架：真插件（可注 limits）+ 宿主上下面绑定（记账走 kv StatePort） */
function makeQqHooks(
  fx: { db: DB; repo: Repo; registry: BotRegistry },
  limits?: Partial<QqSendLimits>,
): {
  hooks: {
    proactiveGate(botId: string, target: string): Promise<ProactiveVerdict>;
    proactiveRecord(botId: string, target: string): void;
  };
  host: ReturnType<typeof createBotHost>;
  plugin: QqConnectorPlugin;
} {
  const plugin = createQqConnector({
    log: createLogger("error"),
    ...(limits !== undefined ? { limits } : {}),
  });
  const host = createBotHost({
    log: createLogger("error"),
    db: fx.db,
    platform: "qq",
    botId: BOT,
    ingest: () => undefined,
    onStatus: () => undefined,
  });
  const config = configSnapshotOf(fx.repo, fx.registry, BOT);
  return {
    hooks: {
      proactiveGate: (botId, target) =>
        plugin.hooks!.proactiveGate!({ host, config }, botId, target),
      proactiveRecord: (botId, target) =>
        plugin.hooks!.proactiveRecord!({ host, config }, botId, target),
    },
    host,
    plugin,
  };
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
  // 基座 bot 直接入 bots 表（白名单含 GROUP），发送开关走库并置 true。
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
  repo.saveMessage({
    botId: BOT,
    scope: "group",
    scopeId: GROUP,
    msgId,
    authorOpenid: "U1",
    authorName: "小明",
    ts: Date.now() - ageMs,
    content: "收到请回复",
    mentions: [],
    text: "收到请回复",
    quote: null,
    records: [],
    attachments: [],
    rawJson: "{}",
  });
}

test("M4-1 幂等重放：同 msg_id+同文本 两次调用只发一条，第二次返回首次结果", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    const first = await sender.reply(BOT, GROUP, "M1", "你好呀");
    assert.equal(first.status, "sent");
    const second = await sender.reply(BOT, GROUP, "M1", "你好呀");
    assert.equal(second.status, "replayed");
    assert.equal(second.provider_msg_id, first.provider_msg_id);
    assert.equal(mock.sentCount(), 1, "API 只应被调一次");
    assert.equal(mock.replies[0]!.msgSeq, 1);
  } finally {
    fx.close();
  }
});

test("M4-13 发送成功后本地补记：messages 表出现 direction=1 的自发消息（官方不回推）", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    const r = await sender.reply(BOT, GROUP, "M1", "你好呀");
    assert.equal(r.status, "sent");
    assert.ok(r.provider_msg_id !== undefined);
    const row = fx.repo.getMessageByMsgId(
      BOT,
      "group",
      GROUP,
      r.provider_msg_id!,
    );
    assert.ok(row !== null, "自发消息应补记进缓存");
    assert.equal(Number(row.direction), 1, "direction=1 供读取层标 yourself");
    assert.equal(row.content, "你好呀");
    assert.equal(row.author_name, "t", "author_name 取 bots 表备注名");
  } finally {
    fx.close();
  }
});

test("M4-2 不同文本 → 第二次以 msg_seq=2 真实发出（账本落库断言见 M4-8）", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    await sender.reply(BOT, GROUP, "M1", "第一条");
    const second = await sender.reply(BOT, GROUP, "M1", "第二条");
    assert.equal(second.status, "sent");
    assert.equal(mock.sentCount(), 2);
    assert.equal(mock.replies[1]!.msgSeq, 2);
  } finally {
    fx.close();
  }
});

test("M4-2b 引用开关：默认纯被动回复不带 message_reference；quote=true 才携带引用块", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    await sender.reply(BOT, GROUP, "M1", "纯回复（不带引用块）");
    await sender.reply(BOT, GROUP, "M1", "引用回复（带引用块）", false, true);
    assert.equal(mock.sentCount(), 2);
    assert.equal(
      mock.replies[0]!.quoteMsgId,
      undefined,
      "默认不携带引用块",
    );
    // 引用块线格式映射（message_reference）规格见 connector-qq-net.test
    assert.equal(mock.replies[1]!.quoteMsgId, "M1");
  } finally {
    fx.close();
  }
});

test("M4-3 窗口过期（>5分钟）→ 明确报错且不发", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "OLD", 6 * 60_000);
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    await assert.rejects(
      () => sender.reply(BOT, GROUP, "OLD", "迟到的回复"),
      /被动回复窗口已过期/,
    );
    assert.equal(mock.sentCount(), 0);
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
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    await assert.rejects(
      () => sender.reply(BOT, GROUP, "M1", "第六次"),
      /次数已用完/,
    );
    assert.equal(mock.sentCount(), 0);

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
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    // 门禁权威在 SQLite（config.sendEnabled 不参与判定）——落库关开关
    fx.repo.setSendEnable(false);
    await assert.rejects(
      () => sender.proactive(BOT, GROUP, "hi"),
      /发送功能未开启/,
    );
    await assert.rejects(
      () => sender.reply(BOT, GROUP, "M1", "hi"),
      /发送功能未开启/,
    );
    await assert.rejects(
      () => sender.recall(BOT, GROUP, "X"),
      /发送功能未开启/,
    );

    // 开关开且白名单含 G1：白名单外群拒绝——区分「空表全拒」与「精确判断某群不在名单」
    fx.repo.setSendEnable(true);
    fx.registry.setAllowGroups(BOT, [GROUP]);
    await assert.rejects(
      () => sender.proactive(BOT, "OTHER_GROUP", "hi"),
      /白名单/,
    );
    assert.equal(mock.sentCount(), 0, "任何拒绝都不得触发 API 调用");
    // 正向对照：白名单内群放行
    const ok = await sender.proactive(BOT, GROUP, "白名单内放行");
    assert.equal(ok.status, "sent");
    assert.equal(mock.sentCount(), 1);
  } finally {
    fx.close();
  }
});

test('M4-6 日额度不足 → 明确报"配额不足"且不重试', async () => {
  const fx = setupDb();
  try {
    const mock = makeNetMock();
    const qq = makeQqHooks(fx, { perGroupDaily: 3 });
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      hooks: qq.hooks,
      transportFor: () => mock.mock,
    });
    for (let i = 0; i < 3; i++) {
      const r = await sender.proactive(BOT, GROUP, `日报 #${i}`);
      assert.equal(r.status, "sent");
    }
    await assert.rejects(
      () => sender.proactive(BOT, GROUP, "第四条"),
      /日额度不足/,
    );
    assert.equal(mock.sentCount(), 3, "额度耗尽后不得再调 API");
  } finally {
    fx.close();
  }
});

test("M4-7 令牌桶：bot 级 qpm 耗尽 → 报频控（含等待秒数）", async () => {
  const fx = setupDb();
  try {
    const mock = makeNetMock();
    const qq = makeQqHooks(fx, { qpm: 2, perRelationQpm: 20, perGroupDaily: 100 });
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      hooks: qq.hooks,
      transportFor: () => mock.mock,
    });
    await sender.proactive(BOT, GROUP, "a");
    await sender.proactive(BOT, GROUP, "b");
    await assert.rejects(() => sender.proactive(BOT, GROUP, "c"), /bot 级频控/);
    assert.equal(mock.sentCount(), 2);
  } finally {
    fx.close();
  }
});

test("M4-8 304036 → Markdown 自动降级纯文本（新 seq，降级结果可查）", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M1");
    const mock = makeNetMock((kind, wire) => {
      if (kind === "reply" && (wire as ReplyWire).markdown === true) {
        throw new FakeApiError(304036);
      }
      return { providerMsgId: "PLAIN_OK" };
    });
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
      sendErrorFor: () => qqSendError,
    });
    const r = await sender.reply(BOT, GROUP, "M1", "# 标题", true);
    assert.equal(r.status, "downgraded");
    assert.equal(r.provider_msg_id, "PLAIN_OK");
    assert.equal(mock.sentCount(), 2);
    assert.equal(mock.replies[0]!.markdown, true);
    assert.notEqual(mock.replies[1]!.markdown, true);
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
    const mock = makeNetMock(() => {
      throw new FakeApiError(304023, 200, "受理待审核");
    });
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
      sendErrorFor: () => qqSendError,
    });
    const r = await sender.proactive(BOT, GROUP, "待审核内容");
    assert.equal(r.status, "pending_audit");
    let row = fx.db
      .prepare("SELECT status FROM sends WHERE kind='proactive'")
      .get() as { status: string };
    assert.equal(row.status, "pending_audit");
    // 审核通过事件：信封 → 插件 normalize 效应 → repo 回填。完整信封形状经
    // JSON.parse 边界进入，由 normalize 内的 wire schema 把关。
    const inbound = normalizeQqEnvelope(
      BOT,
      JSON.parse(
        JSON.stringify({
          platform: "qq",
          type: "MESSAGE_AUDIT_PASS",
          data: { group_openid: GROUP },
        }),
      ),
    );
    assert.ok(inbound !== null);
    fx.repo.applyAuditResult(
      BOT,
      GROUP,
      inbound.effects[0]?.kind === "audit" && inbound.effects[0]?.pass
        ? "audit_pass"
        : "audit_reject",
    );
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
    const mock = makeNetMock(() => {
      throw new FakeApiError(40054002);
    });
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
      sendErrorFor: () => qqSendError,
    });
    await assert.rejects(() => sender.reply(BOT, GROUP, "M1", "hi"), /禁言/);
  } finally {
    fx.close();
  }
});

test("M4-10b 错误语义面委托：无语义面 → 通用兜底文案；有语义面 → 平台文案优先", async () => {
  // 无语义面：QQ 码也是通用兜底（含业务码原文，无平台解释）
  const noSem = describeSendError(new FakeApiError(40054002));
  assert.match(noSem, /业务码 40054002/);
  assert.doesNotMatch(noSem, /禁言/);
  // 有语义面：平台文案优先（QQ 包 describe 给可操作解释）
  const withSem = describeSendError(new FakeApiError(40054002), qqSendError);
  assert.match(withSem, /禁言/);
  // 无业务码错误 → 通用兜底（语义面 describe 也返回 undefined）
  const noCode = describeSendError(new Error("网络炸了"), qqSendError);
  assert.match(noCode, /网络炸了/);
});

test("M4-11 撤回：走官方 DELETE，账本记一行", async () => {
  const fx = setupDb();
  try {
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    const r = await sender.recall(BOT, GROUP, "MSG_TO_RECALL");
    assert.equal(r.recalled, "MSG_TO_RECALL");
    assert.deepEqual(
      mock.recalls.map((r) => r.providerMsgId),
      ["MSG_TO_RECALL"],
    );
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
          .prepare<[], { rowid: number }>(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '收到'",
          )
          .all()
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
    // 由 mcp.test.ts 的并发闸用例以 maxConcurrent=1 + 挂起发送器做真实覆盖。
    const bad = await runTool("no_such_tool", "{}", { repo: fx.repo });
    assert.equal(bad.isError, true);
  } finally {
    fx.close();
  }
});

test("M4-12 经 runTool/插件路由：额度耗尽报配额不足、快照进 quota（平台扩展工具）", async () => {
  const fx = setupDb();
  try {
    const mock = makeNetMock();
    const qq = makeQqHooks(fx, { perGroupDaily: 1 });
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      hooks: qq.hooks,
      transportFor: () => mock.mock,
    });
    const ctx = { repo: fx.repo, botId: BOT, sender, bots: fx.registry };
    const ok = await runTool(
      "send",
      JSON.stringify({ id: GROUP, text: "首条" }),
      ctx,
    );
    assert.ok(!ok.isError);

    const exceeded = await runTool(
      "send",
      JSON.stringify({ id: GROUP, text: "第二条" }),
      ctx,
    );
    assert.equal(exceeded.isError, true);
    assert.ok(exceeded.text.includes("日额度不足"));

    // quota 是平台扩展工具（QQ 插件声明）：经 ToolRouter 路由（工具名单见 mcp.test）
    const router = new ToolRouter(BASE_TOOL_NAMES);
    router.registerPlugin(qq.plugin);
    const route = router.resolve("quota");
    assert.equal(route?.source, "plugin");
    const payload: ToolPayload = await callPluginTool(
      route!.plugin!,
      "quota",
      undefined,
      {
        host: qq.host,
        botId: BOT,
        config: configSnapshotOf(fx.repo, fx.registry, BOT),
      },
    );
    assert.ok(!payload.isError);
    const text = payload.content[0]?.text ?? "";
    assert.ok(text.includes('"today_by_group"'));
    assert.ok(text.includes('"used": 1'));
  } finally {
    fx.close();
  }
});

// —— sendAuto 路由矩阵：被动/主动换道 + 引用块，全部落在已真机验证形态 ——

function makeSender(
  fx: ReturnType<typeof setupDb>,
  mock: ReturnType<typeof makeNetMock>,
  hooks?: {
    proactiveGate(botId: string, target: string): Promise<ProactiveVerdict>;
    proactiveRecord(botId: string, target: string): void;
  },
): Sender {
  return new Sender({
    log: createLogger("error"),
    repo: fx.repo,
    bots: fx.registry,
    transportFor: () => mock.mock,
    sendErrorFor: () => qqSendError,
    ...(hooks !== undefined ? { hooks } : {}),
  });
}

test("M4-14 sendAuto 路由：quote 窗内 → 被动绑=引；quote 超窗 → 主动+引用；无 quote 绑最新；无窗内消息走主动", async () => {
  const fx = setupDb();
  try {
    // 场景1：quote 目标在窗内 → 走被动，绑定与引用同一条（WebUI quote=true 已验证形态）
    seedInbound(fx.repo, "M_Q", 60_000); // 1 分钟前
    const m1 = makeNetMock();
    const r1 = await makeSender(fx, m1).sendAuto(BOT, GROUP, "场景一", "M_Q");
    assert.equal(r1.channel, "passive");
    assert.equal(m1.replies[0]!.msgId, "M_Q");
    // 引用块线格式映射（message_reference）规格见 connector-qq-net.test
    assert.equal(m1.replies[0]!.quoteMsgId, "M_Q");

    // 场景2：quote 目标超窗 → 主动通道 + 引用块（2026-10-26 真机验证受理）
    seedInbound(fx.repo, "M_OLD", 6 * 60_000); // 6 分钟前，已超窗
    const m2 = makeNetMock();
    const r2 = await makeSender(fx, m2).sendAuto(BOT, GROUP, "场景二", "M_OLD");
    assert.equal(r2.channel, "proactive");
    assert.equal(m2.proactives[0]!.quoteMsgId, "M_OLD");

    // 场景3：无 quote、群里有窗内消息 → 被动绑定最新，不带引用块
    seedInbound(fx.repo, "M_NEW", 30_000);
    const m3 = makeNetMock();
    const r3 = await makeSender(fx, m3).sendAuto(BOT, GROUP, "场景三");
    assert.equal(r3.channel, "passive");
    assert.equal(m3.replies[0]!.msgId, "M_NEW");
    assert.equal(m3.replies[0]!.quoteMsgId, undefined);

    // 场景4：无 quote、无窗内消息（M_Q/M_NEW 均已被场景1/3消费为绑定目标，仍窗内——
    // 但次数未超，latestBindable 命中最新的 M_NEW）→ 清空重来验证纯主动：
    // 全新 fixture，不 seed 任何消息。
    const fx4 = setupDb();
    try {
      const m4 = makeNetMock();
      const r4 = await makeSender(fx4, m4).sendAuto(BOT, GROUP, "场景四");
      assert.equal(r4.channel, "proactive");
      assert.equal(m4.proactives[0]!.quoteMsgId, undefined);
      assert.equal(m4.proactives[0]!.media, undefined);
    } finally {
      fx4.close();
    }
  } finally {
    fx.close();
  }
});

test("M4-14b sendAuto AT 翻译：<@openid> 命中成员名册 → 翻译 qqbot-at-user 且升级 markdown；陌生 id 字面保留纯文本；直写新格式标签同样升级", async () => {
  const fx = setupDb();
  try {
    // seedInbound 的作者 U1 经 saveMessage 自动进 members 名册（群聊关系事实）
    seedInbound(fx.repo, "M_AT", 30_000);

    // 场景1：<@U1> 是群成员 → 翻译成出站新格式 + markdown 语义（msg_type=2 由线格式层映射）
    const m1 = makeNetMock();
    const r1 = await makeSender(fx, m1).sendAuto(BOT, GROUP, "叫一下 <@U1> 来看");
    assert.equal(r1.channel, "passive");
    assert.equal(m1.replies[0]!.markdown, true);
    assert.equal(m1.replies[0]!.content, "叫一下 <qqbot-at-user id=\"U1\"/> 来看");

    // 场景2：陌生 id / 字面量不替换，也不升级 markdown（宁可纯文本不误渲染）
    const m2 = makeNetMock();
    const r2 = await makeSender(fx, m2).sendAuto(BOT, GROUP, "这人 <@NOPE> 不在群里");
    assert.equal(r2.channel, "passive");
    assert.equal(m2.replies[0]!.markdown, undefined);
    assert.equal(m2.replies[0]!.content, "这人 <@NOPE> 不在群里");

    // 场景3：<@everyone> 不自动翻译（新格式 @everyone 需管理员+每日 1 次，自动升级风险大）
    const m3 = makeNetMock();
    await makeSender(fx, m3).sendAuto(BOT, GROUP, "<@everyone> 集合");
    assert.equal(m3.replies[0]!.markdown, undefined);
    assert.equal(m3.replies[0]!.content, "<@everyone> 集合");

    // 场景4：agent 直写出站新格式标签 → 直接升级 markdown，内容原样
    const m4 = makeNetMock();
    await makeSender(fx, m4).sendAuto(
      BOT,
      GROUP,
      "<qqbot-at-user id=\"U1\"/> 直写新格式",
    );
    assert.equal(m4.replies[0]!.markdown, true);
    assert.equal(m4.replies[0]!.content, "<qqbot-at-user id=\"U1\"/> 直写新格式");

    // 场景5：主动通道同样翻译+升级（全新 fixture，唯一窗内消息 M_ATW 被 5 次回复耗尽，
    // latestBindable 无可绑 → 第六次走主动兜底）
    const fx5 = setupDb();
    try {
      seedInbound(fx5.repo, "M_ATW", 30_000);
      const m5 = makeNetMock();
      const sender5 = makeSender(fx5, m5);
      for (let i = 0; i < 5; i++) {
        await sender5.reply(BOT, GROUP, "M_ATW", `第${i}次`);
      }
      const r5 = await sender5.sendAuto(BOT, GROUP, "主动 <@U1> 兜底");
      assert.equal(r5.channel, "proactive");
      assert.equal(m5.proactives[0]!.markdown, true);
      assert.equal(
        m5.proactives[0]!.content,
        "主动 <qqbot-at-user id=\"U1\"/> 兜底",
      );
    } finally {
      fx5.close();
    }
  } finally {
    fx.close();
  }
});

test("M4-15 sendAuto：quote 不在缓存 → 报错不发送；被动次数用尽 → 主动兜底", async () => {
  const fx = setupDb();
  try {
    const m1 = makeNetMock();
    await assert.rejects(
      () => makeSender(fx, m1).sendAuto(BOT, GROUP, "x", "M_MISSING"),
      /不在缓存中/,
    );
    assert.equal(m1.sentCount(), 0, "报错路径不应发出任何请求");

    // 窗内消息已被回复 5 次 → latestBindable 跳过 → 主动兜底
    seedInbound(fx.repo, "M_FULL", 30_000);
    const m2 = makeNetMock();
    const sender = makeSender(fx, m2);
    for (let i = 0; i < 5; i++) {
      await sender.reply(BOT, GROUP, "M_FULL", `第${i}次回复`);
    }
    const r = await sender.sendAuto(BOT, GROUP, "第六次");
    assert.equal(r.channel, "proactive", "次数用尽后应换主动通道");
    assert.ok(m2.proactives.length >= 1, "兜底应落在主动通道");
  } finally {
    fx.close();
  }
});

test("M4-16 sendMediaAuto：窗内被动图/无窗内主动图/引用块/本地路径拒绝/上传失败兜底", async () => {
  const fx = setupDb();
  try {
    // 场景1：窗内有消息 → 被动图（绑最新），msg_type=7 + 配文，不带引用块
    seedInbound(fx.repo, "M_PIC", 60_000); // 1 分钟前
    const m1 = makeNetMock();
    const r1 = await makeSender(fx, m1).sendMediaAuto(
      BOT,
      GROUP,
      "https://example.com/cat.png",
      "看看这只猫",
    );
    assert.equal(r1.channel, "passive", "窗内有消息应走被动图（免额度）");
    assert.equal(r1.msg_seq, 1);
    assert.equal(m1.uploads.length, 1);
    assert.deepEqual(m1.uploads[0]!.source, {
      kind: "url",
      url: "https://example.com/cat.png",
    });
    // 富媒体线格式（msg_type=7 + file_info）规格见 connector-qq-net.test
    const r1wire = m1.replies[0]!;
    assert.equal(r1wire.media?.kind, "image");
    assert.equal(r1wire.media?.handle, "FILEINFO_1");
    assert.equal(r1wire.msgId, "M_PIC");
    assert.equal(r1wire.content, "看看这只猫");
    assert.equal(r1wire.quoteMsgId, undefined);
    // 补记行：读取层以 ![图片] 占位（与附件占位符约定一致）
    const latest = fx.repo.browseLatest(BOT, "group", GROUP, 1)[0]!;
    assert.equal(latest.direction, 1);
    assert.equal(latest.content, "![图片] 看看这只猫");

    // 场景2：无窗内消息 → 主动图（独立 fixture：场景1 的 M_PIC 仍窗内会干扰路由）
    const fx2 = setupDb();
    try {
      const m2 = makeNetMock();
      const qq2 = makeQqHooks(fx2);
      const r2 = await makeSender(fx2, m2, qq2.hooks).sendMediaAuto(
        BOT,
        GROUP,
        "data:image/png;base64,AAAA",
      );
      assert.equal(r2.channel, "proactive");
      assert.notEqual(m2.proactives[0]!.media, undefined);
      assert.deepEqual(m2.uploads[0]!.source, { kind: "b64", data: "AAAA" });
      assert.equal(
        await dailyCountOf(qq2.host.state, beijingDate(), GROUP),
        1,
        "主动图应计入日额度",
      );
    } finally {
      fx2.close();
    }

    // 场景3：quote 超窗目标 → 主动 + 引用块（2026-10-27 真机验证受理）
    seedInbound(fx.repo, "M_OLDPIC", 6 * 60_000);
    const m3 = makeNetMock();
    const r3 = await makeSender(fx, m3).sendMediaAuto(
      BOT,
      GROUP,
      "https://example.com/d.gif",
      undefined,
      "M_OLDPIC",
    );
    assert.equal(r3.channel, "proactive");
    assert.equal(m3.proactives[0]!.quoteMsgId, "M_OLDPIC");

    // 场景4：本地路径 → 硬拒绝（MCP 服务可能与智能体不同机），上传与发送零调用
    const m4 = makeNetMock();
    await assert.rejects(
      () =>
        makeSender(fx, m4).sendMediaAuto(
          BOT,
          GROUP,
          "C:\\Users\\tester\\cat.png",
        ),
      /media 参数格式不支持/,
    );
    assert.equal(m4.uploads.length, 0);
    assert.equal(m4.sentCount(), 0);

    // 场景5：上传转存失败 → media_upload_failed 文案，不发送任何消息
    const m5 = makeNetMock();
    m5.mock.uploadMedia = async () => {
      throw new Error("HTTP 500");
    };
    await assert.rejects(
      () =>
        makeSender(fx, m5).sendMediaAuto(
          BOT,
          GROUP,
          "https://example.com/x.png",
        ),
      /图片上传官方转存失败/,
    );
    assert.equal(m5.sentCount(), 0, "上传失败不得发送消息");
  } finally {
    fx.close();
  }
});

test("M10 sendMediaAuto 语音：.mp3 URL → file_type=3 类别，补记 ![语音] 占位", async () => {
  const fx = setupDb();
  try {
    seedInbound(fx.repo, "M_SONG", 60_000);
    const mock = makeNetMock();
    const r = await makeSender(fx, mock).sendMediaAuto(
      BOT,
      GROUP,
      "https://example.com/song.mp3",
      "听听这个",
    );
    assert.equal(r.channel, "passive", "窗内语音同样走被动回复");
    assert.equal(mock.uploads.length, 1);
    assert.equal(
      mock.uploads[0]!.kind,
      "voice",
      "mp3 扩展名应分类为语音（生产适配映射 file_type=3）",
    );
    assert.notEqual(mock.replies[0]!.media, undefined);
    // 补记行：读取层以 ![语音] 占位（与 ![图片]/![附件n] 占位符约定一致）
    const latest = fx.repo.browseLatest(BOT, "group", GROUP, 1)[0]!;
    assert.equal(latest.direction, 1);
    assert.equal(latest.content, "![语音] 听听这个");
  } finally {
    fx.close();
  }
});

// —— 单聊（c2c）发送面：被动窗 60 分钟/4 次、opt-in 门禁、补记与撤回 ——

const C2C_USER = "C2C_USER_OPENID";

function seedC2cInbound(repo: Repo, msgId: string, ageMs = 0): void {
  repo.saveMessage({
    botId: BOT,
    scope: "chat",
    scopeId: C2C_USER,
    msgId,
    authorOpenid: C2C_USER,
    ts: Date.now() - ageMs,
    content: "回复这条消息",
    mentions: [],
    text: "回复这条消息",
    quote: null,
    records: [],
    attachments: [],
    rawJson: "{}",
  });
}

test("M4-18 单聊被动回复：窗内 sendAuto 绑定 msg_id（seq=1）走 c2c scope；自发消息补记进 c2c_messages", async () => {
  const fx = setupDb();
  try {
    seedC2cInbound(fx.repo, "C1", 60_000);
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    const r = await sender.sendAuto(BOT, C2C_USER, "收到！", undefined, "chat");
    assert.equal(r.status, "sent");
    assert.equal(r.channel, "passive", "60 分钟窗内走被动");
    assert.equal(mock.sentCount(), 1);
    assert.equal(
      mock.replies[0]!.scope,
      "chat",
      "wire 会话形态标签（官方 c2c scope 映射规格见 connector-qq-net.test）",
    );
    assert.equal(mock.replies[0]!.target, C2C_USER);
    assert.equal(mock.replies[0]!.msgId, "C1", "被动绑定目标消息");
    assert.equal(mock.replies[0]!.msgSeq, 1);
    assert.notEqual(mock.replies[0]!.markdown, true);
    const row = fx.repo.getMessageByMsgId(
      BOT,
      "chat",
      C2C_USER,
      r.provider_msg_id!,
    );
    assert.ok(row !== null, "自发消息应补记进单聊缓存");
    assert.equal(Number(row.direction), 1);
  } finally {
    fx.close();
  }
});

test("M4-19 单聊被动窗超时 → 主动兜底需 opt-in：无 C2C_MSG_RECEIVE 硬拒，开启后放行并记额度", async () => {
  const fx = setupDb();
  try {
    seedC2cInbound(fx.repo, "C1", 61 * 60_000); // 超出 60 分钟被动窗
    const mock = makeNetMock();
    const qq = makeQqHooks(fx);
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      hooks: qq.hooks,
      transportFor: () => mock.mock,
    });
    await assert.rejects(
      () => sender.sendAuto(BOT, C2C_USER, "早", undefined, "chat"),
      (e: Error) => e.message === t("send_c2c_not_optin", { user: C2C_USER }),
      "无 opt-in 记录的主动单聊硬拒绝",
    );
    assert.equal(mock.sentCount(), 0, "硬拒绝不得触发 API");
    fx.repo.setC2cSwitch(BOT, C2C_USER, true);
    const r = await sender.sendAuto(BOT, C2C_USER, "早", undefined, "chat");
    assert.equal(r.channel, "proactive");
    assert.equal(mock.proactives[0]!.scope, "chat");
    assert.equal(
      await dailyCountOf(qq.host.state, beijingDate(), C2C_USER),
      1,
      "单关系日额度记账 +1",
    );
  } finally {
    fx.close();
  }
});

test("M4-20 单聊门禁：对方拒绝（C2C_MSG_REJECT）连被动回复也硬拒；总开关关 → 拒", async () => {
  const fx = setupDb();
  try {
    seedC2cInbound(fx.repo, "C1");
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    fx.repo.setC2cSwitch(BOT, C2C_USER, false);
    await assert.rejects(
      () =>
        sender.reply(
          BOT,
          C2C_USER,
          "C1",
          "hi",
          false,
          false,
          undefined,
          "chat",
        ),
      (e: Error) => e.message === t("send_c2c_optout", { user: C2C_USER }),
    );
    assert.equal(mock.sentCount(), 0);
    fx.repo.setSendEnable(false);
    await assert.rejects(
      () =>
        sender.reply(
          BOT,
          C2C_USER,
          "C1",
          "hi",
          false,
          false,
          undefined,
          "chat",
        ),
      (e: Error) =>
        e.message ===
        t("send_disabled", {
          enabled: "false",
          allow: 1, // setupDb：白名单 [GROUP]
        }),
    );
    assert.equal(mock.sentCount(), 0);
  } finally {
    fx.close();
  }
});

test("M4-21 单聊被动窗次数上限 4 次；撤回走 c2c scope", async () => {
  const fx = setupDb();
  try {
    seedC2cInbound(fx.repo, "C1");
    const mock = makeNetMock();
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => mock.mock,
    });
    for (let i = 0; i < 4; i += 1) {
      const r = await sender.reply(
        BOT,
        C2C_USER,
        "C1",
        `回复${i}`,
        false,
        false,
        undefined,
        "chat",
      );
      assert.equal(r.status, "sent");
    }
    await assert.rejects(
      () =>
        sender.reply(
          BOT,
          C2C_USER,
          "C1",
          "第5次",
          false,
          false,
          undefined,
          "chat",
        ),
      (e: Error) =>
        e.message === t("send_window_exhausted_c2c", { used: 4, max: 4 }),
      "官方限制每条单聊消息最多回复 4 次",
    );
    assert.equal(mock.sentCount(), 4);
    await sender.recall(BOT, C2C_USER, "PROVIDER_1", "chat");
    assert.equal(mock.recalls.length, 1, "撤回 API 被调用");
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// caps 感知收口：被动窗口与 opt-in 都是 QQ C2C 语义，caps 声明必须真正驱动
// core 的路由与门禁。
// ---------------------------------------------------------------------------

test("caps 感知门禁：proactiveOptIn=false 平台跳过 opt-in 校验（微信语义：能对话即能发）", async () => {
  const fx = setupDb();
  try {
    const wxCaps = {
      scopes: ["chat"],
      media: { image: false, voice: false, video: false, file: false },
      recall: false,
      passiveWindow: false,
      quota: false,
      proactiveOptIn: false,
    };
    // opt-in 开关从未置位（微信无 opt 事件）→ caps 声明无 opt 概念 → 放行
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => makeNetMock().mock,
      capsFor: (botId) => (botId === BOT ? wxCaps : undefined),
    });
    const r = await sender.sendAuto(BOT, "U_WX", "hi", undefined, "chat");
    assert.equal(r.channel, "proactive");
    assert.equal(r.status, "sent");
    // 对照：QQ 语义（proactiveOptIn=true）未 opt-in 仍硬拒——现行为不变
    const qqCaps = {
      scopes: ["group", "c2c"],
      media: { image: true, voice: true, video: false, file: false },
      recall: true,
      passiveWindow: true,
      quota: true,
      proactiveOptIn: true,
    };
    const qqSender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => makeNetMock().mock,
      capsFor: (botId) => (botId === BOT ? qqCaps : undefined),
    });
    await assert.rejects(
      () => qqSender.sendAuto(BOT, "U_QQ", "hi", undefined, "chat"),
      /未开启/,
    );
  } finally {
    fx.close();
  }
});

test("transport 兜底：net.reply 未实现 → 可操作错误（消灭 TypeError 'reply is not a function'）", async () => {
  const fx = setupDb();
  try {
    // seed 窗内消息：穿过 reply() 的缓存/窗口校验，抵达 transport 调用点
    seedInbound(fx.repo, "M1", 60_000);
    // passiveWindow=false 平台（必备性校验不要求 reply）但原语确实缺失
    const bareNet: ConnectorNet = {
      proactive: async () => ({ providerMsgId: "P1" }),
      recall: async () => undefined,
      uploadMedia: async () => ({ handle: "h" }),
    };
    const sender = new Sender({
      log: createLogger("error"),
      repo: fx.repo,
      bots: fx.registry,
      transportFor: () => bareNet,
      capsFor: (botId) =>
        botId === BOT
          ? {
              scopes: ["chat"],
              media: { image: false, voice: false, video: false, file: false },
              recall: false,
              passiveWindow: false,
              quota: false,
              proactiveOptIn: false,
            }
          : undefined,
    });
    await assert.rejects(
      () => sender.reply(BOT, GROUP, "M1", "hi", false, false, undefined, "group"),
      (e: Error) => e.message.includes("net.reply"),
      "兜底错误必须可操作（点名 net.reply），而非 TypeError",
    );
  } finally {
    fx.close();
  }
});
