// 轻量 i18n 字典（对齐 opencode-schedule-cron 的 i18n 模式，零运行时依赖）。
// 中文表 `as const` 是键权威：英文表缺 key 会直接 tsc 报错（Translation 映射类型）。
// {param} 占位插值；未提供的参数保留占位符原文。语言进程内检测一次，无运行时切换。

const zh = {
  // —— 配置校验 ——
  cfg_missing: '配置缺失：{key} 未设置。{hint}',
  cfg_bad_bool: '配置无效：{key}={value}，只接受 true / false。',
  cfg_bad_port: '配置无效：PORT={value}，必须是 1-65535 的整数。',
  cfg_qqapps_bad_json:
    '配置无效：QQ_APPS 不是合法 JSON（{reason}）。示例：QQ_APPS=[{"appid":"123456","secret":"xxx","name":"主bot"}]',
  cfg_qqapps_not_array:
    '配置无效：QQ_APPS 必须是 JSON 数组。示例：QQ_APPS=[{"appid":"123456","secret":"xxx","name":"主bot"}]',
  cfg_app_bad:
    '配置无效：QQ_APPS 第 {index} 个条目缺少 {field}（appid 为开放平台数字AppID，secret 为 AppSecret，均在 q.qq.com 获取）。',
  cfg_app_duplicate: '配置无效：QQ_APPS 中 appid={appid} 重复出现，请去重。',
  cfg_mcp_token_short: '配置无效：MCP_TOKEN 长度不足 16 位（当前 {len} 位）。生成：openssl rand -hex 32',
  cfg_send_needs_allowlist:
    '配置无效：SEND_ENABLE=true 但 ALLOW_GROUPS 为空。写操作需要显式群白名单（双重门禁），格式：ALLOW_GROUPS=abc123,def456（group_openid 逗号分隔）。',
  cfg_bad_retention: '配置无效：RETENTION_DAYS={value}，必须是 1-3650 的整数（缓存消息保留天数）。',
  // —— 启动 ——
  boot_db_fail: '数据库初始化失败：{path}（{reason}）。检查 DATA_DIR 是否存在且可写。',
  boot_listen_fail: '监听失败：{addr} 无法绑定（{reason}）。检查 PORT/HOST 是否被占用或无权限。',
  boot_ok: 'qqbot-websocket-mcp 已启动：http://{addr} ，已注册 {bots} 个bot，数据目录 {dataDir}，发送开关 {send}。',
  // —— 网关（M1） ——
  gw_url_fail: '获取网关地址失败（HTTP {status}）：{reason}。检查到 api.bot.qq.com 的网络连通性与 access_token 有效性。',
  gw_fatal_close: '网关连接致命关闭，已停止重连（{detail}）。若为 4914/4915：intents 未授权或机器人状态异常，需到开放平台人工核查。',
  gw_disconnected_final: '网关断开且不再重连（code={code}，{reason}）。',
  gw_event_dedup: '重复事件已去重丢弃：type={type}，id={id}。',
  // —— 退出 ——
  shutdown_done: '已优雅退出。',
  retention_purged: '保留策略清理完成：删除 {removed} 条过期缓存消息。',
} as const;

type Translation = Record<keyof typeof zh, string>;

const en: Translation = {
  cfg_missing: 'Missing config: {key} is not set. {hint}',
  cfg_bad_bool: 'Invalid config: {key}={value}, only true / false accepted.',
  cfg_bad_port: 'Invalid config: PORT={value}, must be an integer in 1-65535.',
  cfg_qqapps_bad_json:
    'Invalid config: QQ_APPS is not valid JSON ({reason}). Example: QQ_APPS=[{"appid":"123456","secret":"xxx","name":"bot"}]',
  cfg_qqapps_not_array:
    'Invalid config: QQ_APPS must be a JSON array. Example: QQ_APPS=[{"appid":"123456","secret":"xxx","name":"bot"}]',
  cfg_app_bad:
    'Invalid config: entry #{index} of QQ_APPS lacks {field} (appid = numeric AppID, secret = AppSecret, both from q.qq.com).',
  cfg_app_duplicate: 'Invalid config: duplicate appid={appid} in QQ_APPS.',
  cfg_mcp_token_short: 'Invalid config: MCP_TOKEN shorter than 16 chars (got {len}). Generate: openssl rand -hex 32',
  cfg_send_needs_allowlist:
    'Invalid config: SEND_ENABLE=true but ALLOW_GROUPS is empty. Writes require an explicit group allowlist, format: ALLOW_GROUPS=abc123,def456 (comma-separated group_openid).',
  cfg_bad_retention: 'Invalid config: RETENTION_DAYS={value}, must be an integer in 1-3650 (cached message retention days).',
  boot_db_fail: 'Database init failed: {path} ({reason}). Check DATA_DIR exists and is writable.',
  boot_listen_fail: 'Listen failed: cannot bind {addr} ({reason}). Check if PORT/HOST is occupied or permission denied.',
  boot_ok: 'qqbot-websocket-mcp started: http://{addr} , {bots} bot(s) registered, data dir {dataDir}, send={send}.',
  gw_url_fail: 'Failed to fetch gateway URL (HTTP {status}): {reason}. Check network to api.bot.qq.com and access_token validity.',
  gw_fatal_close: 'Gateway connection closed fatally, reconnect stopped ({detail}). For 4914/4915: unauthorized intents or abnormal bot status, resolve manually on the open platform.',
  gw_disconnected_final: 'Gateway disconnected and will not reconnect (code={code}, {reason}).',
  gw_event_dedup: 'Duplicate event dropped: type={type}, id={id}.',
  shutdown_done: 'Graceful shutdown complete.',
  retention_purged: 'Retention purge done: removed {removed} expired cached messages.',
};

export type Lang = 'zh' | 'en';

export function detectLang(): Lang {
  try {
    return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => (name in params ? String(params[name]) : raw));
}

export function createT(lang: Lang) {
  const table: Translation = lang === 'zh' ? zh : en;
  return (key: keyof typeof zh, params?: Record<string, string | number>): string =>
    interpolate(table[key], params);
}

// 进程内检测一次，各模块直接 import 使用
export const t = createT(detectLang());
