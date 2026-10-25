// Fastify HTTP 服务。
// M0：仅 /healthz。/mcp（Streamable HTTP + Bearer，常数时间比较）在 M3 挂载——
// MCP 官方 SDK 的 StreamableHTTPServerTransport 基于 Node 原生 req/res，Fastify 可直接对接，零适配层。

import Fastify from "fastify";
import type { BotRegistry } from "../bots";
import type { GatewayStatus, GatewaySupervisor } from "../gateway";
import type { TokenService } from "../gateway/token";
import type { Logger } from "../logger";
import type { Sender } from "../sender";
import type { DB } from "../store/db";
import { Repo } from "../store/repo";
import { bearerOk, createMcpHandler } from "../tools/mcp";
import { registerUiRoutes } from "./ui";

export interface ServerDeps {
  log: Logger;
  db: DB;
  repo: Repo;
  /** M4 发送器：写工具走这里；缺省=写工具硬拒绝 */
  sender?: Sender;
  version: string;
  /** —— WebUI 依赖（齐备才挂载 /ui 与 /ui/api）—— */
  registry?: BotRegistry;
  supervisor?: GatewaySupervisor;
  tokens?: TokenService;
  botStatuses?: () => GatewayStatus[];
  /** MCP 工具执行全局并发上限（测试注入口；缺省 8，语义见 mcp.ts McpDeps） */
  maxConcurrent?: number;
}

/** Authorization: Bearer <token> 提取；无效返回 null */
function bearerOf(header: unknown): string | null {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const t = header.slice(7).trim();
  return t === "" ? null : t;
}

export function buildServer(deps: ServerDeps) {
  const { log, db, repo, version } = deps;
  // 关闭 fastify 内置日志，统一用自研 logger；请求日志只记方法+路径（去掉 query，防泄漏）
  const app = Fastify({ logger: false });
  const httpLog = log.child("http");

  app.addHook("onRequest", async (req) => {
    httpLog.debug("req", { method: req.method, path: req.url.split("?")[0] });
  });

  app.get("/healthz", async () => {
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      version,
      uptime_s: Math.round(process.uptime()),
      bots: deps.registry?.list().length ?? 0,
      send: deps.repo.getSendEnable() ? "enabled" : "disabled",
      db: dbOk ? "ok" : "error",
    };
  });

  // MCP Streamable HTTP（M3→M9）：Bearer 鉴权为「token→bot」绑定制——
  // admin token 只通 /ui/api；一个 agent_token 只对应 bots 表中的一行。
  const handleMcp = createMcpHandler({
    log,
    repo,
    sender: deps.sender,
    bots: deps.registry,
    supervisor: deps.supervisor,
    maxConcurrent: deps.maxConcurrent,
    version,
  });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
      const bearer = bearerOf(req.headers.authorization);
      const botId =
        bearer === null || deps.registry === undefined
          ? null
          : deps.registry.appIdByToken(bearer);
      if (botId === null) {
        reply.code(401).send({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "Unauthorized：token 无效或未绑定 bot。请用 qq_register_bot 返回的 agent_token，或在 WebUI 设置页重新生成。",
          },
          id: null,
        });
        return;
      }
      reply.hijack(); // 响应由 SDK transport 直接写原生 res
      await handleMcp(req.raw, reply.raw, req.body, botId);
    },
  });

  // WebUI（M7）：registry+supervisor+tokens 齐备才挂载（缺省=测试旧行为，不挂 /ui）
  if (deps.registry !== undefined && deps.supervisor !== undefined && deps.tokens !== undefined && deps.botStatuses !== undefined) {
    registerUiRoutes(app, {
      log,
      db,
      repo,
      version,
      registry: deps.registry,
      supervisor: deps.supervisor,
      tokens: deps.tokens,
      botStatuses: deps.botStatuses,
      sender: deps.sender,
    });
  }

  return app;
}
