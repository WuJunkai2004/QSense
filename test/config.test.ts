// M0/M9 验收：配置校验——env 只承担部署拓扑与运维参数；
// bot 注册（appid/secret/认证等级）、admin token、发送开关、白名单一律以 SQLite 为权威，
// 相关 env 键即使存在也被忽略（不再读取，报错通道走 WebUI / register_bot）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";

test("空 env 即合法：全部缺省值就位（M9 起 bot/token 不再来自 env）", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.dataDir, "./data");
  assert.equal(cfg.logContent, false);
  assert.equal(cfg.retentionDays, 90);
});

test("已退役的 env 键被忽略（QQ_APPS/MCP_TOKEN/SEND_ENABLE/ALLOW_GROUPS/QQ_AUTH_LEVEL）", () => {
  // M9 前这些值非法会直接拒绝启动；现在一律不读取——即使内容是坏的
  const cfg = loadConfig({
    QQ_APPS: "{oops",
    MCP_TOKEN: "short",
    SEND_ENABLE: "yes",
    ALLOW_GROUPS: "abc",
    QQ_AUTH_LEVEL: "gold",
  });
  assert.equal(cfg.port, 8787); // 其余字段照常解析
});

test("HOST/DATA_DIR 自定义生效", () => {
  const cfg = loadConfig({ HOST: " 0.0.0.0 ", DATA_DIR: "/var/lib/qqbot" });
  assert.equal(cfg.host, "0.0.0.0"); // trim
  assert.equal(cfg.dataDir, "/var/lib/qqbot");
});

test("非法布尔值与端口拒绝", () => {
  assert.throws(
    () => loadConfig({ LOG_CONTENT: "yes" }),
    (e: Error) => e.message.includes("LOG_CONTENT"),
  );
  assert.throws(
    () => loadConfig({ PORT: "0" }),
    (e: Error) => e.message.includes("PORT"),
  );
  assert.throws(
    () => loadConfig({ PORT: "abc" }),
    (e: Error) => e.message.includes("PORT"),
  );
  assert.throws(
    () => loadConfig({ PORT: "70000" }),
    (e: Error) => e.message.includes("PORT"),
  );
});

test("LOG_CONTENT=true 生效；RETENTION_DAYS 边界校验", () => {
  assert.equal(loadConfig({ LOG_CONTENT: "true" }).logContent, true);
  assert.equal(loadConfig({ RETENTION_DAYS: "30" }).retentionDays, 30);
  assert.throws(
    () => loadConfig({ RETENTION_DAYS: "0" }),
    (e: Error) => e.message.includes("RETENTION_DAYS"),
  );
  assert.throws(
    () => loadConfig({ RETENTION_DAYS: "9999" }),
    (e: Error) => e.message.includes("RETENTION_DAYS"),
  );
});
