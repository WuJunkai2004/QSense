// 规范化产物类型族（契约 v2，2026-11-17；T2 zod 硬化 2026-11-24）：NormalizedMessage
// 的权威定义自 core 上移 SDK——「解读权在插件」的前提是插件能直接产出成品消息形状；
// 形状一致性由 conformance harness 的 normalize-shape 检查守 + core ingest 管线的
// zod 网关守（生产链路运行时校验，不再只靠 CI 单样本）。
//
// T2 契约硬化：本文件所有类型 = z.infer（schema 是单一事实源，TS 类型与运行时
// 校验永不漂移）。清洗纪律：网关只做守门 + 机械清洗（default / catch 兜底 /
// trim / 有限性归 null），不做语义解读（不猜秒毫秒、不重写正文——那是 parser 的
// 职权）；atMe 三态 / scope 词表 / direction 字面量神圣不可 default。
//
// 语义约定（与 core 存储层对齐，勿破坏）：
// - scope 词表 group|chat 全链路统一（库列/工具面/发送器）
// - text（本条纯文本，FTS 检索源）/ content（渲染 markdown）分列
// - 身份归身份（openid 稳定标识 + users 表矫正展示名）、内容归内容
// - 引用/聊天记录出列结构化（quote / records）
// - looseObject 透传未知键：向前兼容，不静默丢字段（宽容接收方原则）

import { z } from "zod";

/** 会话侧别：group=群聊 / chat=单聊。全链路统一此词表。 */
export const MSG_SCOPES = ["group", "chat"] as const;
export type MsgScope = (typeof MSG_SCOPES)[number];

/** 附件归一类目：由 content_type 推导，未知形状兜底 file；新消息类型只扩此枚举+渲染层 */
export const ATTACHMENT_KINDS = ["image", "voice", "video", "file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const AttachmentSchema = z
  .looseObject({
    kind: z.enum(ATTACHMENT_KINDS).catch("file"), // 契约既定行为（message.ts 历史）：未知形状兜底 file
    url: z.string().transform((s) => s.trim()), // 机械清洗：去尾随空白
    filename: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    size: z.number().optional(),
    /** 语音/视频时长（秒）；缺失时不输出 */
    duration: z.number().optional(),
    /** 平台原始 MIME（voice / image/jpeg / image/png / image/gif / video/mp4 / file） */
    content_type: z.string().optional(),
    /** 语音附件的转写地址（如 QQ SILK→WAV） */
    voice_wav_url: z.string().optional(),
    /** 语音 ASR 转写参考文本（扮演记忆的重要素材；只进渲染占位符，不进 text 检索列） */
    asr_refer_text: z.string().optional(),
  });
export type NormalizedAttachment = z.infer<typeof AttachmentSchema>;

export const MentionSchema = z.looseObject({
  /** 会话内定位标识（openid / @username 等，平台语义由插件权威；可空串=未知） */
  id: z.string(),
  /** 平台给的名字——仅存档，读取端一律以 users 表矫正展示名 */
  name: z.string().optional(),
});
export type NormalizedMention = z.infer<typeof MentionSchema>;

/**
 * 平台结构化卡片（ark）契约（QQ 真机采样锚定，2026-11-24；其他平台可省此字段）。
 * core 只存储（ark_json 列）与回显，永不解读字段语义；ark_type 词表随平台/版本
 * 扩充（现观测 miniapp 小程序卡片）。
 */
export const ArkCardSchema = z.looseObject({
  /** 卡片展示名（如 "小程序"） */
  ark_name: z.string(),
  /** 卡片类型词（如 "miniapp"） */
  ark_type: z.string(),
  /** 卡片字段键值（preview/source/source_logo/title 等；值域文本） */
  fields: z.record(z.string(), z.string()),
  /** 渲染提示文本（如 "[QQ小程序]标题"） */
  prompt: z.string(),
});
export type ArkCard = z.infer<typeof ArkCardSchema>;

/** 引用对象（quote 本体）：落库为 quote_json，读取端零解析零比对 */
const QuoteBodySchema = z.looseObject({
  /** 平台引用锚点（如 QQ msg_idx 令牌 / Telegram 被引 message_id 字符串） */
  msgIdx: z.string().optional(),
  /** 被引正文快照（插件摄取期可得则填；读取端不二次解析）。纯媒体被引时为文字占位（如 [图片]） */
  body: z.string().optional(),
  /** 被引媒体（如 QQ 103 引用自带被引图片）：归引用结构，不混入本条正文/顶层附件 */
  attachments: z.array(AttachmentSchema).optional(),
  /** 被引作者/消息（被引晚到可留 null，读取端懒补） */
  authorOpenid: z.string().nullable().optional(),
  authorName: z.string().nullable().optional(),
  msgId: z.string().nullable().optional(),
});
/** 顶层引用：NormalizedQuote | null */
export const QuoteSchema = QuoteBodySchema.nullable();
export type NormalizedQuote = z.infer<typeof QuoteBodySchema>;

/** 聊天记录（如 QQ 102 元素）拍平子消息：落 message_records 表，宿主 content 只留条数标记 */
export const RecordSchema = z.looseObject({
  /** 全消息内顺序号（拍平后递增，0 起） */
  ord: z.number().int().nonnegative(),
  /** 嵌套深度（记录里还能嵌记录，子层 depth+1） */
  depth: z.number().int().nonnegative(),
  authorOpenid: z.string().optional(),
  authorName: z.string().optional(),
  ts: z.number().nullable().optional(),
  /** 子消息文本（不含媒体占位/引用转写）。default 兜底 NOT NULL 列——normalize 漏字段不再炸入库 */
  text: z.string().default(""),
  /** 子行内引用 */
  quote: QuoteSchema.optional(),  /** 子消息自带媒体（与宿主 attachments 共用编号去重；此处存该子行命中的子集） */
  attachments: z.array(AttachmentSchema).default([]),
});
export type NormalizedRecord = z.infer<typeof RecordSchema>;

/** 成品消息（契约 v2 上行形状）：插件 normalize 产出，core 幂等入库 */
export const UnifiedMessageSchema = z.looseObject({
  botId: z.string().min(1),
  /** group=群聊 / chat=单聊。词表神圣：违规=可观测丢弃，不清洗 */
  scope: z.enum(MSG_SCOPES),
  /** scope=group 时为群标识；scope=chat 时为对端用户标识 */
  scopeId: z.string().min(1),
  /** 平台消息 id（(bot,scope,scope_id) 内唯一；幂等入库主键）。uint64 兜底：漏网数字/大整数字符串化防精度丢失；空串守门（主键坍塌） */
  msgId: z
    .union([z.string(), z.number(), z.bigint()])
    .transform((v) => (typeof v === "string" ? v : String(v)))
    .refine((v) => v !== "", "msgId：不能为空串（幂等入库主键）"),
  /** 平台侧可缺作者（空串=未知）——repo 层归一为 NULL，契约允许空串 */
  authorOpenid: z.string(),
  authorName: z.string().optional(),
  /** member / admin / owner（平台缺省可省） */
  authorRole: z.string().optional(),
  /** 平台 timestamp 转毫秒；机械清洗：非有限数/负数归 null（缺失语义），非整数取整 */
  ts: z
    .number()
    .nullable()
    .transform((v) =>
      v !== null && Number.isFinite(v) && v >= 0 ? Math.round(v) : null,
    ),
  /** 本条纯文本（FTS 检索源——不含媒体占位/结构标记/引用/记录转写） */
  text: z.string().default(""),
  /** 渲染 markdown（媒体占位符 + [卡片] 等结构行；不含引用与记录转写——那些是结构化列） */
  content: z.string().default(""),
  /** 顶层引用（无引用为 null；缺失等同 null） */
  quote: QuoteSchema.default(null),
  /** 聊天记录拍平子消息 */
  records: z.array(RecordSchema).default([]),
  mentions: z.array(MentionSchema).default([]),
  attachments: z.array(AttachmentSchema).default([]),
  /**
   * 平台结构化卡片（ark，QQ 语义；其他平台可省）——形状契约见 ArkCardSchema
   * （真机采样锚定）。core 只存储/回显不解读字段语义。
   */
  ark: ArkCardSchema.optional(),
  /** 平台引用令牌（他人引用本消息时的锚；缺失时 undefined） */
  msgIdx: z.string().optional(),
  /**
   * 群消息「@ 本 bot」权威判定（平台语义，插件权威）：true=确定是@本bot；
   * false=确定不是；省略=平台无法权威判定（如 QQ 全量群消息 GROUP_MESSAGE_CREATE
   * 不区分 @ 归属）。单聊消息恒省略。消费端（wait 层 mention 过滤）按
   * 「true 或 未知且含任意 @」从宽兜底——不漏叫醒优先。三态神圣不可 default。
   */
  atMe: z.boolean().optional(),
  /**
   * 平台事件原始载荷（受 LOG_CONTENT 约束，仅入库不进日志）——JSON 文本
   * （B⁺ T6 字符串化：序列化点显式在插件侧 JSON.stringify，与 StatePort 同哲学）。
   * core 只存 raw_json 列与迁移重演，需要读回时 parseJsonWith+平台 wire schema
   * 解析（形状归插件 *.types.ts）。
   */
  rawJson: z.string().min(2),
  /** 本机外发标记：1=发送成功后本地补记（省略=网关接收） */
  direction: z.union([z.literal(0), z.literal(1)]).optional(),
});
export type NormalizedMessage = z.infer<typeof UnifiedMessageSchema>;

// ---------------------------------------------------------------------------
// 上行效应（InboundEffect）：消息以外的会话侧状态变更，平台语义 → core 中立词汇表。
// botId 不进效应形状——core 按上行信封的 botId 盖章（防插件填错 bot 造成跨 bot 污染）。
// ---------------------------------------------------------------------------

export const InboundEffectSchema = z.discriminatedUnion("kind", [
  /** 群保底在册（消息到达/开关事件的载体证据）；fullMsg=全量开关证据（undefined=不改开关） */
  z.object({ kind: z.literal("group-seen"), scopeId: z.string().min(1), fullMsg: z.boolean().optional() }),
  /** bot 被加入群（开关未确认） */
  z.object({ kind: z.literal("group-added"), scopeId: z.string().min(1) }),
  /** bot 被移出群（注册表失效，缓存历史保留） */
  z.object({ kind: z.literal("group-removed"), scopeId: z.string().min(1) }),
  /** 群全量消息开关事件（receive=开 / reject=关） */
  z.object({ kind: z.literal("group-opt"), scopeId: z.string().min(1), allow: z.boolean() }),
  /** 单聊「允许主动发送」开关（opt-in/opt-out） */
  z.object({ kind: z.literal("chat-opt"), scopeId: z.string().min(1), allow: z.boolean() }),
  /** 发送审核回执（core sends 账本 pending_audit 行回填；target 空串=找不到行，无害） */
  z.object({ kind: z.literal("audit"), target: z.string(), pass: z.boolean() }),
]);
export type InboundEffect = z.infer<typeof InboundEffectSchema>;

/** 插件 normalize 的产物：成品消息 + 会话效应（core 逐项落地） */
export const UnifiedInboundSchema = z.object({
  messages: z.array(UnifiedMessageSchema),
  effects: z.array(InboundEffectSchema),
});
export type NormalizedInbound = z.infer<typeof UnifiedInboundSchema>;

// ---------------------------------------------------------------------------
// 形状断言（harness / 插件自测共用）：normalize 产物不符合契约即抛错。
// T2 起内部 = schema safeParse（补齐手写浅断言盲区：kind 词表 / url / records.text /
// ts 有限性 / quote 字段深度），签名与抛错行为不变。
// ---------------------------------------------------------------------------

/** zod 校验失败 → 可读摘要（字段路径 + 首数条原因；不含数据值——防正文进日志） */
export function formatZodIssues(error: z.ZodError, label = "message"): string {
  const parts = error.issues.slice(0, 5).map((iss) => {
    const path = iss.path.join(".");
    return `${path === "" ? "(root)" : path}: ${iss.message}`;
  });
  const more = error.issues.length > 5 ? `（共 ${error.issues.length} 项）` : "";
  return `${label}：${parts.join("; ")}${more}`;
}

/** 单条消息形状断言（NormalizedMessage 契约；违契即抛） */
export function assertNormalizedMessage(m: NormalizedMessage, label = "message"): void {
  const r = UnifiedMessageSchema.safeParse(m);
  if (!r.success) throw new Error(formatZodIssues(r.error, label));
}

/** 单条效应形状断言（InboundEffect 契约；违契即抛） */
export function assertInboundEffect(fx: InboundEffect, label = "effect"): void {
  const r = InboundEffectSchema.safeParse(fx);
  if (!r.success) throw new Error(formatZodIssues(r.error, label));
}

/** normalize 产物形状断言（NormalizedInbound 契约） */
export function assertNormalizedInbound(inbound: NormalizedInbound): void {
  const r = UnifiedInboundSchema.safeParse(inbound);
  if (!r.success) throw new Error(formatZodIssues(r.error, "normalize 产物"));
}
