// 规范化产物类型：介于官方原始事件与缓存表之间。

export interface NormalizedAttachment {
  url: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  /** voice / image/jpeg / image/png / image/gif / video/mp4 / file */
  content_type?: string;
  /** 语音附件的 SILK→WAV 转写地址 */
  voice_wav_url?: string;
  /** 语音 ASR 转写参考文本（扮演记忆的重要素材） */
  asr_refer_text?: string;
}

export interface NormalizedMention {
  /** openid（<@openid> 标记里的 id） */
  id: string;
  name?: string;
}

export interface NormalizedMessage {
  botId: string;
  /** group=群聊 / c2c=单聊 */
  scope: "group" | "c2c";
  /** scope=group 时为 group_openid；scope=c2c 时为 user_openid */
  scopeId: string;
  msgId: string;
  authorOpenid: string;
  authorName?: string;
  /** member / admin / owner */
  authorRole?: string;
  /** 官方 timestamp 转毫秒；缺失时为 null */
  ts: number | null;
  /** 规范化纯文本：官方 content + msg_elements 递归展开的可读树（含 @<openid> 标记） */
  content: string;
  mentions: NormalizedMention[];
  /** 官方 msg_elements 原始数组（结构化保留，M3 qq_context 展示用） */
  elements: unknown;
  attachments: NormalizedAttachment[];
  /** ark 结构化卡片原始对象 */
  ark?: unknown;
  /** 官方事件原始载荷（受 LOG_CONTENT 约束，仅入库不进日志） */
  raw: unknown;
}
