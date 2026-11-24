// WebUI 路由（/ui）：
// - 静态托管：ui/dist（git submodule qqbot-webui 的构建产物）；未构建时 503 给出可操作提示
// - JSON API：/ui/api/*，Bearer 复用 MCP_TOKEN（sha256 + timingSafeEqual，同 /mcp）
// - 写入口（添加/移除 bot、发送消息）与 MCP 工具共享同一套硬门禁与账本，无旁路
// - 插件化（P1 收口，2026-11-15）：GET /connectors 声明端点（表单/面板按声明渲染）+
//   /platforms/:id/* 插件 webui 路由挂载（admin 鉴权沿用、错误规范化、插件拿不到 fastify
//   reply）；旧 /qr-bind/*、/quota 过渡期保留并委托 QQ 插件路由（P5 切声明端点后收口）
//
// 安全说明：静态资源不含敏感数据（纯 JS 壳）；所有数据经 /ui/api 鉴权后读取；
// token 由前端存 localStorage 并以 Authorization 头携带（非 cookie，无 CSRF 面）。

import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ConnectorError,
  formatZodIssues,
  QrPairPollOutSchema,
  type ConnectorRegistry,
  type PluginWebuiInput,
  type PluginWebuiRoute,
  type WebuiMethod,
} from "@qsense/connector-sdk";
import { QrBindError } from "@qsense/connector-qq";
import { BotRegistryError, type BotRegistry } from "../bots";
import type { ConnectorRuntime, GatewayStatus } from "../connectors/runtime";
import type { Logger } from "../utils/logger";
import { TtsError, synthesizeSpeech, type TtsDeps, type TtsFormat } from "../tts";
import type { Sender } from "../sender";
import type { DB } from "../store/db";
import type { MsgRow, Repo } from "../store/repo";
import { bearerOk } from "../tools/mcp";

export interface UiDeps {
  log: Logger;
  db: DB;
  repo: Repo;
  version: string;
  registry: BotRegistry;
  /** 连接器运行时（P1 收口，原 GatewaySupervisor）：接入/摘除 bot + 插件上下面解析 */
  supervisor: ConnectorRuntime;
  /** 平台插件声明面注册表（GET /connectors 与 /platforms/:id/* 挂载用） */
  connectors: ConnectorRegistry;
  /** 各 bot 网关状态快照（bootstrap 展示用） */
  botStatuses: () => GatewayStatus[];
  /** 发送器：POST /send 用；缺省=发送端点硬拒绝（与 MCP requireSender 同语义） */
  sender?: Sender;
  /** TTS 合成依赖（fetch 注入；缺省=直连），测试注入假端点 */
  ttsDeps?: TtsDeps;
  /** WebUI 静态产物目录（config.toml ui_dist_dir；缺省 ./ui/dist；env UI_DIST_DIR 已退役） */
  uiDistDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** 统一错误映射：BotRegistryError（含参数类错误）→ 400，ConnectorError（插件声明 status）
 *  透传，QrBindError（上游扫码接口）→ 502，TtsError（TTS 上游）→ 502，其余 → 500（记日志）。
 *  连接器对 SDK 只做类型导入（各自打包后 instanceof 跨包不成立），其自带的可操作错误以
 *  「Error 上带合法 status」的鸭子类型识别：透传状态与文案，不落入通用 500 文案。 */
function mapError(
  log: Logger,
  e: unknown,
): { status: number; message: string } {
  if (e instanceof BotRegistryError) return { status: 400, message: e.message };
  if (e instanceof ConnectorError) return { status: e.status, message: e.message };
  if (e instanceof QrBindError) return { status: 502, message: e.message };
  if (e instanceof TtsError) return { status: 502, message: e.message };
  if (e instanceof Error) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600) {
      return { status, message: e.message };
    }
  }
  const message = e instanceof Error ? e.message : String(e);
  log.error("ui api error", { reason: message.slice(0, 300) });
  return { status: 500, message: "内部错误，请查看服务日志。" };
}

export function registerUiRoutes(app: FastifyInstance, deps: UiDeps): void {
  const { log, repo, registry, supervisor, connectors, version } = deps;
  const uiLog = log.child("ui");
  // WebUI 静态产物根（config.toml ui_dist_dir；env UI_DIST_DIR 已退役）
  const distRoot = deps.uiDistDir?.trim() || "./ui/dist";

  // —— 静态托管（无鉴权：纯前端壳，不含数据） ——

  async function serveFile(
    reply: FastifyReply,
    filePath: string,
  ): Promise<void> {
    try {
      const buf = await readFile(filePath);
      const dot = filePath.lastIndexOf(".");
      const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
      reply.type(MIME[ext] ?? "application/octet-stream").send(buf);
    } catch {
      reply.code(404).send({ error: "文件不存在。" });
    }
  }

  async function serveIndex(reply: FastifyReply): Promise<void> {
    const root = resolve(distRoot);
    try {
      await stat(join(root, "index.html"));
    } catch {
      reply
        .code(503)
        .type("text/plain; charset=utf-8")
        .send(
          "WebUI 未构建：ui/ 是 git submodule（qqbot-webui）。请执行 `git submodule update --init`，" +
            "随后在 ui/ 内 `npm install && npm run build`，产物生成于 ui/dist/。",
        );
      return;
    }
    await serveFile(reply, join(root, "index.html"));
  }

  app.get("/ui", async (_req, reply) => serveIndex(reply));
  app.get("/ui/", async (_req, reply) => serveIndex(reply));
  app.get("/ui/*", async (req, reply) => {
    const root = resolve(distRoot);
    let rel: string;
    try {
      rel = decodeURIComponent((req.params as { "*": string })["*"]);
    } catch {
      reply.code(400).send({ error: "非法路径。" });
      return;
    }
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) {
      reply.code(400).send({ error: "非法路径。" });
      return;
    }
    let s;
    try {
      s = await stat(target);
    } catch {
      // 无扩展名路径回退 index.html（SPA 习惯）；带扩展名的缺失文件 404
      if (!rel.includes(".")) {
        await serveIndex(reply);
        return;
      }
      reply.code(404).send({ error: "文件不存在。" });
      return;
    }
    if (s.isDirectory()) {
      await serveIndex(reply);
      return;
    }
    await serveFile(reply, target);
  });

  // —— JSON API（Bearer 鉴权，封装作用域内生效） ——

  app.register(
    async function uiApi(plugin) {
      plugin.addHook("onRequest", async (req, reply) => {
        // M8：WebUI 用 admin token（SQLite admin:token:v1 播种自 env MCP_TOKEN）
        const admin = deps.repo.getAdminToken();
        if (admin === null || !bearerOk(req.headers.authorization, admin)) {
          reply
            .code(401)
            .send({ error: "Unauthorized：缺少或错误的 admin token。" });
        }
      });

      /** bot 解析：与工具面 resolveBotId 同语义（单 bot 缺省，多 bot 必填） */
      const resolveBot = (raw: unknown): string => {
        const bots = registry.list();
        const asked =
          typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
        if (asked !== undefined) {
          if (!bots.some((b) => b.botId === asked)) {
            throw new BotRegistryError(
              `bot 不存在：${asked}。已注册：${bots.map((b) => b.botId).join(", ") || "（无）"}。`,
            );
          }
          return asked;
        }
        if (bots.length === 1) return bots[0].botId;
        throw new BotRegistryError(
          `当前注册了多个 bot（${bots.map((b) => b.botId).join(", ")}），请用 bot 参数指定。`,
        );
      };

      const intParam = (
        raw: unknown,
        min: number,
        max: number,
        fallback: number,
      ): number => {
        if (raw === undefined || raw === null || raw === "") return fallback;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < min || n > max) {
          throw new BotRegistryError(
            `参数必须是 ${min}-${max} 的整数（收到 ${String(raw)}）。`,
          );
        }
        return n;
      };

      const groupOf = (raw: unknown): string => {
        const g = typeof raw === "string" ? raw.trim() : "";
        if (g === "")
          throw new BotRegistryError("缺少 group 参数（群 openid）。");
        return g;
      };

      plugin.get("/bootstrap", async () => {
        const statuses = new Map<string, GatewayStatus>();
        for (const st of deps.botStatuses()) statuses.set(st.botId, st);
        return {
          version,
          uptime_s: Math.round(process.uptime()),
          send_enabled: deps.repo.getSendEnable(),
          bots: registry.list().map((a) => {
            const st = statuses.get(a.botId);
            return {
              appid: a.botId,
              name: a.name,
              allow_groups: registry.allowGroupsOf(a.botId),
              auth_level: registry.authLevelOf(a.botId),
              tts_enabled: deps.repo.getTtsEnabled(a.botId),
              receive_enabled: registry.receiveEnabledOf(a.botId),
              mcp_enabled: registry.mcpEnabledOf(a.botId),
              gateway: st?.state ?? "unknown",
              detail: st?.detail,
            };
          }),
        };
      });

      plugin.post("/bots", async (req, reply) => {
        try {
          const body = (req.body ?? {}) as Record<string, unknown>;
          // 平台缺省 qq（兼容旧前端/脚本）；凭据键按该平台 credentialSchema 的属性名从
          // 请求体取字符串值——表单本身即按该 schema 渲染，宿主不感知具体键
          const platform =
            typeof body.platform === "string" && body.platform.trim() !== ""
              ? body.platform.trim()
              : "qq";
          const target = connectors.get(platform);
          if (target === undefined) {
            throw new BotRegistryError(
              `平台不存在或连接器未装载：${platform}。已注册：${
                connectors.list().map((p) => p.id).join(", ") || "（无）"
              }。`,
            );
          }
          const credentials: Record<string, string> = {};
          for (const key of Object.keys(target.credentialSchema.properties ?? {})) {
            const v = body[key];
            if (typeof v === "string") credentials[key] = v;
          }
          const name = typeof body.name === "string" ? body.name : undefined;
          if (
            body.auth_level !== undefined &&
            body.auth_level !== "certified" &&
            body.auth_level !== "uncertified"
          ) {
            throw new BotRegistryError(
              "auth_level 无效：只接受 certified（60条/分）或 uncertified（30条/分）。",
            );
          }
          const authLevel =
            body.auth_level === "certified" || body.auth_level === "uncertified"
              ? body.auth_level
              : undefined;
          const registered = await registry.add({
            platform,
            credentials,
            name,
            authLevel,
          });
          supervisor.addBot(registered.bot);
          uiLog.info("bot added via ui", {
            platform,
            appid: registered.bot.botId,
          });
          // M8：agent_token 仅此一次返回——WebUI 弹窗提示"立即保存"，服务端不留展示通道
          return {
            ok: true,
            bot: { appid: registered.bot.botId, name: registered.bot.name },
            agent_token: registered.agentToken,
            note: "agent_token 仅本次返回：请立即保存。再次获取请走设置页轮换。",
          };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      // —— 插件化 API（P1 收口，2026-11-15）——
      // GET /connectors：平台声明面（表单/面板按声明渲染，前端 P2/P5 消费）
      plugin.get("/connectors", async () => ({
        connectors: connectors.list().map((p) => ({
          id: p.id,
          title: p.title,
          caps: p.caps,
          credential_schema: p.credentialSchema,
          credential_secrets: p.credentialSecrets,
          login: p.login ?? { kind: "secret" },
          webui: (p.webui ?? []).map((r) => ({
            method: r.method,
            path: r.path,
            summary: r.summary,
          })),
        })),
      }));

      /** 插件 webui 路由匹配："：param" 段捕获（method+段数+字面段全等） */
      const matchRoute = (
        routes: PluginWebuiRoute[],
        method: string,
        path: string,
      ): { route: PluginWebuiRoute; params: Record<string, string> } | null => {
        const parts = path.split("/").filter((s) => s !== "");
        for (const route of routes) {
          if (route.method !== method) continue;
          const rparts = route.path.split("/").filter((s) => s !== "");
          if (rparts.length !== parts.length) continue;
          const params: Record<string, string> = {};
          let ok = true;
          for (let i = 0; i < rparts.length; i += 1) {
            const rp = rparts[i]!;
            const seg = parts[i]!;
            if (rp.startsWith(":")) params[rp.slice(1)] = seg;
            else if (rp !== seg) {
              ok = false;
              break;
            }
          }
          if (ok) return { route, params };
        }
        return null;
      };

      /** 插件 webui 路由的原始输入（控制反转）：宿主注入 configOf/stateOf，
       * body 只以 JSON 文本跨界（schema 解析在 webuiRoute 工厂闭包内完成），
       * 插件拿不到 fastify 原生对象。 */
      const webuiInput = (
        req: { body?: unknown },
        over: { path: string; params?: Record<string, string>; query?: Record<string, string> },
      ): PluginWebuiInput => ({
        path: over.path,
        params: over.params ?? {},
        query: over.query ?? {},
        rawBody: req.body === undefined ? undefined : JSON.stringify(req.body),
        configOf: (botId) => supervisor.configOf(botId),
        stateOf: (botId) => supervisor.hostFor(botId).state,
      });

      // 平台插件路由挂载：/ui/api/platforms/:id/*（admin 鉴权由本作用域统一覆盖）
      // login=qr-pair 的平台：poll 路由由宿主中介——completed 时宿主执行注册
      // （官方两级凭据校验 + 落库 + 拉起网关），凭据绝不透传浏览器；create 与
      // 其余插件路由按声明透传（login 声明的路径从通用匹配中排除，防泄漏面）。
      plugin.all("/platforms/:id/*", async (req, reply) => {
        try {
          const params = req.params as { id: string; "*": string };
          const target = connectors.get(params.id);
          if (target === undefined) {
            reply.code(404).send({
              error: `平台不存在：${params.id}。已注册：${
                connectors.list().map((p) => p.id).join(", ") || "（无）"
              }。`,
            });
            return;
          }
          const sub = `/${params["*"] ?? ""}`;
          const query: Record<string, string> = {};
          for (const [k, v] of Object.entries(
            req.query as Record<string, unknown>,
          )) {
            if (typeof v === "string") query[k] = v;
          }
          const login =
            target.login !== undefined && target.login.kind === "qr-pair"
              ? target.login
              : undefined;

          // login=qr-pair：create 透传（task_id/connect_url 无敏感）、poll 宿主中介
          // （completed → 宿主注册，返回与旧 /qr-bind/poll 一致的 created 形状，
          // 凭据绝不透传浏览器）。非 POST 打到 login 路径 → 落通用匹配的 404。
          if (
            login !== undefined &&
            req.method === "POST" &&
            sub === login.create
          ) {
            const route = (target.webui ?? []).find(
              (r) => r.method === "POST" && r.path === login.create,
            );
            if (route === undefined) {
              reply.code(404).send({
                error: `平台 ${params.id} 声明了 qr-pair 登录但缺少 ${login.create} 路由。`,
              });
              return;
            }
            reply.send(
              await route.handle(webuiInput(req, { path: sub, query })),
            );
            return;
          }
          if (
            login !== undefined &&
            req.method === "POST" &&
            sub === login.poll
          ) {
            const route = (target.webui ?? []).find(
              (r) => r.method === "POST" && r.path === login.poll,
            );
            if (route === undefined) {
              reply.code(404).send({
                error: `平台 ${params.id} 声明了 qr-pair 登录但缺少 ${login.poll} 路由。`,
              });
              return;
            }
            // poll 产物契约 = SDK QrPairPollOut（qr-pair 协议形状）；handle 统一
            // 返回面是 WebuiRouteOut，宿主中介以 QrPairPollOutSchema 锚定完整形状
            // （违反协议 = 可操作错误，防连接器实现 bug 静默坏数据）
            const raw = await route.handle(webuiInput(req, { path: sub, query }));
            const gate = QrPairPollOutSchema.safeParse(raw);
            if (!gate.success) {
              reply.code(502).send({
                error: `平台 ${target.id} 的 poll 路由返回不符合 qr-pair 协议：${formatZodIssues(gate.error, "poll 产物")}`,
              });
              return;
            }
            const out = gate.data;
            if (out.status === "completed") {
              const credentials: Record<string, string> = {};
              for (const [k, v] of Object.entries(out.credential)) {
                if (v !== "") credentials[k] = v;
              }
              const registered = await registry.add({
                platform: target.id,
                credentials,
              });
              supervisor.addBot(registered.bot);
              uiLog.info("bot added via platform qr login", {
                platform: target.id,
                appid: registered.bot.botId,
              });
              reply.send({
                status: "created",
                bot: { appid: registered.bot.botId, name: registered.bot.name },
                agent_token: registered.agentToken,
                note: "agent_token 仅本次返回：请立即保存。再次获取请走设置页轮换。",
              });
              return;
            }
            reply.send(out);
            return;
          }

          // 通用插件路由：login 声明的 create/poll 不进通用匹配（凭据面只走宿主中介）
          const routes = (target.webui ?? []).filter(
            (r) =>
              login === undefined ||
              (r.path !== login.create && r.path !== login.poll),
          );
          const hit = matchRoute(routes, req.method, sub);
          if (hit === null) {
            reply.code(404).send({
              error: `路由不存在：${req.method} ${sub}（平台 ${params.id}）。`,
            });
            return;
          }
          const out = await hit.route.handle(
            webuiInput(req, { path: sub, params: hit.params, query }),
          );
          reply.send(out);
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      // —— 扫码绑定（q.qq.com lite，经 QQ 插件 webui 路由）——
      // 旧路由过渡保留（P5 切声明端点后收口）；bind_key 在插件进程内，浏览器只见 task_id。
      const qqRoute = (
        method: WebuiMethod,
        path: string,
      ): PluginWebuiRoute | undefined => {
        const p = connectors.get("qq");
        return p === undefined ? undefined : matchRoute(p.webui ?? [], method, path)?.route;
      };

      plugin.post("/qr-bind/create", async (_req, reply) => {
        try {
          const route = qqRoute("POST", "/login/qr/create");
          if (route === undefined) {
            throw new QrBindError(
              "QQ 连接器未注册，扫码绑定不可用。可改用手动方式添加（appid + AppSecret）。",
            );
          }
          const out = await route.handle(webuiInput(_req, { path: "/login/qr/create" }));
          uiLog.info("qr bind task created", { taskId: out.task_id ?? "" });
          reply.send(out);
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.post("/qr-bind/poll", async (req, reply) => {
        try {
          const route = qqRoute("POST", "/login/qr/poll");
          if (route === undefined) {
            // 任务态不可用：前端据此重开任务或走手动添加
            return { status: "expired" };
          }
          const raw = await route.handle(webuiInput(req, { path: "/login/qr/poll" }));
          const gate = QrPairPollOutSchema.safeParse(raw);
          if (!gate.success) {
            throw new QrBindError(
              `poll 路由返回不符合 qr-pair 协议：${formatZodIssues(gate.error, "poll 产物")}`,
            );
          }
          const out = gate.data;
          if (out.status !== "completed") return out;
          // 完成 → 既有注册管线（官方两级凭据校验 + 落库 + 拉起网关）；
          // AppSecret 全程不出本进程，凭据绝不下发浏览器
          const appid = out.credential["appid"] ?? "";
          const secret = out.credential["secret"] ?? "";
          const registered = await registry.add({
            platform: "qq",
            credentials: { appid, secret },
          });
          supervisor.addBot(registered.bot);
          uiLog.info("bot added via qr bind", {
            appid: registered.bot.botId,
          });
          return {
            status: "created",
            bot: { appid: registered.bot.botId, name: registered.bot.name },
            agent_token: registered.agentToken,
            note: "agent_token 仅本次返回：请立即保存。再次获取请走设置页轮换。",
          };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      // 改备注名（仅本地展示与自发消息补记的作者名，不触官方任何接口）
      plugin.patch("/bots/:appid", async (req, reply) => {
        try {
          const appid = (req.params as { appid: string }).appid;
          const body = (req.body ?? {}) as Record<string, unknown>;
          const name = typeof body.name === "string" ? body.name : "";
          const renamed = registry.rename(appid, name);
          uiLog.info("bot renamed via ui", { appid, name: renamed.name });
          return {
            ok: true,
            bot: { appid: renamed.appid, name: renamed.name },
          };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      // —— M8 设置页：发送总开关 + 每 bot 白名单（全部落 SQLite）——

      const settingsPayload = () => ({
        send_enabled: deps.repo.getSendEnable(),
        bots: registry.list().map((a) => ({
          appid: a.botId,
          name: a.name,
          allow_groups: registry.allowGroupsOf(a.botId),
          auth_level: registry.authLevelOf(a.botId),
          tts_enabled: deps.repo.getTtsEnabled(a.botId),
          receive_enabled: registry.receiveEnabledOf(a.botId),
          mcp_enabled: registry.mcpEnabledOf(a.botId),
          gateway:
            deps.botStatuses().find((st) => st.botId === a.botId)?.state ??
            "unknown",
        })),
      });

      plugin.get("/settings", async () => settingsPayload());

      plugin.put("/settings", async (req, reply) => {
        try {
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (typeof body.send_enabled === "boolean") {
            deps.repo.setSendEnable(body.send_enabled);
            uiLog.info("send toggle via ui", { enabled: body.send_enabled });
          }
          if (Array.isArray(body.allow_groups)) {
            for (const item of body.allow_groups) {
              const rec = (item ?? {}) as Record<string, unknown>;
              const appid = typeof rec.appid === "string" ? rec.appid : "";
              const groups = rec.groups;
              if (
                registry.get(appid) === undefined ||
                !Array.isArray(groups) ||
                !groups.every((g) => typeof g === "string" && g !== "")
              ) {
                throw new BotRegistryError(
                  "allow_groups 项无效：需要 { appid, groups: string[] }，且 appid 已注册、groups 全为非空字符串。",
                );
              }
              registry.setAllowGroups(appid, groups);
              uiLog.info("allow groups via ui", {
                appid,
                count: groups.length,
              });
            }
          }
          if (Array.isArray(body.auth_levels)) {
            for (const item of body.auth_levels) {
              const rec = (item ?? {}) as Record<string, unknown>;
              const appid = typeof rec.appid === "string" ? rec.appid : "";
              if (
                registry.get(appid) === undefined ||
                (rec.auth_level !== "certified" &&
                  rec.auth_level !== "uncertified")
              ) {
                throw new BotRegistryError(
                  'auth_levels 项无效：需要 { appid, auth_level: "certified" | "uncertified" }，且 appid 已注册。',
                );
              }
              registry.setAuthLevel(appid, rec.auth_level);
              uiLog.info("auth level via ui", {
                appid,
                auth_level: rec.auth_level,
              });
            }
          }
          if (Array.isArray(body.tts_enabled)) {
            for (const item of body.tts_enabled) {
              const rec = (item ?? {}) as Record<string, unknown>;
              const appid = typeof rec.appid === "string" ? rec.appid : "";
              if (
                registry.get(appid) === undefined ||
                typeof rec.enabled !== "boolean"
              ) {
                throw new BotRegistryError(
                  "tts_enabled 项无效：需要 { appid, enabled: boolean }，且 appid 已注册。",
                );
              }
              deps.repo.setTtsEnabled(appid, rec.enabled);
              uiLog.info("tts toggle via ui", { appid, enabled: rec.enabled });
            }
          }
          // 接收消息：落库后即时接入/断开该 bot 的官方网关（缓存与注册保留）
          if (Array.isArray(body.receive_enabled)) {
            for (const item of body.receive_enabled) {
              const rec = (item ?? {}) as Record<string, unknown>;
              const appid = typeof rec.appid === "string" ? rec.appid : "";
              const app = registry.get(appid);
              if (app === undefined || typeof rec.enabled !== "boolean") {
                throw new BotRegistryError(
                  "receive_enabled 项无效：需要 { appid, enabled: boolean }，且 appid 已注册。",
                );
              }
              registry.setReceiveEnabled(appid, rec.enabled);
              if (rec.enabled) supervisor.addBot(app);
              else supervisor.removeBot(appid);
              uiLog.info("receive toggle via ui", {
                appid,
                enabled: rec.enabled,
              });
            }
          }
          // MCP 访问：不涉及网关；落库后该 token 的下一次请求即被 /mcp 拒绝
          if (Array.isArray(body.mcp_enabled)) {
            for (const item of body.mcp_enabled) {
              const rec = (item ?? {}) as Record<string, unknown>;
              const appid = typeof rec.appid === "string" ? rec.appid : "";
              if (
                registry.get(appid) === undefined ||
                typeof rec.enabled !== "boolean"
              ) {
                throw new BotRegistryError(
                  "mcp_enabled 项无效：需要 { appid, enabled: boolean }，且 appid 已注册。",
                );
              }
              registry.setMcpEnabled(appid, rec.enabled);
              uiLog.info("mcp toggle via ui", { appid, enabled: rec.enabled });
            }
          }
          return settingsPayload();
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      // —— TTS（语音合成发送）：全局配置（kv tts:config:v1）+ 每 bot 开关（kv tts:<appid>）——
      // api_key 明文落库（agent_token 同原则），此处只回显打码、不写日志。

      const maskKey = (k: string): string =>
        k === "" ? "" : k.length <= 8 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`;

      plugin.get("/tts/config", async () => {
        const cfg = deps.repo.getTtsConfig();
        if (cfg === null) return { configured: false };
        return {
          configured: true,
          base_url: cfg.base_url,
          model: cfg.model,
          voice: cfg.voice,
          format: cfg.format ?? "wav",
          api_key_masked: maskKey(cfg.api_key),
        };
      });

      plugin.put("/tts/config", async (req, reply) => {
        try {
          const body = (req.body ?? {}) as Record<string, unknown>;
          const text = (k: string): string =>
            typeof body[k] === "string" ? (body[k] as string).trim() : "";
          const base_url = text("base_url");
          const model = text("model");
          const voice = text("voice");
          const apiKey = text("api_key");
          const rawFormat =
            body.format === undefined ? "wav" : (body.format as string);
          if (base_url === "" || model === "" || voice === "") {
            throw new BotRegistryError(
              "TTS 配置不完整：base_url / model / voice 均必填（api_key 可空 = 服务无鉴权）。",
            );
          }
          if (rawFormat !== "mp3" && rawFormat !== "wav") {
            throw new BotRegistryError(
              'format 无效：只接受 "wav"（缺省，兼容面最广）或 "mp3"。',
            );
          }
          const format: TtsFormat = rawFormat; // 校验已穷举枚举
          // api_key 留空 = 保持已存值（UI 回显是打码文本，无法也不必回传原文）
          const key = apiKey !== "" ? apiKey : (deps.repo.getTtsConfig()?.api_key ?? "");
          const cfg = { base_url, api_key: key, model, voice, format };
          deps.repo.setTtsConfig(cfg);
          uiLog.info("tts config via ui", { base_url, model, voice, format });
          return { ok: true, configured: true, api_key_masked: maskKey(key) };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      // 试听（WebUI 测试按钮）：优先用请求体草稿（未保存也能试），缺省字段回退已存配置；
      // 固定合成 "hi"，返回音频字节由浏览器播放。TTS 上游故障 → 502 + 可操作文案。
      plugin.post("/tts/test", async (req, reply) => {
        try {
          const body = (req.body ?? {}) as Record<string, unknown>;
          const stored = deps.repo.getTtsConfig();
          const text = (k: string, fallback: string): string =>
            typeof body[k] === "string" && (body[k] as string).trim() !== ""
              ? (body[k] as string).trim()
              : fallback;
          const rawFormat =
            typeof body.format === "string" && body.format !== ""
              ? body.format
              : (stored?.format ?? "wav");
          if (rawFormat !== "mp3" && rawFormat !== "wav") {
            throw new BotRegistryError(
              'format 无效：只接受 "wav"（缺省，兼容面最广）或 "mp3"。',
            );
          }
          const format: TtsFormat = rawFormat; // 上方校验已穷举枚举
          const cfg = {
            base_url: text("base_url", stored?.base_url ?? ""),
            api_key: text("api_key", stored?.api_key ?? ""),
            model: text("model", stored?.model ?? ""),
            voice: text("voice", stored?.voice ?? ""),
            format,
          };
          if (cfg.base_url === "" || cfg.model === "" || cfg.voice === "") {
            throw new BotRegistryError(
              "TTS 尚未配置完整：请先填写 base_url / model / voice。",
            );
          }
          const { buf, mime } = await synthesizeSpeech(cfg, "hi", deps.ttsDeps);
          reply.type(mime).send(buf);
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      /** 轮换 agent token（管理员操作，无需旧 token）：新值仅本次返回 */
      plugin.post("/bots/:appid/agent-token", async (req, reply) => {
        try {
          const appid = (req.params as { appid: string }).appid;
          const token = registry.rotateToken(appid);
          uiLog.info("agent token rotated via ui", { appid });
          return {
            ok: true,
            bot: appid,
            agent_token: token,
            note: "agent_token 仅本次返回：旧 token 已立即失效。请立即更新到 MCP 客户端配置。",
          };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.delete("/bots/:appid", async (req, reply) => {
        try {
          const appid = (req.params as { appid: string }).appid;
          const removed = registry.remove(appid); // env 基座抛错 → 400
          supervisor.removeBot(appid); // 会话与 token 缓存一并清理（runtime 内联，重加即全新 IDENTIFY）
          uiLog.info("bot removed via ui", { appid: removed.botId });
          return { ok: true, appid };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.get("/groups", async (req, reply) => {
        try {
          const q = req.query as Record<string, unknown>;
          const botId = resolveBot(q.bot);
          // type=all（缺省）合并单聊会话：单聊自建于 c2c_messages，作者名=群聊名册映射
          // （saveC2cMessage）；会话键统一走 group_openid 字段（单聊时为对端 user_openid）
          const type = q.type === "group" || q.type === "chat" ? q.type : "all";
          const sessionTs = (s: {
            last: { ts: string } | null;
            updated_at: string | null;
          }): number =>
            Date.parse(s.last?.ts ?? s.updated_at ?? "1970-01-01T00:00:00Z");
          const groups =
            type === "chat"
              ? []
              : repo.listGroupsWithLast(botId).map((g) => ({
                  type: "group" as const,
                  group_openid: g.group_openid as string,
                  full_msg_enabled: g.full_msg_enabled === 1,
                  member_count: Number(g.member_count ?? 0),
                  updated_at:
                    g.updated_at !== null
                      ? new Date(Number(g.updated_at)).toISOString()
                      : null,
                  last:
                    g.last_ts !== null
                      ? {
                          ts: new Date(Number(g.last_ts)).toISOString(),
                          author: (g.last_author as string | null) ?? null,
                          snippet: ((g.last_content as string | null) ?? "").slice(
                            0,
                            80,
                          ),
                        }
                      : null,
                }));
          const chats =
            type === "group"
              ? []
              : repo.listChatsWithLast(botId).map((c) => ({
                  type: "chat" as const,
                  group_openid: c.user_openid as string,
                  full_msg_enabled: null,
                  member_count: 0,
                  updated_at: null,
                  last:
                    c.last_ts !== null
                      ? {
                          ts: new Date(Number(c.last_ts)).toISOString(),
                          author: (c.last_author as string | null) ?? null,
                          snippet: ((c.last_content as string | null) ?? "").slice(
                            0,
                            80,
                          ),
                        }
                      : null,
                }));
          const sessions = [...groups, ...chats].sort(
            (a, b) => sessionTs(b) - sessionTs(a),
          );
          return { bot: botId, groups: sessions };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      /** 整群缓存删除（合规退出）：原 MCP 工具 forget 迁入——破坏性操作收归人类（admin token + WebUI 确认弹窗），
       *  避免群成员经消息注入诱导 agent 删数据。DELETE 无 body（踩坑#16：勿带 json Content-Type）。 */
      plugin.delete("/groups/:groupOpenid", async (req, reply) => {
        try {
          const botId = resolveBot((req.query as Record<string, unknown>).bot);
          const group = (req.params as { groupOpenid: string }).groupOpenid;
          const purged = repo.purgeGroupAll(botId, group);
          uiLog.info("group purged via ui", { bot: botId, group, ...purged });
          return { ok: true, bot: botId, group, purged };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.get("/messages", async (req, reply) => {
        try {
          const q = req.query as Record<string, unknown>;
          const botId = resolveBot(q.bot);
          const group = groupOf(q.group);
          const limit = intParam(q.limit, 1, 200, 50);
          // type=chat 读 c2c_messages 镜像（group 参数此时为对端 user_openid，读取层同形）
          const isChat = q.type === "chat";
          const scope = isChat ? ("chat" as const) : ("group" as const);
          const out = (rows: MsgRow[]) =>
            rows.map((r) => {
              const q = repo.quoteOf(r);
              return {
                rid: r.rid,
                msg_id: r.msg_id,
                ts: r.ts !== null ? new Date(r.ts).toISOString() : null,
                author: {
                  openid: r.author_openid,
                  name:
                    (r.author_openid !== null
                      ? repo.userNameOf(botId, r.author_openid)
                      : null) ?? r.author_name,
                  role: r.author_role,
                },
                content: r.content,
                quote_msg:
                  q !== null
                    ? { id: q.id, msg_id: q.msgId, content: q.body }
                    : null,
                records_count: r.records_count,
                has_attachments: r.attachments_json !== null,
                attachments: r.attachments_json
                  ? JSON.parse(r.attachments_json)
                  : null,
                has_ark: r.ark_json !== null,
                /** 本机外发（发送成功后补记） */
                out: r.direction === 1,
              };
            });
            if (q.after !== undefined && q.after !== "") {
              // 轮询模式：rowid > after 的增量（升序）
              const after = intParam(q.after, 0, Number.MAX_SAFE_INTEGER, 0);
              const rows = repo.getMessagesAfter(
                botId,
                scope,
                group,
                after,
                limit,
              );
              return { bot: botId, group, mode: "after", messages: out(rows) };
            }
            const before =
              q.before !== undefined && q.before !== ""
                ? intParam(q.before, 0, Number.MAX_SAFE_INTEGER, 0)
                : null;
            const rows = repo.messagesPageBefore(
              botId,
              scope,
              group,
              before,
              limit,
            );
            return {
              bot: botId,
              group,
              mode: "page",
              messages: out(rows),
              has_more: rows.length === limit,
              next_before: rows.length > 0 ? rows[0].rid : null,
            };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.get("/message", async (req, reply) => {
        try {
          const q = req.query as Record<string, unknown>;
          const botId = resolveBot(q.bot);
          const group = groupOf(q.group);
          const msgId = typeof q.msg_id === "string" ? q.msg_id.trim() : "";
          if (msgId === "") {
            throw new BotRegistryError("缺少 msg_id 参数。");
          }
          const isChat = q.type === "chat";
          const scope = isChat ? ("chat" as const) : ("group" as const);
          const row = repo.getMessageByMsgId(botId, scope, group, msgId);
          if (row === null) {
            reply
              .code(404)
              .send({ error: "消息不存在。" });
            return;
          }
          const quote = repo.quoteOf(row);
          return {
            rid: row.rid,
            msg_id: row.msg_id,
            ts: row.ts !== null ? new Date(row.ts).toISOString() : null,
            author: {
              openid: row.author_openid,
              name:
                (row.author_openid !== null
                  ? repo.userNameOf(botId, row.author_openid)
                  : null) ?? row.author_name,
              role: row.author_role,
            },
            content: row.content,
            quote_msg:
              quote !== null
                ? { id: quote.id, msg_id: quote.msgId, content: quote.body }
                : null,
            records_count: row.records_count,
            records:
              row.records_count > 0
                ? repo
                    .getRecords(botId, scope, group, msgId)
                    .map((rec) => ({
                      ord: rec.ord,
                      depth: rec.depth,
                      openid: rec.author_openid,
                      name:
                        (rec.author_openid !== null
                          ? repo.userNameOf(botId, rec.author_openid)
                          : null) ?? rec.author_name,
                      ts: rec.ts !== null ? new Date(rec.ts).toISOString() : null,
                      text: rec.text,
                      quote: rec.quote_json ? JSON.parse(rec.quote_json) : null,
                      attachments: rec.attachments_json
                        ? JSON.parse(rec.attachments_json)
                        : null,
                    }))
                : null,
            out: row.direction === 1,
            mentions: row.mentions_json ? JSON.parse(row.mentions_json) : null,
            attachments: row.attachments_json
              ? JSON.parse(row.attachments_json)
              : null,
            ark: row.ark_json ? JSON.parse(row.ark_json) : null,
            raw: row.raw_json ? JSON.parse(row.raw_json) : null,
          };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.get("/members", async (req, reply) => {
        try {
          const q = req.query as Record<string, unknown>;
          const botId = resolveBot(q.bot);
          const group = groupOf(q.group);
          // 单聊无名册（openid 按 bot 隔离，映射名见 saveC2cMessage）；返回空列表保持响应同形
          if (q.type === "chat") {
            return { bot: botId, group, members: [] };
          }
          const limit = intParam(q.limit, 1, 500, 200);
          const members = repo.listMembers(botId, group, limit).map((m) => ({
            member_openid: m.member_openid,
            username: m.username,
            member_role: m.member_role,
            msg_count: Number(m.msg_count ?? 0),
            last_seen:
              m.last_seen !== null && m.last_seen !== undefined
                ? new Date(Number(m.last_seen)).toISOString()
                : null,
          }));
          return { bot: botId, group, members };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.get("/sends", async (req, reply) => {
        try {
          const q = req.query as Record<string, unknown>;
          const botId = resolveBot(q.bot);
          const group = groupOf(q.group);
          const limit = intParam(q.limit, 1, 100, 30);
          const sends = repo.recentSends(botId, group, limit).map((s) => ({
            id: s.id,
            kind: s.kind,
            status: s.status,
            reply_msg_id: s.reply_msg_id,
            msg_seq: s.msg_seq,
            provider_msg_id: s.provider_msg_id,
            error_code: s.error_code,
            created_at:
              s.created_at !== null
                ? new Date(s.created_at).toISOString()
                : null,
          }));
          return { bot: botId, group, sends };
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.get("/quota", async (req, reply) => {
        try {
          const botId = resolveBot((req.query as Record<string, unknown>).bot);
          // 额度水位是平台语义（QQ）：委托 QQ 插件 webui 路由（形状与旧实现一致）
          const route = qqRoute("GET", "/quota");
          if (route === undefined) {
            throw new Error("QQ 连接器未注册，额度水位不可用。");
          }
          return await route.handle(
            webuiInput(req, { path: "/quota", query: { bot: botId } }),
          );
        } catch (e) {
          const m = mapError(uiLog, e);
          reply.code(m.status).send({ error: m.message });
        }
      });

      plugin.post("/send", async (req, reply) => {
        const sender = deps.sender;
        if (sender === undefined) {
          reply.code(400).send({ error: "发送功能未装配（Sender 未注入）。" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const text = typeof body.text === "string" ? body.text : "";
        const group = typeof body.group === "string" ? body.group.trim() : "";
        const replyMsgId =
          typeof body.reply_msg_id === "string" && body.reply_msg_id !== ""
            ? body.reply_msg_id
            : undefined;
        // type=chat → 单聊（group 字段=对端 user_openid；门禁=opt-in 开关，见 Sender.gate）
        const kind = body.type === "chat" ? ("chat" as const) : ("group" as const);
        if (group === "" || text.trim() === "") {
          reply.code(400).send({ error: "参数 group 与 text 均不能为空。" });
          return;
        }
        // body.quote 已弃用（sendAuto 语义：reply_msg_id 即引用样式，自动判定被动/主动）
        try {
          const botId = resolveBot(body.bot);
          // 统一走 sendAuto（caps 感知路由）：passiveWindow=true 平台窗内被动优先
          //（reply_msg_id 作引用样式），false 平台（微信/Telegram）恒走主动——
          // 旧形态在此直呼 sender.reply 曾对微信爆 TypeError（无被动原语）。
          // 行为对齐工具面：窗过期自动降级主动，不再硬报错。
          const result = await sender.sendAuto(botId, group, text, replyMsgId, kind);
          // 官方不回推 bot 自发消息：发送成功后本地补记，WebUI 刷新后仍可见。
          // 落库失败不影响发送结果（消息已出账，只记日志）。
          try {
            repo.saveOutgoing({
              botId,
              scope: kind,
              scopeId: group,
              msgId:
                result.provider_msg_id ??
                `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              content: text,
              ts: Date.now(),
              authorName:
                registry.list().find((b) => b.botId === botId)?.name ?? null,
            });
          } catch (pe) {
            const pm = pe instanceof Error ? pe.message : String(pe);
            uiLog.error("outgoing message persist failed", {
              reason: pm.slice(0, 200),
            });
          }
          uiLog.info("send via ui", {
            bot: botId,
            group,
            status: result.status,
          });
          return { ok: true, result };
        } catch (e) {
          // 发送类错误（门禁/官方API/频控）全部 400 透出可操作文案
          const message = e instanceof Error ? e.message : String(e);
          uiLog.warn("send via ui failed", { reason: message.slice(0, 200) });
          reply.code(400).send({ error: message });
        }
      });
    },
    { prefix: "/ui/api" },
  );
}
