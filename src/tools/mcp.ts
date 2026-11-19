// MCP Streamable HTTP 端点：Fastify 原生 req/res 直连官方 SDK transport（零适配层）。
// - Bearer 校验助手 bearerOk（sha256 摘要 + timingSafeEqual 常数时间，防时序侧信道）：
//   /ui/api 的 admin token 比对在用；/mcp 的 agent_token 表反查在 server/http.ts
// - 会话管理：POST 无 session 且为 initialize → 新建 Server+transport 对；DELETE 关闭并清理
// - 工具执行统一走 defs.runTool（错误翻译为可操作的 isError 文本）

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BASE_TOOL_NAMES,
  ToolRouter,
  callPluginTool,
  type ConnectorRegistry,
  type HostApi,
  type BotConfigSnapshot,
} from "@qsense/connector-sdk";
import type { BotRegistry } from "../bots";
import type { Logger } from "../utils/logger";
import type { Sender } from "../sender";
import type { Repo } from "../store/repo";
import { TOOLS, runTool } from "./defs";

export interface McpDeps {
  log: Logger;
  repo: Repo;
  /** M4 发送器：写工具走这里；缺省=写工具硬拒绝 */
  sender?: Sender;
  /** 机器人注册表（bots 表域层）：注册/轮换/白名单解析 */
  bots?: BotRegistry;
  /** 资产存储（request_upload / send_media asset: 引用）；缺省=资产功能未装配 */
  assets?: import("../assets").AssetStore;
  /** agent_token 反查（request_upload 票据密钥取自绑定 bot 的 agent_token）；缺省=票据不可签发 */
  agentTokenOf?: (botId: string) => string | null;
  /** MCP 工具执行全局并发上限（M6 限流）：SQLite 同步查询毫秒级、写工具 API 调用秒级，8 足够且防打爆 */
  maxConcurrent?: number;
  version: string;
  /** 平台插件声明面注册表（P1 收口）：扩展工具经 ToolRouter 聚合；缺省=仅基座 13 */
  plugins?: ConnectorRegistry;
  /** 插件工具上下面解析（host+config 按 bot）；缺省=插件工具不可用 */
  pluginContext?: (
    botId: string,
  ) => { host: HostApi; config: BotConfigSnapshot } | undefined;
}
/** sha256 摘要比较：长度差异不影响常数时间性（/ui/api admin token 在用） */
export function bearerOk(
  header: string | undefined,
  expected: string,
): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const got = header.slice(7);
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  json(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

/** 组装 /mcp 路由处理器：签名 (rawReq, rawRes, parsedBody, botId)。botId 由 HTTP 层按 Bearer→bots 表反查得出。 */
export function createMcpHandler(
  deps: McpDeps,
): (
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
  botId?: string,
) => Promise<void> {
  const { log, repo, version } = deps;
  const mcpLog = log.child("mcp");
  const maxConcurrent = deps.maxConcurrent ?? 8;
  let active = 0;
  interface Session {
    server: Server;
    transport: StreamableHTTPServerTransport;
    /** M8：会话与 bot 绑定（token→bot 在 HTTP 层解析，initialize 时落定） */
    botId: string;
    /** initialize 请求的 Host（upload_url 拼接用；会话期内通常不变） */
    baseUrl: string;
  }
  const sessions = new Map<string, Session>();

  // 工具路由（P1 收口 → P5 跨平台过滤，2026-11-17）：基座 13（保留名）+ 该 bot
  // 平台的插件声明扩展。同一服务多平台 bot 并存时，每个 bot 的工具面只含本平台
  // 扩展工具（Telegram bot 看不到 QQ 的 quota——平台语义隔离是工具面结构性的，
  // 不靠调用时报错兜底）。bot 的 platform 不可变（bots 表），会话期内路由表稳定。
  // 插件工具调用经 callPluginTool（错误规范化 + 与基座一致的并发闸/鉴权管线——
  // 顶部的 active 闸对两类工具同等生效）。
  const baseByName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const routerForSession = (botId: string): { router: ToolRouter; platform: string | null } => {
    const router = new ToolRouter(BASE_TOOL_NAMES);
    const platform = deps.bots?.platformOf(botId) ?? null;
    const plugin = platform !== null ? deps.plugins?.get(platform) : undefined;
    if (plugin !== undefined) router.registerPlugin(plugin);
    return { router, platform };
  };

  const createContext = (session: Session) => ({
    repo,
    sender: deps.sender,
    bots: deps.bots,
    assets: deps.assets,
    baseUrl: session.baseUrl,
    agentToken: deps.agentTokenOf?.(session.botId) ?? undefined,
    botId: session.botId,
  });

  const createSession = (botId: string, baseUrl: string): Session => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // 纯请求/响应工具面，JSON 体便于 curl/调试；SSE 流式响应暂无需求
    });
    const server = new Server(
      { name: "qq-gateway", version },
      { capabilities: { tools: {} } },
    );
    const { router, platform } = routerForSession(botId);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: router.names().map((name) => {
        const base = baseByName.get(name);
        if (base !== undefined) {
          return {
            name: base.name,
            description: base.description,
            inputSchema: base.inputSchema,
          };
        }
        const decl = router.resolve(name)?.tool;
        return {
          name,
          description: decl?.description ?? "",
          inputSchema: decl?.inputSchema ?? { type: "object", properties: {} },
        };
      }),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      // M6 限流：全局并发上限（单用户场景够用），超限快速失败不排队
      if (active >= maxConcurrent) {
        mcpLog.warn("tool call rejected (busy)", { tool: name, active });
        return {
          content: [
            {
              type: "text",
              text: `服务繁忙（并发 ${active}/${maxConcurrent}），请稍后重试。`,
            },
          ],
          isError: true,
        };
      }
      active += 1;
      try {
        const route = router.resolve(name);
        let result: { isError?: boolean; text: string; content?: unknown[] };
        if (route === null) {
          // 跨平台可操作性：工具名存在于其他平台的扩展声明时，明确指出归属
          //（如 telegram bot 调 quota——它在 QQ 平台的工具面上）
          const owner = (deps.plugins?.list() ?? []).find((p) =>
            (p.tools ?? []).some((t) => t.name === name),
          );
          result =
            owner !== undefined
              ? {
                  isError: true,
                  text: `工具 ${name} 是平台 ${owner.id} 的扩展工具；当前 bot（${platform ?? "未知"}）的工具面不含它。请用该平台 bot 的 agent_token 访问 /mcp。`,
                }
              : {
                  isError: true,
                  text: `未知工具：${name}。可用：${router.names().join(", ")}`,
                };
        } else if (route.source === "base") {
          result = await runTool(name, args, createContext(session));
        } else {
          const pctx = deps.pluginContext?.(session.botId);
          if (pctx === undefined || route.plugin === undefined) {
            result = {
              isError: true,
              text: `平台扩展工具 ${name} 未装配（服务端未连接对应平台连接器）。`,
            };
          } else {
            const payload = await callPluginTool(
              route.plugin,
              name,
              args,
              { host: pctx.host, botId: session.botId, config: pctx.config },
            );
            result = {
              content: payload.content,
              ...(payload.isError === true ? { isError: true } : {}),
              text: payload.content[0]?.text ?? "",
            };
          }
        }
        mcpLog.debug("tool call", {
          tool: name,
          error: result.isError === true,
        });
        return {
          content:
            result.content !== undefined
              ? (result.content as never)
              : [{ type: "text", text: result.text }],
          ...(result.isError === true ? { isError: true } : {}),
        };
      } finally {
        active -= 1;
      }
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid !== undefined) sessions.delete(sid);
    };
    const session: Session = { server, transport, botId, baseUrl };
    void server.connect(transport);
    return session;
  };

  // 每个请求都已在 HTTP 层完成 Bearer→bot 解析；这里只做会话归属一致性校验
  return async function handleMcp(
    req,
    res,
    body?: unknown,
    botId?: string,
  ): Promise<void> {
    if (botId === undefined) {
      // HTTP 层未解析出 bot（理论上不会走到：/mcp 路由 401 在先）
      rpcError(res, 401, -32001, "Unauthorized：token 未绑定 bot。");
      return;
    }
    const method = req.method ?? "POST";
    const sidHeader = req.headers["mcp-session-id"];
    const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
    if (method === "POST") {
      if (sid !== undefined && sid !== "") {
        const existing = sessions.get(sid);
        if (existing === undefined) {
          rpcError(res, 404, -32001, "会话不存在或已过期，请重新 initialize。");
          return;
        }
        if (existing.botId !== botId) {
          rpcError(
            res,
            403,
            -32001,
            `会话属于 bot ${existing.botId}，当前 token 绑定 bot ${botId}，请勿跨用。`,
          );
          return;
        }
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (
        body !== null &&
        typeof body === "object" &&
        isInitializeRequest(body)
      ) {
        const host = (req.headers.host ?? "").trim();
        const baseUrl = host !== "" ? `http://${host}` : "";
        const session = createSession(botId, baseUrl);
        await session.transport.handleRequest(req, res, body);
        const sid2 = session.transport.sessionId;
        if (sid2 !== undefined) sessions.set(sid2, session);
        mcpLog.info("session created", { botId, sessions: sessions.size });
        return;
      }
      rpcError(
        res,
        400,
        -32600,
        "缺少 Mcp-Session-Id 且非 initialize 请求。请先 initialize 获取会话。",
      );
      return;
    }

    // GET(SSE)/DELETE 均需已有会话
    if (sid === undefined || sid === "") {
      rpcError(res, 400, -32600, "缺少 Mcp-Session-Id。");
      return;
    }
    const session = sessions.get(sid);
    if (session === undefined) {
      rpcError(res, 404, -32001, "会话不存在或已过期。");
      return;
    }
    if (session.botId !== botId) {
      rpcError(
        res,
        403,
        -32001,
        `会话属于 bot ${session.botId}，当前 token 绑定 bot ${botId}。`,
      );
      return;
    }
    await session.transport.handleRequest(req, res);
  };
}
