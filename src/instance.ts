// Telegram 连接器实例（每 bot 一个）：getUpdates 长轮询生命周期 + 状态上报 +
// 原始载荷上行（host.ingest）+ 发送原语（net.*）。
//
// B⁺ T4.1：轮询循环迁上 SDK NetKit 的 longPoll 驱动（游标生命周期/fatal 分档/
// 批次摄取留本包 spec——驱动只承担机械不变量：批全摄完才推进游标、指数退避、
// abort 即时、失败逐次上报 degraded）；发送节流/媒体物化/魔数嗅探/时钟全部
// 走 ctx.net——测试驱动权统一收口 FakeNetKit，包内零测试注入管道。
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
  MediaKind,
  MediaSourceWire,
  PluginContext,
  ProactiveWire,
  RecallWire,
  ReplyWire,
  UploadMediaWire,
} from "@qsense/connector-sdk";
import { parseJsonWith } from "@qsense/connector-sdk";
import { z } from "zod";
import {
  describeSendFailure,
  isRetryableApiError,
  TG_ERROR_CONFLICT,
  TG_ERROR_UNAUTHORIZED,
  TG_POLL_TIMEOUT_S,
  TelegramApiError,
  TelegramFileSchema,
  TelegramMessageIdResultSchema,
  TelegramUpdateSchema,
  type TelegramApi,
  type TelegramInboundPayload,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api";
import { tt } from "./texts";

export interface TelegramInstanceDeps {
  ctx: PluginContext;
  botId: string;
  api: TelegramApi;
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
  const { ctx, botId, api } = deps;
  const kit = ctx.net;
  const log = ctx.log.child("poll").child(botId);
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
    const now = kit.now();
    for (const [k, v] of materials) {
      if (now - v.createdAt > MEDIA_HANDLE_TTL_MS) materials.delete(k);
    }
  }

  /** 来源物化（字节进出归 NetKit：下载/解码/读盘；嗅探归 NetKit，兜底按媒体类别） */
  async function materialize(src: MediaSourceWire, kind: MediaKind): Promise<Materialized> {
    const m = await kit.materialize(src);
    return {
      buffer: m.buf,
      mime: kit.sniffMime(m.buf, kind === "voice" ? "audio/mpeg" : "image/jpeg"),
      filename: m.name ?? `media-${kit.now()}`,
      createdAt: kit.now(),
    };
  }

  /** 发送间保守节流（官方 ~1 msg/s/chat；突发靠 1.2s 间隔避开 429）——NetKit 机械 */
  const pace = kit.throttle(MIN_SEND_INTERVAL_MS);

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
      const result = await api.upload(
        method,
        TelegramMessageIdResultSchema,
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
    const result = await api.call("sendMessage", TelegramMessageIdResultSchema, {
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
      await api.call("deleteMessage", z.boolean(), {
        chat_id: chatIdOf(wire.target),
        message_id: id,
      });
    },
    async uploadMedia(wire: UploadMediaWire) {
      sweepMaterials();
      const mat = await materialize(wire.source, wire.kind);
      const handle = `tgm-${botId}-${kit.now()}-${(handleSeq += 1)}`;
      materials.set(handle, mat);
      return { handle };
    },
  };

  // —— 入站缩略图富化（connector 的网络职责：字节抓取 + 机械编码） ——
  async function enrichThumb(
    msg: TelegramMessage,
  ): Promise<Record<string, string>> {
    const blobs: Record<string, string> = {};
    const thumb = msg.photo?.[0]; // 最小尺寸（带宽最优；get_media 只要求"能看"）
    if (thumb === undefined) return blobs;
    try {
      const file = await api.call("getFile", TelegramFileSchema, {
        file_id: thumb.file_id,
      });
      if (file.file_path === undefined) return blobs;
      const res = await kit
        .http({ timeoutMs: 15_000 })
        .request(api.fileUrl(file.file_path));
      if (res.status < 200 || res.status >= 300) return blobs;
      const buf = Buffer.from(await res.raw.arrayBuffer());
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
    ctx.ingest({
      botId,
      payload: {
        platform: "telegram",
        update,
        ...(Object.keys(blobs).length > 0 ? { mediaBlobs: blobs } : {}),
      } satisfies TelegramInboundPayload,
      receivedAt: kit.now(),
    });
  }

  async function runPollLoop(signal: AbortSignal): Promise<void> {
    try {
      await kit.longPoll(
        {
          // 游标 = 下一次 getUpdates 的 offset 参数（last update_id + 1；0=首拉）。
          // StatePort 值 = JSON 文本（B⁺ T6 字符串化；旧数据本就是 stringify 数字，兼容）
          loadCursor: async () => {
            const raw = await ctx.state.get("poll:offset");
            return parseJsonWith(z.number(), raw ?? "") ?? 0;
          },
          saveCursor: async (offset) => {
            await ctx.state.set("poll:offset", JSON.stringify(offset));
          },
          fetch: async (offset, sig) => {
            const updates = await api.call(
              "getUpdates",
              z.array(TelegramUpdateSchema),
              {
                offset: offset === 0 ? undefined : offset,
                timeout: TG_POLL_TIMEOUT_S,
                allowed_updates: ["message"],
              },
              { signal: sig },
            );
            return {
              items: updates,
              next:
                updates.length > 0
                  ? updates[updates.length - 1]!.update_id + 1
                  : undefined,
            };
          },
          onItem: async (item) => {
            // 批次层已过 schema；此处是驱动契约（items: unknown[]）的兜底窄化——
            // 违规告警（不含正文）后跳过单条，不挡同批其余消息
            const parsed = TelegramUpdateSchema.safeParse(item);
            if (!parsed.success) {
              log.warn("poll item failed wire schema", {
                reason: parsed.error.issues[0]?.path.join(".") ?? "(root)",
              });
              return;
            }
            const update = parsed.data;
            const msg = update.message;
            const blobs =
              msg?.photo !== undefined ? await enrichThumb(msg) : {};
            ingestUpdate(update, blobs);
          },
          // 401/409 及其他不可重试 4xx → fatal（驱动上抛，下方翻译文案）
          isFatal: (e) =>
            e instanceof TelegramApiError && !isRetryableApiError(e),
          onState: (s) => {
            if (s === "ready") {
              ctx.reportStatus({ state: "ready" });
              log.info("polling started");
            } else if (s === "degraded") {
              // 驱动逐次失败上报（退避重试中）；detail 由 longPoll 不携带——
              // 记日志带原因，状态面给降级标记
              ctx.reportStatus({ state: "disconnected" });
            }
          },
          policy: { retryMs: 1000, backoffMs: 2, maxDelayMs: 30_000 },
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted) return;
      // fatal 文案与状态上报（与既有语义逐字对齐）
      if (e instanceof TelegramApiError) {
        if (e.errorCode === TG_ERROR_UNAUTHORIZED) {
          log.error(tt("tg_token_invalid", { reason: e.description }));
          ctx.reportStatus({ state: "fatal", detail: "401 token 无效" });
          return;
        }
        if (e.errorCode === TG_ERROR_CONFLICT) {
          log.error(tt("tg_poll_conflict", {}));
          ctx.reportStatus({ state: "fatal", detail: "409 getUpdates 冲突" });
          return;
        }
        log.error("poll fatal error", {
          code: e.errorCode,
          detail: e.description,
        });
        ctx.reportStatus({
          state: "fatal",
          detail: `${e.errorCode} ${e.description}`,
        });
        return;
      }
      // 理论不可达（isFatal 只放行 TelegramApiError）；保守按 fatal 上报
      const detail = e instanceof Error ? e.message : String(e);
      ctx.reportStatus({ state: "fatal", detail });
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
