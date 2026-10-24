// Fastify HTTP 服务。
// M0：仅 /healthz。/mcp（Streamable HTTP + Bearer，常数时间比较）在 M3 挂载——
// MCP 官方 SDK 的 StreamableHTTPServerTransport 基于 Node 原生 req/res，Fastify 可直接对接，零适配层。

import Fastify from 'fastify';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { DB } from '../store/db';

export interface ServerDeps {
  config: Config;
  log: Logger;
  db: DB;
  version: string;
}

export function buildServer(deps: ServerDeps) {
  const { config, log, db, version } = deps;
  // 关闭 fastify 内置日志，统一用自研 logger；请求日志只记方法+路径（去掉 query，防泄漏）
  const app = Fastify({ logger: false });
  const httpLog = log.child('http');

  app.addHook('onRequest', async (req) => {
    httpLog.debug('req', { method: req.method, path: req.url.split('?')[0] });
  });

  app.get('/healthz', async () => {
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      version,
      uptime_s: Math.round(process.uptime()),
      bots: config.apps.length,
      send: config.sendEnabled ? 'enabled' : 'disabled',
      db: dbOk ? 'ok' : 'error',
    };
  });

  // M3 占位：app.route({ url: '/mcp', ... }) —— Streamable HTTP + Bearer 鉴权

  return app;
}
