// 规范化产物类型：介于官方原始事件与缓存表之间。
// 2026-11-08 存储重构：身份归 users 表（QQ 昵称唯一权威）、引用/聊天记录出列结构化存
//（quote_json / message_records），本条文本与渲染产物分列（text / content）。

/** 会话侧别：group=群聊 / chat=单聊。全链路统一此词表（库列/工具面/发送器）。 */
export type MsgScope = "group" | "chat";

/** 附件归一类目：由 content_type 推导，未知形状兜底 file；新消息类型只扩此枚举+渲染层 */
export type AttachmentKind = "image" | "voice" | "video" | "file";

export interface NormalizedAttachment {
  kind: AttachmentKind;
  url: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  /** 语音/视频时长（秒，官方给法待真机样本核验）；缺失时不输出 */
  duration?: number;
  /** 官方原始 MIME（voice / image/jpeg / image/png / image/gif / video/mp4 / file） */
  content_type?: string;
  /** 语音附件的 SILK→WAV 转写地址 */
  voice_wav_url?: string;
  /** 语音 ASR 转写参考文本（扮演记忆的重要素材；只进渲染占位符，不进 text 检索列） */
  asr_refer_text?: string;
}

export interface NormalizedMention {
  /** openid（<@openid> 标记里的 id） */
  id: string;
  /** 官方给的名字（群昵称）——仅存档，读取端一律以 users 表 QQ 昵称矫正 */
  name?: string;
}

/** 顶层引用（103 元素 + message_scene.ext）：落库为 quote_json，读取端零解析零比对 */
export interface NormalizedQuote {
  /** 官方引用锚点（message_scene.ext 携带；与顶层 103 元素的 msg_idx 同值） */
  msgIdx?: string;
  /** 被引正文快照（官方 103 元素 content 字段自带，真机 2026-10-24 核实） */
  body?: string;
  /** 被引作者/消息（ingest 时查缓存 enrich，被引通常更早到达）；被引晚到则留 null，读取端懒补 */
  authorOpenid?: string | null;
  authorName?: string | null;
  msgId?: string | null;
}

/** 聊天记录（102 元素）拍平子消息：落 message_records 表，宿主 content 只留「[聊天记录·N条]」标记 */
export interface NormalizedRecord {
  /** 全消息内顺序号（拍平后递增，0 起） */
  ord: number;
  /** 嵌套深度（记录里还能嵌记录，子层 depth+1） */
  depth: number;
  authorOpenid?: string;
  authorName?: string;
  ts?: number | null;
  /** 子消息文本（官方 content + 文本元素；不含媒体占位/引用转写） */
  text: string;
  /** 子行内引用（记录里的 103） */
  quote?: NormalizedQuote | null;
  /** 子消息自带媒体（与宿主 attachments 共用编号去重；此处存该子行命中的子集） */
  attachments: NormalizedAttachment[];
}

export interface NormalizedMessage {
  botId: string;
  /** group=群聊 / chat=单聊 */
  scope: MsgScope;
  /** scope=group 时为 group_openid；scope=chat 时为对端 user_openid */
  scopeId: string;
  msgId: string;
  authorOpenid: string;
  authorName?: string;
  /** member / admin / owner */
  authorRole?: string;
  /** 官方 timestamp 转毫秒；缺失时为 null */
  ts: number | null;
  /** 本条纯文本（官方 content + 文本元素；FTS 检索源——不含媒体占位/结构标记/引用/记录转写） */
  text: string;
  /** 渲染 markdown（媒体占位符 + [卡片] 等结构行；不含引用与记录转写——那些是结构化列） */
  content: string;
  /** 顶层引用（无引用为 null） */
  quote: NormalizedQuote | null;
  /** 聊天记录拍平子消息 */
  records: NormalizedRecord[];
  mentions: NormalizedMention[];
  attachments: NormalizedAttachment[];
  /** ark 结构化卡片原始对象 */
  ark?: unknown;
  /** 官方 msg_idx 令牌（message_scene.ext 携带，引用元素以此为锚指向本消息；缺失时 undefined） */
  msgIdx?: string;
  /** 官方事件原始载荷（受 LOG_CONTENT 约束，仅入库不进日志） */
  raw: unknown;
  /** 本机外发标记：1=发送成功后本地补记（省略=网关接收） */
  direction?: 0 | 1;
}
