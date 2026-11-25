// @qsense/connector-sdk —— 连接器契约（三面）：声明面 / 网络面 / 宿主面。
//
// 本包零运行时依赖：不 import MCP SDK / fastify / better-sqlite3 / ws。
// 契约类型必须对任何平台（QQ / 微信 iLink / Telegram…）成立，QQ 语义
// （被动窗口、额度、群/C2C 命名空间）一律走 caps + hooks 声明，不进类型骨架。
//
// 后端唯一上行出口 = HostApi.ingest，插件只通过 HostApi 触达宿主。
// 解读权归插件：ConnectorPlugin.normalize 产出成品 NormalizedMessage；core ingest
// 按 payload.platform 表驱动路由，对平台零硬编码，新插件无需修改 core。

import { z } from "zod";
import type { NormalizedInbound } from "./message";
import type { NetKit } from "./net";

/** SDK 契约版本：宿主加载插件时用 satisfiesRange(SDK_VERSION, plugin.sdkRange) 校验。
 * 破坏性签名变化必须提升版本，并由三方锁版机制（sdkRange、加载校验、config.toml
 * range）保证宿主与插件兼容。 */
export const SDK_VERSION = "2.4.0";

// ---------------------------------------------------------------------------
// 基座工具保留名（12）：插件工具不得与之重名（加载即硬失败）。quota 等平台
// 扩展工具由插件声明，跨插件唯一性由 ConnectorRegistry 保证。注册是管理面操作，
// 经 HTTP POST /register 完成，不占用工具名。
// ---------------------------------------------------------------------------

export const BASE_TOOL_NAMES = [
  "list_all",
  "list_new",
  "get_info",
  "get_new",
  "browse",
  "search",
  "get_records",
  "get_media",
  "send",
  "send_media",
  "request_upload",
  "recall",
] as const;

export type BaseToolName = (typeof BASE_TOOL_NAMES)[number];

/** 保留名集合（基座 12；插件声明面校验用） */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set(BASE_TOOL_NAMES);

// ---------------------------------------------------------------------------
// 日志（与 core Logger 结构对齐：五级 + child；core 实例可直接传入）
// ---------------------------------------------------------------------------

/** 结构化字段值域：平面键值（与 core utils/logger.LogFields 同形——结构类型互通） */
export type LogFields = Record<string, string | number | boolean | null>;

export interface ConnectorLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** 子日志器：模块前缀，级别继承 */
  child(scope: string): ConnectorLogger;
}

// ---------------------------------------------------------------------------
// JSON Schema（最小具体子集）：覆盖 credentialSchema /
// inputSchema 声明与闸门校验；递归结构（properties/items 同形）。不引入 ajv。
// ---------------------------------------------------------------------------

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface JsonSchema {
  type?: JsonSchemaType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  default?: string | number | boolean | null;
}

// ---------------------------------------------------------------------------
// 工具返回载荷：MCP content 的最小同形子集（core 侧直接喂 MCP SDK）
// ---------------------------------------------------------------------------

export interface ToolTextBlock {
  type: "text";
  text: string;
}

export interface ToolPayload {
  content: ToolTextBlock[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// 平台能力声明（caps）：工具面出/不出、设置页面板渲染的依据
// ---------------------------------------------------------------------------

export interface PlatformCaps {
  /** 会话形态标签（开放集合）：QQ=["group","c2c"]；微信 iLink=["chat"] */
  scopes: string[];
  /** 富媒体收发能力；任一为 true → net.uploadMedia 应实现 */
  media: {
    image: boolean;
    voice: boolean;
    video: boolean;
    file: boolean;
  };
  /** 支持撤回：false → 基座不出 recall 工具（如微信） */
  recall: boolean;
  /**
   * 被动回复窗口语义：true（QQ）→ 发送走 net.reply（需 msgId+msgSeq，由 core
   * 幂等账本分配）；false（微信）→ 发送走 net.proactive（任意时刻可发）。
   */
  passiveWindow: boolean;
  /** 平台额度语义存在（门禁/记账归插件 hooks.proactiveGate/Record；WebUI 渲染 quota 面板） */
  quota: boolean;
  /**
   * 主动私聊消息是否要求用户 opt-in 事件（QQ C2C 语义：C2C_MSG_RECEIVE 置位 /
   * C2C_MSG_REJECT 撤权，core gate 校验 kv 开关）。false（微信 iLink / Telegram）
   * =平台无 opt 概念——「能对话即能发」，core 跳过 opt-in 校验。
   */
  proactiveOptIn: boolean;
}

// ---------------------------------------------------------------------------
// 线格式（wire）：core 语义层 ↔ connector 网络层的原语载荷
// ---------------------------------------------------------------------------

/**
 * 上行信封最小契约：core 只读 `platform` 键（= plugin.id，表驱动路由依据）；
 * 完整载荷结构归各插件 *.types.ts（插件信封接口 = 本契约的结构超集）。
 */
export interface RawEnvelope {
  platform: string;
}

/**
 * 原始入站载荷信封：经 HostApi.ingest 上行，core ingest 表驱动按
 * `payload.platform`（= plugin.id）路由到对应插件的 normalize 解读。
 * connector 负责给信封盖 platform 章（如 Telegram {platform:"telegram", update,…}）；
 * 原始结构对 core 不透明，解读权在插件。P 泛型 = 插件自有信封类型（须携带
 * platform 键）——调用点字面量不丢字段，core 视角只见 RawEnvelope。
 */
export interface RawInbound<P extends RawEnvelope = RawEnvelope> {
  botId: string;
  /** 协议原生信封（须携带 platform 键供表驱动路由） */
  payload: P;
  /** connector 收到时刻（epoch ms）；缺省由 core ingest 时刻兜底 */
  receivedAt?: number;
}

export type MediaKind = "image" | "voice" | "video" | "file";

/** 媒体来源（上传用；传输自足——MCP 服务可能与智能体不同机，不收智能体侧本地路径） */
export type MediaSourceWire =
  | { kind: "url"; url: string }
  | { kind: "b64"; data: string }
  | { kind: "file"; path: string };

/** 发送侧媒体引用：handle = net.uploadMedia 返回的素材句柄（如 QQ file_info，TTL 24h） */
export interface MediaWire {
  kind: MediaKind;
  handle: string;
  fileName?: string;
}

/** 会话形态标签（caps.scopes 词汇，如 "group" | "c2c" | "chat"）；core 探测后随 wire 下发 */
export type SessionScope = string;

/** 被动回复（passiveWindow=true 平台）：msgId/msgSeq 由 core 幂等账本保证 */
export interface ReplyWire {
  botId: string;
  /** 目标会话 id（core 语义层的会话标识） */
  target: string;
  /** 会话形态标签（connector 映射到协议侧 scope，如 QQ: chat→c2c） */
  scope: SessionScope;
  /** 最终文案（core 已组装；connector 不再加工） */
  content: string;
  msgId?: string;
  msgSeq?: number;
  /** markdown 语义（QQ: msg_type=2；不支持的平台忽略） */
  markdown?: boolean;
  /** 引用块目标（客户端引用样式；QQ: message_reference） */
  quoteMsgId?: string;
  media?: MediaWire;
}

/** 主动发送（任意平台可用；passiveWindow=false 平台的唯一发送通道） */
export interface ProactiveWire {
  botId: string;
  target: string;
  scope: SessionScope;
  content: string;
  /** markdown 语义（QQ: msg_type=2；不支持的平台忽略），与 ReplyWire.markdown 同义 */
  markdown?: boolean;
  quoteMsgId?: string;
  media?: MediaWire;
}

export interface RecallWire {
  botId: string;
  target: string;
  scope: SessionScope;
  providerMsgId: string;
}

export interface UploadMediaWire {
  botId: string;
  /** 上传目标会话（官方素材句柄按会话绑定，如 QQ file_info） */
  target: string;
  scope: SessionScope;
  kind: MediaKind;
  source: MediaSourceWire;
  fileName?: string;
}

export interface SendReceipt {
  providerMsgId: string;
}

// ---------------------------------------------------------------------------
// 宿主面（HostApi）：前端暴露给后端的唯一接口。插件代码只允许触碰这些。
// （第三道闸门「管线不可绕过」是结构性的：ctx/host 类型里没有 DB、没有 fastify、
//  没有 repo——想绕过管线在类型上就不可表达。）
// ---------------------------------------------------------------------------

/**
 * 跨重启状态：值 = JSON 文本，消费方用 parseJsonWith + 具体 schema 解析。
 * 宿主实现落 SQLite kv；缺失返回 null，坏数据由消费方的 schema 解析失败兜底。
 */
export interface StatePort {
  /** 缺失返回 null；值为 JSON 文本 */
  get(key: string): Promise<string | null>;
  /** 写入 JSON 文本（调用侧 JSON.stringify） */
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HostApi {
  /** 已按 (plugin, bot) 分域的日志器（core 侧脱敏兜底照常生效） */
  log: ConnectorLogger;
  /** bot 作用域 StatePort（宿主实现负责命名空间隔离与持久化） */
  state: StatePort;
  /** 后端唯一上行出口：规范化/去重/入库全在 core 侧发生。
   * 泛型 P = 插件自有信封类型（须携带 platform 键）——结构化上行不丢字段。 */
  ingest<P extends RawEnvelope>(e: RawInbound<P>): void;
  /** 连接生命周期状态上报（宿主聚合展示：/healthz、WebUI bootstrap、设置页） */
  reportStatus(s: ConnectorStatus): void;
}

/** 连接生命周期状态（宿主无关的平台中立形状） */
export interface ConnectorStatus {
  state: "ready" | "resumed" | "disconnected" | "fatal";
  detail?: string;
}

// ---------------------------------------------------------------------------
// 凭据与插件声明面
// ---------------------------------------------------------------------------

export interface BotCreds {
  /** bots 表主键（core 分配；QQ 现状= appid） */
  botId: string;
  /** = plugin.id */
  platform: string;
  /** credentialSchema 驱动的键值对（密钥键清单见 plugin.credentialSecrets） */
  credential: Record<string, string>;
}

/**
 * 每 bot 平台配置快照（宿主提供）：bots 注册表字段与全局发送开关的只读投影。
 * 插件不得假设可选键的存在性。
 */
export interface BotConfigSnapshot {
  authLevel?: string;
  allowGroups?: string[];
  sendEnabled?: boolean;
  name?: string;
}

/** 登录流声明：WebUI 按此渲染（表单 / 扫码轮询） */
export type LoginFlowDecl =
  /** 纯凭据表单（credentialSchema 渲染；QQ 缺省） */
  | { kind: "secret" }
  /** 扫码配对：create/poll 指向插件 webui 路由的 path（加载时校验存在） */
  | { kind: "qr-pair"; create: string; poll: string };

export type WebuiMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * 插件 webui 路由返回值的最小契约：core 只读 `task_id` 记日志（扫码任务关联），
 * 其余字段原样 JSON 序列化给前端。插件路由用自有返回接口 extends 本契约
 * （结构类型：子集可赋值，字面量不触发多余属性检查）。
 */
export interface WebuiRouteOut {
  /** 扫码配对任务 id（create 路由返回；core 日志用） */
  task_id?: string;
}

/**
 * qr-pair 登录协议的路由返回契约（login.kind="qr-pair" 是 SDK 契约——
 * core 注册中介依赖 poll 产物形状，故形状在本层定义，平台插件复用）。
 * completed 分支的 credential 只交回宿主（core 拦截 → verifyCredential → 注册），
 * 绝不下发浏览器。
 */
export interface QrPairCreateOut extends WebuiRouteOut {
  task_id: string;
  /** 浏览器侧连接端点（SSE/轮询地址，前端展示二维码用） */
  connect_url: string;
  /** 建议轮询间隔秒 */
  interval_s: number;
}

export type QrPairPollOut = WebuiRouteOut &
  (
    | { status: "pending" }
    | { status: "expired" }
    | {
        status: "completed";
        /** 平台凭据键值对（credentialSchema 形状；core 拦截，不下发浏览器） */
        credential: Record<string, string>;
        /** 扫码确认人平台侧 openid（留档展示；可省） */
        user_openid?: string;
      }
  );

/** QrPairPollOut 的 wire schema：core 注册中介对插件 poll 产物做形状校验
 * （防御连接器实现 bug——违反协议 → 可操作错误而非静默坏数据） */
export const QrPairPollOutSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("completed"),
    credential: z.record(z.string(), z.string()),
    user_openid: z.string().optional(),
  }),
]);

/**
 * core 代理点喂给 webui 路由的原始输入（控制反转）：body 只以 JSON 文本跨界
 * （序列化点显式在 core 侧 JSON.stringify），schema 解析在 webuiRoute 工厂
 * 闭包内完成——具体 body 类型从不越过本输入接口。
 */
export interface PluginWebuiInput {
  /** 插件前缀剥离后的实际路径（已解码） */
  path: string;
  /** 路径参数（":name" 段） */
  params: Record<string, string>;
  query: Record<string, string>;
  /** 原始请求体 JSON 文本；无 body 时 undefined */
  rawBody: string | undefined;
  /** 按 bot 解析平台配置快照（bot 选择由路由自决，如 ?bot= 约定键） */
  configOf(botId: string): BotConfigSnapshot;
  /** 按 bot 解析 StatePort（插件计数器/私有状态读写） */
  stateOf(botId: string): StatePort;
}

/** 插件 WebUI 路由 handler 视角的请求（body = 该路由 bodySchema 的解析产物） */
export interface PluginWebuiRequest<B = undefined> {
  method: WebuiMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** 该路由 bodySchema 的解析产物（schema 即类型；未声明 schema 的路由恒 undefined） */
  body: B;
  configOf(botId: string): BotConfigSnapshot;
  stateOf(botId: string): StatePort;
}

/**
 * 插件 WebUI 路由（统一接口，非泛型）：异构路由的 body 类型 B 经 webuiRoute
 * 工厂绑定在 handle 闭包内——core 代理点只喂 PluginWebuiInput（JSON 文本），
 * 不经手任何具体 body 类型。
 */
export interface PluginWebuiRoute {
  method: WebuiMethod;
  /** 相对路径，以 / 开头；":name" 段为路径参数 */
  path: string;
  /** WebUI 展示用摘要 */
  summary?: string;
  /**
   * 控制反转入口：core 代理点以原始输入调用；形状违规抛 ConnectorError(400)，
   * 产物经 PluginWebuiRequest<B>.body 交给 handler（均在工厂闭包内完成）。
   */
  handle(input: PluginWebuiInput): Promise<WebuiRouteOut>;
}

/**
 * 插件工具声明（统一接口，非泛型）：异构工具的 args 类型 A 经 pluginTool
 * 工厂绑定在 call 闭包内——core 分发点只喂 MCP arguments 的 JSON 文本，
 * 不经手任何具体 args 类型。
 */
export interface PluginToolDecl {
  /** MCP 工具名；不得与基座保留名冲突、不得跨插件重复 */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * 控制反转入口：rawArgs = MCP arguments 的 JSON 文本（无参调用 undefined）；
   * argsSchema 解析（失败 → isError 可操作文案）与 run 调用在工厂闭包内完成。
   */
  call(rawArgs: string | undefined, ctx: PluginToolCtx): Promise<ToolPayload>;
}

export interface ProactiveVerdict {
  ok: boolean;
  /** 拒绝原因（面向 AI / 用户，可操作） */
  reason?: string;
}

/** 钩子调用上下文（宿主按 bot 解析后传入；插件经此触达 StatePort/配置） */
export interface PluginHookCtx {
  host: HostApi;
  config: BotConfigSnapshot;
}

export interface ConnectorHooks {
  /** 注册凭据校验（QQ：token+网关地址两级，防 11298 假阳性）。失败 throw（文案可操作） */
  verifyCredential?(credential: Record<string, string>): Promise<void>;
  /** 主动发送门禁（QQ：令牌桶+日额度）。send 语义层在 core，门禁回调在这里 */
  proactiveGate?(
    ctx: PluginHookCtx,
    botId: string,
    target: string,
  ): Promise<ProactiveVerdict>;
  /** 主动发送受理成功记账（QQ：日额度语义；私有状态经 StatePort 落地）。core 会 await */
  proactiveRecord?(
    ctx: PluginHookCtx,
    botId: string,
    target: string,
  ): void | Promise<void>;
}

export interface PluginToolCtx {
  host: HostApi;
  botId: string;
  /** 每 bot 平台配置快照（宿主提供） */
  config: BotConfigSnapshot;
}

/**
 * 平台扩展工具入参（控制反转）：A 由 pluginTool 工厂的 argsSchema 绑定，
 * call 闭包内流转——core 分发点只见 JSON 文本。
 */
export interface PluginToolDecl {
  /** MCP 工具名；不得与基座保留名冲突、不得跨插件重复 */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * 控制反转入口：rawArgs = MCP arguments 的 JSON 文本（无参调用 undefined）；
   * argsSchema 解析（失败 → isError 可操作文案）与 run 调用在工厂闭包内完成。
   */
  call(rawArgs: string | undefined, ctx: PluginToolCtx): Promise<ToolPayload>;
}

// ---------------------------------------------------------------------------
// 网络面（ConnectorInstance）：纯网络连接生命周期 + 协议级原语
// ---------------------------------------------------------------------------

export interface ConnectorNet {
  /** passiveWindow=true 平台必备 */
  reply?(req: ReplyWire): Promise<SendReceipt>;
  /** 全平台可用；passiveWindow=false 平台唯一发送通道 */
  proactive?(req: ProactiveWire): Promise<SendReceipt>;
  /** caps.recall=true 时必备 */
  recall?(req: RecallWire): Promise<void>;
  /** caps.media 任一为 true 时必备 */
  uploadMedia?(req: UploadMediaWire): Promise<{ handle: string }>;
}

export interface ConnectorInstance {
  start(): Promise<void>;
  /** 同步停（排空由宿主等待 start() 的 promise 兜底，同现 GatewaySupervisor 纪律） */
  stop(): void;
  net: ConnectorNet;
}

// ---------------------------------------------------------------------------
// 插件（声明面）：分仓包默认导出
// ---------------------------------------------------------------------------

/**
 * 发送错误语义：平台官方错误码 → core 中立词汇 + 平台自包含文案
 * （core i18n 不翻译平台错误码）。bizCode 字段约定是 core 与各连接器共用的
 * 通用协议。
 */
export interface SendErrorSemantics {
  /** 平台判定：受理进入人工审核（core 置 pending_audit 等平台事件回填，勿重发） */
  isAuditPending?(e: Error): boolean;
  /** 平台判定：markdown 无权限（core 自动降级纯文本重试一次） */
  isMarkdownDowngrade?(e: Error): boolean;
  /** 平台文案：可操作错误解释（含官方码语义）；未登记码返回 undefined → core 通用兜底 */
  describe?(e: Error): string | undefined;
}

export interface ConnectorPlugin {
  /** 平台 id：/^[a-z][a-z0-9-]*$/；保留字 "core" 禁用 */
  id: string;
  /** 兼容契约版本范围（semver-lite：^ ~ >= 精确 *，空格 AND）；加载时校验 */
  sdkRange: string;
  /** 展示名（WebUI 用，如 "QQ 官方机器人"） */
  title: string;
  caps: PlatformCaps;
  /**
   * 发送错误语义：平台官方错误 → core 中立词汇。
   * core 发送器按「先问插件、后通用兜底」次序使用；未声明=平台无对应语义
   * （如 Telegram 无审核/降级概念），全部走 core 通用文案。
   */
  sendError?: SendErrorSemantics;
  /** 「添加机器人」表单 schema（WebUI 动态渲染） */
  credentialSchema: JsonSchema;
  /** 密钥键清单：WebUI password 渲染 + 日志/错误脱敏 */
  credentialSecrets: string[];
  login?: LoginFlowDecl;
  tools?: PluginToolDecl[];
  /** 插件声明的 WebUI 路由：core 挂 /ui/api/platforms/{id}/*，admin 鉴权沿用 */
  webui?: PluginWebuiRoute[];
  hooks?: ConnectorHooks;
  /**
   * 上行解读：原始载荷信封 → 成品消息 + 会话效应。
   * core ingest 按 payload.platform 表驱动路由到此（路由已保证 platform 匹配本
   * 插件）；载荷完整形状由插件侧 wire schema safeParse 把关。返回 null = 载荷
   * 无法解读/无需落地；parser 抛错由 core 捕获并 warn。
   */
  normalize(botId: string, payload: RawEnvelope): NormalizedInbound | null;
  /**
   * 实例工厂：ctx = PluginContext（HostApi + net）。结构类型兼容只声明
   * (host: HostApi) 的实现，后者可忽略 net。
   */
  create(ctx: PluginContext, creds: BotCreds): ConnectorInstance;
}

/** 宿主注入面：HostApi + NetKit；对仅依赖 HostApi 的实现保持结构兼容 */
export interface PluginContext extends HostApi {
  /** 协议无关传输机械（超时/中止/重试/节流/物化/嗅探/休眠/长轮询驱动） */
  readonly net: NetKit;
}

/** loadModule 传给插件工厂的宿主 init（工厂据此建自有服务，如 TokenService） */
export interface PluginModuleInit {
  /** 宿主根日志器（插件 child 分域自理） */
  log?: ConnectorLogger;
}

/**
 * 分仓包默认导出的工厂形态（推荐）：宿主注入 init 后产出声明面对象。
 * 默认导出也可以是直接的 ConnectorPlugin 对象（无 init 需求的纯声明插件）。
 */
export type ConnectorPluginFactory = (
  init?: PluginModuleInit,
) => ConnectorPlugin | Promise<ConnectorPlugin>;

// ---------------------------------------------------------------------------
// 插件侧错误：经 core 管线规范化（WebUI → status；MCP → isError 文案）
// ---------------------------------------------------------------------------

export class ConnectorError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
  }
}
