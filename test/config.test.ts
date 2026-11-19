// 配置校验验收（2026-11-17 env 退役）：config.toml 是服务配置唯一权威——
// 服务参数 + 日志 + 连接器声明都从这里来；服务不读任何环境变量。
// bot 注册（appid/secret）、admin token、发送开关、白名单仍以 SQLite 为权威
//（WebUI / POST /register 管理），配置文件里根本没有这些键的容身之处。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromToml, loadConfig } from "../src/utils/config";

test("空文档即合法：全部缺省值就位（bot/token 不来自配置文件）", () => {
  const cfg = configFromToml("");
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.dataDir, "./data");
  assert.equal(cfg.uiDistDir, "./ui/dist");
  assert.equal(cfg.logContent, false);
  assert.equal(cfg.logLevel, "info");
  assert.equal(cfg.logFormat, "pretty");
  assert.deepEqual(cfg.connectors, []);
});

test("字段解析：host trim / port / 目录两键 / 日志三键", () => {
  const cfg = configFromToml(`
host = " 0.0.0.0 "
port = 9000
data_dir = "/var/lib/qqbot"
ui_dist_dir = "/srv/qqbot-ui"
log_content = true
log_level = "debug"
log_format = "json"
`);
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.dataDir, "/var/lib/qqbot");
  assert.equal(cfg.uiDistDir, "/srv/qqbot-ui");
  assert.equal(cfg.logContent, true);
  assert.equal(cfg.logLevel, "debug");
  assert.equal(cfg.logFormat, "json");
});

test("connectors 节委托 decl 解析（详细用例见 connectors-loader.test.ts）", () => {
  const cfg = configFromToml(`
[connectors.qq]
package = "@qsense/connector-qq"
source = "file:packages/connector-qq"
`);
  assert.deepEqual(cfg.connectors, [
    {
      platform: "qq",
      package: "@qsense/connector-qq",
      source: "file:packages/connector-qq",
    },
  ]);
});

test("类型错误拒绝：port 非整数/越界、布尔坏值、log_format 非法", () => {
  assert.throws(() => configFromToml('port = "8787"'), /port/); // 字符串不是整数
  assert.throws(() => configFromToml("port = 0"), /port/);
  assert.throws(() => configFromToml("port = 70000"), /port/);
  assert.throws(() => configFromToml("log_content = 1"), /log_content/); // toml 整数≠布尔
  assert.throws(() => configFromToml('log_format = "xml"'), /log_format/);
  assert.throws(() => configFromToml("host = 127001"), /host/); // 数字不是字符串
});

test("未知顶层键拒绝（typo 拦截：data-dir ≠ data_dir）", () => {
  assert.throws(() => configFromToml('data-dir = "./data"'), /未知键/);
  // 凭据类键同样进不了顶层（红线：凭据绝不进 toml）
  assert.throws(() => configFromToml('qq_secret = "x"'), /未知键/);
});

test("语法错误拒绝（拒启，可操作文案）", () => {
  assert.throws(() => configFromToml("[[["), /解析失败/);
  assert.throws(() => configFromToml("host ="), /解析失败/);
});

test("log_level 宽松：非法值回落 info（打日志的事不值得拒启）", () => {
  assert.equal(configFromToml('log_level = "nope"').logLevel, "info");
});

test("loadConfig：文件缺失即拒启，文案指向 config.toml.example", () => {
  assert.throws(
    () => loadConfig(join(tmpdir(), "no-such-dir-qsense", "config.toml")),
    /config\.toml\.example/,
  );
});

test("loadConfig：真实文件全链路（参数 + 声明一次读齐）", () => {
  const dir = mkdtempSync(join(tmpdir(), "qsense-cfg-"));
  try {
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      'port = 9001\nlog_content = false\n[connectors.qq]\npackage = "@qsense/connector-qq"\n',
    );
    const cfg = loadConfig(p);
    assert.equal(cfg.port, 9001);
    assert.deepEqual(cfg.connectors.map((c) => c.platform), ["qq"]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
