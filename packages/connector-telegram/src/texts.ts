// connector-telegram 包内文案自包含（分仓纪律：不 import 宿主 i18n/任何 src/）。
// 与 connector-qq/src/texts.ts 同模式：zh 为键权威，en 缺 key 由类型报错兜底。

const zh = {
  tg_token_invalid:
    "Token 无效（Telegram API 401）：{reason}。请核对 BotFather 下发的 token（形如 123456:AA-xxx，@BotFather → /mybots → API Token）。",
  tg_poll_conflict:
    "getUpdates 冲突（HTTP 409）：同一 token 已有另一个消费者在长轮询（其他进程/服务器/另一实例），或该 bot 仍挂着 webhook。Telegram 只允许一个 getUpdates 消费者——停掉另一端或调用 deleteWebhook 清除 webhook 后重启本服务。",
  tg_content_too_long:
    "消息内容 {len} 字符，超过 Telegram 上限 4096。请分段发送或精简内容。",
  tg_caption_too_long:
    "媒体配文 {len} 字符，超过 Telegram 媒体 caption 上限 1024。请精简配文。",
  tg_voice_format:
    "语音发送失败：{reason}。Telegram 语音条仅支持 OGG(Opus)/MP3/M4A，不支持 WAV/SILK——请转码为 MP3 后重试。",
  tg_chat_not_found:
    "目标会话不可达（Telegram 400 chat not found）：bot 未加入该群或从未与该用户互发过消息。请先把 bot 拉进群（或让用户先发一条私聊消息）。",
  tg_send_failed: "发送失败（Telegram API）：{reason}。",
  tg_recall_failed:
    "撤回失败（Telegram API）：{reason}。bot 仅能撤回自己发的消息（私聊可撤对方消息需 bot 为管理员且 48h 内）。",
  tg_appid_mismatch:
    "appid 与 token 不匹配：token 属于 bot {actual}，与所传 appid {expected} 不一致。appid 应为 token 冒号前的数字。",
} as const;

type Translation = Record<keyof typeof zh, string>;

const en: Translation = {
  tg_token_invalid:
    "Invalid token (Telegram API 401): {reason}. Check the token issued by @BotFather (format 123456:AA-xxx, @BotFather → /mybots → API Token).",
  tg_poll_conflict:
    "getUpdates conflict (HTTP 409): another consumer is already long-polling this token (other process/server/instance). Telegram allows only one getUpdates consumer — stop the other side and restart.",
  tg_content_too_long:
    "Message content is {len} chars, exceeding Telegram's 4096 limit. Split or shorten the content.",
  tg_caption_too_long:
    "Media caption is {len} chars, exceeding Telegram's 1024 caption limit. Shorten the caption.",
  tg_voice_format:
    "Voice send failed: {reason}. Telegram voice messages only accept OGG(Opus)/MP3/M4A — WAV/SILK are not supported; transcode to MP3 first.",
  tg_chat_not_found:
    "Target chat unreachable (Telegram 400 chat not found): the bot is not in that group or has never chatted with that user. Add the bot to the group (or have the user message it first).",
  tg_send_failed: "Send failed (Telegram API): {reason}.",
  tg_recall_failed:
    "Recall failed (Telegram API): {reason}. Bots can only delete their own messages (deleting others' in private chats requires admin and within 48h).",
  tg_appid_mismatch:
    "appid does not match token: token belongs to bot {actual}, but appid {expected} was given. appid should be the number before the colon in the token.",
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

// 进程内检测一次（与 connector-qq 同法）
export const tt = createT(detectLang());

/** i18n 键类型（供外部做键映射表） */
export type TelegramI18nKey = keyof typeof zh;
