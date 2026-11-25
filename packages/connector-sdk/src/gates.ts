// 声明面闸门：插件注册/加载前的全量校验。
//
// 三道闸门对应关系：
// 1. 保留名校验 —— validatePluginTool（BASE_TOOL_NAMES 硬冲突即拒）
// 2. inputSchema 合法性校验 —— validatePluginTool / validateCredentialSchema
// 3. 管线不可绕过 —— 结构性闸门（PluginToolCtx/HostApi 类型里没有 DB/reply），
//    无法运行时校验，靠类型契约表达；本文件注释即为规格。
//
// 入参使用具体契约类型（ConnectorPlugin / JsonSchema / …）。加载边界（loadModule
// 动态 import）的不可信形状先由 registry.ts 的 zod custom 收口；本文件的
// typeof/形状检查是运行时防线，覆盖 JS 插件与越过静态类型的动态面。

import {
  type ConnectorPlugin,
  type JsonSchema,
  type LoginFlowDecl,
  type PlatformCaps,
  type PluginToolDecl,
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

/** 运行时防线：待验值必须是普通对象（动态边界产物不信任静态标注）。
 * 泛型无约束参数 = 接受任何值做形状检查（调用点保留具体类型视角）。 */
function isPlainObject<T>(v: T): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// JSON Schema 结构合法性（务实深度：类型/properties/required 一致性）
// ---------------------------------------------------------------------------

export function validateJsonSchema(schema: JsonSchema, label: string): void {
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
    const props = schema.properties;
    if (props === undefined || !isPlainObject(props)) {
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
  schema: JsonSchema,
  credentialSecrets: string[],
): void {
  validateJsonSchema(schema, "credentialSchema");
  const props = schema.properties;
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

export function validatePluginTool(tool: PluginToolDecl): void {
  if (!isPlainObject(tool)) {
    throw new GateError("插件工具声明必须是对象。");
  }
  const { name, description, inputSchema, call } = tool;
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
    throw new GateError(
      `插件工具名非法：${JSON.stringify(name)}（须匹配 ${TOOL_NAME_RE}）。`,
    );
  }
  if (RESERVED_TOOL_NAMES.has(name)) {
    throw new GateError(
      `插件工具与基座保留名冲突：${name}（基座工具名为核心保留）。`,
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new GateError(`插件工具 ${name}：description 必须非空。`);
  }
  validateJsonSchema(inputSchema, `工具 ${name} 的 inputSchema`);
  if (typeof call !== "function") {
    throw new GateError(`插件工具 ${name}：call 必须是函数。`);
  }
}

// ---------------------------------------------------------------------------
// 插件 WebUI 路由：method 合法、path 规范、插件内唯一
// ---------------------------------------------------------------------------

function normalizeRoutePath(path: string): string {
  const segs = path.split("/").filter((s) => s !== "");
  return `/${segs.join("/")}`;
}

function validateRoutePath(path: string, label: string): string {
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
    if (typeof r.handle !== "function") {
      throw new GateError(`webui 路由 ${key}：handle 必须是函数。`);
    }
  }
}

/** login 声明引用的 qr-pair 路由必须真实存在（POST） */
export function validateLoginFlow(
  login: LoginFlowDecl | undefined,
  routes: PluginWebuiRoute[],
): void {
  if (login === undefined) return;
  const kind: string = login.kind; // 运行时值先取（动态边界产物可能越出词表）
  if (login.kind === "secret") return;
  if (kind !== "qr-pair") {
    throw new GateError(`login.kind 非法：${JSON.stringify(kind)}。`);
  }
  const norm = (p: string, label: string): string =>
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

function validateCaps(caps: PlatformCaps): void {
  if (!isPlainObject(caps)) {
    throw new GateError("caps 必须是对象。");
  }
  if (
    !Array.isArray(caps.scopes) ||
    caps.scopes.length === 0 ||
    caps.scopes.some((s) => typeof s !== "string" || s.trim() === "")
  ) {
    throw new GateError(
      "caps.scopes 必须是非空字符串数组（会话形态标签，如 group/c2c/chat）。",
    );
  }
  if (!isPlainObject(caps.media)) {
    throw new GateError("caps.media 必须是对象（image/voice/video/file 四布尔）。");
  }
  for (const k of ["image", "voice", "video", "file"] as const) {
    if (typeof caps.media[k] !== "boolean") {
      throw new GateError(`caps.media.${k} 必须是布尔。`);
    }
  }
  for (const k of ["recall", "passiveWindow", "quota", "proactiveOptIn"] as const) {
    if (typeof caps[k] !== "boolean") {
      throw new GateError(`caps.${k} 必须是布尔。`);
    }
  }
}

// ---------------------------------------------------------------------------
// 全量校验：register / loadModule 前必过
// ---------------------------------------------------------------------------

export function validatePlugin(plugin: ConnectorPlugin): ConnectorPlugin {
  if (!isPlainObject(plugin)) {
    throw new GateError("connector 插件默认导出必须是对象。");
  }

  if (typeof plugin.id !== "string" || !PLUGIN_ID_RE.test(plugin.id)) {
    throw new GateError(
      `插件 id 非法：${JSON.stringify(plugin.id)}（须匹配 ${PLUGIN_ID_RE}）。`,
    );
  }
  if (plugin.id === "core") {
    throw new GateError('插件 id "core" 是宿主保留字。');
  }
  if (typeof plugin.sdkRange !== "string" || plugin.sdkRange.trim() === "") {
    throw new GateError(`插件 ${plugin.id}：sdkRange 必须非空（如 "^2.0.0"）。`);
  }
  if (!satisfiesRange(SDK_VERSION, plugin.sdkRange)) {
    throw new GateError(
      `插件 ${plugin.id} 声明的 sdkRange "${plugin.sdkRange}" 与宿主契约版本 ` +
        `${SDK_VERSION} 不兼容：请升级 connector-sdk 或插件本体。`,
    );
  }
  if (typeof plugin.title !== "string" || plugin.title.trim() === "") {
    throw new GateError(`插件 ${plugin.id}：title 必须非空。`);
  }
  validateCaps(plugin.caps);
  validateCredentialSchema(plugin.credentialSchema, plugin.credentialSecrets ?? []);

  const secrets = plugin.credentialSecrets ?? [];
  if (
    !Array.isArray(secrets) ||
    secrets.some((s) => typeof s !== "string" || s === "")
  ) {
    throw new GateError(`插件 ${plugin.id}：credentialSecrets 必须是非空字符串数组。`);
  }

  const tools = plugin.tools ?? [];
  if (!Array.isArray(tools)) {
    throw new GateError(`插件 ${plugin.id}：tools 必须是数组。`);
  }
  const names = new Set<string>();
  for (const tool of tools) {
    validatePluginTool(tool);
    const name = tool.name;
    if (names.has(name)) {
      throw new GateError(`插件 ${plugin.id}：工具名插件内重复：${name}。`);
    }
    names.add(name);
  }

  const webui = plugin.webui ?? [];
  if (!Array.isArray(webui)) {
    throw new GateError(`插件 ${plugin.id}：webui 必须是数组。`);
  }
  validateWebuiRoutes(webui);
  validateLoginFlow(plugin.login, webui);

  if (typeof plugin.create !== "function") {
    throw new GateError(`插件 ${plugin.id}：create(host, creds) 必须是函数。`);
  }
  // 上行解读权在插件：normalize 缺位会使该平台消息无法进入 core 管线，因此加载
  // 即拒，显式失败优于运行期静默丢消息。
  if (typeof plugin.normalize !== "function") {
    throw new GateError(
      `插件 ${plugin.id}：normalize(botId, payload) 必须是函数（上行解读权在插件）。`,
    );
  }

  return plugin;
}
