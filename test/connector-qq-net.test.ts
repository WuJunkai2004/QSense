// connector-qq 协议面规格：语义 wire → QQ 官方线格式（P1 自 sender.test 迁入的
// 真机验证形态规格，勿改——全部对应已真机验证的官方受理形态）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProactiveBody,
  buildReplyBody,
  createQqNet,
  scopeToApi,
  type QQSendApi,
} from "@qsense/connector-qq";
import type { ProactiveWire, ReplyWire, UploadMediaWire } from "@qsense/connector-sdk";

const CREDS = { appid: "10001", secret: "s" };

function replyWire(over: Partial<ReplyWire> = {}): ReplyWire {
  return {
    botId: "10001",
    target: "G1",
    scope: "group",
    content: "hi",
    ...over,
  };
}

test("replyBody：纯文本 = msg_type 0 + msg_id/msg_seq；quote → message_reference（ignore_get_message_error 兜底）", () => {
  const plain = buildReplyBody(
    replyWire({ msgId: "M1", msgSeq: 2 }),
  );
  assert.deepEqual(plain, {
    msg_type: 0,
    content: "hi",
    msg_id: "M1",
    msg_seq: 2,
  });

  const quoted = buildReplyBody(
    replyWire({ msgId: "M1", msgSeq: 1, quoteMsgId: "M1" }),
  );
  assert.deepEqual(quoted, {
    msg_type: 0,
    content: "hi",
    msg_id: "M1",
    msg_seq: 1,
    message_reference: { message_id: "M1", ignore_get_message_error: true },
  });
});

test("replyBody：markdown = msg_type 2（304036 降级前形态）", () => {
  const body = buildReplyBody(
    replyWire({ content: "# 标题", markdown: true, msgId: "M1", msgSeq: 1 }),
  );
  assert.deepEqual(body, {
    msg_type: 2,
    markdown: { content: "# 标题" },
    msg_id: "M1",
    msg_seq: 1,
  });
});

test("replyBody：富媒体 = msg_type 7 + media.file_info（2026-10-27 真机：可走被动窗、可带引用块）", () => {
  const body = buildReplyBody(
    replyWire({
      content: "看看这只猫",
      msgId: "M_PIC",
      msgSeq: 1,
      media: { kind: "image", handle: "FILEINFO_1" },
    }),
  );
  assert.deepEqual(body, {
    msg_type: 7,
    content: "看看这只猫",
    media: { file_info: "FILEINFO_1" },
    msg_id: "M_PIC",
    msg_seq: 1,
  });

  const withQuote = buildReplyBody(
    replyWire({
      content: "",
      media: { kind: "voice", handle: "F1" },
      msgId: "C1",
      msgSeq: 1,
      quoteMsgId: "C1",
    }),
  );
  assert.deepEqual(withQuote, {
    msg_type: 7,
    content: "",
    media: { file_info: "F1" },
    msg_id: "C1",
    msg_seq: 1,
    message_reference: { message_id: "C1", ignore_get_message_error: true },
  });
});

test("proactiveBody：主动消息无 msg_id/msg_seq；文本/媒体/引用块三形态（真机验证受理）", () => {
  const text = buildProactiveBody({ botId: "1", target: "G1", scope: "group", content: "早" });
  assert.deepEqual(text, { msg_type: 0, content: "早" });

  const media = buildProactiveBody({
    botId: "1",
    target: "G1",
    scope: "group",
    content: "配文",
    media: { kind: "image", handle: "F2" },
  });
  assert.deepEqual(media, {
    msg_type: 7,
    media: { file_info: "F2" },
    content: "配文",
  });

  const quoted = buildProactiveBody({
    botId: "1",
    target: "G1",
    scope: "group",
    content: "x",
    quoteMsgId: "M_OLD",
  });
  assert.deepEqual(quoted, {
    msg_type: 0,
    content: "x",
    message_reference: { message_id: "M_OLD", ignore_get_message_error: true },
  });

  // markdown 形态（出站 AT 标签仅 markdown 渲染；2026-11-19 官方「文本交互」页）
  const md = buildProactiveBody({
    botId: "1",
    target: "G1",
    scope: "group",
    content: "<qqbot-at-user id=\"U1\"/> 早",
    markdown: true,
  });
  assert.deepEqual(md, { msg_type: 2, markdown: { content: "<qqbot-at-user id=\"U1\"/> 早" } });

  const mdQuoted = buildProactiveBody({
    botId: "1",
    target: "G1",
    scope: "group",
    content: "<qqbot-at-user id=\"U1\"/> 早",
    markdown: true,
    quoteMsgId: "M_OLD",
  });
  assert.deepEqual(mdQuoted, {
    msg_type: 2,
    markdown: { content: "<qqbot-at-user id=\"U1\"/> 早" },
    message_reference: { message_id: "M_OLD", ignore_get_message_error: true },
  });
});

test("scopeToApi：core 会话形态标签 → 官方 API scope（chat→c2c，group→group）", () => {
  assert.equal(scopeToApi("chat"), "c2c");
  assert.equal(scopeToApi("group"), "group");
});

test("createQqNet：wire → QQSendApi 映射（scope/目标/凭据/线格式/回执）", async () => {
  const calls: Array<{
    scope: string;
    targetId: string;
    body: Record<string, unknown>;
  }> = [];
  const uploads: Array<{ scope: string; targetId: string; kind: string; src: unknown }> = [];
  const recalls: Array<{ scope: string; targetId: string; messageId: string }> = [];
  const net = createQqNet({
    creds: { botId: "10001", platform: "qq", credential: CREDS },
    tokenManager: {} as never,
    log: { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } },
    apiFor: (): QQSendApi => ({
      sendRaw: async (scope, targetId, creds, body) => {
        assert.deepEqual(creds, { appId: "10001", clientSecret: "s" });
        calls.push({ scope, targetId, body });
        return { id: `PM_${calls.length}` };
      },
      recallMessage: async (scope, targetId, messageId) => {
        recalls.push({ scope, targetId, messageId });
      },
      uploadMedia: async (scope, targetId, _creds, src, kind) => {
        uploads.push({ scope, targetId, kind, src });
        return `FILEINFO_${uploads.length}`;
      },
    }),
  });

  // 被动回复：chat → c2c scope
  const receipt = await net.reply!(
    replyWire({ scope: "chat", target: "U1", msgId: "C1", msgSeq: 1 }),
  );
  assert.deepEqual(receipt, { providerMsgId: "PM_1" });
  assert.equal(calls[0]!.scope, "c2c");
  assert.equal(calls[0]!.targetId, "U1");
  assert.equal(calls[0]!.body.msg_id, "C1");

  // 主动：group scope
  const p: ProactiveWire = { botId: "10001", target: "G1", scope: "group", content: "早" };
  await net.proactive!(p);
  assert.equal(calls[1]!.scope, "group");
  assert.equal(calls[1]!.body.msg_id, undefined);

  // 撤回
  await net.recall!({
    botId: "10001",
    target: "G1",
    scope: "group",
    providerMsgId: "PM_1",
  });
  assert.deepEqual(recalls[0], { scope: "group", targetId: "G1", messageId: "PM_1" });

  // 上传：voice 类别 + file 源直通
  const up: UploadMediaWire = {
    botId: "10001",
    target: "G1",
    scope: "group",
    kind: "voice",
    source: { kind: "url", url: "https://example.com/a.mp3" },
  };
  const upR = await net.uploadMedia!(up);
  assert.deepEqual(upR, { handle: "FILEINFO_1" });
  assert.equal(uploads[0]!.kind, "voice");
  assert.deepEqual(uploads[0]!.src, { kind: "url", url: "https://example.com/a.mp3" });
});
