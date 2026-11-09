// 日志（零依赖，输出到 stdout）。两种格式：
// - pretty（缺省）：loguru 风格人类可读行，TTY 下带 ANSI 着色（NO_COLOR/FORCE_COLOR 可控）
// - json：结构化 JSON 行，供 journald / Docker 等采集端解析（部署环境显式 LOG_FORMAT=json）
// 硬约束「日志不得泄露消息正文」：除调用侧纪律外，这里对敏感键做兜底剥离（含嵌套对象），
// 命中即替换为 [REDACTED]。敏感键清单随里程碑扩充（messages 表字段为准）。

export type Level = "debug" | "info" | "warn" | "error" | "fatal";
export type LogFormat = "pretty" | "json";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const SENSITIVE_KEYS = new Set([
  // 消息内容类（LOG_CONTENT=false 时不允许出现在日志里）
  "content",
  "text",
  "raw",
  "raw_json",
  "markdown",
  "elements_json",
  "attachments_json",
  "mentions_json",
  "ark_json",
  // 密钥类（无论如何都不允许）
  "secret",
  "clientsecret",
  "appsecret",
  "token",
  "authorization",
  "password",
]);

/** 深度剥离敏感键（测试直连此函数）。depth 限 4 层，足够覆盖日志 fields 的嵌套。 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase())
      ? "[REDACTED]"
      : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  fatal(msg: string, fields?: Record<string, unknown>): void;
  /** 子日志器：模块前缀，级别继承 */
  child(mod: string): Logger;
}

// —— pretty 格式：loguru 风格 ——

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const LEVEL_COLOR: Record<Level, string> = {
  debug: GRAY,
  info: CYAN,
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[1;31m",
};

/** 颜色开关：NO_COLOR / FORCE_COLOR=0 关；FORCE_COLOR 强制开；否则仅 TTY 且支持色彩 */
function detectColor(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0";
  if (process.env.NO_COLOR !== undefined) return false;
  const out = process.stdout as {
    isTTY?: boolean;
    hasColors?: (depth?: number) => boolean;
  };
  return out.isTTY === true && (out.hasColors?.() ?? true);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地时间 YYYY-MM-DD HH:mm:ss.SSS（loguru 缺省风格） */
function localTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.` +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

const fmtValue = (v: unknown): string =>
  typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));

const renderPretty = (
  lvl: Level,
  mod: string,
  msg: string,
  fields: Record<string, unknown> | undefined,
  color: boolean,
): string => {
  /** 着色助手：color=false 时输出纯文本（管道/重定向不落转义符） */
  const c = (code: string, s: string): string =>
    color ? code + s + RESET : s;
  const bar = color ? `${GRAY} | ${RESET}` : " | ";
  const fieldsOut = Object.entries(fields ?? {}).filter(
    ([, v]) => v !== undefined,
  );
  const line =
    c(GREEN, localTimestamp(new Date())) +
    bar +
    c(LEVEL_COLOR[lvl], lvl.toUpperCase().padEnd(5)) +
    bar +
    c(CYAN, mod) +
    (color ? `${GRAY} - ${RESET}` : " - ") +
    c(LEVEL_COLOR[lvl], msg);
  if (fieldsOut.length === 0) return line;
  const flat = fieldsOut.map(([k, v]) => `${k}=${fmtValue(v)}`).join(" ");
  return `${line} ${c(GRAY, flat)}`;
};

export function createLogger(
  level: Level = "info",
  mod = "main",
  format: LogFormat = "pretty",
): Logger {
  const threshold = LEVELS[level];
  const emit = (
    lvl: Level,
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVELS[lvl] < threshold) return;
    const clean = fields ? (redact(fields) as Record<string, unknown>) : undefined;
    const line =
      format === "json"
        ? JSON.stringify({
            t: new Date().toISOString(),
            level: lvl,
            mod,
            msg,
            ...(clean ?? {}),
          })
        : renderPretty(lvl, mod, msg, clean, detectColor());
    process.stdout.write(line + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    fatal: (m, f) => emit("fatal", m, f),
    child: (m) => createLogger(level, `${mod}:${m}`, format),
  };
}

export function levelFromEnv(
  raw: string | undefined,
  fallback: Level = "info",
): Level {
  const v = raw?.toLowerCase();
  return v && v in LEVELS ? (v as Level) : fallback;
}
