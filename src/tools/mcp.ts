// MCP Streamable HTTP 端点：Fastify 原生 req/res 直连官方 SDK transport（零适配层）。
// - Bearer 鉴权：sha256 摘要后 timingSafeEqual（常数时间，防时序侧信道）
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
import type { BotApp } from "../config";
import type { BotRegistry } from "../bots";
import type { Logger } from "../logger";
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
  /** 网关接入器：register_bot 后立即接入新 bot；缺省=测试环境不接入 */
  supervisor?: { addBot: (app: BotApp) => void };
  /** MCP 工具执行全局并发上限（M6 限流）：SQLite 同步查询毫秒级、写工具 API 调用秒级，8 足够且防打爆 */
  maxConcurrent?: number;
  version: string;
}
/** sha256 摘要比较：长度差异不影响常数时间性 */
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
  }
  const sessions = new Map<string, Session>();

  const createContext = (session: { botId: string }) => ({
    repo,
    sender: deps.sender,
    bots: deps.bots,
    supervisor: deps.supervisor,
    botId: session.botId,
  });

  const createSession = (botId: string): Session => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // 纯请求/响应工具面，JSON 体便于 curl/调试；SSE 流式响应暂无需求
    });
    const server = new Server(
      { name: "qq-gateway", version },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
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
        const result = await runTool(name, args, createContext({ botId }));
        mcpLog.debug("tool call", {
          tool: name,
          error: result.isError === true,
        });
        return {
          content: [{ type: "text", text: result.text }],
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
    void server.connect(transport);
    return { server, transport, botId };
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
        const session = createSession(botId);
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
