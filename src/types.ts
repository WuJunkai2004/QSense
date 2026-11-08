// 与 qqbot-websocket-mcp /ui/api 的载荷契约（字段与服务端 ui.ts 输出一一对应）

export type AuthLevel = "certified" | "uncertified";

export interface BotInfo {
  appid: string;
  name: string;
  /** M8：白名单按 bot 独立落库（bots 表），不再是顶层全局字段 */
  allow_groups: string[];
  /** M9：认证等级按 bot 落库（主动消息频控预算 certified=60qpm / uncertified=30qpm） */
  auth_level: AuthLevel;
  /** TTS 语音发送开关（kv tts:<appid>，缺省关）；send_media "tts:" 来源的使用闸门之一 */
  tts_enabled: boolean;
  gateway: "ready" | "resumed" | "disconnected" | "fatal" | "unknown";
  detail?: string;
}

export interface Bootstrap {
  version: string;
  uptime_s: number;
  send_enabled: boolean;
  bots: BotInfo[];
}

/** GET/PUT /ui/api/settings 载荷 */
export interface SettingsInfo {
  send_enabled: boolean;
  bots: Array<{
    appid: string;
    name: string;
    allow_groups: string[];
    auth_level: AuthLevel;
    tts_enabled: boolean;
    gateway: string;
  }>;
}

/** GET /ui/api/tts/config：api_key 只回显打码，绝不回原文 */
export type TtsFormat = "mp3" | "wav";

export type TtsConfigGet =
  | { configured: false }
  | {
      configured: true;
      base_url: string;
      model: string;
      voice: string;
      format: TtsFormat;
      api_key_masked: string;
    };

/** PUT /ui/api/tts/config 响应 */
export interface TtsConfigPut {
  ok: true;
  configured: true;
  api_key_masked: string;
}

/** POST /bots/:appid/agent-token（轮换）：新 token 仅本次返回 */
export interface AgentTokenResult {
  ok: true;
  bot: string;
  agent_token: string;
  note: string;
}

/** POST /bots（注册）：agent_token 仅本次返回 */
export interface AddBotResult {
  ok: true;
  bot: { appid: string; name: string };
  agent_token: string;
  note: string;
}

/** POST /ui/api/qr-bind/create 载荷：连接页 URL 由前端本地画成二维码 */
export interface QrBindCreate {
  task_id: string;
  connect_url: string;
  interval_s: number;
}

/** POST /ui/api/qr-bind/poll 载荷：created 时 AppSecret 已在服务端解密注册，
 *  返回形状与 AddBotResult 对齐（agent_token 仅此一次，任务即焚） */
export type QrBindPoll =
  | { status: "pending" }
  | { status: "expired" }
  | {
      status: "created";
      bot: { appid: string; name: string };
      agent_token: string;
      note: string;
    };

export interface GroupLast {
  ts: string;
  author: string | null;
  snippet: string;
}

export interface GroupItem {
  /** 会话类型：group=群聊 / chat=单聊（单聊时 group_openid=对端 user_openid） */
  type: "group" | "chat";
  group_openid: string;
  /** 单聊恒 null（无全量消息开关概念） */
  full_msg_enabled: boolean | null;
  /** 单聊恒 0（无名册） */
  member_count: number;
  updated_at: string | null;
  last: GroupLast | null;
}

export interface MsgAuthor {
  openid: string | null;
  name: string | null;
  role: string | null;
}

/** 附件分型（2026-11-08 存储重构 v8：服务端按 content_type 归一；新消息类型只扩此枚举） */
export type AttKind = "image" | "voice" | "video" | "file";

export interface MsgAttachment {
  kind: AttKind;
  url: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  duration?: number;
  content_type?: string;
  /** 语音：官方 ASR 转写（服务端已内联进 content 占位符后的「（转写：…）」） */
  voice_wav_url?: string;
  asr_refer_text?: string;
}

/** 结构化引用（v8：quote_json 直读，被引原文不再糅进 content） */
export interface QuoteMsg {
  /** 被引作者 openid（被引晚到且缓存未命中时 null） */
  id: string | null;
  /** 被引消息 id（同上） */
  msg_id: string | null;
  /** 被引正文摘要（首行，≤50 字符，超出带省略号） */
  content: string;
}

export interface MsgItem {
  rid: number;
  msg_id: string;
  ts: string | null;
  author: MsgAuthor;
  content: string | null;
  /** 结构化引用：null = 本条无引用 */
  quote_msg: QuoteMsg | null;
  /** 聊天记录子消息数（>0 时 /message 详情内联 records） */
  records_count: number;
  has_attachments: boolean;
  /** 附件描述符（与 content 内 `![附件n]` / `[附件n 文件名]` 占位符编号对应：n = 下标 + 1）；旧消息可能为 null */
  attachments: MsgAttachment[] | null;
  has_ark: boolean;
  /** 本机乐观追加的发送消息（仅存在于前端会话内） */
  pending?: boolean;
  /** 本机外发消息（服务端发送成功后已落库，刷新后仍在） */
  out?: boolean;
}

export interface MemberItem {
  member_openid: string;
  username: string | null;
  member_role: string | null;
  msg_count: number;
  last_seen: string | null;
}

export interface SendItem {
  id: number;
  kind: string;
  status: string;
  reply_msg_id: string | null;
  msg_seq: number | null;
  provider_msg_id: string | null;
  error_code: number | null;
  created_at: string | null;
}

export interface QuotaInfo {
  bot: string;
  send_enabled: boolean;
  auth_level: string;
  proactive_sent_today: number;
  buckets?: Record<string, unknown>;
}

/** /message 详情内联的聊天记录子消息（v8 拍平行；depth=嵌套层级） */
export interface RecordItem {
  ord: number;
  depth: number;
  openid: string | null;
  name: string | null;
  ts: string | null;
  text: string | null;
  /** 子行内引用（{msg_idx?, body?}，原始形状） */
  quote: unknown;
  attachments: unknown;
}

/** /ui/api/message 详情（智能体视角原始载荷）；attachments 为原始 JSON（unknown），覆盖基类窄类型 */
export interface MessageDetail extends Omit<MsgItem, "attachments"> {
  records: RecordItem[] | null;
  mentions: unknown;
  attachments: unknown;
  ark: unknown;
  raw: unknown;
}

export interface SendResult {
  status: "sent" | "replayed" | "downgraded" | "pending_audit";
  msg_seq?: number;
  provider_msg_id?: string;
  detail?: string;
}
