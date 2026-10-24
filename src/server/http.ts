// Fastify HTTP 服务。
// M0：仅 /healthz。/mcp（Streamable HTTP + Bearer，常数时间比较）在 M3 挂载——
// MCP 官方 SDK 的 StreamableHTTPServerTransport 基于 Node 原生 req/res，Fastify 可直接对接，零适配层。

import Fastify from "fastify";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Sender } from "../sender";
import type { DB } from "../store/db";
import { Repo } from "../store/repo";
import { bearerOk, createMcpHandler } from "../tools/mcp";

export interface ServerDeps {
  config: Config;
  log: Logger;
  db: DB;
  repo: Repo;
  /** M4 发送器：写工具走这里；缺省=写工具硬拒绝 */
  sender?: Sender;
  version: string;
}

export function buildServer(deps: ServerDeps) {
  const { config, log, db, repo, version } = deps;
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
      bots: config.apps.length,
      send: config.sendEnabled ? "enabled" : "disabled",
      db: dbOk ? "ok" : "error",
    };
  });

  // MCP Streamable HTTP（M3）：Bearer 鉴权 + 会话管理；Fastify 解析 JSON 体后交 SDK transport
  const handleMcp = createMcpHandler({
    config,
    log,
    repo,
    sender: deps.sender,
    version,
  });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
      if (!bearerOk(req.headers.authorization, config.mcpToken)) {
        reply.code(401).send({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unauthorized：缺少或错误的 Bearer token。",
          },
          id: null,
        });
        return;
      }
      reply.hijack(); // 响应由 SDK transport 直接写原生 res
      await handleMcp(req.raw, reply.raw, req.body);
    },
  });

  return app;
}
