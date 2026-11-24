// 配置加载与校验
//
// config.toml 是唯一的服务配置，配置只在启动时读取一次。
// - 部署拓扑（host/port/data_dir/ui_dist_dir）
// - 日志（log_content/log_level/log_format）
// - 连接器声明（[connectors.*]，解析委托 decl.ts）
//
// 服务运行不读任何环境变量
// （例外：终端着色 NO_COLOR/FORCE_COLOR 属 TTY 惯例；CLI 脚本的调用参数类 env
// 如 MCP_TOKEN/TELEGRAM_TOKEN 是每次调用的入参，不是服务配置）。

import { readFileSync } from "node:fs";
import type { Level, LogFormat } from "./logger";
import { levelFromRaw } from "./logger";
import { t } from "../i18n";
import { connectorDeclsOf, type ConnectorDecl } from "../connectors/decl";
import { parse, type TomlTable } from "smol-toml";

export type AuthLevel = "certified" | "uncertified";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** WebUI 静态产物目录（qqbot-webui 构建产物；junction 挂载点 ./ui/dist） */
  uiDistDir: string;
  logContent: boolean;
  logLevel: Level;
  logFormat: LogFormat;
  /** 连接器声明清单（[connectors.*]；存在即启用） */
  connectors: ConnectorDecl[];
}

/** 顶层允许的键（connectors 节的内部校验在 decl.ts） */
const TOP_KEYS = new Set([
  "host",
  "port",
  "data_dir",
  "ui_dist_dir",
  "log_content",
  "log_level",
  "log_format",
  "connectors",
]);

/** 字符串字段：trim 后返回；缺省/空串回落 fallback；类型不对即拒（toml 强类型） */
function strOf(doc: TomlTable, key: string, fallback: string): string {
  const raw = doc[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") {
    throw new Error(t("cfg_bad_type", { key, type: t("type_string") }));
  }
  const v = raw.trim();
  return v === "" ? fallback : v;
}

/** 布尔字段：只接受真布尔（toml 的 1/0/"true" 都拒绝——显式优于隐式转换） */
function boolOf(doc: TomlTable, key: string, fallback: boolean): boolean {
  const raw = doc[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") {
    throw new Error(t("cfg_bad_bool", { key, value: String(raw) }));
  }
  return raw;
}

function portOf(doc: TomlTable): number {
  const raw = doc["port"];
  if (raw === undefined) return 8787;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error(t("cfg_bad_port", { value: String(raw) }));
  }
  if (raw < 1 || raw > 65535) {
    throw new Error(t("cfg_bad_port", { value: String(raw) }));
  }
  return raw;
}

function logFormatOf(doc: TomlTable): LogFormat {
  const raw = doc["log_format"];
  if (raw === undefined) return "pretty";
  if (typeof raw !== "string") {
    throw new Error(
      t("cfg_bad_type", { key: "log_format", type: t("type_string") }),
    );
  }
  const v = raw.trim().toLowerCase();
  if (v === "pretty" || v === "json") return v;
  throw new Error(t("cfg_bad_log_format", { value: raw }));
}

function logLevelOf(doc: TomlTable): Level {
  const raw = doc["log_level"];
  if (typeof raw !== "string") {
    return "info"; // 宽松回落 info（打日志的事，不值得拒启）
  }
  return levelFromRaw(raw);
}

/** config.toml 源文 → Config；语法/类型错误抛可操作中文错误（经 i18n）。
 *  B⁺ T6：doc 类型 = smol-toml 自带的 TomlTable（TOML 强类型，零 unknown）。 */
export function configFromToml(source: string): Config {
  let doc: TomlTable;
  try {
    doc = parse(source);
  } catch (e) {
    throw new Error(
      `config.toml 解析失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 未知顶层键拒绝（typo 拦截：data-dir ≠ data_dir 这类静默失效最危险）
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) {
      throw new Error(t("cfg_unknown_key", { key }));
    }
  }

  return {
    host: strOf(doc, "host", "127.0.0.1"),
    port: portOf(doc),
    dataDir: strOf(doc, "data_dir", "./data"),
    uiDistDir: strOf(doc, "ui_dist_dir", "./ui/dist"),
    logContent: boolOf(doc, "log_content", false),
    logLevel: logLevelOf(doc),
    logFormat: logFormatOf(doc),
    connectors: connectorDeclsOf(doc),
  };
}

/**
 * 读 config.toml → Config。文件缺失即拒启（可操作文案指向 config.toml.example）——
 * 它是唯一配置权威，静默全缺省跑起来只会让部署者困惑。
 */
export function loadConfig(path = "config.toml"): Config {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(t("cfg_file_missing", { path }));
    }
    throw new Error(
      `config.toml 读取失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return configFromToml(source);
}
