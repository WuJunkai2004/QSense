// M3 验收：MCP 客户端 SDK 直连 /mcp——
// 鉴权（401）、listTools、列群→取新消息→搜历史闭环、游标读写、context/browse、不可信内容提示首行。

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
import { UNTRUSTED_NOTICE } from "../src/tools/defs";

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

async function connectClient(baseUrl: string, agentToken = TOKEN): Promise<Client> {
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
  const text = result.content[0]!.text ?? "";
  assert.ok(
    text.startsWith(UNTRUSTED_NOTICE),
    "返回体首行必须是不可信内容提示",
  );
  return JSON.parse(text.slice(UNTRUSTED_NOTICE.length)) as Record<
    string,
    unknown
  >;
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

test("M3-2 listTools 含 15 个工具；未开启发送时写工具硬拒绝", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    client = await connectClient(fx.baseUrl, fx.agentToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "qq_browse",
      "qq_context",
      "qq_cursor_get",
      "qq_cursor_set",
      "qq_forget",
      "qq_get_new",
      "qq_list_groups",
      "qq_list_members",
      "qq_quota",
      "qq_recall",
      "qq_register_bot",
      "qq_reply",
      "qq_search",
      "qq_send_proactive",
      "qq_token_refresh",
    ]);
    // 双重门禁未开（SEND_ENABLE 缺省 false）→ 写工具硬拒绝且不炸
    const denied = (await client.callTool({
      name: "qq_send_proactive",
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

test("M3-3 闭环：列群 → 取新消息 → 关键词搜索；游标断点续拉", async () => {
  const fx = await setupServer();
  try {
    const client = await connectClient(fx.baseUrl, fx.agentToken);

    // 列群
    const groups = payloadOf(
      (await client.callTool({
        name: "qq_list_groups",
        arguments: {},
      })) as never,
    );
    assert.ok(!("count" in groups), "qq_list_groups 返回体不应有 count 字段");
    const groupList = groups.groups as Array<Record<string, unknown>>;
    assert.equal(groupList.length, 2);
    const g1 = groupList.find((g) => g.group_openid === GROUP)!;
    assert.equal(g1.full_msg_enabled, true);
    assert.equal(g1.member_count, 3);

    // 取新消息（从头）
    const first = payloadOf(
      (await client.callTool({
        name: "qq_get_new",
        arguments: { group: GROUP },
      })) as never,
    );
    assert.equal(first.count, 5);
    const nextCursor = first.next_cursor as string;
    assert.ok(/^\d+$/.test(nextCursor));

    // 增量：提交游标后无新消息
    await client.callTool({
      name: "qq_cursor_set",
      arguments: { group: GROUP, cursor: nextCursor },
    });
    const cursorState = payloadOf(
      (await client.callTool({
        name: "qq_cursor_get",
        arguments: { group: GROUP },
      })) as never,
    );
    assert.equal(cursorState.cursor, nextCursor);
    const second = payloadOf(
      (await client.callTool({
        name: "qq_get_new",
        arguments: { group: GROUP, cursor: nextCursor },
      })) as never,
    );
    assert.equal(second.count, 0);

    // 搜索（≥3 字走 FTS trigram 路径，见 repo.searchMessages：[...q].length >= 3）
    // "排期表" 命中 M4/M5；M1 仅含「排期」二字，短语不应命中——同时验证 FTS JOIN 真实执行
    const search = payloadOf(
      (await client.callTool({
        name: "qq_search",
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
        name: "qq_search",
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
      name: "qq_send_proactive",
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
      name: "qq_list_groups",
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
      name: "qq_list_groups",
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
        name: "qq_context",
        arguments: { group: GROUP, msg_id: "M3", radius: 2 },
      })) as never,
    );
    const ctxIds = (ctx.messages as Array<Record<string, unknown>>).map(
      (m) => m.msg_id,
    );
    assert.deepEqual(ctxIds, ["M1", "M2", "M3", "M4", "M5"]);

    const before = payloadOf(
      (await client.callTool({
        name: "qq_browse",
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
        name: "qq_browse",
        arguments: { group: GROUP, limit: 2 },
      })) as never,
    );
    assert.deepEqual(
      (latest.messages as Array<Record<string, unknown>>).map((m) => m.msg_id),
      ["M4", "M5"],
    );

    const members = payloadOf(
      (await client.callTool({
        name: "qq_list_members",
        arguments: { group: GROUP },
      })) as never,
    );
    const memberList = members.members as Array<Record<string, unknown>>;
    assert.equal(memberList.length, 3);
    assert.equal(memberList[0]!.msg_count, 3); // 小明 3 条最活跃

    const quota = payloadOf(
      (await client.callTool({ name: "qq_quota", arguments: {} })) as never,
    );
    assert.equal(quota.send_enabled, false);
    assert.equal(quota.proactive_sent_today, 0);

    // 不存在的锚点 → 可操作错误（isError=true 且不炸）
    const miss = (await client.callTool({
      name: "qq_context",
      arguments: { group: GROUP, msg_id: "NOPE" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(miss.isError, true);
    assert.ok(
      miss.content[0]!.text.includes("qq_search"),
      "错误提示应引导先搜索",
    );

    // 缺参数 → 可操作错误
    const missing = (await client.callTool({
      name: "qq_get_new",
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
