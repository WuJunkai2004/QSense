// @qsense/connector-sdk 契约测试：semver-lite / 声明面闸门 / 工具路由 / 注册表 / 内存宿主 / harness。
// P0 验收：本文件全绿 + 既有 112 用例不受影响（diff 纯新增）。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  BASE_TOOL_NAMES,
  ConnectorError,
  ConnectorRegistry,
  type ConnectorPlugin,
  GateError,
  runConformance,
  satisfiesRange,
  ToolRouter,
  callPluginTool,
  createMemoryHost,
  loadModule,
  validateCredentialSchema,
  validatePlugin,
  validatePluginTool,
  validateWebuiRoutes,
} from "@qsense/connector-sdk";
import type { JsonSchema } from "@qsense/connector-sdk";

// ---------------------------------------------------------------------------
// 测试夹具：最小合法 QQ 形插件 + 可变形参
// ---------------------------------------------------------------------------

const QQ_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    appid: { type: "string", description: "机器人 appid" },
    AppSecret: { type: "string", description: "机器人 AppSecret" },
  },
  required: ["appid", "AppSecret"],
};

/** 组装最小合法插件声明（覆盖测试按字段覆写） */
function makePlugin(over: Partial<ConnectorPlugin> = {}): ConnectorPlugin {
  const base: ConnectorPlugin = {
    id: "qq",
    sdkRange: "^2.0.0",
    title: "QQ 官方机器人",
    caps: {
      scopes: ["group", "c2c"],
      media: { image: true, voice: true, video: false, file: false },
      recall: false,
      passiveWindow: true,
      quota: true,
      proactiveOptIn: true,
    },
    normalize: (botId, payload) => {
      // 最小 normalize：zod 解析测试信封 {platform, kind:"msg", id} → 成品消息
      const p = z
        .object({ kind: z.string().optional(), id: z.string().optional() })
        .safeParse(payload);
      if (!p.success || p.data.kind !== "msg") return null;
      return {
        messages: [
          {
            botId,
            scope: "group",
            scopeId: "g-1",
            msgId: p.data.id ?? "m-1",
            authorOpenid: "u-1",
            ts: null,
            text: "",
            content: "",
            quote: null,
            records: [],
            mentions: [],
            attachments: [],
            rawJson: JSON.stringify(payload),
          },
        ],
        effects: [{ kind: "group-seen", scopeId: "g-1" }],
      };
    },
    credentialSchema: QQ_SCHEMA,
    credentialSecrets: ["AppSecret"],
    tools: [
      {
        name: "quota",
        description: "查询主动发送额度",
        inputSchema: { type: "object", properties: {} },
        call: async () => ({
          content: [{ type: "text", text: "quota ok" }],
        }),
      },
    ],
    hooks: {
      async verifyCredential(credential) {
        if (credential["appid"] === "bad") {
          throw new Error("凭据校验失败：appid 无效");
        }
      },
    },
    create: (host, creds) => ({
      start: async () => {
        await host.state.set("boot", JSON.stringify({ bot: creds.botId }));
        host.ingest({
          botId: creds.botId,
          payload: { platform: "qq", kind: "hello" },
          receivedAt: 1,
        });
      },
      stop: () => undefined,
      net: {
        reply: async () => ({ providerMsgId: "pm-1" }),
        proactive: async () => ({ providerMsgId: "pm-2" }),
        uploadMedia: async () => ({ handle: "h-1" }),
      },
    }),
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------
// semver-lite
// ---------------------------------------------------------------------------

describe("sdk/semver", () => {
  it("精确版本", () => {
    assert.equal(satisfiesRange("1.2.3", "1.2.3"), true);
    assert.equal(satisfiesRange("1.2.4", "1.2.3"), false);
  });

  it("^ 锁主版本", () => {
    assert.equal(satisfiesRange("1.9.0", "^1.0.0"), true);
    assert.equal(satisfiesRange("2.0.0", "^1.0.0"), false);
    assert.equal(satisfiesRange("0.9.9", "^1.0.0"), false);
  });

  it("~ 锁次版本", () => {
    assert.equal(satisfiesRange("1.2.9", "~1.2.3"), true);
    assert.equal(satisfiesRange("1.3.0", "~1.2.3"), false);
  });

  it(">= / > / = / *", () => {
    assert.equal(satisfiesRange("1.5.0", ">=1.0.0"), true);
    assert.equal(satisfiesRange("1.5.0", ">1.5.0"), false);
    assert.equal(satisfiesRange("1.5.0", "=1.5.0"), true);
    assert.equal(satisfiesRange("9.9.9", "*"), true);
  });

  it("空格 AND", () => {
    assert.equal(satisfiesRange("1.4.0", ">=1.2.0 <1.5.0"), true);
    assert.equal(satisfiesRange("1.5.0", ">=1.2.0 <1.5.0"), false);
  });

  it("非法输入一律 false", () => {
    assert.equal(satisfiesRange("banana", "^1.0.0"), false);
    assert.equal(satisfiesRange("1.0.0", "banana"), false);
    assert.equal(satisfiesRange("1.0.0", ""), false);
  });
});

// ---------------------------------------------------------------------------
// 闸门
// ---------------------------------------------------------------------------

describe("sdk/gates", () => {
  it("最小合法插件过全量闸门", () => {
    const p = makePlugin();
    assert.doesNotThrow(() => validatePlugin(p));
  });

  it("保留名冲突硬失败", () => {
    const p = makePlugin({
      tools: [
        {
          name: "list_all",
          description: "x",
          inputSchema: { type: "object" },
          call: async () => ({
            content: [{ type: "text", text: "" }],
          }),
        },
      ],
    });
    assert.throws(() => validatePlugin(p), GateError);
    assert.throws(() => validatePlugin(p), /保留名/);
  });

  it("inputSchema 顶层必须 object、required 必须引用存在的属性", () => {
    const bad1 = makePlugin({
      tools: [
        {
          name: "t1",
          description: "d",
          inputSchema: { type: "string" },
          call: async () => ({ content: [{ type: "text", text: "" }] }),
        },
      ],
    });
    assert.throws(() => validatePluginTool(bad1.tools![0]!), /"object"/);

    const bad2 = makePlugin({
      tools: [
        {
          name: "t2",
          description: "d",
          inputSchema: { type: "object", required: ["ghost"] },
          call: async () => ({ content: [{ type: "text", text: "" }] }),
        },
      ],
    });
    assert.throws(() => validatePluginTool(bad2.tools![0]!), /required/);
  });

  it("credentialSchema 与 credentialSecrets 一致性", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { appid: { type: "string" } },
    };
    assert.throws(
      () => validateCredentialSchema(schema, ["AppSecret"]),
      /AppSecret/,
    );
    assert.doesNotThrow(() =>
      validateCredentialSchema(QQ_SCHEMA, ["AppSecret"]),
    );
  });

  it("webui 路由：path 规范 + 插件内唯一", () => {
    const mk = (path: string) => [
      { method: "POST" as const, path, handle: async () => ({}) },
    ];
    assert.throws(() => validateWebuiRoutes(mk("no-slash")), GateError);
    assert.throws(
      () => validateWebuiRoutes([...mk("/a"), ...mk("/a")]),
      /重复/,
    );
    assert.doesNotThrow(() => validateWebuiRoutes(mk("/login/qr/create")));
  });

  it("qr-pair login 引用的路由必须存在", () => {
    const p = makePlugin({
      login: { kind: "qr-pair", create: "/qr/create", poll: "/qr/poll" },
    });
    assert.throws(() => validatePlugin(p), /POST \/qr\/create/);
    const ok = makePlugin({
      login: { kind: "qr-pair", create: "/qr/create", poll: "/qr/poll" },
      webui: [
        { method: "POST", path: "/qr/create", handle: async () => ({}) },
        { method: "POST", path: "/qr/poll", handle: async () => ({}) },
      ],
    });
    assert.doesNotThrow(() => validatePlugin(ok));
  });

  it("sdkRange 与宿主契约版本不兼容即拒", () => {
    const p = makePlugin({ sdkRange: "^99.0.0" });
    assert.throws(() => validatePlugin(p), /sdkRange/);
  });

  it("normalize 缺位即拒（契约 v2：上行解读权在插件）", () => {
    const p = makePlugin({ normalize: undefined as never });
    assert.throws(() => validatePlugin(p), /normalize/);
  });

  it("非法 id / core 保留字", () => {
    assert.throws(() => validatePlugin(makePlugin({ id: "QQ" })), GateError);
    assert.throws(() => validatePlugin(makePlugin({ id: "core" })), /保留字/);
  });
});

// ---------------------------------------------------------------------------
// 工具路由 + 插件工具调用
// ---------------------------------------------------------------------------

describe("sdk/router", () => {
  it("base → plugin → null 解析", () => {
    const router = new ToolRouter(BASE_TOOL_NAMES);
    router.registerPlugin(makePlugin());
    assert.equal(router.resolve("list_all")?.source, "base");
    const r = router.resolve("quota");
    assert.equal(r?.source, "plugin");
    assert.equal(r?.plugin?.id, "qq");
    assert.equal(router.resolve("nope"), null);
  });

  it("names() = 基座 13 + 插件扩展，排序", () => {
    const router = new ToolRouter(BASE_TOOL_NAMES);
    router.registerPlugin(makePlugin());
    const names = router.names();
    assert.equal(names.length, 14);
    assert.ok(names.includes("quota"));
    assert.deepEqual(names, [...names].sort());
  });

  it("跨插件工具名冲突被拒", () => {
    const router = new ToolRouter(BASE_TOOL_NAMES);
    router.registerPlugin(makePlugin());
    const wx = makePlugin({ id: "weixin" }); // tools 里同名 quota
    assert.throws(() => router.registerPlugin(wx), /跨平台冲突/);
  });

  it("callPluginTool：成功 / 未声明 / 异常规范化", async () => {
    const plugin = makePlugin();
    const { host } = createMemoryHost();
    const ctx = { host, botId: "b1", config: {} };

    const okp = await callPluginTool(plugin, "quota", undefined, ctx);
    assert.equal(okp.isError, undefined);
    assert.equal(okp.content[0]?.text, "quota ok");

    const miss = await callPluginTool(plugin, "ghost", undefined, ctx);
    assert.equal(miss.isError, true);

    const bad = makePlugin({
      tools: [
        {
          name: "boom",
          description: "d",
          inputSchema: { type: "object" },
          call: async () => {
            throw new ConnectorError("上游超时", 502);
          },
        },
      ],
    });
    const err = await callPluginTool(bad, "boom", undefined, ctx);
    assert.equal(err.isError, true);
    assert.equal(err.content[0]?.text, "上游超时");
  });
});

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

describe("sdk/registry", () => {
  it("register / get / list / require 可操作错误", () => {
    const reg = new ConnectorRegistry();
    reg.register(makePlugin());
    reg.register(makePlugin({ id: "weixin", title: "微信" }));
    assert.deepEqual(
      reg.list().map((p) => p.id),
      ["qq", "weixin"],
    );
    assert.throws(() => reg.require("telegram"), /telegram[\s\S]*未注册/);
    assert.throws(() => reg.register(makePlugin()), /重复注册/);
  });

  it("instantiate：platform 一致性校验 + create 产出实例", () => {
    const reg = new ConnectorRegistry();
    reg.register(makePlugin());
    const { host } = createMemoryHost();
    const inst = reg.instantiate(
      "qq",
      host,
      { botId: "b1", platform: "qq", credential: {} },
    );
    assert.equal(typeof inst.start, "function");
    assert.throws(
      () =>
        reg.instantiate("qq", host, {
          botId: "b1",
          platform: "weixin",
          credential: {},
        }),
      /不一致/,
    );
  });

  it("loadModule：非法包名报可操作错误", async () => {
    await assert.rejects(
      () => loadModule("@qsense/not-exist-xyz"),
      /加载失败/,
    );
  });

  it("loadModule：默认导出为工厂时注入 init 执行（P2 声明制加载路径）", async () => {
    // 临时 .mjs：默认导出工厂，校验 init 透传 + 声明面过闸门
    const file = join(
      mkdtempSync(join(tmpdir(), "qsense-sdk-factory-")),
      "plugin.mjs",
    );
    writeFileSync(
      file,
      `export default (init) => ({
  id: "factory-p",
  sdkRange: "^2.0.0",
  title: "Factory",
  caps: {
    scopes: ["group"],
    media: { image: false, voice: false, video: false, file: false },
    recall: false,
    passiveWindow: false,
    quota: false,
    proactiveOptIn: false,
  },
  credentialSchema: { type: "object", properties: {}, required: [] },
  credentialSecrets: [],
  normalize: () => null,
  create: () => ({
    start: async () => undefined,
    stop: () => undefined,
    sawInitLog: typeof init?.log?.debug === "function",
  }),
});
`,
      "utf8",
    );
    try {
      const p = await loadModule(pathToFileURL(file).href, {
        log: { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } },
      });
      assert.equal(p.id, "factory-p");
      const inst = p.create(createMemoryHost().host, {
        botId: "b",
        platform: "factory-p",
        credential: {},
      });
      // init.log 透传验证：create 闭包读到的 init 已带 log
      assert.equal(
        (inst as { sawInitLog?: boolean }).sawInitLog,
        true,
        "工厂应收到含 log 的 init",
      );
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("loadModule：工厂执行失败报可操作错误", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qsense-sdk-factory-bad-"));
    const file = join(dir, "bad.mjs");
    writeFileSync(
      file,
      "export default () => { throw new Error('boom in factory'); };",
      "utf8",
    );
    try {
      await assert.rejects(
        () => loadModule(pathToFileURL(file).href),
        /boom in factory/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 内存宿主 + harness
// ---------------------------------------------------------------------------

describe("sdk/memory+harness", () => {
  it("memory host：ingest 顺序记录 + state roundtrip", async () => {
    const h = createMemoryHost({ botId: "b1" });
    h.host.ingest({ botId: "b1", payload: { platform: "t", n: 1 } });
    h.host.ingest({ botId: "b1", payload: { platform: "t", n: 2 } });
    assert.equal(h.ingested.length, 2);
    assert.deepEqual(h.ingested[1]?.payload, { platform: "t", n: 2 });
    // StatePort 值 = JSON 文本（B⁺ T6 字符串化）
    await h.state.set("s", JSON.stringify({ a: [1, 2] }));
    assert.deepEqual(JSON.parse((await h.state.get("s")) ?? "null"), {
      a: [1, 2],
    });
    await h.state.delete("s");
    assert.equal(await h.state.get("s"), null);
  });

  it("harness：合法插件全检查通过（含 probe 上行断言）", async () => {
    const report = await runConformance(makePlugin(), {
      probe: async (host, instance) => {
        // 经实例 start 注入的 hello 载荷由 probe 里重新驱动验证上行通道：
        host.ingest({ botId: "bot-conformance", payload: { platform: "qq", kind: "probe" } });
        const receipt = await instance.net.reply?.({
          botId: "bot-conformance",
          target: "g-x",
          scope: "group",
          content: "hi",
          msgId: "m-1",
          msgSeq: 1,
        });
        assert.equal(receipt?.providerMsgId, "pm-1");
      },
    });
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks.map((c) => c.name),
      [
        "declaration-gates",
        "lifecycle",
        "host-state-roundtrip",
        "net-primitives",
        "probe",
      ],
    );
  });

  it("harness：声明面失败 → report.passed=false", async () => {
    const bad = makePlugin({ sdkRange: "^99.0.0" });
    const report = await runConformance(bad);
    assert.equal(report.passed, false);
    const gates = report.checks.find((c) => c.name === "declaration-gates");
    assert.match(gates?.detail ?? "", /sdkRange/);
  });

  it("harness：normalize-shape——样本产出成品消息过形状断言；坏形状判失败", async () => {
    // 合法样本：normalize 产物符合契约 → 检查通过
    const ok = await runConformance(makePlugin(), {
      normalizeSample: { platform: "qq", kind: "msg", id: "m-9" },
    });
    const okCheck = ok.checks.find((c) => c.name === "normalize-shape");
    assert.equal(okCheck?.ok, true);
    // 坏形状：msgId 置空 → assertNormalizedMessage 抛错 → 检查失败
    const badShape = makePlugin({
      normalize: (botId, payload) => {
        const inbound = makePlugin().normalize(botId, payload);
        if (inbound === null) return null;
        (inbound.messages[0] as { msgId: string }).msgId = "";
        return inbound;
      },
    });
    const bad = await runConformance(badShape, {
      normalizeSample: { platform: "qq", kind: "msg", id: "m-9" },
    });
    assert.equal(bad.passed, false);
    assert.match(
      bad.checks.find((c) => c.name === "normalize-shape")?.detail ?? "",
      /msgId/,
    );
    // 未知效应类别同样判失败
    const badFx = makePlugin({
      normalize: () => ({
        messages: [],
        effects: [{ kind: "mystery", scopeId: "g" } as never],
      }),
    });
    const bfx = await runConformance(badFx, { normalizeSample: { platform: "qq" } });
    assert.equal(bfx.passed, false);
    assert.match(
      bfx.checks.find((c) => c.name === "normalize-shape")?.detail ?? "",
      /kind/,
    );
  });

  it("harness：caps 与原语不一致 → net-primitives 失败", async () => {
    // 微信形态：passiveWindow=false、无 quota/recall，net 缺 proactive —— 应判失败
    const wx = makePlugin({
      id: "weixin",
      caps: {
        scopes: ["chat"],
        media: { image: true, voice: true, video: true, file: true },
        recall: false,
        passiveWindow: false,
        quota: false,
        proactiveOptIn: false,
      },
      tools: [],
      create: (host, creds) => ({
        start: async () => {
          await host.state.set("boot", JSON.stringify({ bot: creds.botId }));
        },
        stop: () => undefined,
        net: {
          // 故意缺 proactive（passiveWindow=false 平台唯一发送通道）
          reply: async () => ({ providerMsgId: "pm-1" }),
          uploadMedia: async () => ({ handle: "h-1" }),
        },
      }),
    });
    const report = await runConformance(wx);
    assert.equal(report.passed, false);
    const net = report.checks.find((c) => c.name === "net-primitives");
    assert.match(net?.detail ?? "", /net\.proactive/);
  });
});
