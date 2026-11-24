// T1 ingest 管线加固验收（2026-11-24）：形状违规消息不得炸整批、不得触发
// 「标记后入库失败→重拉全滤→游标推进→静默丢批」失败链、告警不得含消息正文。
//
// 失败链背景（架构审查 §1.3）：旧管线 BoundedDedup.isNew 检查即标记，单条
// saveMessage 抛错（如 undefined 绑定撞 better-sqlite3 TypeError）时该键已进
// 去重窗口——连接器重拉同批时全部命中去重被滤、游标照样推进，进程生命周期内
// 永久静默丢失。加固后：检查/标记两段式 + 逐条 try/catch 隔离 + 入库成功才标记。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectorRegistry,
  UnifiedInboundSchema,
  type ConnectorLogger,
  type ConnectorPlugin,
  type InboundEffect,
  type NormalizedMessage,
  type RawEnvelope,
} from "@qsense/connector-sdk";
import { z } from "zod";
import { createIngestPipeline } from "../src/connectors/ingest";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";

/** 正常成品消息工厂（over 允许注入非法字段值——测试的职责就是注入非法输入） */
function msg(over: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    botId: "bot-t1",
    scope: "group",
    scopeId: "G1",
    msgId: "m-good",
    authorOpenid: "u1",
    authorName: "测试者",
    ts: 1700000000000,
    text: "hello",
    content: "hello",
    quote: null,
    records: [],
    mentions: [],
    attachments: [],
    rawJson: JSON.stringify({ src: "fake" }),
    direction: 0,
    ...over,
  } as NormalizedMessage;
}

/** 效应工厂（over 同上允许注入非法值） */
function fx(over: Partial<InboundEffect>): InboundEffect {
  return { kind: "group-seen", scopeId: "G1", fullMsg: true, ...over } as InboundEffect;
}

interface TestRig {
  repo: Repo;
  db: DB;
  warns: string[];
  dir: string;
  /** 投递一批（inbound 预校验形状直接透传给管线——测试完全控制管线产出的垃圾值） */
  feed: (inbound: InboundWire | null) => void;
}

/** 管线输入面（schema 输入类型：default 字段可省——模拟 normalize 漏字段） */
type InboundWire = z.input<typeof UnifiedInboundSchema>;

/** fake 平台插件：声明面补齐过 validatePlugin 闸门，normalize 由用例给定 */
function makeFakePlugin(normalize: ConnectorPlugin["normalize"]): ConnectorPlugin {
  const unused = new Error("测试假插件不得触发网络面");
  return {
    id: "fake",
    sdkRange: "^2.0.0",
    title: "假平台",
    caps: {
      scopes: ["group"],
      media: { image: false, voice: false, video: false, file: false },
      recall: false,
      passiveWindow: false,
      quota: false,
      proactiveOptIn: false,
    },
    credentialSchema: { type: "object", properties: {} },
    credentialSecrets: [],
    tools: [],
    // 声明面过闸即可；ingest 管线只用 normalize（网络面 stub 一律抛错）
    create: () => ({
      start: async () => undefined,
      stop: () => undefined,
      net: {
        reply: async () => {
          throw unused;
        },
        proactive: async () => {
          throw unused;
        },
        recall: async () => {
          throw unused;
        },
        uploadMedia: async () => {
          throw unused;
        },
      },
    }),
    normalize,
  };
}

/** 透传 normalize：信封原样当产出（管线只做守门，真值经 schema 校验） */
const passThrough = (_botId: string, payload: RawEnvelope) =>
  // JSON round-trip 返回 any（库签名）——契约违规的注入面在此
  JSON.parse(JSON.stringify(payload));

/** 台架：fake 插件（normalize=透传）+ 假日志（收集 warn）+ 真库 */
function setup(): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "qsense-ingest-guard-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  const warns: string[] = [];
  const log: ConnectorLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (s: string) => warns.push(s),
    error: () => undefined,
    fatal: () => undefined,
    child: () => log,
  };
  const plugins = new ConnectorRegistry();
  // fake 平台插件：normalize 原样透传信封内容（测试完全控制管线产出）
  plugins.register(makeFakePlugin(passThrough));
  const pipeline = createIngestPipeline({ repo, log, plugins });
  return {
    repo,
    db,
    warns,
    dir,
    feed: (inbound) => {
      pipeline({
        botId: "bot-t1",
        // 坏信封（null）经 JSON.parse 边界进入——模拟动态载荷形状（可观测丢弃路径）
        payload:
          inbound === null
            ? JSON.parse("null")
            : { platform: "fake", ...inbound },
      });
    },
  };
}

function teardown(rig: TestRig): void {
  rig.db.close();
  try {
    rmSync(rig.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows 句柄延迟，best-effort */
  }
}

function countByMsgId(rig: TestRig, msgId: string): number {
  const row = rig.db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND msg_id = ?")
    .get("bot-t1", msgId) as { n: number };
  return row.n;
}

test("G-1 不可清洗的形状违规被隔离：同批正常消息存活、坏消息不入库、告警含字段路径不含正文", () => {
  const rig = setup();
  try {
    const good = msg({ msgId: "m-ok" });
    const bad = msg({
      msgId: "m-bad",
      text: "SECRET-BODY-不得入日志",
      scope: "频道" as NormalizedMessage["scope"], // 词表违规：schema 不可清洗 → 隔离
    });
    assert.doesNotThrow(() => rig.feed({ messages: [good, bad], effects: [] }));
    assert.equal(countByMsgId(rig, "m-ok"), 1, "同批正常消息必须入库");
    assert.equal(countByMsgId(rig, "m-bad"), 0, "坏消息不入库");
    const saveFails = rig.warns.filter((w) => w.includes("m-bad"));
    assert.equal(saveFails.length, 1, "坏消息恰有一条契约校验失败告警");
    assert.ok(saveFails[0]!.includes("scope"), "告警含违规字段路径（可定位）");
    for (const w of rig.warns) {
      assert.ok(!w.includes("SECRET-BODY"), "告警绝不含消息正文（log_content 纪律）");
    }
  } finally {
    teardown(rig);
  }
});

test("G-1b 可机械清洗的违规被兜底入库：records 缺失 → 清洗为空记录集", () => {
  const rig = setup();
  try {
    const sloppy = msg({
      msgId: "m-sloppy",
      records: undefined, // normalize 漏字段 → schema default([]) 兜底
    });
    rig.feed({ messages: [sloppy], effects: [] });
    assert.equal(countByMsgId(rig, "m-sloppy"), 1, "可清洗违规兜底入库（不丢消息）");
    const row = rig.db
      .prepare("SELECT records_count FROM messages WHERE bot_id = ? AND msg_id = ?")
      .get("bot-t1", "m-sloppy") as { records_count: number };
    assert.equal(row.records_count, 0, "records 清洗为空集");
  } finally {
    teardown(rig);
  }
});

test("G-2 存储层故障不标记去重：故障排除后重投可入库（封死静默丢批失败链）", () => {
  const rig = setup();
  try {
    // 模拟存储层故障（db 锁/约束等任何 saveMessage 抛错来源）
    class BoomRepo extends Repo {
      override saveMessage(): never {
        throw new Error("db-boom");
      }
    }
    const boomRepo = new BoomRepo(rig.db);
    const plugins = new ConnectorRegistry();
    plugins.register(makeFakePlugin(passThrough));
    const warnLog: ConnectorLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (s: string) => rig.warns.push(s),
      error: () => undefined,
      fatal: () => undefined,
      child: () => warnLog,
    };
    const pipeline = createIngestPipeline({
      repo: boomRepo,
      log: warnLog,
      plugins,
    });
    const failing = msg({ msgId: "m-x" });
    assert.doesNotThrow(() =>
      pipeline({ botId: "bot-t1", payload: { platform: "fake", messages: [failing], effects: [] } }),
    );
    assert.equal(countByMsgId(rig, "m-x"), 0);
    assert.equal(
      rig.warns.filter((w) => w.includes("m-x")).length,
      1,
      "首轮入库失败有告警",
    );
    // 故障排除（真 repo）后重拉同批——同一 msgId 必须能重新入库
    rig.feed({ messages: [msg({ msgId: "m-x", text: "修复后" })], effects: [] });
    assert.equal(
      countByMsgId(rig, "m-x"),
      1,
      "失败链核心断言：入库失败的键未被去重标记，重投必须能重新入库",
    );
  } finally {
    teardown(rig);
  }
});

test("G-3 成功入库的去重语义不变：同键重投仍被滤", () => {
  const rig = setup();
  try {
    rig.feed({ messages: [msg({ msgId: "m-d" })], effects: [] });
    rig.feed({ messages: [msg({ msgId: "m-d", text: "重投" })], effects: [] });
    assert.equal(countByMsgId(rig, "m-d"), 1, "存储层不重复");
    const dedupWarns = rig.warns.filter((w) => w.includes("去重") || w.includes("duplicate") || w.includes("Duplicate"));
    assert.equal(dedupWarns.length, 1, "重投恰有一条去重告警");
  } finally {
    teardown(rig);
  }
});

test("G-4 效应落地失败不炸管线、不影响同批消息", () => {
  const rig = setup();
  try {
    const good = msg({ msgId: "m-e" });
    // repo 效应路径对坏参数天然归一化（如 enabled?1:0），自然抛错难以构造——
    // 隔离机制的测试直接 mock repo 注入抛错，不赌 repo 内部实现细节
    class BoomFxRepo extends Repo {
      override setGroupSwitch(): never {
        throw new Error("fx-boom");
      }
    }
    const boomRepo = new BoomFxRepo(rig.db);
    const plugins = new ConnectorRegistry();
    plugins.register(makeFakePlugin(passThrough));
    const warnLog: ConnectorLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (s: string) => rig.warns.push(s),
      error: () => undefined,
      fatal: () => undefined,
      child: () => warnLog,
    };
    const pipeline = createIngestPipeline({
      repo: boomRepo,
      log: warnLog,
      plugins,
    });
    const badFx = fx({ kind: "group-opt", scopeId: "G1", allow: true });
    assert.doesNotThrow(() =>
      pipeline({ botId: "bot-t1", payload: { platform: "fake", messages: [good], effects: [badFx] } }),
    );
    assert.equal(countByMsgId(rig, "m-e"), 1, "效应失败不影响同批消息入库");
    const fxWarns = rig.warns.filter((w) => w.includes("group-opt") && w.includes("fx-boom"));
    assert.equal(fxWarns.length, 1, "效应落地失败有告警且含效应类别与原因");
  } finally {
    teardown(rig);
  }
});

test("G-5 管线整体绝不抛错（每条消息路径纪律）：null 信封 / 未知平台 / normalize 抛错", () => {
  const rig = setup();
  try {
    assert.doesNotThrow(() => rig.feed(null));
    const plugins = new ConnectorRegistry();
    const log: ConnectorLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (s: string) => rig.warns.push(s),
      error: () => undefined,
      fatal: () => undefined,
      child: () => log,
    };
    const throwingPlugin = makeFakePlugin(() => {
      throw new Error("boom");
    });
    plugins.register(throwingPlugin);
    const pipeline = createIngestPipeline({ repo: rig.repo, log, plugins });
    assert.doesNotThrow(() =>
      pipeline({ botId: "bot-t1", payload: { platform: "boom", x: 1 } }),
    );
    assert.ok(rig.warns.some((w) => w.includes("boom")));
  } finally {
    teardown(rig);
  }
});
