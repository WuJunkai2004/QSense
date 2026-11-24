// 轻量 i18n 字典（对齐 opencode-schedule-cron 的 i18n 模式，零运行时依赖）。
// 中文表 `as const` 是键权威：英文表缺 key 会直接 tsc 报错（Translation 映射类型）。
// {param} 占位插值；未提供的参数保留占位符原文。语言进程内检测一次，无运行时切换。

const zh = {
  // —— 配置校验（config.toml 唯一权威；env 已退役） ——
  cfg_file_missing:
    "配置文件缺失：{path}。请复制仓库根的 config.toml.example 为 config.toml（服务参数与连接器声明都在其中）。",
  cfg_unknown_key:
    'config.toml 存在未知键 "{key}"（允许：host/port/data_dir/ui_dist_dir/log_content/log_level/log_format/connectors；凭据绝不进 toml）。',
  cfg_bad_type: "配置无效：{key} 类型错误，必须是{type}。",
  type_string: "字符串",
  cfg_bad_bool: "配置无效：{key}={value}，只接受 true / false。",
  cfg_bad_port: "配置无效：port={value}，必须是 1-65535 的整数。",
  cfg_bad_log_format:
    "配置无效：log_format={value}，只接受 pretty（人类可读，缺省）或 json（JSON 行，供采集端解析）。",
  // —— 启动 ——
  boot_db_fail:
    "数据库初始化失败：{path}（{reason}）。检查 DATA_DIR 是否存在且可写。",
  boot_listen_fail:
    "监听失败：{addr} 无法绑定（{reason}）。检查 PORT/HOST 是否被占用或无权限。",
  boot_ok:
    "qqbot-websocket-mcp 已启动：http://{addr} ，已注册 {bots} 个bot，数据目录 {dataDir}，发送开关 {send}。",
  // —— 网关（M1） ——
  gw_event_dedup: "重复事件已去重丢弃：type={type}，id={id}。",
  ingest_no_platform:
    "上行信封缺 platform 键，已丢弃（bot={bot}）。请检查连接器版本是否与契约 v2 兼容。",
  ingest_platform_unloaded:
    "平台 {platform} 的连接器未注册（bot={bot}），上行已丢弃。请检查 config.toml 声明与对应连接器包安装/构建。",
  ingest_parse_fail:
    "平台 {platform} 的 normalize 解读失败，载荷已丢弃：{reason}",
  ingest_save_fail:
    "平台 {platform} 消息入库失败，本条已跳过（去重未标记，重拉同批可恢复），id={id}：{reason}",
  ingest_shape_fail:
    "平台 {platform} 消息未过契约校验，已隔离丢弃（不入库、不去重标记），id={id}：{reason}",
  ingest_effect_fail:
    "平台 {platform} 效应 {kind} 落地失败，已跳过：{reason}",
  ingest_effect_shape_fail:
    "平台 {platform} 效应未过契约校验，已丢弃：{reason}",
  // —— 退出 ——
  shutdown_done: "已优雅退出。",
  // —— 发送器（M4） ——
  send_disabled:
    "发送功能未开启，已硬拒绝。写操作需要发送总开关开启（WebUI 设置页管理），且目标会话满足发送条件（群=在该 bot 白名单内；私聊=对方未拒绝消息接收）。当前开关 {enabled}，该 bot 白名单群数 {allow}。",
  send_not_allowlisted:
    "目标群 {group} 不在该 bot 的发送白名单中，已硬拒绝。如确需对该群发送，请在 WebUI 设置页将该群加入白名单（即时生效，无需重启）。",
  send_c2c_optout:
    "对方已关闭机器人的消息接收（官方 C2C_MSG_REJECT 事件），单聊发送已硬拒绝：{user}。",
  send_c2c_not_optin:
    "对方未开启机器人的主动消息接收（无 C2C_MSG_RECEIVE 记录），单聊主动消息已硬拒绝：{user}。可让对方先给 bot 发一条消息——60 分钟被动窗口内可直接回复。",
  send_window_expired:
    "被动回复窗口已过期：群聊消息仅可在官方消息时间后 5 分钟内回复（官方限制）。可改为直接发送（自动走主动消息，消耗群日额度），或放弃本次回复。",
  send_window_expired_c2c:
    "被动回复窗口已过期：单聊消息仅可在官方消息时间后 60 分钟内回复（官方限制）。请放弃本次回复。",
  send_window_exhausted:
    "该消息的被动回复次数已用完（{used}/{max}，官方限制每条群消息最多回复 5 次）。可改为直接发送（自动走主动通道）。",
  send_window_exhausted_c2c:
    "该消息的被动回复次数已用完（{used}/{max}，官方限制每条单聊消息最多回复 4 次）。",
  send_window_no_msg:
    "回复目标消息不在缓存中：msg_id={msg_id}。请先用 search / browse 确认消息存在（撤回/回复只能针对官方消息ID）。",
  send_quote_not_found:
    "引用目标消息不在缓存中：msg_id={msg_id}。请先用 search / browse 确认消息存在（引用需要缓存中的官方消息ID）。",
  send_audit_pending:
    "消息已提交平台，但进入人工审核（平台码 {code}）：服务端已标记 pending_audit，结果将由平台事件回填，请勿重发（重复发送浪费额度）。",
  send_markdown_downgraded: "Markdown 不受支持，已自动降级为纯文本发送成功。",
  send_text_too_long:
    "消息内容 {len} 字符，超过官方上限 5000。请分段发送或精简内容。",
  media_source_invalid:
    "media 参数格式不支持：仅接受 http(s):// 图片 URL 或 data:<mime>;base64,… 内联数据。不支持本地路径——MCP 服务可能与智能体不在同一台机器上（本地文件请先读出并 base64 内联）。",
  media_upload_failed:
    "图片上传官方转存失败：{reason}。可更换图片来源后重试（URL 须公网可访问；data: 内联数据须为有效图片）。",
  asset_not_found:
    "资产不存在：asset:{id}。请先调 request_upload 拿上传票据，并按返回的 curl 命令用执行环境直传图片字节（票据 15 分钟有效、单次使用）。",
  err_send_unknown: "发送失败（HTTP {status}，业务码 {code}）：{message}。",
  err_send_no_code: "发送失败（{message}）。请检查网络与平台服务状态。",
} as const;

type Translation = Record<keyof typeof zh, string>;

const en: Translation = {
  cfg_file_missing:
    "Config file missing: {path}. Copy config.toml.example from the repo root to config.toml (server options and connector declarations live there).",
  cfg_unknown_key:
    'config.toml has unknown key "{key}" (allowed: host/port/data_dir/ui_dist_dir/log_content/log_level/log_format/connectors; credentials never go into toml).',
  cfg_bad_type: "Invalid config: {key} must be {type}.",
  type_string: "a string",
  cfg_bad_bool: "Invalid config: {key}={value}, only true / false accepted.",
  cfg_bad_port: "Invalid config: port={value}, must be an integer in 1-65535.",
  cfg_bad_log_format:
    "Invalid config: log_format={value}, only pretty (default) or json is accepted.",
  boot_db_fail:
    "Database init failed: {path} ({reason}). Check DATA_DIR exists and is writable.",
  boot_listen_fail:
    "Listen failed: cannot bind {addr} ({reason}). Check if PORT/HOST is occupied or permission denied.",
  boot_ok:
    "qqbot-websocket-mcp started: http://{addr} , {bots} bot(s) registered, data dir {dataDir}, send={send}.",
  gw_event_dedup: "Duplicate event dropped: type={type}, id={id}.",
  ingest_no_platform:
    "Inbound envelope lacks the platform key, dropped (bot={bot}). Check that the connector is compatible with contract v2.",
  ingest_platform_unloaded:
    "Connector for platform {platform} is not registered (bot={bot}); inbound dropped. Check config.toml declarations and the connector package install/build.",
  ingest_parse_fail:
    "normalize failed for platform {platform}; payload dropped: {reason}",
  ingest_save_fail:
    "Message save failed for platform {platform}; item skipped (dedup not marked, recoverable on re-poll), id={id}: {reason}",
  ingest_shape_fail:
    "Message failed contract validation for platform {platform}; isolated and dropped (not saved, dedup not marked), id={id}: {reason}",
  ingest_effect_fail:
    "Effect {kind} failed to apply for platform {platform}; skipped: {reason}",
  ingest_effect_shape_fail:
    "Effect failed contract validation for platform {platform}; dropped: {reason}",
  shutdown_done: "Graceful shutdown complete.",
  send_disabled:
    "Sending is disabled, rejected. Writes require the master send switch enabled (managed in the WebUI settings) and the target conversation meeting send conditions (group = in the bot's allowlist; direct message = recipient has not rejected messages). Current switch {enabled}, allowlisted groups {allow}.",
  send_not_allowlisted:
    "Target group {group} is not in this bot's send allowlist, rejected. To enable, add the group to the allowlist in the WebUI settings page (effective immediately, no restart).",
  send_c2c_optout:
    "The recipient has disabled bot messages (official C2C_MSG_REJECT event); direct-message send rejected: {user}.",
  send_c2c_not_optin:
    "The recipient has not enabled proactive bot messages (no C2C_MSG_RECEIVE record); proactive direct message rejected: {user}. Ask them to message the bot first — replies are possible within the 60-minute passive window.",
  send_window_expired:
    "Passive reply window expired: group messages can only be replied within 5 minutes of the official timestamp (official limit). Send directly instead (auto-routes to proactive, consumes daily quota), or skip.",
  send_window_expired_c2c:
    "Passive reply window expired: direct messages can only be replied within 60 minutes of the official timestamp (official limit). Skip this reply.",
  send_window_exhausted:
    "Reply count exhausted for this message ({used}/{max}, official limit: max 5 replies per group message). Send directly instead (auto-routes to proactive).",
  send_window_exhausted_c2c:
    "Reply count exhausted for this message ({used}/{max}, official limit: max 4 replies per direct message).",
  send_window_no_msg:
    "Reply target not in cache: msg_id={msg_id}. Use search / browse to locate a cached message first (reply/recall require official message IDs).",
  send_quote_not_found:
    "Quote target not in cache: msg_id={msg_id}. Use search / browse to locate a cached message first (quoting requires a cached official message ID).",
  send_audit_pending:
    "Message submitted but queued for manual audit (platform code {code}): marked pending_audit server-side; result will arrive via a platform event. Do not resend (wastes quota).",
  send_markdown_downgraded:
    "Markdown is not supported; automatically sent as plain text instead.",
  send_text_too_long:
    "Message content is {len} chars, exceeding the official 5000 limit. Split or shorten the content.",
  media_source_invalid:
    "Unsupported media format: only http(s):// image URLs or data:<mime>;base64,… inline data are accepted. Local paths are not supported — the MCP server may run on a different machine than the agent (read local files and inline them as base64).",
  media_upload_failed:
    "Image upload/transfer failed: {reason}. Retry with a different source (URL must be publicly accessible; data: payload must be a valid image).",
  asset_not_found:
    "Asset not found: asset:{id}. Call request_upload first to get an upload ticket, then PUT the image bytes from your execution environment following the returned curl command (ticket valid 15 min, single use).",
  err_send_unknown: "Send failed (HTTP {status}, biz code {code}): {message}.",
  err_send_no_code: "Send failed ({message}). Check network and platform service status.",
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
