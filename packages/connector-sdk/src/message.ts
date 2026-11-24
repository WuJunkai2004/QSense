// 规范化产物类型族（契约 v2，2026-11-17）：NormalizedMessage 的权威定义自 core
// 上移 SDK——「解读权在插件」的前提是插件能直接产出成品消息形状；形状一致性由
// conformance harness 的 normalize-shape 检查守（不再靠「parser 在 core」守）。
//
// 语义约定（与 core 存储层对齐，勿破坏）：
// - scope 词表 group|chat 全链路统一（库列/工具面/发送器）
// - text（本条纯文本，FTS 检索源）/ content（渲染 markdown）分列
// - 身份归身份（openid 稳定标识 + users 表矫正展示名）、内容归内容
// - 引用/聊天记录出列结构化（quote / records）

/** 会话侧别：group=群聊 / chat=单聊。全链路统一此词表。 */
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
  /** 语音/视频时长（秒）；缺失时不输出 */
  duration?: number;
  /** 平台原始 MIME（voice / image/jpeg / image/png / image/gif / video/mp4 / file） */
  content_type?: string;
  /** 语音附件的转写地址（如 QQ SILK→WAV） */
  voice_wav_url?: string;
  /** 语音 ASR 转写参考文本（扮演记忆的重要素材；只进渲染占位符，不进 text 检索列） */
  asr_refer_text?: string;
}

export interface NormalizedMention {
  /** 会话内定位标识（openid / @username 等，平台语义由插件权威） */
  id: string;
  /** 平台给的名字——仅存档，读取端一律以 users 表矫正展示名 */
  name?: string;
}

/** 顶层引用：落库为 quote_json，读取端零解析零比对 */
export interface NormalizedQuote {
  /** 平台引用锚点（如 QQ msg_idx 令牌 / Telegram 被引 message_id 字符串） */
  msgIdx?: string;
  /** 被引正文快照（插件摄取期可得则填；读取端不二次解析）。纯媒体被引时为文字占位（如 [图片]） */
  body?: string;
  /** 被引媒体（如 QQ 103 引用自带被引图片）：归引用结构，不混入本条正文/顶层附件 */
  attachments?: NormalizedAttachment[];
  /** 被引作者/消息（被引晚到可留 null，读取端懒补） */
  authorOpenid?: string | null;
  authorName?: string | null;
  msgId?: string | null;
}

/** 聊天记录（如 QQ 102 元素）拍平子消息：落 message_records 表，宿主 content 只留条数标记 */
export interface NormalizedRecord {
  /** 全消息内顺序号（拍平后递增，0 起） */
  ord: number;
  /** 嵌套深度（记录里还能嵌记录，子层 depth+1） */
  depth: number;
  authorOpenid?: string;
  authorName?: string;
  ts?: number | null;
  /** 子消息文本（不含媒体占位/引用转写） */
  text: string;
  /** 子行内引用 */
  quote?: NormalizedQuote | null;
  /** 子消息自带媒体（与宿主 attachments 共用编号去重；此处存该子行命中的子集） */
  attachments: NormalizedAttachment[];
}

/** 成品消息（契约 v2 上行形状）：插件 normalize 产出，core 幂等入库 */
export interface NormalizedMessage {
  botId: string;
  /** group=群聊 / chat=单聊 */
  scope: MsgScope;
  /** scope=group 时为群标识；scope=chat 时为对端用户标识 */
  scopeId: string;
  /** 平台消息 id（(bot,scope,scope_id) 内唯一；幂等入库主键） */
  msgId: string;
  authorOpenid: string;
  authorName?: string;
  /** member / admin / owner（平台缺省可省） */
  authorRole?: string;
  /** 平台 timestamp 转毫秒；缺失时为 null */
  ts: number | null;
  /** 本条纯文本（FTS 检索源——不含媒体占位/结构标记/引用/记录转写） */
  text: string;
  /** 渲染 markdown（媒体占位符 + [卡片] 等结构行；不含引用与记录转写——那些是结构化列） */
  content: string;
  /** 顶层引用（无引用为 null） */
  quote: NormalizedQuote | null;
  /** 聊天记录拍平子消息 */
  records: NormalizedRecord[];
  mentions: NormalizedMention[];
  attachments: NormalizedAttachment[];
  /** ark 结构化卡片原始对象（QQ 语义；其他平台可省） */
  ark?: unknown;
  /** 平台引用令牌（他人引用本消息时的锚；缺失时 undefined） */
  msgIdx?: string;
  /**
   * 群消息「@ 本 bot」权威判定（平台语义，插件权威）：true=确定是@本bot；
   * false=确定不是；省略=平台无法权威判定（如 QQ 全量群消息 GROUP_MESSAGE_CREATE
   * 不区分 @ 归属）。单聊消息恒省略。消费端（wait 层 mention 过滤）按
   * 「true 或 未知且含任意 @」从宽兜底——不漏叫醒优先。
   */
  atMe?: boolean;
  /** 平台事件原始载荷（受 LOG_CONTENT 约束，仅入库不进日志） */
  raw: unknown;
  /** 本机外发标记：1=发送成功后本地补记（省略=网关接收） */
  direction?: 0 | 1;
}

// ---------------------------------------------------------------------------
// 上行效应（InboundEffect）：消息以外的会话侧状态变更，平台语义 → core 中立词汇表。
// botId 不进效应形状——core 按上行信封的 botId 盖章（防插件填错 bot 造成跨 bot 污染）。
// ---------------------------------------------------------------------------

export type InboundEffect =
  /** 群保底在册（消息到达/开关事件的载体证据）；fullMsg=全量开关证据（undefined=不改开关） */
  | { kind: "group-seen"; scopeId: string; fullMsg?: boolean }
  /** bot 被加入群（开关未确认） */
  | { kind: "group-added"; scopeId: string }
  /** bot 被移出群（注册表失效，缓存历史保留） */
  | { kind: "group-removed"; scopeId: string }
  /** 群全量消息开关事件（receive=开 / reject=关） */
  | { kind: "group-opt"; scopeId: string; allow: boolean }
  /** 单聊「允许主动发送」开关（opt-in/opt-out） */
  | { kind: "chat-opt"; scopeId: string; allow: boolean }
  /** 发送审核回执（core sends 账本 pending_audit 行回填） */
  | { kind: "audit"; target: string; pass: boolean };

/** 插件 normalize 的产物：成品消息 + 会话效应（core 逐项落地） */
export interface NormalizedInbound {
  messages: NormalizedMessage[];
  effects: InboundEffect[];
}

// ---------------------------------------------------------------------------
// 形状断言（harness / 插件自测共用）：normalize 产物不符合契约即抛错
// ---------------------------------------------------------------------------

function assertPlainObject(v: unknown, label: string): void {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${label}：必须是对象`);
  }
}

function assertNonEmptyString(v: unknown, label: string): void {
  if (typeof v !== "string" || v === "") {
    throw new Error(`${label}：必须是非空字符串`);
  }
}

/** 单条消息形状断言（NormalizedMessage 契约） */
export function assertNormalizedMessage(m: unknown, label = "message"): void {
  assertPlainObject(m, label);
  const msg = m as Record<string, unknown>;
  assertNonEmptyString(msg["botId"], `${label}.botId`);
  if (msg["scope"] !== "group" && msg["scope"] !== "chat") {
    throw new Error(`${label}.scope：必须是 "group" | "chat"`);
  }
  assertNonEmptyString(msg["scopeId"], `${label}.scopeId`);
  assertNonEmptyString(msg["msgId"], `${label}.msgId`);
  assertNonEmptyString(msg["authorOpenid"], `${label}.authorOpenid`);
  const ts = msg["ts"];
  if (ts !== null && typeof ts !== "number") {
    throw new Error(`${label}.ts：必须是 number | null`);
  }
  if (typeof msg["text"] !== "string" || typeof msg["content"] !== "string") {
    throw new Error(`${label}.text/.content：必须是字符串（可为空串）`);
  }
  for (const key of ["records", "mentions", "attachments"] as const) {
    if (!Array.isArray(msg[key])) {
      throw new Error(`${label}.${key}：必须是数组`);
    }
  }
  if (msg["quote"] !== null && msg["quote"] !== undefined) {
    assertPlainObject(msg["quote"], `${label}.quote`);
  }
  if (
    msg["atMe"] !== undefined &&
    typeof msg["atMe"] !== "boolean"
  ) {
    throw new Error(`${label}.atMe：省略或布尔（true/@本bot，false/确定不是）`);
  }
  assertPlainObject(msg["raw"], `${label}.raw（平台原始载荷）`);
}

/** 单条效应形状断言（InboundEffect 契约） */
export function assertInboundEffect(fx: unknown, label = "effect"): void {
  assertPlainObject(fx, label);
  const e = fx as Record<string, unknown>;
  assertNonEmptyString(e["scopeId"], `${label}.scopeId`);
  switch (e["kind"]) {
    case "group-seen":
      return;
    case "group-added":
    case "group-removed":
      return;
    case "group-opt":
    case "chat-opt":
      if (typeof e["allow"] !== "boolean") {
        throw new Error(`${label}.allow：必须是布尔`);
      }
      return;
    case "audit":
      assertNonEmptyString(e["target"], `${label}.target`);
      if (typeof e["pass"] !== "boolean") {
        throw new Error(`${label}.pass：必须是布尔`);
      }
      return;
    default:
      throw new Error(`${label}.kind：未知效应类别 ${JSON.stringify(e["kind"])}`);
  }
}

/** normalize 产物形状断言（NormalizedInbound 契约） */
export function assertNormalizedInbound(inbound: unknown): void {
  assertPlainObject(inbound, "normalize 产物");
  const b = inbound as Record<string, unknown>;
  if (!Array.isArray(b["messages"]) || !Array.isArray(b["effects"])) {
    throw new Error("normalize 产物：messages / effects 必须是数组");
  }
  (b["messages"] as unknown[]).forEach((m, i) => assertNormalizedMessage(m, `messages[${i}]`));
  (b["effects"] as unknown[]).forEach((fx, i) => assertInboundEffect(fx, `effects[${i}]`));
}
