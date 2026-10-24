// 去重器单测：环形窗口、淘汰后允许再次出现。

import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedDedup } from "../src/gateway/dedup";
import { OUR_INTENTS } from "../src/gateway/intents";

test("BoundedDedup：首次 true、重复 false、容量淘汰后视为新", () => {
  const d = new BoundedDedup(2);
  assert.equal(d.isNew("a"), true);
  assert.equal(d.isNew("b"), true);
  assert.equal(d.isNew("a"), false);
  assert.equal(d.isNew("c"), true); // 淘汰 a
  assert.equal(d.isNew("a"), true); // a 已被淘汰，视为新
  assert.equal(d.size, 2);
});

test("OUR_INTENTS = GROUP_AND_C2C(1<<25) | MESSAGE_AUDIT(1<<27)", () => {
  assert.equal(OUR_INTENTS, (1 << 25) | (1 << 27));
});
