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
    repo.saveGroupMessage({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: s.msgId,
      authorOpenid: s.author,
      authorName: s.name,
      authorRole: s.role,
      ts: Date.now() - s.ageH * 3600 * 1000,
      content: s.content,
      mentions: [],
      elements: undefined,
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
      arguments: { group: GROUP, text: "test" },
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
        arguments: { group: GROUP },
      })) as never,
    );
    assert.equal(first.count, 5);
    assert.ok(!("next_cursor" in first), "已读水位是服务端内部状态，不外露");

    // 重复拉取：零重复（水位已推进）
    const second = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { group: GROUP },
      })) as never,
    );
    assert.equal(second.count, 0);

    // 已读后 list_new 不再命中该群
    const news2 = payloadOf(
      (await client.callTool({ name: "list_new", arguments: {} })) as never,
    );
    assert.equal(news2.count, 0);

    // 新消息到达 → 再次未读；增量拉取只给新消息
    new Repo(fx.db).saveOutgoingGroupMessage({
      botId: "10001",
      groupOpenid: GROUP,
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
        arguments: { group: GROUP },
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
        arguments: { group: GROUP, query: "排期表" },
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
        arguments: { group: GROUP, query: "开会" },
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
      arguments: { group: GROUP, text: "慢请求" },
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
        arguments: { group: GROUP, msg_id: "M3", radius: 2 },
      })) as never,
    );
    const ctxIds = (ctx.messages as Array<Record<string, unknown>>).map(
      (m) => m.msg_id,
    );
    assert.deepEqual(ctxIds, ["M1", "M2", "M3", "M4", "M5"]);

    const before = payloadOf(
      (await client.callTool({
        name: "browse",
        arguments: { group: GROUP, msg_id: "M3", mode: "before", limit: 10 },
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
        arguments: { group: GROUP, limit: 2 },
      })) as never,
    );
    assert.deepEqual(
      (latest.messages as Array<Record<string, unknown>>).map((m) => m.msg_id),
      ["M4", "M5"],
    );

    const members = payloadOf(
      (await client.callTool({
        name: "list_members",
        arguments: { group: GROUP },
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
      arguments: { group: GROUP, msg_id: "NOPE" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(miss.isError, true);
    assert.ok(miss.content[0]!.text.includes("search"), "错误提示应引导先搜索");

    // 缺参数 → 可操作错误
    const missing = (await client.callTool({
      name: "get_new",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(missing.isError, true);
    assert.ok(missing.content[0]!.text.includes("group"), "缺参提示应点名参数");
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

test("M3-5 引用回溯 + 信封统一：get_new 内联被引原文；条目/信封均无会话回显", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    // 被引消息带 msg_idx（ingest 从 message_scene.ext 提取）；引用方 content 携带令牌行
    const repo = new Repo(fx.db);
    const base = {
      botId: "10001",
      scope: "group" as const,
      scopeId: GROUP,
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    };
    repo.saveGroupMessage({
      ...base,
      msgId: "Q1",
      authorOpenid: "U_A",
      authorName: "被引者",
      authorRole: "member",
      ts: Date.now() - 60_000,
      content: "被引的原文内容",
      msgIdx: "REFIDX_Q1",
    });
    repo.saveGroupMessage({
      ...base,
      msgId: "Q2",
      authorOpenid: "U_B",
      authorName: "引用者",
      authorRole: "member",
      ts: Date.now() - 30_000,
      content: "[引用 msg_idx=REFIDX_Q1]\n看看这条",
      msgIdx: "REFIDX_Q2",
    });
    repo.saveGroupMessage({
      ...base,
      msgId: "Q3",
      authorOpenid: "U_B",
      authorName: "引用者",
      authorRole: "member",
      ts: Date.now(),
      content: "[引用 msg_idx=REFIDX_MISSING]\n引用了一条没缓存的消息",
    });
    // 真实 ingest 顺序：正文 → 引用结构行 → 103 元素展开的被引原文行（命中时应被吞掉，不重复）
    repo.saveGroupMessage({
      ...base,
      msgId: "Q4",
      authorOpenid: "U_B",
      authorName: "引用者",
      authorRole: "member",
      ts: Date.now() + 30_000,
      content: "看看这条\n[引用 msg_idx=REFIDX_Q1]\n被引的原文内容",
    });

    client = await connectClient(fx.baseUrl, fx.agentToken);
    const res = payloadOf(
      (await client.callTool({
        name: "get_new",
        arguments: { group: GROUP },
      })) as never,
    );
    assert.ok(!("group" in res), "信封无会话回显字段");
    assert.equal(typeof res.has_more, "boolean");
    const msgs = res.messages as Array<Record<string, unknown>>;
    const q2 = msgs.find((m) => m.msg_id === "Q2")!;
    assert.ok(!("group_openid" in q2), "消息条目无会话回显字段");
    const hit = String(q2.content);
    assert.ok(hit.includes("[引用 @被引者]"), "命中缓存内联被引作者");
    assert.ok(hit.includes("> 被引的原文内容"), "被引正文以 > 前缀内联");
    assert.ok(!hit.includes("REFIDX_Q1"), "令牌不外露");
    const q3 = msgs.find((m) => m.msg_id === "Q3")!;
    assert.ok(
      String(q3.content).includes("REFIDX_MISSING"),
      "未命中缓存保留原令牌行",
    );
    const q4 = msgs.find((m) => m.msg_id === "Q4")!;
    const q4content = String(q4.content);
    assert.ok(q4content.includes("> 被引的原文内容"), "命中内联原文");
    assert.equal(
      q4content.split("被引的原文内容").length - 1,
      1,
      "ingest 展开行被吞掉，正文只出现一次",
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

test("M3-6 get_media：图像块返回（多模态）；非图片/越界/缺消息可操作报错", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  const realFetch = globalThis.fetch;
  try {
    new Repo(fx.db).saveGroupMessage({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: "MD1",
      authorOpenid: "U_A",
      authorName: "画师",
      authorRole: "member",
      ts: Date.now(),
      content: "![附件1]\n看图",
      mentions: [],
      elements: undefined,
      attachments: [
        {
          url: "https://cdn.example/a.png",
          filename: "a.png",
          content_type: "image/png",
          width: 10,
          height: 10,
        },
        { url: "https://cdn.example/b.bin", filename: "b.bin", content_type: "file" },
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
      arguments: { group: GROUP, msg_id: "MD1", n: 1 },
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
      arguments: { group: GROUP, msg_id: "MD1", n: 2 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(notImg.isError, true);
    assert.ok(notImg.content[0]!.text.includes("不是图片"));

    const oob = (await client.callTool({
      name: "get_media",
      arguments: { group: GROUP, msg_id: "MD1", n: 3 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(oob.isError, true);
    assert.ok(oob.content[0]!.text.includes("越界"));

    const miss = (await client.callTool({
      name: "get_media",
      arguments: { group: GROUP, msg_id: "NOPE", n: 1 },
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
    repo.saveOutgoingGroupMessage({
      botId: "10001",
      groupOpenid: GROUP,
      msgId: "M_SELF",
      content: "我刚才说的话",
      ts: Date.now(),
      authorName: "主bot",
    });
    repo.saveGroupMessage({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: "M_HUMAN",
      authorOpenid: "U_A",
      authorName: "小明",
      authorRole: "member",
      ts: Date.now() + 1,
      content: "群友说的话",
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    });
    client = await connectClient(fx.baseUrl, fx.agentToken);
    const res = payloadOf(
      (await client.callTool({
        name: "context",
        arguments: { group: GROUP, msg_id: "M_SELF", radius: 1 },
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
