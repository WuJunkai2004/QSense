// QQ 连接器文案（自包含：分仓后不得依赖 core i18n）。键随实现从 core i18n 迁出，
// 文案逐字保留（tests 以正则/全文断言）。{param} 占位插值；语言进程内检测一次（同 core）。

const zh = {
  gw_url_fail:
    "获取网关地址失败（HTTP {status}）：{reason}。检查到 api.bot.qq.com 的网络连通性与 access_token 有效性。",
  gw_fatal_close:
    "网关连接致命关闭，已停止重连（{detail}）。若为 4914/4915：intents 未授权或机器人状态异常，需到开放平台人工核查。",
  gw_disconnected_final: "网关断开且不再重连（code={code}，{reason}）。",
  send_quota_daily:
    "主动消息日额度不足：群 {group} 今日已发 {used}/{limit} 条（官方上限 1000 条/天/群，北京时间 0 点重置）。digest 类任务请降级为落盘不发，勿重试。",
  send_rate_limited_bot:
    "主动消息触发 bot 级频控（{qpm} 条/分钟，认证等级 {level}）。请等待约 {wait} 秒后重试，勿立即重试。",
  send_rate_limited_relation:
    "对该群的主动消息触发单关系频控（官方限制 20 条/分钟/群）。请等待约 {wait} 秒后重试。",
  // —— 发送错误官方码 → 可操作文案（API-FACTS.md #5；2026-11-19 自 core i18n 下沉） ——
  send_audit_pending:
    "消息已提交官方，但进入人工审核（官方码 {code}）：服务端已标记 pending_audit，结果将由 MESSAGE_AUDIT 事件回填，请勿重发（重复发送浪费额度）。",
  send_markdown_downgraded:
    "Markdown 无模板权限（官方码 304036），已自动降级为纯文本发送成功。",
  err_40034004:
    "富媒体转存失败（官方码 40034004）。可重试一次；反复失败请更换图片 URL（须公网可访问）或改用 data: 内联。",
  err_40034005:
    "回复目标 msg_id 已过期（官方码 40034005）：超出被动窗口。可改为直接发送（自动走主动通道）或放弃。",
  err_304027:
    "回复目标 msg_id 已过期（官方码 304027）：超出被动窗口。可改为直接发送（自动走主动通道）或放弃。",
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
} as const;

const en: Record<keyof typeof zh, string> = {
  gw_url_fail:
    "Failed to fetch gateway URL (HTTP {status}): {reason}. Check network to api.bot.qq.com and access_token validity.",
  gw_fatal_close:
    "Gateway connection closed fatally, reconnect stopped ({detail}). For 4914/4915: unauthorized intents or abnormal bot status, resolve manually on the open platform.",
  gw_disconnected_final:
    "Gateway disconnected and will not reconnect (code={code}, {reason}).",
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
  err_40034004:
    "Rich media transfer failed (official code 40034004). Retry once; if it keeps failing, use a different image URL (must be publicly accessible) or switch to data: inline.",
  err_40034005:
    "Reply target msg_id expired (official code 40034005): passive window exceeded. Send directly instead (auto-routes to proactive) or skip.",
  err_304027:
    "Reply target msg_id expired (official code 304027): passive window exceeded. Send directly instead (auto-routes to proactive) or skip.",
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
};

export type QqTextKey = keyof typeof zh;

const lang: "zh" | "en" = /^zh/i.test(
  Intl.DateTimeFormat().resolvedOptions().locale,
)
  ? "zh"
  : "en";

function interpolate(
  template: string,
  params?: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = params?.[key];
    return v === undefined ? whole : String(v);
  });
}

export function tt(key: QqTextKey, params?: Record<string, unknown>): string {
  return interpolate(lang === "zh" ? zh[key] : en[key], params);
}
