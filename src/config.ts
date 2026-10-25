// 配置加载与校验：显式 validate，缺项/非法值直接抛可操作的中文错误（经 i18n）。
// 环境变量清单见 .env.example；配置只在启动时读取一次。

import { existsSync, readFileSync } from "node:fs";
import type { Level } from "./logger";
import { levelFromEnv } from "./logger";
import { t } from "./i18n";

export interface BotApp {
  /** 开放平台 AppID（数字串），同时作为缓存表主键中的 bot_id */
  appid: string;
  /** AppSecret，仅存 SQLite bots 表，不落日志（logger 兜底剥离） */
  secret: string;
  /** 备注名，缺省回落 appid */
  name: string;
}

export type AuthLevel = "certified" | "uncertified";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logContent: boolean;
  logLevel: Level;
  /** 缓存消息保留天数（DESIGN.md §3.3 保留策略），默认 90 */
  retentionDays: number;
}

/** 读取 .env（不覆盖已存在的进程环境变量）；零依赖轻实现，仅需 KEY=VALUE 语法。 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // 读不了不在此崩溃，交给后续校验报缺项
  }
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function parseBool(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(t("cfg_bad_bool", { key, value: raw }));
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  // M9 起 env 只承担部署拓扑与运维参数：bot 注册（appid/secret/认证等级）、
  // admin token、发送开关、白名单一律以 SQLite 为唯一权威（WebUI / qq_register_bot 管理）。

  const portRaw = env.PORT;
  let port = 8787;
  if (portRaw !== undefined && portRaw !== "") {
    if (
      !/^\d+$/.test(portRaw) ||
      Number(portRaw) < 1 ||
      Number(portRaw) > 65535
    ) {
      throw new Error(t("cfg_bad_port", { value: portRaw }));
    }
    port = Number(portRaw);
  }

  let retentionDays = 90;
  const retentionRaw = env.RETENTION_DAYS;
  if (retentionRaw !== undefined && retentionRaw !== "") {
    if (
      !/^\d+$/.test(retentionRaw) ||
      Number(retentionRaw) < 1 ||
      Number(retentionRaw) > 3650
    ) {
      throw new Error(t("cfg_bad_retention", { value: retentionRaw }));
    }
    retentionDays = Number(retentionRaw);
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    dataDir: env.DATA_DIR?.trim() || "./data",
    logContent: parseBool(env, "LOG_CONTENT", false),
    logLevel: levelFromEnv(env.LOG_LEVEL),
    retentionDays,
  };
}
