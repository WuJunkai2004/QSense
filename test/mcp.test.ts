// MCP 验收：客户端 SDK 直连 /mcp——
// 鉴权（401）、listTools、会话列表→取新消息（拉取即已读，水位自动推进）→搜历史闭环、
// browse 锚点与前后文。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectorRegistry, type NormalizedAttachment } from "@qsense/connector-sdk";
import { createQqConnector } from "@qsense/connector-qq";
import { createTelegramConnector } from "@qsense/connector-telegram";
import { buildServer } from "../src/server/http";
import { createLogger } from "../src/utils/logger";
import { Sender } from "../src/sender";
import { ConnectorSupervisor } from "../src/connectors/runtime";
import { createBotHost, configSnapshotOf } from "../src/connectors/host";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { BotRegistry } from "../src/bots";
import { Repo } from "../src/store/repo";

const TOKEN = "m3-test-token-0123456789abcdef";
const GROUP = "GROUP_OPENID_G1";

interface Fixture {
  baseUrl: string;
  agentToken: string;
  /** telegramBot 模式下第二个 bot 的 agent_token（跨平台工具过滤用例） */
  tgAgentToken: string | null;
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
  /** 额外注册 telegram 平台（插件 + bot）：跨平台工具过滤用例用 */
  telegramBot?: boolean;
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
      rawJson: JSON.stringify({ id: s.msgId }),
    });
  }
  repo.setGroupSwitch("10001", GROUP, true);
  repo.addGroup("10001", "GROUP_OPENID_G2");

  // admin token 现场生成即可（本文件只测 401，不需要有效值）；bot 注册入表，
  // 发送开关走库
  repo.ensureRuntime();
  if (opts.sendEnabled === true) repo.setSendEnable(true);
  const registry = new BotRegistry({ db });
  await registry.add({
    credentials: { appid: "10001", secret: "s" },
    name: "t",
    allowGroups: [GROUP],
  });
  const agentToken = registry.rotateToken("10001");

  // 跨平台过滤用例：telegram bot 入表（verify 未注入=跳过官方校验，入参即落库）
  let tgAgentToken: string | null = null;
  if (opts.telegramBot === true) {
    await registry.add({
      platform: "telegram",
      credentials: { id: "9167497677", token: "dummy-tg-token" },
      name: "柔嘉",
    });
    tgAgentToken = registry.rotateToken("9167497677");
  }

  // 可选：挂起的发送器——net.reply 阻塞到 release()，供并发闸测试占住并发槽
  let releaseHang: () => void = () => {};
  let sender: Sender | undefined;
  if (opts.hangSend === true) {
    const gate = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    sender = new Sender({
      log: createLogger("error"),
      repo,
      bots: registry,
      transportFor: () =>
        ({
          reply: async () => {
            await gate;
            return { providerMsgId: "PROVIDER_HUNG" };
          },
          proactive: async () => {
            await gate;
            return { providerMsgId: "PROVIDER_HUNG" };
          },
          recall: async () => {
            await gate;
          },
          uploadMedia: async () => {
            await gate;
            return { handle: "HANG" };
          },
        }) 
    });
  }

  // 平台扩展工具（quota）声明面：真 QQ 插件注册（工具名单断言依赖）
  const plugins = new ConnectorRegistry();
  plugins.register(createQqConnector({ log: createLogger("error") }));
  if (opts.telegramBot === true) {
    plugins.register(createTelegramConnector({ log: createLogger("error") }));
  }
  const connectors: ConnectorSupervisor = {
    plugins,
    addBot: () => undefined,
    removeBot: () => undefined,
    hostFor: (botId: string) =>
      createBotHost({
        log: createLogger("error"),
        db,
        platform: "qq",
        botId,
        ingest: () => undefined,
        onStatus: () => undefined,
      }),
    configOf: (botId: string) => configSnapshotOf(repo, registry, botId),
  };

  const app = buildServer({
    log: createLogger("debug"),
    db,
    repo,
    registry,
    version: "0.1.0",
    sender,
    maxConcurrent: opts.maxConcurrent,
    connectors,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    agentToken,
    tgAgentToken,
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

// —— 工具输出 JSON round-trip 的测试消费面（与 src/tools/defs.ts 各工具输出形状
// 对齐；可选字段并集 = 逐工具形状的闭集，测试只读。访问点不再 as Record 链） ——
interface ConvJson {
  type: "chat" | "group";
  id: string;
  unread: number;
  last_msg_ts: string | null;
}

interface QuoteJson {
  id: string | null;
  msg_id: string | null;
  content: string;
  attachments?: NormalizedAttachment[];
}

interface MsgJson {
  msg_id: string;
  ts: string | null;
  author: { id: string | null; name: string | null; role: string | null };
  content: string | null;
  quote_msg?: QuoteJson;
  records_count?: number;
  mentions?: Array<{ id: string; name?: string }>;
  attachments?: NormalizedAttachment[];
}

interface RecordItemJson {
  ord: number;
  depth: number;
  author: { id: string | null; name: string | null };
  ts: string | null;
  text: string | null;
  quote_msg?: QuoteJson;
  attachments?: NormalizedAttachment[];
}

interface MemberJson {
  member_id: string;
  name: string;
  role: string | null;
  first_seen: string;
  last_seen: string;
  msg_count: number;
}

interface PayloadJson {
  count?: number;
  has_more?: boolean;
  conversations?: ConvJson[];
  messages?: MsgJson[];
  /** get_info：群 / 群成员 / 单聊对象三种判别输出 */
  type?: "group" | "member" | "chat";
  member_count?: number;
  members_has_more?: boolean;
  full_msg_enabled?: boolean;
  members?: MemberJson[];
  member?: MemberJson;
  group_id?: string;
  user?: {
    id: string;
    name: string;
    first_seen: string;
    last_seen: string;
    msg_count: number;
  };
  records?: RecordItemJson[];
  msg_id?: string;
  id?: string;
  status?: string;
  provider_msg_id?: string;
  detail?: string;
  upload_url?: string;
  asset_id?: string;
  curl?: string;
  /** quota 工具（QQ 平台扩展）输出 */
  send_enabled?: boolean;
  proactive_sent_today?: number;
}

/** callTool + 单文本块解包：应答过 SDK CallToolResult schema（运行时锚点）后
 * 判别窄化取文本块——本文件所有被解包的调用都是文本块输出 */
async function callPayload(
  client: Client,
  name: string,
  args: CallToolRequest["params"]["arguments"],
): Promise<PayloadJson> {
  const gate = CallToolResultSchema.safeParse(
    await client.callTool({ name, arguments: args }),
  );
  assert.ok(gate.success, "callTool 应答应过 CallToolResult schema");
  assert.equal(gate.data.content.length, 1);
  const block = gate.data.content[0]!;
  if (block.type !== "text") {
    throw new Error(`payload 首块不是文本：${String(block.type)}`);
  }
  return JSON.parse(block.text);
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

test("M3-2 listTools = 基座 12 + quota；未开启发送时写工具硬拒绝", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    client = await connectClient(fx.baseUrl, fx.agentToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "browse",
      "get_info",
      "get_media",
      "get_new",
      "get_records",
      "list_all",
      "list_new",
      "quota",
      "recall",
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

test("跨平台工具过滤（P5）：telegram bot 工具面无 quota，跨平台调用报归属", async () => {
  const fx = await setupServer({ telegramBot: true });
  let client: Client | null = null;
  try {
    client = await connectClient(fx.baseUrl, fx.tgAgentToken!);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.equal(names.length, 12, "telegram bot 工具面 = 基座 12（无平台扩展）");
    assert.ok(
      !names.includes("quota"),
      "quota 是 QQ 平台扩展工具，telegram bot 不可见",
    );
    // 跨平台调用 quota → 可操作报错（指出归属平台与本 bot 平台）
    const denied = (await client.callTool({
      name: "quota",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text, /平台 qq 的扩展工具/);
    assert.match(denied.content[0]!.text, /telegram/);
    // 未知工具仍报可用名单（本平台过滤后的）
    const noSuchTool = (await client.callTool({
      name: "no_such_tool",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(noSuchTool.isError, true);
    assert.match(noSuchTool.content[0]!.text, /未知工具/);
  } finally {
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
    const listed = await callPayload(client, "list_all", {});
    assert.equal(listed.count, 2);
    const convs = listed.conversations!;
    const g1 = convs.find((c) => c.id === GROUP)!;
    assert.equal(g1.type, "group");
    assert.equal(g1.unread, 5);
    assert.ok(typeof g1.last_msg_ts === "string");
    assert.ok(!("full_msg_enabled" in g1), "agent 视角不含管理面字段");

    // list_new：有未读 → 命中
    const news = await callPayload(client, "list_new", {});
    assert.equal(news.count, 1);

    // 取新消息（拉取即已读，水位自动推进）
    const first = await callPayload(client, "get_new", { id: GROUP });
    assert.equal(first.count, 5);
    assert.ok(!("next_cursor" in first), "已读水位是服务端内部状态，不外露");

    // 重复拉取：零重复（水位已推进）
    const second = await callPayload(client, "get_new", { id: GROUP });
    assert.equal(second.count, 0);

    // 已读后 list_new 不再命中该群
    const news2 = await callPayload(client, "list_new", {});
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
    const news3 = await callPayload(client, "list_new", {});
    assert.equal(news3.count, 1);
    const inc = await callPayload(client, "get_new", { id: GROUP });
    assert.deepEqual(
      (inc.messages!).map((m) => m.msg_id),
      ["M6"],
    );

    // 搜索（≥3 字走 FTS trigram 路径，见 repo.searchMessages：[...q].length >= 3）
    // "排期表" 命中 M4/M5；M1 仅含「排期」二字，短语不应命中——同时验证 FTS JOIN 真实执行
    const search = await callPayload(client, "search", { id: GROUP, query: "排期表" });
    const hitIds = (search.messages!).map((m) => m.msg_id);
    assert.ok(hitIds.includes("M4"), "FTS 应命中 M4");
    assert.ok(hitIds.includes("M5"), "FTS 应命中 M5");
    assert.ok(
      !hitIds.includes("M1"),
      "短语「排期表」不应命中仅含「排期」的 M1",
    );
    // 2 字降级 LIKE 子串路径（"开会" 仅 M1）
    const search2 = await callPayload(client, "search", { id: GROUP, query: "开会" });
    assert.equal((search2.messages!).length, 1);
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

test("M3-4 browse 锚点/前后文 / get_info 群名册 / quota / 错误可操作", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    client = await connectClient(fx.baseUrl, fx.agentToken);

    const ctx = await callPayload(client, "browse", {
      id: GROUP,
      msg_id: "M3",
      mode: "around",
      limit: 5,
    });
    const ctxIds = (ctx.messages!).map((m) => m.msg_id);
    assert.deepEqual(ctxIds, ["M1", "M2", "M3", "M4", "M5"]);
    assert.equal(ctx.count, 5, "around 的 limit 是包含锚点在内的总条数");
    assert.equal(ctx.has_more, false, "两侧均已取尽");

    const one = await callPayload(client, "browse", {
      id: GROUP,
      msg_id: "M3",
      mode: "around",
      limit: 1,
    });
    assert.deepEqual(one.messages!.map((m) => m.msg_id), ["M3"]);
    assert.equal(one.has_more, true, "锚点两侧仍有消息");

    const two = await callPayload(client, "browse", {
      id: GROUP,
      msg_id: "M3",
      mode: "around",
      limit: 2,
    });
    assert.deepEqual(
      two.messages!.map((m) => m.msg_id),
      ["M2", "M3"],
      "偶数上限优先补更早一侧",
    );

    const before = await callPayload(client, "browse", { id: GROUP, msg_id: "M3", mode: "before", limit: 10 });
    // before 方向按时间轴降序（新→旧，聊天回滚语义）
    assert.deepEqual(
      (before.messages!).map((m) => m.msg_id),
      ["M2", "M1"],
    );

    const latest = await callPayload(client, "browse", { id: GROUP, limit: 2 });
    assert.deepEqual(
      (latest.messages!).map((m) => m.msg_id),
      ["M4", "M5"],
    );

    const groupInfo = await callPayload(client, "get_info", { id: GROUP });
    assert.equal(groupInfo.type, "group");
    assert.equal(groupInfo.member_count, 3);
    const memberList = groupInfo.members!;
    assert.equal(memberList.length, 3);
    assert.equal(memberList[0]!.msg_count, 3); // 小明 3 条最活跃

    const memberInfo = await callPayload(client, "get_info", {
      id: GROUP,
      member_id: memberList[0]!.member_id,
    });
    assert.equal(memberInfo.type, "member");
    assert.equal(memberInfo.member!.member_id, memberList[0]!.member_id);

    const noMember = (await client.callTool({
      name: "get_info",
      arguments: { id: GROUP, member_id: "NO_SUCH_MEMBER" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(noMember.isError, true);
    assert.ok(noMember.content[0]!.text.includes("不在群"));

    const quota = await callPayload(client, "quota", {});
    assert.equal(quota.send_enabled, false);
    assert.equal(quota.proactive_sent_today, 0);

    // 不存在的锚点 → 可操作错误（isError=true 且不炸）
    const miss = (await client.callTool({
      name: "browse",
      arguments: { id: GROUP, msg_id: "NOPE", mode: "around" },
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
      rawJson: "{}",
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
    const res = await callPayload(client, "get_new", { id: GROUP });
    assert.ok(!("group" in res), "信封无会话回显字段");
    assert.equal(typeof res.has_more, "boolean");
    const msgs = res.messages!;
    const q2 = msgs.find((m) => m.msg_id === "Q2")!;
    assert.ok(!("group_openid" in q2), "消息条目无会话回显字段");
    assert.equal(String(q2.content), "看看这条", "正文干净");
    const q2quote = q2.quote_msg!;
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
    const q3quote = q3.quote_msg!;
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
      q4.quote_msg!.msg_id,
      "Q1",
      "命中产 quote_msg",
    );
    const q6 = msgs.find((m) => m.msg_id === "Q6")!;
    const q6quote = q6.quote_msg!;
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
      rawJson: "{}",
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
    const ok = await callPayload(client, "get_records", { id: GROUP, msg_id: "R1" });
    assert.equal(ok.count, 2);
    const recs = ok.records!;
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
    const r0quote = r0.quote_msg!;
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
      rawJson: "{}",
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
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
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

test("M3-6b 内联 data:URL 附件：工具输出不回显 base64 载荷（带体积占位），get_media 仍出图像块，库列不动", async () => {
  const fx = await setupServer();
  let client: Client | null = null;
  try {
    // 摄取期富化的内联图（微信 CDN 解密图 / Telegram 缩略图）形态
    const payload = Buffer.from(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ).toString("base64");
    const dataUrl = `data:image/png;base64,${payload}`;
    new Repo(fx.db).saveMessage({
      botId: "10001",
      scope: "group",
      scopeId: GROUP,
      msgId: "MD2",
      authorOpenid: "U_A",
      authorName: "画师",
      authorRole: "member",
      ts: Date.now(),
      text: "截图",
      content: "![附件1]\n![附件2]\n截图",
      quote: {
        msgId: "MD1",
        body: "看图",
        attachments: [{ kind: "image", url: dataUrl, content_type: "image/png" }],
      },
      records: [],
      mentions: [],
      attachments: [
        { kind: "image", url: dataUrl, content_type: "image/png" },
        { kind: "image", url: "https://cdn.example/b.png", content_type: "image/png" },
      ],
      rawJson: "{}",
    });
    client = await connectClient(fx.baseUrl, fx.agentToken);
    const res = await callPayload(client, "browse", { id: GROUP, limit: 1 });
    const msg = res.messages![0]!;
    assert.equal(msg.msg_id, "MD2");
    const atts = msg.attachments as Array<{ url: string; content_type: string }>;
    assert.match(
      atts[0]!.url,
      /^data:image\/png;base64,…\(内联 \d+KB，图像经 get_media 获取\)$/,
    );
    assert.equal(atts[0]!.content_type, "image/png"); // 其余元数据保留
    assert.equal(atts[1]!.url, "https://cdn.example/b.png"); // 非内联 URL 原样
    assert.match(msg.quote_msg!.attachments![0]!.url, /内联/); // 被引内联图同样压缩
    assert.equal(JSON.stringify(res).includes(payload), false); // 载荷不进工具输出

    // get_media 仍从库列取图（data:URL 可被通用 fetch）
    const media = (await client.callTool({
      name: "get_media",
      arguments: { id: GROUP, msg_id: "MD2", n: 1 },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
    assert.equal(media.isError, undefined);
    assert.equal(media.content[0]!.type, "image");
    assert.equal(media.content[0]!.data, payload);

    // 库列不动（WebUI 聊天窗直接用 attachments_json 内联渲染）
    const row = fx.db
      .prepare("SELECT attachments_json FROM messages WHERE msg_id = 'MD2'")
      .get() as { attachments_json: string };
    assert.equal(row.attachments_json.includes(payload), true);
  } finally {
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
      rawJson: "{}",
    });
    client = await connectClient(fx.baseUrl, fx.agentToken);
    const res = await callPayload(client, "browse", {
      id: GROUP,
      msg_id: "M_SELF",
      mode: "around",
      limit: 3,
    });
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

test("M3-8 单聊读取面：get_new 水位/search/browse/get_info 走 c2c 缓存；侧别由 id 自动探测", async () => {
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
      rawJson: "{}",
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
    const fresh = await callPayload(client, "list_new", {});
    const chat = (fresh.conversations!).find(
      (c) => c.type === "chat",
    )!;
    assert.equal(chat.id, USER);
    assert.equal(chat.unread, 2);

    // get_new：拉取即已读，重复调用不重拉；引用结构化 quote_msg（侧别由 id 探测）
    const first = await callPayload(client, "get_new", { id: USER });
    assert.equal(first.count, 2);
    const again = await callPayload(client, "get_new", { id: USER });
    assert.equal(again.count, 0, "水位已推进，重拉为空");
    const c2 = (first.messages!).find(
      (m) => m.msg_id === "C2",
    )!;
    assert.equal(String(c2.content), "单聊里引用一下", "单聊引用同样摘除内联");
    const c2quote = c2.quote_msg!;
    assert.equal(c2quote.msg_id, "C1");
    assert.equal(c2quote.content, "被引的单聊原文");

    // 已读后红点消失
    const after = await callPayload(client, "list_all", { type: "chat" });
    assert.equal(
      (after.conversations!).find(
        (c) => c.id === USER,
      )!.unread,
      0,
    );

    // search：≥3 字 FTS 命中；<3 字降级 LIKE 兜底
    const fts = await callPayload(client, "search", { id: USER, query: "单聊原文" });
    assert.equal(fts.count, 1, "FTS 只命中 C1");
    const like = await callPayload(client, "search", { id: USER, query: "引用" });
    assert.equal(like.count, 1, "LIKE 兜底命中 C2 令牌行");

    // browse：单聊锚点 around
    const around = await callPayload(client, "browse", { id: USER, msg_id: "C1", mode: "around" });
    assert.equal(around.count, 2, "前后文含 C1/C2 两条");

    // 群聊侧不受影响（探测：GROUP 命中群缓存）
    const g = await callPayload(client, "get_new", { id: GROUP });
    assert.equal(g.count, 5, "群聊种子消息照常拉取");

    // 探测语义：侧别由 id 决定——单聊 id 查群消息（及反向）均报"不存在，可先 search"
    const wrongSide = (await client.callTool({
      name: "browse",
      arguments: { id: USER, msg_id: "M1", mode: "around" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(wrongSide.isError, true);
    assert.ok(
      wrongSide.content[0]!.text.includes("search"),
      "跨会话锚点报可定位错误",
    );
    const wrongSide2 = (await client.callTool({
      name: "browse",
      arguments: { id: GROUP, msg_id: "C1", mode: "around" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(wrongSide2.isError, true);
    assert.ok(wrongSide2.content[0]!.text.includes("search"), "反向同理");

    // 真不存在的消息 → 仍走"可先 search"路径
    const miss = (await client.callTool({
      name: "browse",
      arguments: { id: USER, msg_id: "NOPE", mode: "around" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(miss.isError, true);
    assert.ok(miss.content[0]!.text.includes("search"));

    // 探测失败 → 可操作错误（未知 id：两侧无缓存且不在白名单）
    const unknownSession = (await client.callTool({
      name: "get_new",
      arguments: { id: "NO_SUCH_SESSION" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(unknownSession.isError, true);
    assert.ok(
      unknownSession.content[0]!.text.includes("无法定位会话"),
      "探测失败应给可操作提示",
    );

    // get_info 单聊 id → 返回对端用户资料
    const chatInfo = await callPayload(client, "get_info", { id: USER });
    assert.equal(chatInfo.type, "chat");
    assert.equal(chatInfo.id, USER);
    assert.equal(chatInfo.user!.msg_count, 2);
    // 单聊传 member_id 无意义 → 可操作错误
    const roster = (await client.callTool({
      name: "get_info",
      arguments: { id: USER, member_id: "NOT_A_GROUP_MEMBER" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(roster.isError, true);
    assert.ok(
      roster.content[0]!.text.includes("没有群成员名册"),
      "get_info 单聊传 member_id 应报可操作错误",
    );

    // 探测补充证据：C2C 开关事件可先行于首条缓存消息（用户已 opt-in 但尚无消息）
    //——kv 记录独立裁决 chat 侧，主动消息门禁亦依赖该记录
    repo.setC2cSwitch("10001", "C2C_OPENID_U2", true);
    const optinOnly = await callPayload(client, "get_new", { id: "C2C_OPENID_U2" });
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
