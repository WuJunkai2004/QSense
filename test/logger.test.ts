// M0 验收：结构化日志——级别过滤 + 敏感字段兜底剥离。
// B⁺ T6：fields 值域 = 平面基元联合（调用侧全量调查实证），redact 顶层整键替换。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, levelFromRaw, redact } from "../src/utils/logger";

test("redact：敏感键整键替换为 [REDACTED]（平面字段值域）", () => {
  const out = redact({
    msg_id: "m1",
    content: "你好",
    raw: "整键即敏感，直接替换",
    token: "abc",
    keep: 1,
  });

  assert.equal(out.content, "[REDACTED]");
  assert.equal(out.raw, "[REDACTED]");
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.msg_id, "m1");
  assert.equal(out.keep, 1);
});

test("pretty（缺省）：loguru 风格行、级别过滤、敏感字段剥离", () => {
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const log = createLogger("info").child("unit");
    log.debug("hidden");
    log.info("visible", { content: "不得出现", ok: 1 });
  } finally {
    process.stdout.write = origWrite;
  }

  assert.equal(lines.length, 1);
  // 去 ANSI 后断言纯文本形状（颜色开关随运行环境 TTY 变化，不参与断言）
  const plain = lines[0].replace(/\x1b\[[0-9;]*m/g, "").replace(/\n$/, "");
  assert.match(
    plain,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \| INFO {2}\| main:unit - visible content=\[REDACTED\] ok=1$/,
  );
  assert.ok(!plain.includes("不得出现"));
});

test("json 格式（LOG_FORMAT=json）：结构化 JSON 行，采集端可解析", () => {
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const log = createLogger("info", "main", "json").child("unit");
    log.info("visible", { content: "不得出现", ok: 1 });
  } finally {
    process.stdout.write = origWrite;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as {
    t: string;
    level: string;
    mod: string;
    msg: string;
    content?: string;
    ok?: number;
  };
  assert.equal(parsed.level, "info");
  assert.equal(parsed.mod, "main:unit");
  assert.equal(parsed.msg, "visible");
  assert.equal(parsed.content, "[REDACTED]");
  assert.equal(parsed.ok, 1);
});

test("levelFromRaw：非法值回落 info", () => {
  assert.equal(levelFromRaw("debug"), "debug");
  assert.equal(levelFromRaw(undefined), "info");
  assert.equal(levelFromRaw("nope"), "info");
});
