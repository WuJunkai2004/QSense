// 与 qqbot-websocket-mcp /ui/api 的载荷契约（字段与服务端 ui.ts 输出一一对应）

export interface BotInfo {
  appid: string;
  name: string;
  dynamic: boolean;
  gateway: "ready" | "resumed" | "disconnected" | "fatal" | "unknown";
  detail?: string;
}

export interface Bootstrap {
  version: string;
  uptime_s: number;
  send_enabled: boolean;
  auth_level: "certified" | "uncertified";
  allow_groups: string[];
  bots: BotInfo[];
}

export interface GroupLast {
  ts: string;
  author: string | null;
  snippet: string;
}

export interface GroupItem {
  group_openid: string;
  full_msg_enabled: boolean;
  member_count: number;
  updated_at: string | null;
  last: GroupLast | null;
}

export interface MsgAuthor {
  openid: string | null;
  name: string | null;
  role: string | null;
}

export interface MsgItem {
  rid: number;
  msg_id: string;
  ts: string | null;
  author: MsgAuthor;
  content: string | null;
  has_attachments: boolean;
  has_ark: boolean;
  has_elements: boolean;
  /** 本机乐观追加的发送消息（仅存在于前端会话内） */
  pending?: boolean;
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

/** /ui/api/message 详情（智能体视角原始载荷） */
export interface MessageDetail extends MsgItem {
  mentions: unknown;
  attachments: unknown;
  ark: unknown;
  elements: unknown;
  raw: unknown;
}

export interface SendResult {
  status: "sent" | "replayed" | "downgraded" | "pending_audit";
  msg_seq?: number;
  provider_msg_id?: string;
  detail?: string;
}
