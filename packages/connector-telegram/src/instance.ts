// Telegram 连接器实例（每 bot 一个）：getUpdates 长轮询生命周期 + 状态上报 +
// 原始载荷上行（host.ingest）+ 发送原语（net.*）。
//
// 与 QQ（WS Gateway + RESUME）的本质差异：
// - 长轮询无会话概念，断线连续性 = StatePort 持久化的 poll:offset（重启凭它补拉；
//   至少一次语义由 core 按 msg_id 幂等入库兜底）；
// - 无被动窗口/无额度语义（caps.passiveWindow=false / quota=false）——发送只有
//   proactive 通道（net.reply 仅作契约兼容别名，core caps 感知路由后不会走到）；
// - 入站图片摄取时顺带富化最小尺寸缩略图（data: URL 进载荷 mediaBlobs），
//   core parser 直接落附件 url——get_media 的通用 fetch(att.url) 即可用，core 零改动。

import type {
  ConnectorInstance,
  ConnectorNet,
  HostApi,
  MediaSourceWire,
  ProactiveWire,
  RecallWire,
  ReplyWire,
  UploadMediaWire,
} from "@qsense/connector-sdk";
import {
  describeSendFailure,
  isRetryableApiError,
  TG_ERROR_CONFLICT,
  TG_ERROR_UNAUTHORIZED,
  TelegramApiError,
  type TelegramApi,
  type TelegramInboundPayload,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api";
import { tt } from "./texts";

export interface TelegramInstanceDeps {
  host: HostApi;
  botId: string;
  api: TelegramApi;
  /** 测试注入：轮询间隔/缩略图开关（缺省全走真实通道） */
  overrides?: {
    /** 覆写单条 update 的摄取前处理（缩略图富化）；缺省=真实 getFile+下载 */
    enrich?: (msg: TelegramMessage) => Promise<Record<string, string>>;
  };
}

/** Telegram 单聊频率约束（官方 ~1 msg/s/_chat）：发送间最小间隔（保守 1.2s） */
const MIN_SEND_INTERVAL_MS = 1200;
/** 上传素材句柄 TTL：core uploadMedia → 立即 send，15 分钟富余 */
const MEDIA_HANDLE_TTL_MS = 15 * 60_000;
/** 缩略图字节上限（最小尺寸图通常 <10KB；防御性截断） */
const THUMB_MAX_BYTES = 64 * 1024;

/** 会话 id 是数字字符串（Telegram chat.id）；API 侧转数字更稳（官方 Integer|String） */
function chatIdOf(target: string): number | string {
  return /^-?\d+$/.test(target) ? Number(target) : target;
}

/** 数字化 message_id（quote/撤回锚点；坏值返回 undefined 并由调用侧省略/报错） */
function msgIdNum(id: string | undefined): number | undefined {
  if (id === undefined || !/^-?\d+$/.test(id)) return undefined;
  return Number(id);
}

export function createTelegramInstance(
  deps: TelegramInstanceDeps,
): ConnectorInstance {
  const { host, botId, api } = deps;
  const log = host.log.child("poll").child(botId);
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  // —— 上传素材区（handle → 已物化字节；core uploadMedia 后立即 send） ——
  interface Materialized {
    buffer: Buffer;
    mime: string;
    filename: string;
    createdAt: number;
  }
  const materials = new Map<string, Materialized>();
  let handleSeq = 0;

  function sweepMaterials(): void {
    const now = Date.now();
    for (const [k, v] of materials) {
      if (now - v.createdAt > MEDIA_HANDLE_TTL_MS) materials.delete(k);
    }
  }

  /** 来源物化（connector 只做字节进出：下载/解码/读盘 + 机械嗅探） */
  async function materialize(src: MediaSourceWire): Promise<Materialized> {
    let buffer: Buffer;
    if (src.kind === "url") {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        throw new Error(`来源下载失败（HTTP ${res.status}）`);
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } else if (src.kind === "b64") {
      buffer = Buffer.from(src.data, "base64");
    } else {
      const { readFile } = await import("node:fs/promises");
      buffer = await readFile(src.path);
    }
    return {
      buffer,
      mime: sniffMime(buffer, src.kind),
      filename: guessFilename(src),
      createdAt: Date.now(),
    };
  }

  /** 魔数嗅探（机械编码问题，非语义判断）：JPEG/PNG/GIF → 图；ID3/OGG → 音频；按 kind 兜底 */
  function sniffMime(buf: Buffer, kind: string): string {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
    if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "RIFF") {
      return "audio/wav";
    }
    if (buf.length >= 3 && buf.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
    if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
    if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
    if (buf.length >= 3 && buf.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
    // 按 wire 的类别兜底（core MediaKind: image|voice；b64 源无 mime 信息）
    return buf.length > 0 && (kind === "voice" || kind === "audio") ? "audio/mpeg" : "image/jpeg";
  }

  function guessFilename(src: MediaSourceWire): string {
    if (src.kind === "url") {
      const m = /\/([^/?#]+)\.[a-z0-9]+(?=$|[?#])/i.exec(src.url);
      if (m !== null) return m[1]!;
    }
    if (src.kind === "file") {
      const seg = src.path.split(/[\\/]/).pop();
      if (seg !== undefined && seg !== "") return seg;
    }
    return `media-${Date.now()}`;
  }

  /** 发送间保守节流（官方 ~1 msg/s/chat；突发靠 1.2s 间隔避开 429） */
  const lastSendAt = new Map<string, number>();
  async function pace(target: string): Promise<void> {
    const last = lastSendAt.get(target) ?? 0;
    const wait = last + MIN_SEND_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSendAt.set(target, Date.now());
  }

  /** 发送公共尾段：media 有 → multipart（caption=content）；无 → sendMessage */
  async function sendWire(
    wire: ProactiveWire,
    forceReplyTo?: number,
  ): Promise<{ providerMsgId: string }> {
    const content = wire.content ?? "";
    const replyParams = (() => {
      const ids = [forceReplyTo, msgIdNum(wire.quoteMsgId)];
      const id = ids.find((v) => v !== undefined);
      return id === undefined
        ? undefined
        : { reply_parameters: { message_id: id, allow_sending_without_reply: false } };
    })();

    await pace(wire.target);
    const media = wire.media;
    if (media !== undefined) {
      const mat = materials.get(media.handle);
      if (mat === undefined) {
        throw new Error("媒体句柄不存在或已过期（handle TTL 15 分钟）。");
      }
      materials.delete(media.handle); // 单次使用（与 request_upload 票据同纪律）
      if (content.length > 1024) {
        throw new Error(tt("tg_caption_too_long", { len: content.length }));
      }
      const method = media.kind === "voice" ? "sendVoice" : "sendPhoto";
      const field = media.kind === "voice" ? "voice" : "photo";
      // multipart 复杂字段官方约定 JSON 序列化传递（reply_parameters 为嵌套对象）
      const result = await api.upload<{ message_id: number }>(
        method,
        { buffer: mat.buffer, filename: mat.filename, mime: mat.mime },
        field,
        {
          chat_id: String(chatIdOf(wire.target)),
          ...(content !== "" ? { caption: content } : {}),
          ...(replyParams !== undefined
            ? { reply_parameters: JSON.stringify(replyParams.reply_parameters) }
            : {}),
        },
      );
      return { providerMsgId: String(result.message_id) };
    }

    const chars = [...content].length;
    if (chars > 4096) {
      throw new Error(tt("tg_content_too_long", { len: chars }));
    }
    if (content === "") {
      throw new Error("消息内容为空（文本与媒体均缺失）。");
    }
    const result = await api.call<{ message_id: number }>("sendMessage", {
      chat_id: chatIdOf(wire.target),
      text: content,
      ...(replyParams ?? {}),
    });
    return { providerMsgId: String(result.message_id) };
  }

  const net: ConnectorNet = {
    // passiveWindow=false 平台的唯一发送通道
    async proactive(wire: ProactiveWire) {
      try {
        return await sendWire(wire);
      } catch (e) {
        throw new Error(describeSendFailure(e));
      }
    },
    // 契约兼容别名（passiveWindow=false 平台 core 不会路由到此）：
    // Telegram 无被动窗口，"被动回复"即带 reply_to 的普通发送。
    async reply(wire: ReplyWire) {
      const force = msgIdNum(wire.msgId);
      try {
        return await sendWire(
          {
            botId: wire.botId,
            target: wire.target,
            scope: wire.scope,
            content: wire.content,
            quoteMsgId: wire.quoteMsgId,
            media: wire.media,
          },
          force,
        );
      } catch (e) {
        throw new Error(describeSendFailure(e));
      }
    },
    async recall(wire: RecallWire) {
      const id = msgIdNum(wire.providerMsgId);
      if (id === undefined) {
        throw new Error(`撤回目标不是合法的 Telegram message_id：${wire.providerMsgId}。`);
      }
      await api.call("deleteMessage", {
        chat_id: chatIdOf(wire.target),
        message_id: id,
      });
    },
    async uploadMedia(wire: UploadMediaWire) {
      sweepMaterials();
      const mat = await materialize(wire.source);
      const handle = `tgm-${botId}-${Date.now()}-${(handleSeq += 1)}`;
      materials.set(handle, mat);
      return { handle };
    },
  };

  // —— 入站缩略图富化（connector 的网络职责：字节抓取 + 机械编码） ——
  async function enrichThumb(
    msg: TelegramMessage,
  ): Promise<Record<string, string>> {
    const blobs: Record<string, string> = {};
    const sizes = msg.photo ?? [];
    const thumb = sizes[0]; // 最小尺寸（带宽最优；get_media 只要求"能看"）
    if (thumb === undefined) return blobs;
    try {
      const file = await api.call<{ file_path?: string }>("getFile", {
        file_id: thumb.file_id,
      });
      if (file.file_path === undefined) return blobs;
      const res = await fetch(api.fileUrl(file.file_path), {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return blobs;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > THUMB_MAX_BYTES) return blobs;
      blobs[thumb.file_id] = `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch (e) {
      // 缩略图失败不挡消息摄取：parser 落空 url，get_media 给可操作错误
      log.warn("thumb enrich failed", {
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    return blobs;
  }

  /** 单条 update 摄取（顺序处理保序；批量完成后才推进 offset——至少一次语义） */
  function ingestUpdate(
    update: TelegramUpdate,
    blobs: Record<string, string>,
  ): void {
    host.ingest({
      botId,
      payload: {
        platform: "telegram",
        update,
        ...(Object.keys(blobs).length > 0 ? { mediaBlobs: blobs } : {}),
      } satisfies TelegramInboundPayload,
      receivedAt: Date.now(),
    });
  }

  async function runPollLoop(signal: AbortSignal): Promise<void> {
    let offset =
      (await host.state.get<number>("poll:offset")) ?? 0;
    let backoffMs = 1000;
    let firstSuccess = false;
    while (!signal.aborted) {
      try {
        const updates = await api.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: offset === 0 ? undefined : offset,
            timeout: 50,
            allowed_updates: ["message"],
          },
          { signal },
        );
        for (const update of updates) {
          const msg = update.message;
          const blobs =
            msg?.photo !== undefined
              ? await (deps.overrides?.enrich?.(msg) ?? enrichThumb(msg))
              : {};
          ingestUpdate(update, blobs);
        }
        if (updates.length > 0) {
          offset = updates[updates.length - 1]!.update_id + 1;
          await host.state.set("poll:offset", offset);
        }
        if (!firstSuccess) {
          firstSuccess = true;
          host.reportStatus({ state: "ready" });
          log.info("polling started");
        }
        backoffMs = 1000; // 成功即重置退避
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof TelegramApiError) {
          if (e.errorCode === TG_ERROR_UNAUTHORIZED) {
            log.error(tt("tg_token_invalid", { reason: e.description }));
            host.reportStatus({ state: "fatal", detail: "401 token 无效" });
            return;
          }
          if (e.errorCode === TG_ERROR_CONFLICT) {
            log.error(tt("tg_poll_conflict", {}));
            host.reportStatus({
              state: "fatal",
              detail: "409 getUpdates 冲突",
            });
            return;
          }
          if (!isRetryableApiError(e)) {
            // 其他 4xx（如 400 参数错）不盲重试——fatal 人工处理
            log.error("poll fatal error", {
              code: e.errorCode,
              detail: e.description,
            });
            host.reportStatus({
              state: "fatal",
              detail: `${e.errorCode} ${e.description}`,
            });
            return;
          }
        }
        const detail = e instanceof Error ? e.message : String(e);
        log.warn("poll error; will retry", { backoffMs, detail });
        host.reportStatus({ state: "disconnected", detail });
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  const instance: ConnectorInstance = {
    net,
    start(): Promise<void> {
      if (loop !== null) return loop;
      const c = new AbortController();
      controller = c;
      loop = runPollLoop(c.signal).finally(() => {
        loop = null;
        controller = null;
      });
      return loop;
    },
    stop(): void {
      controller?.abort();
      controller = null;
    },
  };
  return instance;
}
