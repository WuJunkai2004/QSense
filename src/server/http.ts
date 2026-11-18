// Fastify HTTP 服务。
// M0：仅 /healthz。/mcp（Streamable HTTP + Bearer，常数时间比较）在 M3 挂载——
// MCP 官方 SDK 的 StreamableHTTPServerTransport 基于 Node 原生 req/res，Fastify 可直接对接，零适配层。

import Fastify from "fastify";
import type { AssetStore } from "../assets";
import type { BotRegistry } from "../bots";
import type { ConnectorRuntime, GatewayStatus } from "../connectors/runtime";
import type { Logger } from "../utils/logger";
import type { Sender } from "../sender";
import type { DB } from "../store/db";
import { Repo } from "../store/repo";
import { createMcpHandler } from "../tools/mcp";
import { registerUiRoutes } from "./ui";
import { DOCS_MARKDOWN } from "./docs";
import {
  TIMEOUT_RESPONSE,
  validateWaitBody,
  type WaitHub,
  type WaitResponse,
} from "./wait";
import type { TtsDeps } from "../tts";

const ASSET_MAX_BYTES = 20 * 1024 * 1024;

export interface ServerDeps {
  log: Logger;
  db: DB;
  repo: Repo;
  /** M4 发送器：写工具走这里；缺省=写工具硬拒绝 */
  sender?: Sender;
  version: string;
  /** —— WebUI 依赖（齐备才挂载 /ui 与 /ui/api）—— */
  registry?: BotRegistry;
  /** 连接器运行时（P1 收口，原 supervisor）：/ui 装配条件 + 运行时接入/摘除 */
  connectors?: ConnectorRuntime;
  botStatuses?: () => GatewayStatus[];
  /** MCP 工具执行全局并发上限（测试注入口；缺省 8，语义见 mcp.ts McpDeps） */
  maxConcurrent?: number;
  /** 资产存储（request_upload 票据 + PUT /assets 数据端点 + asset: 引用）；缺省=未装配 */
  assets?: AssetStore;
  /** TTS 合成依赖（透传 UiDeps.ttsDeps；缺省=直连），测试注入假端点 */
  ttsDeps?: TtsDeps;
  /** WebUI 静态产物目录（config.toml ui_dist_dir；缺省 ./ui/dist） */
  uiDistDir?: string;
  /** /wait 长轮询事件中枢（宿主唤醒面；缺省=端点 501 不装配） */
  wait?: WaitHub;
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

  // 数据平面：非 JSON 的请求体（资产直传 octet-stream 等）按 buffer 接收，
  // 上限 20MB（控制平面 /mcp、/ui/api 的 JSON 由内置 parser 处理，互不影响）
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: ASSET_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

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
    supervisor: deps.connectors,
    assets: deps.assets,
    agentTokenOf:
      deps.assets !== undefined && deps.registry !== undefined
        ? (botId) => deps.registry!.agentTokenOf(botId)
        : undefined,
    maxConcurrent: deps.maxConcurrent,
    version,
    plugins: deps.connectors?.plugins,
    pluginContext:
      deps.connectors !== undefined
        ? (botId) => ({
            host: deps.connectors!.hostFor(botId),
            config: deps.connectors!.configOf(botId),
          })
        : undefined,
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
              "Unauthorized：token 无效或未绑定 bot。请用 register_bot 返回的 agent_token，或在 WebUI 设置页重新生成。",
          },
          id: null,
        });
        return;
      }
      // 每 bot MCP 开关（WebUI「MCP 访问」）：关闭后该 token 的所有请求一律拒绝
      if (
        deps.registry !== undefined &&
        !deps.registry.mcpEnabledOf(botId)
      ) {
        reply.code(403).send({
          jsonrpc: "2.0",
          error: {
            code: -32003,
            message:
              `Forbidden：bot ${botId} 的 MCP 访问已在 WebUI 设置页禁用（「机器人」栏 → MCP 访问）。` +
              "请先在设置页启用，或联系管理员。",
          },
          id: null,
        });
        return;
      }
      reply.hijack(); // 响应由 SDK transport 直接写原生 res
      await handleMcp(req.raw, reply.raw, req.body, botId);
    },
  });

  // —— 文档面：AI 自举入口（调用契约全量在案，无密钥内容，不鉴权）——
  app.get("/docs", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return DOCS_MARKDOWN;
  });

  // —— 宿主唤醒面：/wait 长轮询（Bearer agent_token，与 /mcp 同源同闸）——
  // 解耦契约：网关只吐事件+快照，绝不拉起智能体；消费仍走 get_new 水位。
  app.post("/wait", async (req, reply) => {
    if (deps.wait === undefined || deps.registry === undefined) {
      return reply.code(501).send({ error: "/wait 未装配。" });
    }
    const bearer = bearerOf(req.headers.authorization);
    const botId =
      bearer === null ? null : deps.registry.appIdByToken(bearer);
    if (botId === null) {
      return reply.code(401).send({
        error:
          "Unauthorized：token 无效或未绑定 bot。请用 register_bot 返回的 agent_token（与 /mcp 同一把）。",
      });
    }
    if (!deps.registry.mcpEnabledOf(botId)) {
      return reply.code(403).send({
        error: `Forbidden：bot ${botId} 的 MCP 访问已在 WebUI 设置页禁用（同闸覆盖 /wait）。`,
      });
    }
    let parsed;
    try {
      parsed = validateWaitBody(req.body);
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : String(e) });
    }
    let handle;
    try {
      handle = deps.wait.wait(botId, parsed.filter, parsed.hold * 1000);
    } catch (e) {
      httpLog.warn("wait rejected", { botId, reason: String(e) });
      return reply
        .code(429)
        .send({ error: e instanceof Error ? e.message : String(e) });
    }
    // 长轮询 hold：hijack 后手写原生 res（/mcp 同技巧）；每 15s 写一个换行字节——
    // 保活 NAT/代理空闲计时器 + 把「静默断链」变成写时即时察觉；JSON 前导空白合法。
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.socket?.setNoDelay(true);
    res.on("error", () => {}); // 断链写错误不进未捕获异常（close 钩子统一清理）
    const heartbeat = setInterval(() => {
      try {
        res.write("\n");
      } catch {
        /* 断链写失败：close 钩子统一清理 */
      }
    }, 15_000);
    let finished = false;
    const finish = (payload: WaitResponse): void => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      handle.cancel(); // 幂等结算（已结算为 noop），防 waiter 泄漏
      if (!res.writableEnded) res.end(JSON.stringify(payload));
    };
    // 客户端主动断开（FIN/RST）或响应结束后连接关闭 → 即时清理（ServerResponse
    // 'close'：响应完成或连接提前终止都会触发；finished 幂等挡住正常路径）
    res.on("close", () => finish(TIMEOUT_RESPONSE));
    handle.done.then(finish, () => finish(TIMEOUT_RESPONSE));
  });

  // 数据平面：资产直传端点（票据自鉴权，不走 Bearer）。字节从执行环境流到此落盘，
  // 不经过 MCP 消息与模型上下文（控制平面/数据平面分离）。
  app.put("/assets/:botId/:assetId", async (req, reply) => {
    if (deps.assets === undefined) {
      return reply.code(501).send({ error: "资产功能未启用。" });
    }
    if (deps.registry === undefined) {
      return reply.code(501).send({ error: "注册表未装配。" });
    }
    const { botId, assetId } = req.params as {
      botId: string;
      assetId: string;
    };
    const code = deps.assets.verifyPut(
      botId,
      assetId,
      deps.registry.agentTokenOf(botId),
      (req.query as Record<string, unknown>).exp,
      (req.query as Record<string, unknown>).sig,
    );
    if (code !== null) {
      const why: Record<number, string> = {
        400: "缺少 exp/sig 参数。",
        403: "票据无效：bot 不存在、token 已轮换、签名不符或已过期。",
        404: "asset_id 非法。",
        409: "该 asset_id 已上传过（票据单次使用）。",
        410: "票据已过期（15 分钟），请重新 request_upload。",
      };
      return reply.code(code).send({ error: why[code] ?? "校验失败。" });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return reply.code(400).send({
        error: "请求体缺失：请以二进制（--data-binary）直传图片字节。",
      });
    }
    try {
      const { mime, size } = deps.assets.save(assetId, body);
      httpLog.info("asset stored", { assetId, botId, mime, size });
      return {
        ok: true,
        asset_id: assetId,
        mime,
        size,
        next: `send_media({ group, media: "asset:${assetId}", text: "配文" })`,
      };
    } catch (e) {
      if (e instanceof RangeError) {
        return reply.code(415).send({
          error:
            "内容不是图片/音频（魔数嗅探失败）。仅支持 png/jpeg/gif/webp/bmp 与 mp3/wav/silk。",
        });
      }
      throw e;
    }
  });

  // WebUI（M7）：registry+connectors+botStatuses 齐备才挂载（缺省=测试旧行为，不挂 /ui）
  if (
    deps.registry !== undefined &&
    deps.connectors !== undefined &&
    deps.botStatuses !== undefined
  ) {
    registerUiRoutes(app, {
      log,
      db,
      repo,
      version,
      registry: deps.registry,
      supervisor: deps.connectors,
      connectors: deps.connectors.plugins,
      botStatuses: deps.botStatuses,
      sender: deps.sender,
      ttsDeps: deps.ttsDeps,
      uiDistDir: deps.uiDistDir,
    });
  }

  // /wait 关停钩子：app.close() 前结算全部挂起 waiter（防测试/生产关停挂死连接）
  if (deps.wait !== undefined) {
    const hub = deps.wait;
    app.addHook("onClose", async () => {
      hub.abortAll();
    });
  }

  return app;
}
