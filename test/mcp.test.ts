// M3 验收：MCP 客户端 SDK 直连 /mcp——
// 鉴权（401）、listTools、会话列表→取新消息（拉取即已读，水位自动推进）→搜历史闭环、
// context/browse。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/server/http";
import { createLogger } from "../src/logger";
import { Sender } from "../src/sender";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";

const TOKEN = "m3-test-token-0123456789abcdef";
const GROUP = "GROUP_OPENID_G1";

interface Fixture {
  baseUrl: string;
  agentToken: string;
  db: DB;
  /** hangSend 模式下解锁挂起的 sendRaw（幂等；其余模式为 no-op） */
  hang: { release: () => void };
  close: () => Promise<void>;
}

interface SetupOpts {
  /** 发送总开关入库值（缺省 false——多数用例验证写工具被拒） */
  sendEnabled?: boolean;
  /** MCP 并发上限注入口（缺省 8，见 mcp.ts McpDeps） */
  maxConcurrent?: number;
  /** 注入「挂起的发送器」：sendRaw 阻塞到 hang.release()，供并发闸测试占用并发槽 */
  hangSend?: boolean;
}

async function setupServer(opts: SetupOpts = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-m3-test-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);

  // 种子数据：2 群 + 3 成员 + 5 条消息（含合并转发展开文本）
  const seed = [
    {
      msgId: "M1",
      author: "U_A",
      name: "小明",
      role: "member",
      content: "今晚一起开会讨论项目排期",
      ageH: 5,
    },
    {
      msgId: "M2",
      author: "U_B",
      name: "小红",
      role: "admin",
      content: "好，我把会议室订好了",
      ageH: 4,
    },
    {
      msgId: "M3",
      author: "U_A",
      name: "小明",
      role: "member",
      content: "转发给你看\n[聊天记录]\n  上周结论：按期交付",
      ageH: 3,
    },
    {
      msgId: "M4",
      author: "U_C",
      name: "小刚",
      role: "member",
      content: "排期表发我一份",
      ageH: 2,
    },
    {
      msgId: "M5",
      author: "U_A",
      name: "小明",
      role: "member",
      content: "排期表在群里置顶了",
      ageH: 1,
    },
  ];
  for (const s of seed) {
    repo.saveMessage({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: s.msgId,
      authorOpenid: s.author,
      authorName: s.name,
      authorRole: s.role,
      ts: Date.now() - s.ageH * 3600 * 1000,
      text: s.content,
      content: s.content,
      quote: null,
      records: [],
      mentions: [],
      attachments: [],
      raw: { id: s.msgId },
    });
  }
  repo.setGroupSwitch("10001", GROUP, true);
  repo.addGroup("10001", "GROUP_OPENID_G2");

  // M9：env 不再读取——admin token 现场生成即可（本文件只测 401，不需要有效值），
  // bot 注册入表，发送开关走库
  repo.ensureRuntime();
  if (opts.sendEnabled === true) repo.setSendEnable(true);
  const registry = new BotRegistry({ db });
  await registry.add({
    appid: "10001",
    secret: "s",
    name: "t",
    allowGroups: [GROUP],
  });
  const agentToken = registry.rotateToken("10001");

  // 可选：挂起的发送器——sendRaw 阻塞到 release()，供 M6-14 并发闸测试占住并发槽
  let releaseHang: () => void = () => {};
  let sender: Sender | undefined;
  if (opts.hangSend === true) {
    const gate = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    sender = new Sender({
      log: createLogger("error"),
      db,
      repo,
      tokenManager: {} as never,
      bots: registry,
      apiFor: () =>
        ({
          async sendRaw() {
            await gate;
            return { id: "PROVIDER_HUNG" };
          },
          async recallMessage() {},
        }) as never,
    });
  }

  const app = buildServer({
    log: createLogger("debug"),
    db,
    repo,
    registry,
    version: "0.1.0",
    sender,
    maxConcurrent: opts.maxConcurrent,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    agentToken,
    db,
    hang: { release: releaseHang },
    close: async () => {
      await app.close();
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

async function connectClient(
  baseUrl: string,
  agentToken = TOKEN,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${agentToken}` } },
    },
  );
  const client = new Client({ name: "m3-test", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

function payloadOf(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  return JSON.parse(result.content[0]!.text ?? "") as Record<string, unknown>;
}

test("M3-1 未带 token / 错 token → 401", async () => {
  const fx = await setupServer();
  try {
    const noAuth = await fetch(`${fx.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
        id: 1,
      }),
    });
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${fx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
        id: 1,
      }),
    });
    assert.equal(badAuth.status, 401);
  } finally {
    await fx.close();
  }
});

test("M3-2 listTools 含 14 个工具；未开启发送时写工具硬拒绝", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    client = await connectClient(fx.baseUrl, fx.agentToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "browse",
      "context",
      "get_media",
      "get_new",
      "get_records",
      "list_all",
      "list_members",
      "list_new",
      "quota",
      "recall",
      "register_bot",
      "request_upload",
      "search",
      "send",
      "send_media",
    ]);
    // 双重门禁未开（发送开关缺省关）→ 写工具硬拒绝且不炸
    const denied = (await client.callTool({
      name: "send",
      arguments: { id: GROUP, text: "test" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(denied.isError, true);
    assert.ok(
      denied.content[0]!.text.includes("发送功能未启用"),
      "拒绝文案应指出写工具面未开启",
    );
  } finally {
    // 关闭顺序（踩坑#3）：断言失败也不能跳过 client.close，否则 app.close() 等 SSE 挂死
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});

test("M3-3 闭环：会话列表 → 取新消息（拉取即已读） → 关键词搜索", async () => {
  const fx = await setupServer();
  try {
    const client = await connectClient(fx.baseUrl, fx.agentToken);

    // 会话列表：2 群；无水位 → 未读=全部消息
    const listed = payloadOf(
      (await client.callTool({ name: "list_all", arguments: {} })) as never,
    );
    assert.equal(listed.count, 2);
    const convs = listed.conversations as Array<Record<string, unknown>>;
    const g1 = convs.find((c) => c.id === GROUP)!;
    assert.equal(g1.type, "group");
    assert.equal(g1.unread, 5);
    assert.ok(typeof g1.last_msg_ts === "string");
    assert.ok(!("full_msg_enabled" in g1), "agent 视角不含管理面字段");

    // list_new：有未读 → 命中
    const news = payloadOf(
      (await client.callTool({ name: "list_new", arguments: {} })) as never,
    );
    assert.equal(news.count, 1);

    // 取新消息（拉取即已读，水位自动推进）
    const first = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: GROUP },
      })) as never,
    );
    assert.equal(first.count, 5);
    assert.ok(!("next_cursor" in first), "已读水位是服务端内部状态，不外露");

    // 重复拉取：零重复（水位已推进）
    const second = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: GROUP },
      })) as never,
    );
    assert.equal(second.count, 0);

    // 已读后 list_new 不再命中该群
    const news2 = payloadOf(
      (await client.callTool({ name: "list_new", arguments: {} })) as never,
    );
    assert.equal(news2.count, 0);

    // 新消息到达 → 再次未读；增量拉取只给新消息
    new Repo(fx.db).saveOutgoing({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: "M6",
      content: "新到的消息",
      ts: Date.now(),
      authorName: null,
    });
    const news3 = payloadOf(
      (await client.callTool({ name: "list_new", arguments: {} })) as never,
    );
    assert.equal(news3.count, 1);
    const inc = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: GROUP },
      })) as never,
    );
    assert.deepEqual(
      (inc.messages as Array<Record<string, unknown>>).map((m) => m.msg_id),
      ["M6"],
    );

    // 搜索（≥3 字走 FTS trigram 路径，见 repo.searchMessages：[...q].length >= 3）
    // "排期表" 命中 M4/M5；M1 仅含「排期」二字，短语不应命中——同时验证 FTS JOIN 真实执行
    const search = payloadOf(
      (await client.callTool({
        name: "search",
        arguments: { id: GROUP, query: "排期表" },
      })) as never,
    );
    const hitIds = (search.messages as Array<Record<string, unknown>>).map(
      (m) => m.msg_id,
    );
    assert.ok(hitIds.includes("M4"), "FTS 应命中 M4");
    assert.ok(hitIds.includes("M5"), "FTS 应命中 M5");
    assert.ok(
      !hitIds.includes("M1"),
      "短语「排期表」不应命中仅含「排期」的 M1",
    );
    // 2 字降级 LIKE 子串路径（"开会" 仅 M1）
    const search2 = payloadOf(
      (await client.callTool({
        name: "search",
        arguments: { id: GROUP, query: "开会" },
      })) as never,
    );
    assert.equal((search2.messages as unknown[]).length, 1);
    await client.close();
  } finally {
    await fx.close();
  }
});

test("M6-14 MCP 并发闸（真实路径）：占满上限后第二请求立即报服务繁忙，不排队", async () => {
  const fx = await setupServer({
    sendEnabled: true,
    maxConcurrent: 1,
    hangSend: true,
  });
  let client: Client | null = null;
  try {
    client = await connectClient(fx.baseUrl, fx.agentToken);
    // 请求 A：进闸（active=1）并卡在挂起的 sendRaw——账本出现 reserved 行即视为已进闸
    const slowP = client.callTool({
      name: "send",
      arguments: { id: GROUP, text: "慢请求" },
    }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    let reserved = 0;
    for (let i = 0; i < 500 && reserved === 0; i++) {
      reserved = (
        fx.db.prepare("SELECT COUNT(*) AS n FROM sends").get() as { n: number }
      ).n;
      if (reserved === 0) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      reserved,
      1,
      "慢请求应已进入挂起的 sendRaw（账本已记 reserved 行）",
    );

    // 请求 B：闸满 → 立即得到「服务繁忙」（此刻 A 仍挂起，B 未排队等待）
    const busy = (await client.callTool({
      name: "list_all",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(busy.isError, true);
    assert.ok(
      busy.content[0]!.text.includes("服务繁忙"),
      `应报服务繁忙：${busy.content[0]!.text}`,
    );

    // 释放 A：正常完成且并发槽归还——后续请求不再繁忙（无占位泄漏）
    fx.hang.release();
    const slow = await slowP;
    assert.ok(
      slow.isError !== true,
      `挂起请求释放后应成功：${slow.content[0]?.text}`,
    );
    const after = (await client.callTool({
      name: "list_all",
      arguments: {},
    })) as { isError?: boolean };
    assert.ok(after.isError !== true, "释放后并发槽应已归还");
  } finally {
    fx.hang.release();
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});

test("M3-4 context 前后文 / browse 锚点翻页 / 名册 / quota / 错误可操作", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    client = await connectClient(fx.baseUrl, fx.agentToken);

    const ctx = payloadOf(
      (await client.callTool({
        name: "context",
        arguments: { id: GROUP, msg_id: "M3", radius: 2 },
      })) as never,
    );
    const ctxIds = (ctx.messages as Array<Record<string, unknown>>).map(
      (m) => m.msg_id,
    );
    assert.deepEqual(ctxIds, ["M1", "M2", "M3", "M4", "M5"]);

    const before = payloadOf(
      (await client.callTool({
        name: "browse",
        arguments: { id: GROUP, msg_id: "M3", mode: "before", limit: 10 },
      })) as never,
    );
    // before 方向按时间轴降序（新→旧，聊天回滚语义）
    assert.deepEqual(
      (before.messages as Array<Record<string, unknown>>).map((m) => m.msg_id),
      ["M2", "M1"],
    );

    const latest = payloadOf(
      (await client.callTool({
        name: "browse",
        arguments: { id: GROUP, limit: 2 },
      })) as never,
    );
    assert.deepEqual(
      (latest.messages as Array<Record<string, unknown>>).map((m) => m.msg_id),
      ["M4", "M5"],
    );

    const members = payloadOf(
      (await client.callTool({
        name: "list_members",
        arguments: { id: GROUP },
      })) as never,
    );
    const memberList = members.members as Array<Record<string, unknown>>;
    assert.equal(memberList.length, 3);
    assert.equal(memberList[0]!.msg_count, 3); // 小明 3 条最活跃

    const quota = payloadOf(
      (await client.callTool({ name: "quota", arguments: {} })) as never,
    );
    assert.equal(quota.send_enabled, false);
    assert.equal(quota.proactive_sent_today, 0);

    // 不存在的锚点 → 可操作错误（isError=true 且不炸）
    const miss = (await client.callTool({
      name: "context",
      arguments: { id: GROUP, msg_id: "NOPE" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(miss.isError, true);
    assert.ok(miss.content[0]!.text.includes("search"), "错误提示应引导先搜索");

    // 缺参数 → 可操作错误
    const missing = (await client.callTool({
      name: "get_new",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(missing.isError, true);
    assert.ok(missing.content[0]!.text.includes("id"), "缺参提示应点名参数");

    // 旧参数名 group → 可操作的更名提示（存量调用模式可立即自愈）
    const renamed = (await client.callTool({
      name: "get_new",
      arguments: { group: GROUP },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(renamed.isError, true);
    assert.ok(
      renamed.content[0]!.text.includes("已更名 id"),
      "旧名 group 应报更名提示",
    );
  } finally {
    // 关闭顺序：先客户端（SSE/keep-alive 归还），再服务端；断言失败也不能跳过
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});

test("M3-5 引用结构化（quote_json 直读）+ 信封统一：quote_msg 呈现；条目/信封均无会话回显", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    // 被引消息带 msg_idx；引用方以结构化 quote 落库（ingest 时缓存命中即补被引身份）
    const repo = new Repo(fx.db);
    const base = {
      botId: "10001",
      scope: "group" as const,
      scopeId: GROUP,
      mentions: [],
      attachments: [],
      records: [],
      raw: {},
    };
    repo.saveMessage({
      ...base,
      msgId: "Q1",
      authorOpenid: "U_A",
      authorName: "被引者",
      authorRole: "member",
      ts: Date.now() - 60_000,
      text: "被引的原文内容",
      content: "被引的原文内容",
      quote: null,
      msgIdx: "REFIDX_Q1",
    });
    repo.saveMessage({
      ...base,
      msgId: "Q2",
      authorOpenid: "U_B",
      authorName: "引用者",
      authorRole: "member",
      ts: Date.now() - 30_000,
      text: "看看这条",
      content: "看看这条",
      quote: { msgIdx: "REFIDX_Q1", body: "被引的原文内容" },
      msgIdx: "REFIDX_Q2",
    });
    // 被引不在缓存：body（官方 103 快照）仍在，身份留空由读取端懒补（此处永不命中）
    repo.saveMessage({
      ...base,
      msgId: "Q3",
      authorOpenid: "U_B",
      authorName: "引用者",
      authorRole: "member",
      ts: Date.now(),
      text: "引用了一条没缓存的消息",
      content: "引用了一条没缓存的消息",
      quote: { msgIdx: "REFIDX_MISSING", body: "一条看不到原文的引用" },
    });
    repo.saveMessage({
      ...base,
      msgId: "Q4",
      authorOpenid: "U_B",
      authorName: "引用者",
      authorRole: "member",
      ts: Date.now() + 30_000,
      text: "看看这条",
      content: "看看这条",
      quote: { msgIdx: "REFIDX_Q1", body: "被引的原文内容" },
    });
    // 长被引正文：quote_msg.content 只取首行并截断到 50 字符加省略号
    repo.saveMessage({
      ...base,
      msgId: "Q5",
      authorOpenid: "U_C",
      authorName: "长文者",
      authorRole: "member",
      ts: Date.now() + 45_000,
      text: `${"长".repeat(60)}`,
      content: `${"长".repeat(60)}`,
      quote: null,
      msgIdx: "REFIDX_Q5",
    });
    repo.saveMessage({
      ...base,
      msgId: "Q6",
      authorOpenid: "U_B",
      authorName: "引用者",
      authorRole: "member",
      ts: Date.now() + 50_000,
      text: "引用了一条很长的消息",
      content: "引用了一条很长的消息",
      quote: { msgIdx: "REFIDX_Q5", body: `${"长".repeat(60)}` },
    });

    client = await connectClient(fx.baseUrl, fx.agentToken);
    const res = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: GROUP },
      })) as never,
    );
    assert.ok(!("group" in res), "信封无会话回显字段");
    assert.equal(typeof res.has_more, "boolean");
    const msgs = res.messages as Array<Record<string, unknown>>;
    const q2 = msgs.find((m) => m.msg_id === "Q2")!;
    assert.ok(!("group_openid" in q2), "消息条目无会话回显字段");
    assert.equal(String(q2.content), "看看这条", "正文干净");
    const q2quote = q2.quote_msg as Record<string, unknown>;
    assert.equal(
      q2quote.id,
      "U_A",
      "quote_msg.id=被引作者 openid（ingest enrich）",
    );
    assert.equal(q2quote.msg_id, "Q1", "quote_msg.msg_id=被引消息");
    assert.equal(
      q2quote.content,
      "被引的原文内容",
      "被引正文（首行，≤50 字不截断）",
    );
    const q3 = msgs.find((m) => m.msg_id === "Q3")!;
    assert.equal(String(q3.content), "引用了一条没缓存的消息");
    const q3quote = q3.quote_msg as Record<string, unknown>;
    assert.equal(q3quote.id, null, "被引不在缓存：身份 null");
    assert.equal(q3quote.msg_id, null);
    assert.equal(
      q3quote.content,
      "一条看不到原文的引用",
      "body 来自官方 103 快照，不依赖缓存",
    );
    const q4 = msgs.find((m) => m.msg_id === "Q4")!;
    assert.equal(String(q4.content), "看看这条");
    assert.equal(
      (q4.quote_msg as Record<string, unknown>).msg_id,
      "Q1",
      "命中产 quote_msg",
    );
    const q6 = msgs.find((m) => m.msg_id === "Q6")!;
    const q6quote = q6.quote_msg as Record<string, unknown>;
    assert.equal(q6quote.id, "U_C");
    assert.equal(q6quote.msg_id, "Q5");
    assert.equal(
      q6quote.content,
      `${"长".repeat(50)}…`,
      "首行截断：50 字符 + 省略号",
    );
    assert.ok(
      !String(q6.content).includes("长".repeat(50)),
      "被引正文不进 content",
    );
    const q1 = msgs.find((m) => m.msg_id === "Q1")!;
    assert.ok(!("quote_msg" in q1), "无引用的消息没有 quote_msg 字段");
    assert.ok(!("records_count" in q1), "无记录的消息没有 records_count 字段");
    for (const m of msgs) {
      assert.ok(
        !String(m.content).includes("[引用 @") &&
          !String(m.content).includes("\n> "),
        "MCP 面正文无内联引用文字",
      );
    }
  } finally {
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});

test("M3-5b get_records：聊天记录拍平展开（users 昵称/嵌套 depth/子行引用）；非记录可操作报错", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    const repo = new Repo(fx.db);
    const base = {
      botId: "10001",
      scope: "group" as const,
      scopeId: GROUP,
      mentions: [],
      attachments: [],
      raw: {},
    };
    // 身份锚：USER_B 在 users 表（子行作者名以此为准）
    repo.saveMessage({
      ...base,
      msgId: "R0",
      authorOpenid: "USER_B",
      authorName: "记录者B",
      ts: Date.now() - 120_000,
      text: "发言",
      content: "发言",
      quote: null,
      records: [],
      msgIdx: "REF_R0",
    });
    repo.saveMessage({
      ...base,
      msgId: "R1",
      authorOpenid: "USER_A",
      authorName: "转发者",
      ts: Date.now() - 60_000,
      text: "看这个",
      content: "看这个\n[聊天记录·2条]",
      quote: null,
      records: [
        {
          ord: 0,
          depth: 0,
          authorOpenid: "USER_B",
          authorName: "记录者B旧名",
          ts: Date.now() - 300_000,
          text: "记录里的发言",
          quote: { msgIdx: "REF_R0", body: "发言" },
          attachments: [
            { kind: "image" as const, url: "https://cdn.example/r.png" },
          ],
        },
        { ord: 1, depth: 1, text: "嵌套层", quote: null, attachments: [] },
      ],
    });

    client = await connectClient(fx.baseUrl, fx.agentToken);
    const ok = payloadOf(
      (await client.callTool({
        name: "get_records",
        arguments: { id: GROUP, msg_id: "R1" },
      })) as never,
    );
    assert.equal(ok.count, 2);
    const recs = ok.records as Array<Record<string, unknown>>;
    const r0 = recs[0]!;
    assert.equal(r0.ord, 0);
    assert.equal(r0.depth, 0);
    const r0author = r0.author as { id: string; name: string };
    assert.equal(r0author.id, "USER_B");
    assert.equal(
      r0author.name,
      "记录者B",
      "子行作者名以 users 最新昵称为准（非行快照）",
    );
    assert.equal(r0.text, "记录里的发言");
    const r0quote = r0.quote_msg as Record<string, unknown>;
    assert.equal(r0quote.msg_id, "R0", "子行引用锚解析为宿主 msg_id");
    assert.ok(Array.isArray(r0.attachments) && r0.attachments.length === 1);
    const r1 = recs[1]!;
    assert.equal(r1.depth, 1, "嵌套记录子层 depth+1");

    // 非聊天记录消息 → 可操作报错
    const nope = (await client.callTool({
      name: "get_records",
      arguments: { id: GROUP, msg_id: "R0" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(nope.isError, true);
    assert.ok(nope.content[0]!.text.includes("records_count=0"));
  } finally {
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});

test("M3-6 get_media：图像块返回（多模态）；非图片/越界/缺消息可操作报错", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  const realFetch = globalThis.fetch;
  try {
    new Repo(fx.db).saveMessage({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: "MD1",
      authorOpenid: "U_A",
      authorName: "画师",
      authorRole: "member",
      ts: Date.now(),
      text: "看图",
      content: "![附件1]\n看图",
      quote: null,
      records: [],
      mentions: [],
      attachments: [
        {
          kind: "image",
          url: "https://cdn.example/a.png",
          filename: "a.png",
          content_type: "image/png",
          width: 10,
          height: 10,
        },
        {
          kind: "file",
          url: "https://cdn.example/b.bin",
          filename: "b.bin",
          content_type: "file",
        },
      ],
      raw: {},
    });
    // 拦截网络（测试零真实网络依赖）：仅劫持假 CDN 域名，其余（MCP 传输自身）走真实 fetch
    type FetchInput = Parameters<typeof realFetch>[0];
    globalThis.fetch = (async (
      input: FetchInput,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("https://cdn.example/")) {
        return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    client = await connectClient(fx.baseUrl, fx.agentToken);
    const ok = (await client.callTool({
      name: "get_media",
      arguments: { id: GROUP, msg_id: "MD1", n: 1 },
    })) as { isError?: boolean; content: Array<Record<string, unknown>> };
    assert.equal(ok.isError, undefined);
    assert.equal(ok.content[0]!.type, "image", "首块为 MCP 图像块");
    assert.equal(ok.content[0]!.mimeType, "image/png");
    assert.ok(
      typeof ok.content[0]!.data === "string" &&
        (ok.content[0]!.data as string).length > 0,
      "base64 数据非空",
    );
    assert.equal(ok.content[1]!.type, "text", "次块为元数据文本");
    assert.ok(String(ok.content[1]!.text).includes("a.png"));

    const notImg = (await client.callTool({
      name: "get_media",
      arguments: { id: GROUP, msg_id: "MD1", n: 2 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(notImg.isError, true);
    assert.ok(notImg.content[0]!.text.includes("不是图片"));

    const oob = (await client.callTool({
      name: "get_media",
      arguments: { id: GROUP, msg_id: "MD1", n: 3 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(oob.isError, true);
    assert.ok(oob.content[0]!.text.includes("越界"));

    const miss = (await client.callTool({
      name: "get_media",
      arguments: { id: GROUP, msg_id: "NOPE", n: 1 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(miss.isError, true);
    assert.ok(miss.content[0]!.text.includes("search"));
  } finally {
    globalThis.fetch = realFetch;
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});

test("M3-7 自己发的消息（direction=1 补记）author.role=yourself，防模型接自己的话", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    const repo = new Repo(fx.db);
    // bot 自发消息补记形态（官方不回推，发送成功后本地写入）：author 只有备注名
    repo.saveOutgoing({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: "M_SELF",
      content: "我刚才说的话",
      ts: Date.now(),
      authorName: "主bot",
    });
    repo.saveMessage({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: "M_HUMAN",
      authorOpenid: "U_A",
      authorName: "小明",
      authorRole: "member",
      ts: Date.now() + 1,
      text: "群友说的话",
      content: "群友说的话",
      quote: null,
      records: [],
      mentions: [],
      attachments: [],
      raw: {},
    });
    client = await connectClient(fx.baseUrl, fx.agentToken);
    const res = payloadOf(
      (await client.callTool({
        name: "context",
        arguments: { id: GROUP, msg_id: "M_SELF", radius: 1 },
      })) as never,
    );
    const msgs = res.messages as Array<{
      msg_id: string;
      author: { role: string | null };
    }>;
    const self = msgs.find((m) => m.msg_id === "M_SELF")!;
    const human = msgs.find((m) => m.msg_id === "M_HUMAN")!;
    assert.equal(self.author.role, "yourself", "自己的消息标 yourself");
    assert.equal(human.author.role, "member", "群友消息不受影响");
  } finally {
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});

test("M3-8 单聊读取面：get_new 水位/search/browse/context 走 c2c 缓存；侧别由 id 自动探测", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    const repo = new Repo(fx.db);
    const USER = "C2C_OPENID_U1";
    const c2cBase = {
      botId: "10001",
      scope: "chat" as const,
      scopeId: USER,
      mentions: [],
      attachments: [],
      raw: {},
    };
    // 被引消息 + 引用消息（引用回溯走合一 messages 表，scope=chat 与群侧隔离）
    repo.saveMessage({
      ...c2cBase,
      msgId: "C1",
      authorOpenid: USER,
      authorName: undefined,
      authorRole: undefined,
      ts: Date.now() - 60_000,
      text: "被引的单聊原文",
      content: "被引的单聊原文",
      quote: null,
      records: [],
      msgIdx: "REFIDX_C1",
    });
    repo.saveMessage({
      ...c2cBase,
      msgId: "C2",
      authorOpenid: USER,
      authorName: undefined,
      authorRole: undefined,
      ts: Date.now(),
      text: "单聊里引用一下",
      content: "单聊里引用一下",
      quote: { msgIdx: "REFIDX_C1", body: "被引的单聊原文" },
      records: [],
    });

    client = await connectClient(fx.baseUrl, fx.agentToken);

    // list_new 红点含私聊会话（unread=2）
    const fresh = payloadOf(
      (await client.callTool({ name: "list_new", arguments: {} })) as never,
    );
    const chat = (fresh.conversations as Array<Record<string, unknown>>).find(
      (c) => c.type === "chat",
    )!;
    assert.equal(chat.id, USER);
    assert.equal(chat.unread, 2);

    // get_new：拉取即已读，重复调用不重拉；引用结构化 quote_msg（侧别由 id 探测）
    const first = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: USER },
      })) as never,
    );
    assert.equal(first.count, 2);
    const again = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: USER },
      })) as never,
    );
    assert.equal(again.count, 0, "水位已推进，重拉为空");
    const c2 = (first.messages as Array<Record<string, unknown>>).find(
      (m) => m.msg_id === "C2",
    )!;
    assert.equal(String(c2.content), "单聊里引用一下", "单聊引用同样摘除内联");
    const c2quote = c2.quote_msg as Record<string, unknown>;
    assert.equal(c2quote.msg_id, "C1");
    assert.equal(c2quote.content, "被引的单聊原文");

    // 已读后红点消失
    const after = payloadOf(
      (await client.callTool({
        name: "list_all",
        arguments: { type: "chat" },
      })) as never,
    );
    assert.equal(
      (after.conversations as Array<Record<string, unknown>>).find(
        (c) => c.id === USER,
      )!.unread,
      0,
    );

    // search：≥3 字 FTS 命中；<3 字降级 LIKE 兜底
    const fts = payloadOf(
      (await client.callTool({
        name: "search",
        arguments: { id: USER, query: "单聊原文" },
      })) as never,
    );
    assert.equal(fts.count, 1, "FTS 只命中 C1");
    const like = payloadOf(
      (await client.callTool({
        name: "search",
        arguments: { id: USER, query: "引用" },
      })) as never,
    );
    assert.equal(like.count, 1, "LIKE 兜底命中 C2 令牌行");

    // browse：单聊锚点 around
    const around = payloadOf(
      (await client.callTool({
        name: "browse",
        arguments: { id: USER, msg_id: "C1", mode: "around" },
      })) as never,
    );
    assert.equal(around.count, 2, "前后文含 C1/C2 两条");

    // 群聊侧不受影响（探测：GROUP 命中群缓存）
    const g = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: GROUP },
      })) as never,
    );
    assert.equal(g.count, 5, "群聊种子消息照常拉取");

    // 探测语义：侧别由 id 决定——单聊 id 查群消息（及反向）均报"不存在，可先 search"
    const wrongSide = (await client.callTool({
      name: "context",
      arguments: { id: USER, msg_id: "M1" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(wrongSide.isError, true);
    assert.ok(
      wrongSide.content[0]!.text.includes("search"),
      "跨会话锚点报可定位错误",
    );
    const wrongSide2 = (await client.callTool({
      name: "context",
      arguments: { id: GROUP, msg_id: "C1" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(wrongSide2.isError, true);
    assert.ok(wrongSide2.content[0]!.text.includes("search"), "反向同理");

    // 真不存在的消息 → 仍走"可先 search"路径
    const miss = (await client.callTool({
      name: "context",
      arguments: { id: USER, msg_id: "NOPE" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(miss.isError, true);
    assert.ok(miss.content[0]!.text.includes("search"));

    // 探测失败 → 可操作错误（未知 id：两侧无缓存且不在白名单）
    const unknown = (await client.callTool({
      name: "get_new",
      arguments: { id: "NO_SUCH_SESSION" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(unknown.isError, true);
    assert.ok(
      unknown.content[0]!.text.includes("无法定位会话"),
      "探测失败应给可操作提示",
    );

    // list_members 传单聊 id → 可操作报错（名册仅群聊语义，不静默返回空册）
    const roster = (await client.callTool({
      name: "list_members",
      arguments: { id: USER },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(roster.isError, true);
    assert.ok(
      roster.content[0]!.text.includes("单聊会话"),
      "list_members 单聊 id 应报可操作错误",
    );

    // 探测补充证据：C2C 开关事件可先行于首条缓存消息（用户已 opt-in 但尚无消息）
    //——kv 记录独立裁决 chat 侧，主动消息门禁亦依赖该记录
    repo.setC2cSwitch("10001", "C2C_OPENID_U2", true);
    const optinOnly = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { id: "C2C_OPENID_U2" },
      })) as never,
    );
    assert.equal(
      optinOnly.count,
      0,
      "无缓存但开关记录裁决 chat：不报错、返回空页",
    );
  } finally {
    try {
      await client?.close();
    } catch {
      /* 已关闭则忽略 */
    }
    await fx.close();
  }
});
