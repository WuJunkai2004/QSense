// QQ 官方事件线格式 schema（B⁺ T5 parser zod 化）：{type, data} 信封、消息事件体、
// msg_elements 元素树（0=文本 / 3=ARK 卡片 / 101=并行消息 / 102=聊天记录 / 103=引用）
// 全部声明化——防御性 typeof 分支由 schema 替代（parse, don't validate）。
//
// 容错纪律（与旧手写防御逐条等价，官方对元素内字段命名未给全样例）：
// - 容错字段 S/N/B：类型不符 → 视同缺失（畸形已知键不炸整包，等价旧 typeof 守卫）
// - looseObject：未知键透传不解读（宽容接收方原则，raw 保真）
// - 容错数组 tolerantArrayOf：坏元素（null/形状不符）逐项剔除、好元素保留——
//   旧实现对垃圾元素按 ElementLike 强转处理（null 子项会 TypeError 炸整条），
//   现按元素级容错剔除，语义更严且不丢同批好数据
// - 元素类型双名容错（message_type / type）归 elementTypeOf 单点归一，
//   词表 0/3/101/102/103 判别联合 + 未知值宽容（兜底「有文本抽文本」）

import { z } from "zod";

/** 容错字段：声明即消费面；类型不符 → 视同缺失（旧 typeof 防御的 schema 化等价物） */
const S = z.string().optional().catch(undefined);
const N = z.number().optional().catch(undefined);
const B = z.boolean().optional().catch(undefined);

/**
 * 容错数组：坏元素逐项剔除、好元素保留。
 * 单元素失败不炸整个数组（z.array 原生语义是全有全无，不符合本包容错纪律）。
 */
function tolerantArrayOf<T>(item: z.ZodType<T>): z.ZodType<T[]> {
  return z
    .array(item.nullable().catch(null))
    .transform((items) => items.filter((e): e is T => e !== null));
}

// ---------------------------------------------------------------------------
// 附件 / 作者 / 提及（非递归，类型直接 z.infer）
// ---------------------------------------------------------------------------

/** 官方 attachments 数组单项（url 是媒体判定锚；语音可由 wav 转写地址/ASR 文本旁证） */
export const QqAttachmentSchema = z.looseObject({
  url: S,
  filename: S,
  width: N,
  height: N,
  size: N,
  duration: N,
  content_type: S,
  voice_wav_url: S,
  asr_refer_text: S,
});
export type QqAttachment = z.infer<typeof QqAttachmentSchema>;

/** 事件体 author 对象（单聊/群消息的作者标识与展示字段；字段名双写容错全试） */
export const QqAuthorSchema = z.looseObject({
  id: S,
  user_openid: S,
  member_openid: S,
  username: S,
  nickname: S,
  author_name: S,
  member_role: S,
});
export type QqAuthor = z.infer<typeof QqAuthorSchema>;

/** mentions 数组单项（is_you 是「@是否本bot」权威归属，契约 v2.1） */
export const QqMentionSchema = z.looseObject({
  id: S,
  user_openid: S,
  member_openid: S,
  username: S,
  is_you: B,
});
export type QqMention = z.infer<typeof QqMentionSchema>;

// ---------------------------------------------------------------------------
// msg_elements 元素树（递归；接口手写 + z.ZodType 显式标注——zod 推不了递归，
// schema 是运行时权威，接口仅编译期锚点。字段即旧 ElementLike 全部消费点。）
// ---------------------------------------------------------------------------

/** 官方元素类型词表；未知值宽容（兜底分支「有文本抽文本」，不静默丢内容） */
export type QqElementType = 0 | 3 | 101 | 102 | 103 | (number & {});

export const QQ_EL_TEXT = 0;
export const QQ_EL_ARK = 3;
export const QQ_EL_PARALLEL = 101;
export const QQ_EL_FORWARD = 102;
export const QQ_EL_QUOTE = 103;

/** 元素类型归一：message_type / type 双名容错（官方字段命名未给全样例） */
export function elementTypeOf(el: QqElement): QqElementType {
  return el.message_type ?? el.type ?? -1;
}

export interface QqElement {
  /** 类型双名（官方两种命名都见过，elementTypeOf 归一） */
  message_type?: number;
  type?: number;
  /** 文本双名（content/text） */
  content?: string;
  text?: string;
  /** 引用锚 / 记录子行锚 */
  msg_idx?: string;
  /** 卡片标题 / 记录标题 / 被引摘要备选 */
  title?: string;
  desc?: string;
  /** 记录子行时间戳（RFC3339） */
  timestamp?: string;
  // —— 元素自身即媒体 / 记录子行作者的容错字段（旧索引读取声明化） ——
  url?: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  duration?: number;
  content_type?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
  author_openid?: string;
  member_openid?: string;
  user_openid?: string;
  username?: string;
  nickname?: string;
  author_name?: string;
  author?: QqAuthor;
  /** 元素自带媒体（真机 103 引用形状：被引图片在此） */
  attachments?: QqAttachment[];
  /** 子元素四名全试（children/elements/messages/paragraphs） */
  children?: QqElement[];
  elements?: QqElement[];
  messages?: QqElement[];
  paragraphs?: QqElement[];
  [key: string]: unknown;
}

export const QqElementSchema: z.ZodType<QqElement> = z.lazy(() =>
  z.looseObject({
    message_type: N,
    type: N,
    content: S,
    text: S,
    msg_idx: S,
    title: S,
    desc: S,
    timestamp: S,
    url: S,
    filename: S,
    width: N,
    height: N,
    size: N,
    duration: N,
    content_type: S,
    voice_wav_url: S,
    asr_refer_text: S,
    author_openid: S,
    member_openid: S,
    user_openid: S,
    username: S,
    nickname: S,
    author_name: S,
    author: QqAuthorSchema.optional().catch(undefined),
    attachments: tolerantArrayOf(QqAttachmentSchema).optional().catch(undefined),
    children: tolerantArrayOf(z.lazy(() => QqElementSchema))
      .optional()
      .catch(undefined),
    elements: tolerantArrayOf(z.lazy(() => QqElementSchema))
      .optional()
      .catch(undefined),
    messages: tolerantArrayOf(z.lazy(() => QqElementSchema))
      .optional()
      .catch(undefined),
    paragraphs: tolerantArrayOf(z.lazy(() => QqElementSchema))
      .optional()
      .catch(undefined),
  }),
);

// ---------------------------------------------------------------------------
// 消息事件体 / 信封 / 效应事件定位
// ---------------------------------------------------------------------------

/** 消息类事件体（GROUP_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE 的 data） */
export const QqMessageEventDataSchema = z.looseObject({
  id: S,
  group_openid: S,
  content: S,
  /** 消息级 message_type=102（官方合并转发无元素树形状） */
  message_type: N,
  timestamp: S,
  author: QqAuthorSchema.optional().catch(undefined),
  mentions: tolerantArrayOf(QqMentionSchema).optional().catch(undefined),
  attachments: tolerantArrayOf(QqAttachmentSchema).optional().catch(undefined),
  msg_elements: tolerantArrayOf(z.lazy(() => QqElementSchema))
    .optional()
    .catch(undefined),
  /** message_scene.ext = ["msg_idx=…", "auth_token=…"] 令牌数组（本条自己的引用锚） */
  message_scene: z
    .looseObject({ ext: z.array(S).optional().catch(undefined) })
    .optional()
    .catch(undefined),
  /** ARK 卡片原始对象（字段名双写都试；合法不透明边界，契约 ark?: unknown） */
  ark: z.unknown().optional(),
  ark_data: z.unknown().optional(),
});
export type QqMessageEventData = z.infer<typeof QqMessageEventDataSchema>;

/** 事件信封（core ingest 的 QQ 分支唯一输入形状：{platform, type, data}） */
export const QqEnvelopeSchema = z.looseObject({
  type: z.string(),
  data: z.unknown().optional(),
});

/** 效应事件的宽松定位（群侧）：官方事件体字段未完全核实，容错提取 */
export const QqGroupEventDataSchema = z.looseObject({ group_openid: S });

/** 效应事件的宽松定位（单聊侧） */
export const QqUserDataSchema = z.looseObject({ user_openid: S });
