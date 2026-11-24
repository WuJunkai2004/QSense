// 声明制装载验收：config.toml 声明清单 → loadModule → 注册。
// - toml 解析：合法声明 / 语法错误拒启 / 未知键拒绝 / platform 键规则
// - 装载：qq 声明 → 真 QQ 插件注册（load 注入读源码声明面，不依赖 dist 构建）
// - 加载失败不炸启动：failed 清单可操作，registry 为空
// - 声明名与插件 id 一致性 / range 钉版
// - fail-fast：已注册 bot 的 platform 缺失 → missingPlatformBots 报孤儿

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorPlugin } from "@qsense/connector-sdk";
import { createQqConnector } from "@qsense/connector-qq";
import {
  loadDeclaredConnectors,
} from "../src/connectors/loader";
import {
  DeclError,
  loadConnectorDeclarations,
  missingPlatformBots,
  parseConnectorsToml,
} from "../src/connectors/decl";
import { createLogger } from "../src/utils/logger";

const LOGGER = createLogger("error");

// ---------------------------------------------------------------------------
// toml 解析（decl.ts）
// ---------------------------------------------------------------------------

test("decl：合法 config.toml → 声明清单（package/range/source）", () => {
  const decls = parseConnectorsToml(`
# 注释行
[connectors.qq]
package = "@qsense/connector-qq"
source = "file:packages/connector-qq"

[connectors.telegram]
package = "@qsense/connector-telegram"
range = "^2.0.0"
`);
  assert.deepEqual(decls, [
    {
      platform: "qq",
      package: "@qsense/connector-qq",
      source: "file:packages/connector-qq",
    },
    {
      platform: "telegram",
      package: "@qsense/connector-telegram",
      range: "^2.0.0",
    },
  ]);
});

test("decl：无 [connectors] 节 = 零声明（合法）", () => {
  assert.deepEqual(parseConnectorsToml('[log]\nlevel = "info"\n'), []);
});

test("decl：语法错误 / 结构错误 → DeclError（拒启，可操作文案）", () => {
  assert.throws(() => parseConnectorsToml("[[["), DeclError);
  assert.throws(
    () => parseConnectorsToml("[connectors]\nqq = 3\n"),
    /connectors\.qq 必须是表/,
  );
  assert.throws(
    () => parseConnectorsToml('[connectors.qq]\npackage = "x"\nrange = ""\n'),
    /range/,
  );
});

test("decl：package 必填、platform 键规则、未知键拒绝、凭据语义红线", () => {
  assert.throws(
    () => parseConnectorsToml("[connectors.qq]\nrange = '^2.0.0'\n"),
    /package/,
  );
  assert.throws(
    () => parseConnectorsToml('[connectors."QQ"]\npackage = "x"\n'),
    /平台名非法/,
  );
  assert.throws(
    () =>
      parseConnectorsToml('[connectors.qq]\npackage = "x"\nsecret = "s"\n'),
    /未知键 "secret"[\s\S]*凭据绝不进 toml/,
  );
});

// ---------------------------------------------------------------------------
// 装载（loader.ts）
// ---------------------------------------------------------------------------

test("声明制装载：qq 声明 → 真 QQ 插件注册成功", async () => {
  const outcome = await loadDeclaredConnectors({
    log: LOGGER,
    declarations: [{ platform: "qq", package: "@qsense/connector-qq" }],
    load: async () => createQqConnector({ log: LOGGER }) as ConnectorPlugin,
  });
  assert.deepEqual(outcome.loaded, ["qq"]);
  assert.equal(outcome.failed.length, 0);
  const qq = outcome.plugins.get("qq");
  assert.ok(qq !== undefined, "qq 平台应已注册");
  assert.equal(qq.id, "qq");
  assert.deepEqual(qq.caps.scopes, ["group", "c2c"]);
  assert.equal(typeof qq.normalize, "function");
});

test("加载失败不炸启动：failed 清单可操作 + registry 为空", async () => {
  const outcome = await loadDeclaredConnectors({
    log: LOGGER,
    declarations: [{ platform: "qq", package: "@qsense/connector-qq" }],
    load: async () => {
      throw new Error("Cannot find module '@qsense/connector-qq'");
    },
  });
  assert.equal(outcome.loaded.length, 0);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0]?.platform, "qq");
  assert.match(outcome.failed[0]?.reason ?? "", /Cannot find module/);
  assert.equal(outcome.plugins.get("qq"), undefined);
  assert.equal(outcome.plugins.list().length, 0);
});

test("零声明不装载任何插件（全新部署合法）", async () => {
  let calls = 0;
  const outcome = await loadDeclaredConnectors({
    log: LOGGER,
    declarations: [],
    load: async () => {
      calls += 1;
      return createQqConnector({ log: LOGGER }) as ConnectorPlugin;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(outcome.loaded, []);
  assert.equal(outcome.failed.length, 0);
});

test("声明名与插件 id 一致性：漂移即装载失败（platform 是 bots 外键目标）", async () => {
  const outcome = await loadDeclaredConnectors({
    log: LOGGER,
    declarations: [{ platform: "telegram", package: "@qsense/connector-qq" }],
    load: async () => createQqConnector({ log: LOGGER }) as ConnectorPlugin,
  });
  assert.equal(outcome.loaded.length, 0);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0]?.reason ?? "", /声明名与插件 id 不一致/);
});

test("range 钉版：与宿主契约版本不兼容即装载失败", async () => {
  const outcome = await loadDeclaredConnectors({
    log: LOGGER,
    declarations: [
      { platform: "qq", package: "@qsense/connector-qq", range: "^99.0.0" },
    ],
    load: async () => createQqConnector({ log: LOGGER }) as ConnectorPlugin,
  });
  assert.equal(outcome.loaded.length, 0);
  assert.match(outcome.failed[0]?.reason ?? "", /钉版 range/);
});

test("多平台声明同样按声明装载（声明驱动，不硬编码平台清单）", async () => {
  const loadedIds: string[] = [];
  const outcome = await loadDeclaredConnectors({
    log: LOGGER,
    declarations: [
      { platform: "qq", package: "@qsense/connector-qq" },
      { platform: "weixin", package: "@qsense/connector-weixin" },
    ],
    load: async (spec) => {
      loadedIds.push(spec);
      const qq = createQqConnector({ log: LOGGER });
      // 模拟 weixin 包：同一声明面换 id（闸门按 id 校验）
      return spec === "@qsense/connector-weixin"
        ? ({ ...qq, id: "weixin", forget: undefined } as ConnectorPlugin)
        : (qq as ConnectorPlugin);
    },
  });
  assert.deepEqual(loadedIds.sort(), [
    "@qsense/connector-qq",
    "@qsense/connector-weixin",
  ]);
  assert.deepEqual(outcome.loaded.sort(), ["qq", "weixin"]);
});

// ---------------------------------------------------------------------------
// 文件读取 + fail-fast
// ---------------------------------------------------------------------------

test("decl：文件缺失 = 零声明；存在则解析", () => {
  assert.deepEqual(loadConnectorDeclarations("no-such-dir/no-config.toml"), []);
  // 使用临时 toml 断言解析行为，不依赖仓库根生产 config.toml（其内容随真实
  // 平台接线变化）
  const dir = mkdtempSync(join(tmpdir(), "qsense-decl-test-"));
  try {
    const tomlPath = join(dir, "config.toml");
    writeFileSync(
      tomlPath,
      [
        "[connectors.qq]",
        'package = "@qsense/connector-qq"',
        'range = "^2.x"',
        'source = "file"',
        "[connectors.telegram]",
        'package = "@qsense/connector-telegram"',
        'range = "^2.x"',
        'source = "file"',
        "",
      ].join("\n"),
      "utf8",
    );
    const decls = loadConnectorDeclarations(tomlPath);
    assert.deepEqual(
      decls.map((d) => d.platform),
      ["qq", "telegram"],
    );
    for (const d of decls) {
      assert.equal(typeof d.package, "string");
      assert.ok(d.package !== "");
      assert.equal(d.source === undefined, false);
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows 句柄延迟，best-effort */
    }
  }
});

test("fail-fast：已注册 bot 的 platform 缺失 → 孤儿清单", () => {
  const bots = [
    { botId: "qq-bot", platform: "qq" },
    { botId: "tg-bot", platform: "telegram" },
  ];
  const loaded = new Set(["qq"]); // telegram 声明被删/装载失败
  assert.deepEqual(missingPlatformBots(bots, loaded), [
    { botId: "tg-bot", platform: "telegram" },
  ]);
  assert.deepEqual(
    missingPlatformBots(bots, new Set(["qq", "telegram"])),
    [],
  );
});
