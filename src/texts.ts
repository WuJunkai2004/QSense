// connector-weixin 包内文案自包含（分仓纪律：不 import 宿主 i18n/任何 src/）。
// 与 connector-qq / connector-telegram 的 texts.ts 同模式：zh 为键权威，en 缺 key 由类型报错兜底。

const zh = {
  wx_appid_form:
    "appid 形制不对：应填 ilink_bot_id 的安全形式——把 @ 与 . 换成 -（如 abc123@im.bot 填作 abc123-im-bot）。扫码添加会自动产出该形式。",
  wx_credential_missing:
    "凭据缺失：appid（机器人账号 id）与 token 均必填。请用 WebUI「扫码添加」完成绑定。",
  wx_token_invalid:
    "微信 token 无效或已失效（{detail}）。请在 WebUI 移除该机器人后重新扫码绑定。",
  wx_token_stale_status:
    "微信 token 已失效（errcode -14）：请在 WebUI 移除该机器人后重新扫码绑定",
  wx_unreachable:
    "微信 iLink 服务不可达（{reason}）。请检查本机网络能否访问 ilinkai.weixin.qq.com，或凭据里的 base_url 是否正确。",
  wx_verify_failed: "凭据校验失败（微信 iLink）：{reason}",
  wx_content_too_long:
    "消息内容 {len} 字符，超过微信单条上限 4000。请分段发送或精简内容。",
  wx_content_empty: "消息内容为空（文本与媒体均缺失）。",
  wx_target_invalid:
    "目标会话 id 无效：应传 list_all 返回的微信用户 id（形如 xxx@im.wechat）。",
  wx_send_failed: "发送失败（微信 iLink）：{reason}",
  wx_media_too_large: "媒体 {mb}MB，超过微信单文件上限 20MB。请压缩后重试。",
  wx_media_empty: "媒体内容为空（0 字节）。",
  wx_media_source_failed: "媒体来源读取失败（{reason}）。",
  wx_media_handle_invalid:
    "媒体句柄无效或已损坏，请重新经 request_upload 上传后再发送。",
  wx_upload_no_url:
    "微信未返回上传地址（getuploadurl 应答缺 upload_full_url / upload_param）。",
  wx_cdn_upload_failed: "媒体上传微信 CDN 失败（{reason}）。",
  wx_cdn_download_failed: "媒体下载或解密失败（{reason}）。",
  wx_recall_unsupported: "微信不支持撤回消息（平台能力缺失）。",
  wx_qr_invalid_resp:
    "微信未返回合法二维码（get_bot_qrcode 应答缺 qrcode / qrcode_img_content）。请重试。",
  wx_qr_already_bound:
    "该微信机器人已绑定过本服务（服务端识别为已连接，未下发新凭据）。如已注册请直接使用；需更换凭据请先在设置页移除对应机器人后重新扫码。",
  wx_qr_need_verifycode:
    "微信要求输入手机上显示的配对码完成二次校验，当前扫码流程暂不支持输入配对码——请稍后重新扫码；若反复出现，请在手机微信确认绑定页核对提示。",
  wx_qr_blocked: "配对码多次输入错误，微信已暂时锁定本次绑定。请稍后重新扫码。",
  wx_qr_incomplete:
    "扫码已确认，但微信未返回完整凭据（缺机器人 id 或 token）。请重新扫码。",
  wx_qr_poll_failed: "扫码状态查询连续失败（{reason}）。请检查网络后重新扫码。",
} as const;

type Translation = Record<keyof typeof zh, string>;

const en: Translation = {
  wx_appid_form:
    "Invalid appid: use the filesystem-safe form of ilink_bot_id with @ and . replaced by - (e.g. abc123@im.bot is entered as abc123-im-bot). QR pairing produces this form automatically.",
  wx_credential_missing:
    "Missing credentials: both appid (bot account id) and token are required. Use WebUI \"scan to add\" to bind.",
  wx_token_invalid:
    "Weixin token is invalid or expired ({detail}). Remove this bot in WebUI and scan again to re-bind.",
  wx_token_stale_status:
    "Weixin token expired (errcode -14): remove this bot in WebUI and scan again to re-bind",
  wx_unreachable:
    "Weixin iLink service unreachable ({reason}). Check network access to ilinkai.weixin.qq.com or the base_url in credentials.",
  wx_verify_failed: "Credential verification failed (Weixin iLink): {reason}",
  wx_content_too_long:
    "Message is {len} chars, exceeding Weixin's 4000 limit per message. Split or shorten it.",
  wx_content_empty: "Message is empty (no text and no media).",
  wx_target_invalid:
    "Invalid target id: pass the Weixin user id from list_all (like xxx@im.wechat).",
  wx_send_failed: "Send failed (Weixin iLink): {reason}",
  wx_media_too_large:
    "Media is {mb}MB, exceeding Weixin's 20MB limit per file. Compress and retry.",
  wx_media_empty: "Media content is empty (0 bytes).",
  wx_media_source_failed: "Failed to read media source ({reason}).",
  wx_media_handle_invalid:
    "Media handle is invalid or corrupted; upload again via request_upload before sending.",
  wx_upload_no_url:
    "Weixin returned no upload URL (getuploadurl response lacks upload_full_url / upload_param).",
  wx_cdn_upload_failed: "Uploading media to Weixin CDN failed ({reason}).",
  wx_cdn_download_failed: "Media download or decryption failed ({reason}).",
  wx_recall_unsupported:
    "Weixin does not support message recall (platform capability missing).",
  wx_qr_invalid_resp:
    "Weixin returned no valid QR code (get_bot_qrcode lacks qrcode / qrcode_img_content). Retry.",
  wx_qr_already_bound:
    "This Weixin bot is already bound to this service (server recognized it as connected; no new credentials issued). Use the registered bot, or remove it in settings and scan again to replace credentials.",
  wx_qr_need_verifycode:
    "Weixin requires the pairing code shown on your phone for a second verification, which the current scan flow cannot enter — scan again later; if it keeps happening, check the prompt on the confirmation page in WeChat.",
  wx_qr_blocked:
    "Too many wrong pairing codes; Weixin temporarily locked this binding. Scan again later.",
  wx_qr_incomplete:
    "Scan confirmed, but Weixin returned incomplete credentials (missing bot id or token). Scan again.",
  wx_qr_poll_failed:
    "QR status polling kept failing ({reason}). Check the network and scan again.",
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

// 进程内检测一次（与 connector-qq / connector-telegram 同法）
export const tt = createT(detectLang());

/** i18n 键类型（供外部做键映射表） */
export type WeixinI18nKey = keyof typeof zh;
