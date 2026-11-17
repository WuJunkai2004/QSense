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
