// 声明面闸门：插件注册/加载前的全量校验。
//
// 三道闸门对应关系：
// 1. 保留名校验 —— validatePluginTool（BASE_TOOL_NAMES 硬冲突即拒）
// 2. inputSchema 合法性校验 —— validatePluginTool / validateCredentialSchema
// 3. 管线不可绕过 —— 结构性闸门（PluginToolCtx/HostApi 类型里没有 DB/reply），
//    无法运行时校验，靠类型契约表达；本文件注释即为规格。

import {
  type ConnectorPlugin,
  type LoginFlowDecl,
  type PlatformCaps,
  type PluginWebuiRoute,
  RESERVED_TOOL_NAMES,
  SDK_VERSION,
} from "./types";
import { satisfiesRange } from "./semver";

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
const SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "DELETE"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// JSON Schema 结构合法性（务实深度：类型/properties/required 一致性）
// ---------------------------------------------------------------------------

export function validateJsonSchema(schema: unknown, label: string): void {
  if (!isPlainObject(schema)) {
    throw new GateError(`${label}：必须是 JSON Schema 对象。`);
  }
  if (schema.type !== undefined && schema.type !== "object") {
    throw new GateError(
      `${label}：顶层 type 必须为 "object"（工具参数/凭据表单都是对象）。`,
    );
  }
  const props = schema.properties;
  if (props !== undefined) {
    if (!isPlainObject(props)) {
      throw new GateError(`${label}：properties 必须是对象。`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (!isPlainObject(sub)) {
        throw new GateError(`${label}：属性 ${key} 的 schema 必须是对象。`);
      }
      if (
        sub.type !== undefined &&
        (typeof sub.type !== "string" || !SCHEMA_TYPES.has(sub.type))
      ) {
        throw new GateError(
          `${label}：属性 ${key} 的 type 非法（${JSON.stringify(sub.type)}）。`,
        );
      }
    }
  }
  const required = schema.required;
  if (required !== undefined) {
    if (
      !Array.isArray(required) ||
      required.some((k) => typeof k !== "string")
    ) {
      throw new GateError(`${label}：required 必须是字符串数组。`);
    }
    if (!isPlainObject(props)) {
      throw new GateError(
        `${label}：required 必须与 properties 配套（properties 缺失）。`,
      );
    }
    const missing = required.filter(
      (k) => !Object.prototype.hasOwnProperty.call(props, k),
    );
    if (missing.length > 0) {
      throw new GateError(
        `${label}：required 引用了不存在的属性：${missing.join(", ")}。`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// credentialSchema：类型 + 密钥键清单一致性
// ---------------------------------------------------------------------------

export function validateCredentialSchema(
  schema: unknown,
  credentialSecrets: string[],
): void {
  validateJsonSchema(schema, "credentialSchema");
  const props = isPlainObject(schema)
    ? (schema.properties as Record<string, unknown> | undefined)
    : undefined;
  for (const secret of credentialSecrets) {
    if (typeof secret !== "string" || secret === "") {
      throw new GateError("credentialSecrets：密钥键必须是非空字符串。");
    }
    if (props && !Object.prototype.hasOwnProperty.call(props, secret)) {
      throw new GateError(
        `credentialSecrets：密钥键 ${secret} 不在 credentialSchema.properties 中。`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 插件工具：保留名 + 命名规范 + schema 合法性
// ---------------------------------------------------------------------------

export function validatePluginTool(tool: unknown): void {
  if (!isPlainObject(tool)) {
    throw new GateError("插件工具声明必须是对象。");
  }
  const { name, description, inputSchema, handler } = tool as {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    handler?: unknown;
  };
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
    throw new GateError(
      `插件工具名非法：${JSON.stringify(name)}（须匹配 ${TOOL_NAME_RE}）。`,
    );
  }
  if (RESERVED_TOOL_NAMES.has(name)) {
    throw new GateError(
      `插件工具与基座保留名冲突：${name}（基座 14 工具名为核心保留）。`,
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new GateError(`插件工具 ${name}：description 必须非空。`);
  }
  validateJsonSchema(inputSchema, `工具 ${name} 的 inputSchema`);
  if (typeof handler !== "function") {
    throw new GateError(`插件工具 ${name}：handler 必须是函数。`);
  }
}

// ---------------------------------------------------------------------------
// 插件 WebUI 路由：method 合法、path 规范、插件内唯一
// ---------------------------------------------------------------------------

function normalizeRoutePath(path: string): string {
  const segs = path.split("/").filter((s) => s !== "");
  return `/${segs.join("/")}`;
}

function validateRoutePath(path: unknown, label: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new GateError(`${label}：path 必须以 / 开头。`);
  }
  if (path.includes("//") || path.includes("?") || path.includes("#")) {
    throw new GateError(`${label}：path 含非法字符（// ? #）：${path}`);
  }
  return normalizeRoutePath(path);
}

export function validateWebuiRoutes(routes: PluginWebuiRoute[]): void {
  const seen = new Set<string>();
  for (const r of routes) {
    if (!METHODS.has(r.method)) {
      throw new GateError(
        `webui 路由 method 非法：${String(r.method)}（允许 GET/POST/PUT/DELETE）。`,
      );
    }
    const norm = validateRoutePath(r.path, `webui 路由 ${r.method}`);
    const key = `${r.method} ${norm}`;
    if (seen.has(key)) {
      throw new GateError(`webui 路由重复：${key}`);
    }
    seen.add(key);
    if (typeof r.handler !== "function") {
      throw new GateError(`webui 路由 ${key}：handler 必须是函数。`);
    }
  }
}

/** login 声明引用的 qr-pair 路由必须真实存在（POST） */
export function validateLoginFlow(
  login: LoginFlowDecl | undefined,
  routes: PluginWebuiRoute[],
): void {
  if (login === undefined) return;
  if (login.kind === "secret") return;
  if (login.kind !== "qr-pair") {
    throw new GateError(
      `login.kind 非法：${JSON.stringify((login as { kind?: unknown }).kind)}。`,
    );
  }
  const norm = (p: unknown, label: string): string =>
    validateRoutePath(p, `login.qr-pair.${label}`);
  const create = norm(login.create, "create");
  const poll = norm(login.poll, "poll");
  const have = new Set(
    routes
      .filter((r) => r.method === "POST")
      .map((r) => normalizeRoutePath(r.path)),
  );
  for (const [label, p] of [
    ["create", create],
    ["poll", poll],
  ] as const) {
    if (!have.has(p)) {
      throw new GateError(
        `login.qr-pair.${label} 引用的路由 POST ${p} 不在 webui 路由表中。`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

function validateCaps(caps: unknown): void {
  if (!isPlainObject(caps)) {
    throw new GateError("caps 必须是对象。");
  }
  const c = caps as Partial<PlatformCaps>;
  if (
    !Array.isArray(c.scopes) ||
    c.scopes.length === 0 ||
    c.scopes.some((s) => typeof s !== "string" || s.trim() === "")
  ) {
    throw new GateError(
      "caps.scopes 必须是非空字符串数组（会话形态标签，如 group/c2c/chat）。",
    );
  }
  if (!isPlainObject(c.media)) {
    throw new GateError("caps.media 必须是对象（image/voice/video/file 四布尔）。");
  }
  for (const k of ["image", "voice", "video", "file"] as const) {
    if (typeof (c.media as Record<string, unknown>)[k] !== "boolean") {
      throw new GateError(`caps.media.${k} 必须是布尔。`);
    }
  }
  for (const k of ["recall", "passiveWindow", "quota", "proactiveOptIn"] as const) {
    if (typeof c[k] !== "boolean") {
      throw new GateError(`caps.${k} 必须是布尔。`);
    }
  }
}

// ---------------------------------------------------------------------------
// 全量校验：register / loadModule 前必过
// ---------------------------------------------------------------------------

export function validatePlugin(plugin: unknown): ConnectorPlugin {
  if (!isPlainObject(plugin)) {
    throw new GateError("connector 插件默认导出必须是对象。");
  }
  const p = plugin as Partial<ConnectorPlugin> & Record<string, unknown>;

  if (typeof p.id !== "string" || !PLUGIN_ID_RE.test(p.id)) {
    throw new GateError(
      `插件 id 非法：${JSON.stringify(p.id)}（须匹配 ${PLUGIN_ID_RE}）。`,
    );
  }
  if (p.id === "core") {
    throw new GateError('插件 id "core" 是宿主保留字。');
  }
  if (typeof p.sdkRange !== "string" || p.sdkRange.trim() === "") {
    throw new GateError(`插件 ${p.id}：sdkRange 必须非空（如 "^2.0.0"）。`);
  }
  if (!satisfiesRange(SDK_VERSION, p.sdkRange)) {
    throw new GateError(
      `插件 ${p.id} 声明的 sdkRange "${p.sdkRange}" 与宿主契约版本 ` +
        `${SDK_VERSION} 不兼容：请升级 connector-sdk 或插件本体。`,
    );
  }
  if (typeof p.title !== "string" || p.title.trim() === "") {
    throw new GateError(`插件 ${p.id}：title 必须非空。`);
  }
  validateCaps(p.caps);
  validateCredentialSchema(p.credentialSchema, p.credentialSecrets ?? []);

  const secrets = p.credentialSecrets ?? [];
  if (
    !Array.isArray(secrets) ||
    secrets.some((s) => typeof s !== "string" || s === "")
  ) {
    throw new GateError(`插件 ${p.id}：credentialSecrets 必须是非空字符串数组。`);
  }

  const tools = p.tools ?? [];
  if (!Array.isArray(tools)) {
    throw new GateError(`插件 ${p.id}：tools 必须是数组。`);
  }
  const names = new Set<string>();
  for (const tool of tools) {
    validatePluginTool(tool);
    const name = (tool as { name: string }).name;
    if (names.has(name)) {
      throw new GateError(`插件 ${p.id}：工具名插件内重复：${name}。`);
    }
    names.add(name);
  }

  const webui = p.webui ?? [];
  if (!Array.isArray(webui)) {
    throw new GateError(`插件 ${p.id}：webui 必须是数组。`);
  }
  validateWebuiRoutes(webui as PluginWebuiRoute[]);
  validateLoginFlow(p.login, webui as PluginWebuiRoute[]);

  if (typeof p.create !== "function") {
    throw new GateError(`插件 ${p.id}：create(host, creds) 必须是函数。`);
  }
  // 契约 v2（决策 #8）：上行解读权在插件——normalize 缺位 = 该平台消息无法进
  // core 管线，加载即拒（显态失败优于运行期静默丢消息）。
  if (typeof p.normalize !== "function") {
    throw new GateError(
      `插件 ${p.id}：normalize(botId, payload) 必须是函数（契约 v2：上行解读权在插件）。`,
    );
  }

  return plugin as unknown as ConnectorPlugin;
}
