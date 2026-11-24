// 去重器单测：环形窗口、淘汰后允许再次出现。

import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedDedup } from "../src/connectors/dedup";
import { OUR_INTENTS } from "@qsense/connector-qq";

test("BoundedDedup：检查与标记两段式（检查不标记）；标记后去重、容量淘汰后视为新", () => {
  const d = new BoundedDedup(2);
  // 检查是幂等的：不改变状态，重复检查结果一致
  assert.equal(d.isNew("a"), true);
  assert.equal(d.isNew("a"), true);
  assert.equal(d.size, 0);
  // 标记后才视为重复
  d.mark("a");
  assert.equal(d.isNew("a"), false);
  d.mark("b");
  assert.equal(d.isNew("b"), false);
  assert.equal(d.size, 2);
  // 容量淘汰：标记 c 挤掉 a，a 重新视为新
  d.mark("c"); // 淘汰 a
  assert.equal(d.isNew("a"), true);
  assert.equal(d.size, 2);
  // mark 幂等：重复标记不挤占窗口
  d.mark("c");
  assert.equal(d.size, 2);
});

test("OUR_INTENTS = GROUP_AND_C2C(1<<25) | MESSAGE_AUDIT(1<<27)", () => {
  assert.equal(OUR_INTENTS, (1 << 25) | (1 << 27));
});
