// QQ 连接器插件声明面（ConnectorPlugin）：caps / credentialSchema / login /
// tools（quota）/ hooks（verifyCredential / proactiveGate / proactiveRecord）/
// webui（扫码配对 + 额度水位）/ create。
// P1 QQ 收口手术（2026-11-15）：平台特有语义自 core 收口于此——
// - verifyCredential = 原 index.ts registry verify（token + 网关地址两级）；
// - proactiveGate/Record = 原 sender 令牌桶 + 日额度（记账经 StatePort）；
// - quota 工具 = 原 defs.ts quota 工具（输出形状逐字段保持）；
// - webui /login/qr/* = 原 ui.ts /qr-bind/* 的协议半（bind_key 内存态迁入），
//   poll 完成时把凭据交回宿主注册（core 拦截，绝不下发浏览器）。

import type {
  ConnectorLogger,
  ConnectorPlugin,
  NormalizedInbound,
  PluginContext,
  QrPairCreateOut,
  QrPairPollOut,
  WebuiRouteOut,
} from "@qsense/connector-sdk";
import {
  createNetKit,
  pluginTool,
  webuiJsonRoute,
  webuiRoute,
  type NetKit,
} from "@qsense/connector-sdk";
import { z } from "zod";
import { createQqInstance, type QqOverrides } from "./instance";
import {
  PER_GROUP_DAILY,
  createQuota,
  dailyTotalOf,
  type QqSendLimits,
  type QuotaSnapshot,
} from "./quota";
import { createQrBindTask, pollQrBind } from "./qrbind";
import { appOfCreds, type QqNetDeps } from "./net";
import { qqSendError } from "./errors";
import { fetchGatewayUrl } from "./url";
import { normalizeQqEnvelope } from "./normalize";
import { TokenService, type QqApp } from "./token";

export interface QqConnectorOpts {
  /** 宿主根日志器（loadModule 注入；缺省=静默 noop，仅独立调试用） */
  log?: ConnectorLogger;
  /** 注入共享 TokenService（缺省自建） */
  tokens?: TokenService;
  /** 官方 SDK 边界缝（token/重连/发送 API 适配；详见 QqOverrides 注释） */
  overrides?: QqOverrides;
  /** 控制面 NetKit（凭据校验的 /gateway 请求 + 扫码 lite 接口 + 实例 /gateway
   * 传输；测试注入 FakeNetKit，缺省真实现） */
  net?: NetKit;
  /** 测试注入：覆盖额度默认值 */
  limits?: Partial<QqSendLimits>;
}

/** 无日志器缺省（分仓包不依赖 SDK 运行时值，noop 本地实现） */
function noopLog(): ConnectorLogger {
  const noop = (): void => undefined;
  const logger: ConnectorLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

const QR_TASK_TTL_MS = 10 * 60_000;

export interface QqConnectorPlugin extends ConnectorPlugin {
  /** 移除 bot 时的运行时卫生（清 token 缓存 + 释放 host/app 映射）；宿主 removeBot 调用 */
  forget(botId: string): void;
}

// —— webui 路由返回形状（B⁺ T6：qr-pair 协议形状在 SDK 契约；平台自有路由
// 返回接口 extends WebuiRouteOut）——

/** GET /quota：主动发送额度水位（平台自有路由形状） */
interface QuotaWaterlineOut extends WebuiRouteOut {
  bot: string;
  send_enabled: boolean;
  auth_level: string;
  proactive_sent_today: number;
  buckets: QuotaSnapshot;
}

export function createQqConnector(opts: QqConnectorOpts = {}): QqConnectorPlugin {
  const log = opts.log ?? noopLog();
  const tokens = opts.tokens ?? new TokenService(log.child("token"));
  const quota = createQuota(opts.limits);
  // 控制面传输（凭据校验 /gateway + 扫码 lite 接口；实例 /gateway 亦同源）
  const controlHttp = (opts.net ?? createNetKit()).http({ timeoutMs: 15_000 });
  const apps = new Map<string, QqApp>();

  // 扫码绑定内存任务表：task_id → 密钥（bind_key 只在本进程；完成即焚，进程重启失效）
  const qrTasks = new Map<string, { bindKey: string; createdAt: number }>();
  const pruneQrTasks = (): void => {
    const now = Date.now();
    for (const [k, v] of qrTasks) {
      if (now - v.createdAt > QR_TASK_TTL_MS) qrTasks.delete(k);
    }
  };

  return {
    id: "qq",
    sdkRange: "^2.0.0",
    title: "QQ 官方机器人",
    caps: {
      scopes: ["group", "c2c"],
      media: { image: true, voice: true, video: false, file: false },
      recall: true,
      passiveWindow: true,
      quota: true,
      proactiveOptIn: true, // QQ C2C：主动消息需用户同意（C2C_MSG_RECEIVE 置位）
    },
    // 发送错误语义面（契约 v2.2.2）：官方码判定 + 包内文案，core 委托翻译
    sendError: qqSendError,
    normalize: (botId, payload): NormalizedInbound | null =>
      normalizeQqEnvelope(botId, payload),
    credentialSchema: {
      type: "object",
      required: ["appid", "secret"],
      properties: {
        appid: {
          type: "string",
          description: "开放平台 AppID（q.qq.com → 开发设置）",
        },
        secret: { type: "string", description: "对应的 AppSecret" },
      },
    },
    credentialSecrets: ["secret"],
    login: { kind: "qr-pair", create: "/login/qr/create", poll: "/login/qr/poll" },
    tools: [
      pluginTool({
        name: "quota",
        description:
          "主动消息额度水位（只读）：发送开关、认证等级、令牌桶余量、当日已发、官方限额常量。",
        inputSchema: { type: "object", properties: {} },
        argsSchema: z.object({}),
        run: async (_args, ctx) => {
          const date = new Date().toISOString().slice(0, 10); // 与旧实现一致（UTC 日期查询）
          const payload = {
            send_enabled: ctx.config.sendEnabled ?? false,
            auth_level: ctx.config.authLevel ?? "uncertified",
            proactive_sent_today: await dailyTotalOf(ctx.host.state, date),
            buckets: await quota.snapshot(
              ctx.botId,
              ctx.config,
              ctx.host.state,
            ),
            limits: {
              per_group_daily: PER_GROUP_DAILY,
              qpm: "认证 bot 60 / 未认证 30（群聊主动消息）；单关系 20",
              passive_note:
                "被动回复不计额度：群 5 分钟内 5 次 / 单聊 60 分钟内 4 次",
            },
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
        },
      }),
    ],
    webui: [
      webuiRoute({
        method: "POST",
        path: "/login/qr/create",
        summary: "创建扫码绑定任务（官方 lite 接口）",
        handler: async (): Promise<QrPairCreateOut> => {
          pruneQrTasks();
          const task = await createQrBindTask(controlHttp);
          qrTasks.set(task.taskId, {
            bindKey: task.bindKey,
            createdAt: Date.now(),
          });
          return {
            task_id: task.taskId,
            connect_url: task.connectUrl,
            interval_s: 2,
          };
        },
      }),
      webuiJsonRoute({
        method: "POST",
        path: "/login/qr/poll",
        summary: "轮询扫码绑定结果",
        bodySchema: z.object({ task_id: z.string().optional() }),
        handler: async (req): Promise<QrPairPollOut> => {
          const taskId = (req.body.task_id ?? "").trim();
          const task = qrTasks.get(taskId);
          if (task === undefined) {
            // 任务不存在 / 已过期清理 / 进程重启：前端据此重开任务
            return { status: "expired" };
          }
          const r = await pollQrBind(
            { taskId, bindKey: task.bindKey },
            controlHttp,
          );
          if (r.status !== "pending") qrTasks.delete(taskId);
          if (r.status !== "completed") return r;
          // 凭据只交回宿主（core 拦截 → verifyCredential → 注册），绝不下发浏览器
          return {
            status: "completed",
            credential: { appid: r.appid, secret: r.secret },
            user_openid: r.userOpenid,
          };
        },
      }),
      webuiRoute({
        method: "GET",
        path: "/quota",
        summary: "主动发送额度水位",
        handler: async (req): Promise<QuotaWaterlineOut> => {
          const raw = req.query["bot"];
          const botId = typeof raw === "string" ? raw.trim() : "";
          const config = req.configOf(botId);
          const state = req.stateOf(botId);
          const date = new Date().toISOString().slice(0, 10); // 与旧实现一致（UTC 日期查询）
          return {
            bot: botId,
            send_enabled: config.sendEnabled ?? false,
            auth_level: config.authLevel ?? "uncertified",
            proactive_sent_today: await dailyTotalOf(state, date),
            buckets: await quota.snapshot(botId, config, state),
          };
        },
      }),
    ],
    hooks: {
      verifyCredential: async (credential) => {
        // 两级凭据校验：token 接口（appid/secret 正确性）+ 网关地址接口（IP 白名单
        // 11298 等网关入口问题——token 接口不校验白名单，只验 token 会出现
        // "添加成功但连不上"）。QQ 专属核对提示由本插件自带（P3 起宿主包装只承担
        // 统一前缀，不感知任何平台语义）。
        try {
          const token = await tokens.getAccessToken({
            appid: credential["appid"] ?? "",
            secret: credential["secret"] ?? "",
          });
          await fetchGatewayUrl(controlHttp, token);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new Error(
            `${reason}。请核对 appid 与 AppSecret（q.qq.com → 开发设置）；` +
              "若报「接口访问源IP不在白名单」（code 11298），需在该机器人管理端关闭 IP 白名单或把本机公网 IP 加入白名单。",
          );
        }
      },
      proactiveGate: (ctx, botId, target) => quota.gate(ctx, botId, target),
      proactiveRecord: (ctx, botId, target) => quota.record(ctx, botId, target),
    },
    create: (ctx: PluginContext, creds) => {
      apps.set(creds.botId, appOfCreds(creds));
      return createQqInstance({
        ctx,
        creds,
        tokens,
        ...(opts.net !== undefined ? { net: opts.net.http({ timeoutMs: 30_000 }) } : {}),
        overrides: opts.overrides,
      });
    },
    forget(botId: string): void {
      const app = apps.get(botId);
      if (app !== undefined) tokens.clear(app);
      apps.delete(botId);
    },
  };
}

/** net 依赖形状再导出（宿主装配/测试注入用） */
export type { QqNetDeps };
