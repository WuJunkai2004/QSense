// Telegram Bot API 客户端（每 bot 一个）：JSON/Multipart 两路 + 可操作错误翻译。
// 零运行时依赖（Node 20 全局 fetch/FormData/Blob）；测试经 overrides.fetch 注入假端点。
// 分仓纪律：connector 只做网络（字节进出与机械编解码），不解码、不判断——
// 载荷解读权在 core 的 normalize/telegram parser。

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

/** 覆写点：字段名与官方 API 一致（snake_case 直通，不做映射层） */
export interface TelegramApiOverrides {
  fetch?: typeof globalThis.fetch;
  /** 缺省 https://api.telegram.org */
  baseUrl?: string;
  /** 长轮询超时秒（官方建议 30-50；测试注入 0 短轮询） */
  pollTimeoutS?: number;
}

/** 官方 Update（只声明本项目消费的字段；透传未知键） */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  [key: string]: unknown;
}

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
  entities?: Array<Record<string, unknown>>;
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

export interface TelegramSticker {
  file_id: string;
  emoji?: string;
  set_name?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  [key: string]: unknown;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  first_name?: string;
  last_name?: string;
  [key: string]: unknown;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  duration: number;
  width: number;
  height: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** getFile 的返回（file_path 拼下载 URL 用；<4h 有效） */
export interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

/** 上行载荷信封（TelegramInboundPayload）：core ingest 按 platform 字段路由到
 * normalize/telegram parser。core 侧经包名 type-only 导入同一形状（对齐 ui.ts
 * 引 connector-qq 命名导出的先例——类型编译期消失，运行时零依赖）。 */
export interface TelegramInboundPayload {
  platform: "telegram";
  update: TelegramUpdate;
  /** 入站图片的最小尺寸缩略图（file_id → data:URL）；摄取失败无键（parser 降级空 url） */
  mediaBlobs?: Record<string, string>;
}

export interface TelegramApi {
  /**
   * JSON POST 调用（Bot API 绝大多数方法是 POST+JSON 可用）；
   * opts.signal 透传 fetch（长轮询打断——stop() 即时生效，不必等 timeout 到期）
   */
  call<T>(
    method: string,
    body?: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
  /** multipart 上传（sendPhoto/sendVoice 等的文件直传） */
  upload<T>(
    method: string,
    file: { buffer: Buffer; filename: string; mime: string },
    field: string,
    fields: Record<string, string>,
  ): Promise<T>;
  /** getFile 产物 → 下载 URL（内嵌 token，绝不能外泄到缓存/日志/工具面） */
  fileUrl(filePath: string): string;
}

export function createTelegramApi(
  token: string,
  overrides: TelegramApiOverrides = {},
): TelegramApi {
  const doFetch = overrides.fetch ?? globalThis.fetch;
  const base = (overrides.baseUrl ?? "https://api.telegram.org").replace(
    /\/$/,
    "",
  );
  const pollTimeoutS = overrides.pollTimeoutS ?? 50;

  async function unwrap<T>(res: Response): Promise<T> {
    let body: { ok?: boolean; result?: T; description?: string; error_code?: number };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramApiError(
        `HTTP ${res.status}（响应非 JSON）`,
        res.status,
      );
    }
    if (body.ok !== true || body.result === undefined) {
      throw new TelegramApiError(
        body.description ?? `HTTP ${res.status}`,
        body.error_code ?? res.status,
      );
    }
    return body.result;
  }

  return {
    async call<T>(
      method: string,
      body: Record<string, unknown> = {},
      opts?: { signal?: AbortSignal },
    ): Promise<T> {
      let res: Response;
      try {
        res = await doFetch(`${base}/bot${token}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal:
            opts?.signal ??
            AbortSignal.timeout(
              // 长轮询按官方 timeout + 网络余量；其余方法 30s 足够
              method === "getUpdates" ? pollTimeoutS * 1000 + 15_000 : 30_000,
            ),
        });
      } catch (e) {
        // 网络层失败（超时/DNS/重置/中断）→ 统一按 0 码抛出（调用侧按可重试分档）
        throw new TelegramApiError(
          e instanceof Error ? e.message : String(e),
          0,
        );
      }
      return unwrap<T>(res);
    },

    async upload<T>(
      method: string,
      file: { buffer: Buffer; filename: string; mime: string },
      field: string,
      fields: Record<string, string>,
    ): Promise<T> {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append(
        field,
        new Blob([new Uint8Array(file.buffer)], { type: file.mime }),
        file.filename,
      );
      let res: Response;
      try {
        res = await doFetch(`${base}/bot${token}/${method}`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        throw new TelegramApiError(
          e instanceof Error ? e.message : String(e),
          0,
        );
      }
      return unwrap<T>(res);
    },

    fileUrl(filePath: string): string {
      return `${base}/file/bot${token}/${filePath}`;
    },
  };
}

/** 可重试分档：网络层失败（code=0）/ 5xx / 429 → true（实例退避重试）；401/409 → fatal */
export function isRetryableApiError(e: unknown): boolean {
  if (!(e instanceof TelegramApiError)) return true; // 非 API 错误（编程错误除外）保守可重试
  if (e.errorCode === 0) return true;
  if (e.errorCode === TG_ERROR_UNAUTHORIZED) return false;
  if (e.errorCode === TG_ERROR_CONFLICT) return false;
  return e.errorCode >= 500 || e.errorCode === 429;
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
