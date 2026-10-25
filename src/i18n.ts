// 轻量 i18n 字典（对齐 opencode-schedule-cron 的 i18n 模式，零运行时依赖）。
// 中文表 `as const` 是键权威：英文表缺 key 会直接 tsc 报错（Translation 映射类型）。
// {param} 占位插值；未提供的参数保留占位符原文。语言进程内检测一次，无运行时切换。

const zh = {
  // —— 配置校验 ——
  cfg_bad_bool: "配置无效：{key}={value}，只接受 true / false。",
  cfg_bad_port: "配置无效：PORT={value}，必须是 1-65535 的整数。",
  cfg_bad_retention:
    "配置无效：RETENTION_DAYS={value}，必须是 1-3650 的整数（缓存消息保留天数）。",
  // —— 启动 ——
  boot_db_fail:
    "数据库初始化失败：{path}（{reason}）。检查 DATA_DIR 是否存在且可写。",
  boot_listen_fail:
    "监听失败：{addr} 无法绑定（{reason}）。检查 PORT/HOST 是否被占用或无权限。",
  boot_ok:
    "qqbot-websocket-mcp 已启动：http://{addr} ，已注册 {bots} 个bot，数据目录 {dataDir}，发送开关 {send}。",
  // —— 网关（M1） ——
  gw_url_fail:
    "获取网关地址失败（HTTP {status}）：{reason}。检查到 api.bot.qq.com 的网络连通性与 access_token 有效性。",
  gw_fatal_close:
    "网关连接致命关闭，已停止重连（{detail}）。若为 4914/4915：intents 未授权或机器人状态异常，需到开放平台人工核查。",
  gw_disconnected_final: "网关断开且不再重连（code={code}，{reason}）。",
  gw_event_dedup: "重复事件已去重丢弃：type={type}，id={id}。",
  // —— 退出 ——
  shutdown_done: "已优雅退出。",
  retention_purged: "保留策略清理完成：删除 {removed} 条过期缓存消息。",
  // —— 发送器（M4） ——
  send_disabled:
    "发送功能未开启，已硬拒绝。写操作需要双重门禁：.env 中 SEND_ENABLE=true 且 ALLOW_GROUPS 包含目标群。当前 SEND_ENABLE={enabled}，白名单群数 {allow}。",
  send_not_allowlisted:
    "目标群 {group} 不在 ALLOW_GROUPS 白名单中，已硬拒绝。如确需对该群发送，请在 .env 的 ALLOW_GROUPS 追加该 group_openid 并重启服务。",
  send_window_expired:
    "被动回复窗口已过期：群聊消息仅可在官方消息时间后 5 分钟内回复（官方限制）。可改用 qq_send_proactive 发主动消息（消耗群日额度），或放弃本次回复。",
  send_window_exhausted:
    "该消息的被动回复次数已用完（{used}/{max}，官方限制每条群消息最多回复 5 次）。可改用 qq_send_proactive。",
  send_window_no_msg:
    "回复目标消息不在缓存中：msg_id={msg_id}。请先用 qq_search / qq_browse 确认消息存在（撤回/回复只能针对官方消息ID）。",
  send_quota_daily:
    "主动消息日额度不足：群 {group} 今日已发 {used}/{limit} 条（官方上限 1000 条/天/群，北京时间 0 点重置）。digest 类任务请降级为落盘不发，勿重试。",
  send_rate_limited_bot:
    "主动消息触发 bot 级频控（{qpm} 条/分钟，认证等级 {level}）。请等待约 {wait} 秒后重试，勿立即重试。",
  send_rate_limited_relation:
    "对该群的主动消息触发单关系频控（官方限制 20 条/分钟/群）。请等待约 {wait} 秒后重试。",
  send_audit_pending:
    "消息已提交官方，但进入人工审核（官方码 {code}）：服务端已标记 pending_audit，结果将由 MESSAGE_AUDIT 事件回填，请勿重发（重复发送浪费额度）。",
  send_markdown_downgraded:
    "Markdown 无模板权限（官方码 304036），已自动降级为纯文本发送成功。",
  send_text_too_long:
    "消息内容 {len} 字符，超过官方上限 5000。请分段发送或精简内容。",
  err_40034004:
    "富媒体转存失败（官方码 40034004）。v1 仅支持文本/Markdown，不应出现此码；可重试一次。",
  err_40034005:
    "回复目标 msg_id 已过期（官方码 40034005）：超出被动窗口。可改用 qq_send_proactive 或放弃。",
  err_304027:
    "回复目标 msg_id 已过期（官方码 304027）：超出被动窗口。可改用 qq_send_proactive 或放弃。",
  err_40034100:
    "主动消息超过官方频控（官方码 40034100）。请等待额度恢复后再试（bot 级 {qpm} 条/分钟，单群 1000 条/天）。",
  err_40034010:
    "官方不允许发送 URL（官方码 40034010）：URL 需在开放平台报备。请去除内容中的链接后重试。",
  err_40054010:
    "官方不允许发送 URL（官方码 40054010）：URL 需在开放平台报备。请去除内容中的链接后重试。",
  err_40034101:
    "机器人已不是该群成员（官方码 40034101），发送失败。请检查机器人是否被移出群。",
  err_40054003:
    "机器人已不是该群成员（官方码 40054003），发送失败。请检查机器人是否被移出群。",
  err_40054005:
    "官方判定消息重复（官方码 40054005：msg_seq 未递增）。服务端账本异常，请勿重试并报告维护者。",
  err_40054002: "机器人被禁言（官方码 40054002），无法发送。请等待解禁。",
  err_40034006:
    "消息内容被官方判定违规（官方码 40034006），已放弃。请修改内容。",
  err_send_unknown: "发送失败（HTTP {status}，业务码 {code}）：{message}。",
  err_send_no_code: "发送失败（{message}）。请检查网络与官方服务状态。",
} as const;

type Translation = Record<keyof typeof zh, string>;

const en: Translation = {
  cfg_bad_bool: "Invalid config: {key}={value}, only true / false accepted.",
  cfg_bad_port: "Invalid config: PORT={value}, must be an integer in 1-65535.",
  cfg_bad_retention:
    "Invalid config: RETENTION_DAYS={value}, must be an integer in 1-3650 (cached message retention days).",
  boot_db_fail:
    "Database init failed: {path} ({reason}). Check DATA_DIR exists and is writable.",
  boot_listen_fail:
    "Listen failed: cannot bind {addr} ({reason}). Check if PORT/HOST is occupied or permission denied.",
  boot_ok:
    "qqbot-websocket-mcp started: http://{addr} , {bots} bot(s) registered, data dir {dataDir}, send={send}.",
  gw_url_fail:
    "Failed to fetch gateway URL (HTTP {status}): {reason}. Check network to api.bot.qq.com and access_token validity.",
  gw_fatal_close:
    "Gateway connection closed fatally, reconnect stopped ({detail}). For 4914/4915: unauthorized intents or abnormal bot status, resolve manually on the open platform.",
  gw_disconnected_final:
    "Gateway disconnected and will not reconnect (code={code}, {reason}).",
  gw_event_dedup: "Duplicate event dropped: type={type}, id={id}.",
  shutdown_done: "Graceful shutdown complete.",
  retention_purged:
    "Retention purge done: removed {removed} expired cached messages.",
  send_disabled:
    "Sending is disabled, rejected. Writes require two gates: SEND_ENABLE=true and ALLOW_GROUPS containing the target group in .env. Current SEND_ENABLE={enabled}, allowlisted groups {allow}.",
  send_not_allowlisted:
    "Target group {group} is not in ALLOW_GROUPS, rejected. To enable, append the group_openid to ALLOW_GROUPS in .env and restart.",
  send_window_expired:
    "Passive reply window expired: group messages can only be replied within 5 minutes of the official timestamp (official limit). Use qq_send_proactive instead (consumes daily quota), or skip.",
  send_window_exhausted:
    "Reply count exhausted for this message ({used}/{max}, official limit: max 5 replies per group message). Use qq_send_proactive instead.",
  send_window_no_msg:
    "Reply target not in cache: msg_id={msg_id}. Use qq_search / qq_browse to locate a cached message first (reply/recall require official message IDs).",
  send_quota_daily:
    "Daily proactive quota exhausted for group {group}: {used}/{limit} today (official limit 1000/day/group, resets at midnight Beijing). Digest jobs should fall back to disk, do not retry.",
  send_rate_limited_bot:
    "Bot-level proactive rate limit hit ({qpm}/min, auth level {level}). Wait about {wait}s before retrying.",
  send_rate_limited_relation:
    "Per-relation proactive rate limit hit for this group (official limit 20/min/group). Wait about {wait}s before retrying.",
  send_audit_pending:
    "Message submitted but queued for manual audit (official code {code}): marked pending_audit server-side; result will arrive via MESSAGE_AUDIT event. Do not resend (wastes quota).",
  send_markdown_downgraded:
    "Markdown has no template permission (official code 304036); automatically sent as plain text instead.",
  send_text_too_long:
    "Message content is {len} chars, exceeding the official 5000 limit. Split or shorten the content.",
  err_40034004:
    "Rich media transfer failed (official code 40034004). v1 only supports text/markdown; retry once if unexpected.",
  err_40034005:
    "Reply target msg_id expired (official code 40034005): passive window exceeded. Use qq_send_proactive or skip.",
  err_304027:
    "Reply target msg_id expired (official code 304027): passive window exceeded. Use qq_send_proactive or skip.",
  err_40034100:
    "Proactive message rate-limited by official API (code 40034100). Wait for quota ({qpm}/min bot level, 1000/day per group).",
  err_40034010:
    "URLs are not allowed by official API (code 40034010): URLs must be registered on the platform. Remove links from content.",
  err_40054010:
    "URLs are not allowed by official API (code 40054010): URLs must be registered on the platform. Remove links from content.",
  err_40034101:
    "Bot is no longer a member of this group (official code 40034101). Check whether the bot was removed.",
  err_40054003:
    "Bot is no longer a member of this group (official code 40054003). Check whether the bot was removed.",
  err_40054005:
    "Official dedup hit (code 40054005: msg_seq not incremented). Ledger anomaly — do not retry, report to maintainer.",
  err_40054002: "Bot is muted (official code 40054002). Wait for unmute.",
  err_40034006:
    "Content rejected by official audit (code 40034006). Abandoned; modify the content.",
  err_send_unknown: "Send failed (HTTP {status}, biz code {code}): {message}.",
  err_send_no_code:
    "Send failed ({message}). Check network and official service status.",
};

export type Lang = "zh" | "en";

export function detectLang(): Lang {
  try {
    return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale)
      ? "zh"
      : "en";
  } catch {
    return "en";
  }
}

function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    name in params ? String(params[name]) : raw,
  );
}

export function createT(lang: Lang) {
  const table: Translation = lang === "zh" ? zh : en;
  return (
    key: keyof typeof zh,
    params?: Record<string, string | number>,
  ): string => interpolate(table[key], params);
}

// 进程内检测一次，各模块直接 import 使用
export const t = createT(detectLang());

/** i18n 键类型（供外部模块做键映射表） */
export type I18nKey = keyof typeof zh;
