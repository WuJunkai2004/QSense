// 配置加载与校验：显式 validate，缺项/非法值直接抛可操作的中文错误（经 i18n）。
// 环境变量清单见 .env.example；配置只在启动时读取一次。

import { existsSync, readFileSync } from 'node:fs';
import type { Level } from './logger';
import { levelFromEnv } from './logger';
import { t } from './i18n';

export interface BotApp {
  /** 开放平台 AppID（数字串），同时作为缓存表主键中的 bot_id */
  appid: string;
  /** AppSecret，仅存 .env，不落日志（logger 兜底剥离） */
  secret: string;
  /** 备注名，缺省回落 appid */
  name: string;
}

export interface Config {
  apps: BotApp[];
  mcpToken: string;
  host: string;
  port: number;
  dataDir: string;
  sendEnabled: boolean;
  allowGroups: string[];
  logContent: boolean;
  logLevel: Level;
  /** 缓存消息保留天数（DESIGN.md §3.3 保留策略），默认 90 */
  retentionDays: number;
}

/** 读取 .env（不覆盖已存在的进程环境变量）；零依赖轻实现，仅需 KEY=VALUE 语法。 */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
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

function parseBool(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(t('cfg_bad_bool', { key, value: raw }));
}

function parseApps(raw: string | undefined): BotApp[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      t('cfg_missing', {
        key: 'QQ_APPS',
        hint: '示例：QQ_APPS=[{"appid":"123456","secret":"xxx","name":"主bot"}]（支持多bot）',
      }),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(t('cfg_qqapps_bad_json', { reason: e instanceof Error ? e.message : String(e) }));
  }
  if (!Array.isArray(parsed)) throw new Error(t('cfg_qqapps_not_array'));
  const apps: BotApp[] = [];
  const seen = new Set<string>();
  for (const [i, item] of parsed.entries()) {
    const entry = item as Record<string, unknown>;
    const appid = typeof entry.appid === 'string' ? entry.appid.trim() : '';
    const secret = typeof entry.secret === 'string' ? entry.secret.trim() : '';
    if (!appid) throw new Error(t('cfg_app_bad', { index: i + 1, field: 'appid' }));
    if (!secret) throw new Error(t('cfg_app_bad', { index: i + 1, field: 'secret' }));
    if (seen.has(appid)) throw new Error(t('cfg_app_duplicate', { appid }));
    seen.add(appid);
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : appid;
    apps.push({ appid, secret, name });
  }
  return apps;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const apps = parseApps(env.QQ_APPS);

  const mcpToken = env.MCP_TOKEN ?? '';
  if (mcpToken === '') {
    throw new Error(t('cfg_missing', { key: 'MCP_TOKEN', hint: '生成：openssl rand -hex 32，写入 .env' }));
  }
  if (mcpToken.length < 16) {
    throw new Error(t('cfg_mcp_token_short', { len: mcpToken.length }));
  }

  const portRaw = env.PORT;
  let port = 8787;
  if (portRaw !== undefined && portRaw !== '') {
    if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
      throw new Error(t('cfg_bad_port', { value: portRaw }));
    }
    port = Number(portRaw);
  }

  const sendEnabled = parseBool(env, 'SEND_ENABLE', false);
  const allowGroups = (env.ALLOW_GROUPS ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sendEnabled && allowGroups.length === 0) {
    throw new Error(t('cfg_send_needs_allowlist'));
  }

  let retentionDays = 90;
  const retentionRaw = env.RETENTION_DAYS;
  if (retentionRaw !== undefined && retentionRaw !== '') {
    if (!/^\d+$/.test(retentionRaw) || Number(retentionRaw) < 1 || Number(retentionRaw) > 3650) {
      throw new Error(t('cfg_bad_retention', { value: retentionRaw }));
    }
    retentionDays = Number(retentionRaw);
  }

  return {
    apps,
    mcpToken,
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    dataDir: env.DATA_DIR?.trim() || './data',
    sendEnabled,
    allowGroups,
    logContent: parseBool(env, 'LOG_CONTENT', false),
    logLevel: levelFromEnv(env.LOG_LEVEL),
    retentionDays,
  };
}
