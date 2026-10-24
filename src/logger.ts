// 结构化 JSON 行日志（零依赖，输出到 stdout，供 journald/Docker 直接采集）。
// 硬约束「日志不得泄露消息正文」：除调用侧纪律外，这里对敏感键做兜底剥离（含嵌套对象），
// 命中即替换为 [REDACTED]。敏感键清单随里程碑扩充（messages 表字段为准）。

export type Level = "debug" | "info" | "warn" | "error" | "fatal";

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

export function createLogger(level: Level = "info", mod = "main"): Logger {
  const threshold = LEVELS[level];
  const emit = (
    lvl: Level,
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level: lvl,
      mod,
      msg,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    });
    process.stdout.write(line + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    fatal: (m, f) => emit("fatal", m, f),
    child: (m) => createLogger(level, `${mod}:${m}`),
  };
}

export function levelFromEnv(
  raw: string | undefined,
  fallback: Level = "info",
): Level {
  const v = raw?.toLowerCase();
  return v && v in LEVELS ? (v as Level) : fallback;
}
