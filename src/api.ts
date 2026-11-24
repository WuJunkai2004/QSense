// Telegram Bot API 客户端（每 bot 一个）：JSON/Multipart 两路 + 可操作错误翻译。
// B⁺ T4.1：传输机械走 SDK NetKit（HttpClient 统一超时/中止合并/unref 定时器），
// 应答经本包 wire schema（zod）校验——网络层出来的数据 = 插件声明类型，无盲转型；
// 测试驱动权统一收口到 FakeNetKit（包内不再自持 overrides.fetch / 假端点管道）。
// 分仓纪律：connector 只做网络（字节进出与机械编解码），不解码、不判断——
// 载荷解读权在本包 normalize parser。
//
// 信封语义（不在 NetKit json() 层做，保错误保真）：Telegram 业务错误走应答体
// {ok:false, error_code, description} 且 HTTP 状态同步 4xx/5xx——错误体的
// description（"Bad Request: chat not found" 等）是可操作文案的正则锚点，
// 必须读出来，不能用 NetError("http", status) 把它吞掉。

import { z, type ZodType } from "zod";
import { isNetError, parseJsonWith, type HttpClient, type HttpResponse } from "@qsense/connector-sdk";
import { tt } from "./texts";

/** Telegram API 错误（description 可读、error_code 官方码；分档判断在调用侧） */
export class TelegramApiError extends Error {
  constructor(
    readonly description: string,
    readonly errorCode: number,
  ) {
    super(description);
    this.name = "TelegramApiError";
  }
}

/** getUpdates 401/409 等致命分档（实例据此 fatal，不无限重试） */
export const TG_ERROR_UNAUTHORIZED = 401;
export const TG_ERROR_CONFLICT = 409;

/** 长轮询官方建议挂起时长（秒，50-30）；HTTP 超时 = 挂起时长 + 网络余量 */
export const TG_POLL_TIMEOUT_S = 50;

// ---------------------------------------------------------------------------
// wire schema（官方线格式；looseObject 保透传键——宽容接收方原则）。
// 纪律：轮询路径的 schema 只做结构守门（字段在不在、类型对不对），词表过滤
// （chat.type 等）归 parser——官方新增枚举值不得把整批 update 卡死在网关。
// 递归形状（reply_to_message / pinned_message）需要手写接口做显式标注——
// schema 仍是运行时权威，接口仅编译期锚点（zod 无法推断递归类型）。
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  [key: string]: unknown;
}

export const TelegramUserSchema = z.looseObject({
  id: z.number(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

export interface TelegramChat {
  id: number;
  /** 官方词表 private|group|supergroup|channel；schema 宽容为 string，词表过滤归 parser */
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  [key: string]: unknown;
}

export const TelegramChatSchema = z.looseObject({
  id: z.number(),
  type: z.string(),
  title: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export const TelegramPhotoSizeSchema = z.looseObject({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  width: z.number(),
  height: z.number(),
  file_size: z.number().optional(),
});

export interface TelegramSticker {
  file_id: string;
  emoji?: string;
  set_name?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export const TelegramStickerSchema = z.looseObject({
  file_id: z.string(),
  emoji: z.string().optional(),
  set_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export interface TelegramVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export const TelegramVoiceSchema = z.looseObject({
  file_id: z.string(),
  duration: z.number(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

export interface TelegramVideo {
  file_id: string;
  duration: number;
  width: number;
  height: number;
  mime_type?: string;
  file_size?: number;
}

export const TelegramVideoSchema = z.looseObject({
  file_id: z.string(),
  duration: z.number(),
  width: z.number(),
  height: z.number(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export const TelegramDocumentSchema = z.looseObject({
  file_id: z.string(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

/** 消息实体（mention/text_mention 等；parser 消费 type/offset/length/user） */
export interface TelegramEntity {
  type?: string;
  offset?: number;
  length?: number;
  user?: TelegramUser;
  [key: string]: unknown;
}

export const TelegramEntitySchema = z.looseObject({
  type: z.string().optional(),
  offset: z.number().optional(),
  length: z.number().optional(),
  user: TelegramUserSchema.optional(),
});

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  video?: TelegramVideo;
  document?: TelegramDocument;
  sticker?: TelegramSticker;
  entities?: TelegramEntity[];
  // —— 服务消息（群生命周期；内容进括注行，与 QQ [卡片] 括注约定同风格） ——
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
  new_chat_title?: string;
  new_chat_photo?: TelegramPhotoSize;
  delete_chat_photo?: true;
  group_chat_created?: true;
  pinned_message?: TelegramMessage;
  [key: string]: unknown;
}

export const TelegramMessageSchema: z.ZodType<TelegramMessage> = z.lazy(() =>
  z.looseObject({
    message_id: z.number(),
    from: TelegramUserSchema.optional(),
    chat: TelegramChatSchema,
    date: z.number().optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    reply_to_message: z.lazy(() => TelegramMessageSchema).optional(),
    photo: z.array(TelegramPhotoSizeSchema).optional(),
    voice: TelegramVoiceSchema.optional(),
    video: TelegramVideoSchema.optional(),
    document: TelegramDocumentSchema.optional(),
    sticker: TelegramStickerSchema.optional(),
    entities: z.array(TelegramEntitySchema).optional(),
    new_chat_members: z.array(TelegramUserSchema).optional(),
    left_chat_member: TelegramUserSchema.optional(),
    new_chat_title: z.string().optional(),
    new_chat_photo: TelegramPhotoSizeSchema.optional(),
    delete_chat_photo: z.literal(true).optional(),
    group_chat_created: z.literal(true).optional(),
    pinned_message: z.lazy(() => TelegramMessageSchema).optional(),
  }),
);

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  [key: string]: unknown;
}

export const TelegramUpdateSchema = z.looseObject({
  update_id: z.number(),
  message: TelegramMessageSchema.optional(),
  edited_message: TelegramMessageSchema.optional(),
});

/** getFile 的返回（file_path 拼下载 URL 用；<4h 有效） */
export interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

export const TelegramFileSchema = z.looseObject({
  file_id: z.string(),
  file_path: z.string().optional(),
  file_size: z.number().optional(),
});

/** getMe 产物（atMe 身份判定 + verifyCredential 的 appid 对照） */
export interface TelegramMe {
  id: number;
  username?: string;
  [key: string]: unknown;
}

export const TelegramMeSchema = z.looseObject({
  id: z.number(),
  username: z.string().optional(),
});

/** sendMessage/sendPhoto/sendVoice 回执（发送侧只消费 message_id） */
export interface TelegramMessageIdResult {
  message_id: number;
  [key: string]: unknown;
}

export const TelegramMessageIdResultSchema = z.looseObject({
  message_id: z.number(),
});

/** 上行载荷信封（TelegramInboundPayload）：core ingest 按 platform 字段路由到
 * normalize/telegram parser。core 侧经包名 type-only 导入同一形状（对齐 ui.ts
 * 引 connector-qq 命名导出的先例——类型编译期消失，运行时零依赖）。 */
export interface TelegramInboundPayload {
  platform: "telegram";
  update: TelegramUpdate;
  /** 入站图片的最小尺寸缩略图（file_id → data:URL）；摄取失败无键（parser 降级空 url） */
  mediaBlobs?: Record<string, string>;
}

/** 信封 wire schema（B⁺ T5）：plugin.normalize 头部 safeParse 入口——形状违规
 * = 可观测丢弃 + warn（与容错丢弃语义一致，不再盲信类型标注） */
export const TelegramInboundPayloadSchema = z.looseObject({
  platform: z.literal("telegram"),
  update: TelegramUpdateSchema,
  mediaBlobs: z.record(z.string(), z.string()).optional(),
});

export interface TelegramApi {
  /**
   * JSON POST 调用（Bot API 绝大多数方法是 POST+JSON 可用）。
   * 结果经 result schema 校验返回（网络层出来的数据 = 声明类型）；
   * opts.signal 透传（长轮询打断——stop() 即时生效，不必等 timeout 到期）。
   */
  call<T>(
    method: string,
    result: ZodType<T>,
    body?: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
  /** multipart 上传（sendPhoto/sendVoice 等的文件直传） */
  upload<T>(
    method: string,
    result: ZodType<T>,
    file: { buffer: Buffer; filename: string; mime: string },
    field: string,
    fields: Record<string, string>,
  ): Promise<T>;
  /** getFile 产物 → 下载 URL（内嵌 token，绝不能外泄到缓存/日志/工具面） */
  fileUrl(filePath: string): string;
}

const BASE_URL = "https://api.telegram.org";

/** 应答信封：ok 缺失/为 false → TelegramApiError（保真 description/error_code）；
 * ok=true → result 字段过 wire schema（违规=可定位字段路径，不带数据值）。 */
const EnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().optional(),
});

function unwrap<T>(res: HttpResponse, result: ZodType<T>): Promise<T> {
  return (async () => {
    // 应答体 JSON 文本 → parseJsonWith（信封 schema 把关；坏 JSON → 可操作错误）
    const text = await res.text().catch(() => "");
    const env = parseJsonWith(EnvelopeSchema, text);
    if (env === null) {
      throw new TelegramApiError(`HTTP ${res.status}（响应非 JSON）`, res.status);
    }
    if (env.ok !== true) {
      throw new TelegramApiError(
        env.description ?? `HTTP ${res.status}`,
        env.error_code ?? res.status,
      );
    }
    const parsed = result.safeParse(env["result"]);
    if (!parsed.success) {
      const paths = parsed.error.issues
        .slice(0, 5)
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ");
      throw new TelegramApiError(
        `响应不符合 wire schema：${paths}`,
        res.status,
      );
    }
    return parsed.data;
  })();
}

export function createTelegramApi(http: HttpClient, token: string): TelegramApi {
  const url = (method: string): string => `${BASE_URL}/bot${token}/${method}`;
  return {
    async call(method, result, body = {}, opts) {
      const res = await http.request(url(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs:
          // 长轮询按官方 timeout + 网络余量；其余方法 30s 足够
          method === "getUpdates" ? TG_POLL_TIMEOUT_S * 1000 + 15_000 : 30_000,
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
      return unwrap(res, result);
    },

    async upload(method, result, file, field, fields) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append(
        field,
        new Blob([new Uint8Array(file.buffer)], { type: file.mime }),
        file.filename,
      );
      const res = await http.request(url(method), {
        method: "POST",
        body: form,
        timeoutMs: 60_000,
      });
      return unwrap(res, result);
    },

    fileUrl(filePath: string): string {
      return `${BASE_URL}/file/bot${token}/${filePath}`;
    },
  };
}

/** 可重试分档：NetError 机械档（timeout/network）→ true；TelegramApiError
 * 网络 0 码 / 5xx / 429 → true（实例退避重试）；401/409 及其他 4xx → false（fatal） */
export function isRetryableApiError(e: unknown): boolean {
  if (e instanceof Error && isNetError(e)) {
    return e.kind === "network" || e.kind === "timeout";
  }
  if (e instanceof TelegramApiError) {
    if (e.errorCode === 0) return true;
    if (e.errorCode === TG_ERROR_UNAUTHORIZED) return false;
    if (e.errorCode === TG_ERROR_CONFLICT) return false;
    return e.errorCode >= 500 || e.errorCode === 429;
  }
  return true; // 非 API/网络错误保守可重试
}

/** 发送类错误的可操作翻译（connector 自带平台提示，宿主/基座不再加工平台语义） */
export function describeSendFailure(e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  if (e instanceof TelegramApiError) {
    if (/chat not found/i.test(reason)) return tt("tg_chat_not_found", { reason });
    if (/voice/i.test(reason) || / Wrong file id|unsupported/i.test(reason)) {
      // 语音格式类失败优先给转码提示（Telegram 只收 OGG/MP3/M4A）
      return tt("tg_voice_format", { reason });
    }
  }
  return tt("tg_send_failed", { reason });
}
