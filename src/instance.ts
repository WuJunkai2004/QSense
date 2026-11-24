// 微信连接器实例（每 bot 一个）：getupdates 长轮询生命周期 + 状态上报 + 入站图片解密富化 +
// 原始载荷上行（host.ingest）+ 发送原语（net.*）。
//
// B⁺ T4.2：轮询循环迁上 SDK NetKit 的 longPoll 驱动——wx 两处协议语义点的套入形态：
// - 连败 ≥2 且带旧游标清空重拉 → spec.resetCursor（驱动 policy.maxFailures=2 承担，
//   至少一次语义由 core 按 msg_id 去重兜底）；
// - 长轮询挂起到点无消息（timeout）= 正常出口 → spec.fetch 内捕获转空批（驱动
//   ready 语义承担 announce，不计失败不报 disconnected）；
// - 业务码 ret/errcode 非零 → fetch 抛 biz 错（-14 fatal 经 isFatal 上抛）。
// 发送节流/媒体物化/时钟走 ctx.net；CDN 上下行走 ctx.net http——测试驱动权统一
// 收口 FakeNetKit，包内零 overrides 管道。
//
// 断线连续性 = StatePort 持久化的 get_updates_buf 游标（重启凭它续拉）。无被动窗口/
// 无额度语义（caps.passiveWindow=false / quota=false）：发送只有 proactive 通道
// （net.reply 不实现，core caps 感知路由后不会走到）。
//
// 协议事实（参照实现 2.4.10 monitor/monitor.ts、messaging/inbound.ts、messaging/send.ts，
// 2026-11-24 解包核对）：
// - 启动 notifystart、停止 notifystop（在线状态对账，best-effort）
// - 应答体 ret/errcode 非零 = 业务错误：-14 是 bot token 失效（fatal，需重新扫码）
// - longpolling_timeout_ms 是服务端建议的下一次挂起时长（客户端超时取它 + 余量，
//   避免与服务端应答同时到点而误废一次请求）
// - context_token 随每条入站消息下发，出站必须原样回带（按对端用户缓存，StatePort 持久化）
// - 发送间保守节流（软频控，缺省 1s；突发靠间隔避开频控）

import { randomBytes, randomUUID } from "node:crypto";
import type {
  ConnectorInstance,
  ConnectorNet,
  LongPollPolicy,
  MediaSourceWire,
  PluginContext,
  ProactiveWire,
  RecallWire,
  UploadMediaWire,
} from "@qsense/connector-sdk";
import { parseJsonWith } from "@qsense/connector-sdk";
import { z } from "zod";
import {
  LONG_POLL_TIMEOUT_MS,
  WeixinApiError,
  bizCodeOf,
  type WeixinApi,
} from "./api";
import { uploadMediaToCdn } from "./cdn";
import { DEFAULT_MAX_INLINE_IMAGE_BYTES, enrichImages } from "./enrich";
import { WeixinError } from "./errors";
import {
  isSupportedInbound,
  quoteRefIdOf,
  weixinMsgIdOf,
  type WeixinInboundPayload,
} from "./parser";
import { digestOf, mediaLabelOf } from "./quote";
import { tt } from "./texts";
import {
  ILINK_CDN_BASE_URL,
  STALE_TOKEN_ERRCODE,
  WeixinMessageSchema,
  type MessageItem,
  type WeixinMessage,
} from "./types";
import {
  MAX_TEXT_CHARS,
  MAX_UPLOAD_BYTES,
  buildBotMessage,
  buildMediaItem,
  buildTextItem,
  decodeHandle,
  encodeHandle,
  planUpload,
} from "./wire";

export interface WeixinInstanceDeps {
  ctx: PluginContext;
  botId: string;
  api: WeixinApi;
  /** 长轮询策略（NetKit policy；缺省生产值，测试可注入短值） */
  policy?: LongPollPolicy;
  /** 同一对端两次发送的最小间隔（软频控产品参数；缺省 1000ms） */
  sendMinIntervalMs?: number;
}

// —— StatePort 键（宿主按 connector:weixin:{botId}: 前缀隔离） ——
/** getupdates 游标 */
const STATE_BUF = "poll:buf";
/** 对端用户 → 最新 context_token */
const STATE_CTX = "ctx-tokens";
/** 本地引用缓存：最近消息摘要（有序对；ID-only 引用的正文线索） */
const STATE_QUOTES = "quote-cache";

/** 本地引用缓存条数上限（引用通常指向近期消息） */
const QUOTE_MAX_ENTRIES = 300;
/** context_token 缓存的对端数上限（单聊一对端一项） */
const CTX_MAX_ENTRIES = 500;
/** 客户端长轮询超时相对服务端建议值的余量 */
const POLL_MARGIN_MS = 5_000;
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 90_000;
/** 停服通知的超时（独立于已中止的轮询 signal） */
const STOP_NOTIFY_TIMEOUT_MS = 5_000;

/** 长轮询生产缺省策略：首退避 2s、指数封顶 30s、连败 2 次清游标（wx 语义） */
const DEFAULT_POLL_POLICY: LongPollPolicy = {
  retryMs: 2_000,
  backoffMs: 2,
  maxDelayMs: 30_000,
  maxFailures: 2,
};

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createWeixinInstance(deps: WeixinInstanceDeps): ConnectorInstance {
  const { ctx, botId, api } = deps;
  const host = ctx;
  const kit = ctx.net;
  const log = host.log.child("poll").child(botId);
  const sendMinIntervalMs = deps.sendMinIntervalMs ?? 1_000;

  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  // —— context_token 缓存（内存为主、StatePort 持久化，重启存活） ——
  const ctxTokens = new Map<string, string>();

  async function loadCtxTokens(): Promise<void> {
    const raw = await host.state.get(STATE_CTX);
    const parsed = parseJsonWith(z.record(z.string(), z.string()), raw ?? "");
    if (parsed === null) return;
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== "") ctxTokens.set(k, v);
    }
  }

  async function persistCtxTokens(): Promise<void> {
    try {
      await host.state.set(STATE_CTX, JSON.stringify(Object.fromEntries(ctxTokens)));
    } catch (e) {
      log.warn("context token persist failed", { reason: reasonOf(e) });
    }
  }

  function setContextToken(userId: string, token: string): void {
    // 重新插入维持「插入序 = 新旧序」，淘汰时丢最旧
    if (ctxTokens.has(userId)) ctxTokens.delete(userId);
    ctxTokens.set(userId, token);
    while (ctxTokens.size > CTX_MAX_ENTRIES) {
      const oldest = ctxTokens.keys().next().value;
      if (oldest === undefined) break;
      ctxTokens.delete(oldest);
    }
    void persistCtxTokens();
  }

  // —— 本地引用缓存（消息 id → 摘要；有序对持久化，数字型 id 的对象键序不可靠） ——
  const quotes = new Map<string, string>();
  let quotesDirty = false;

  async function loadQuotes(): Promise<void> {
    const raw = await host.state.get(STATE_QUOTES);
    const parsed = parseJsonWith(
      z.object({ q: z.array(z.tuple([z.string(), z.string()])) }),
      raw ?? "",
    );
    if (parsed === null) return;
    for (const [k, v] of parsed.q) {
      quotes.set(k, v);
    }
  }

  async function persistQuotes(): Promise<void> {
    if (!quotesDirty) return;
    quotesDirty = false;
    try {
      await host.state.set(STATE_QUOTES, JSON.stringify({ q: [...quotes] }));
    } catch (e) {
      log.warn("quote cache persist failed", { reason: reasonOf(e) });
    }
  }

  /** 记一条消息摘要（入站消息 / 机器人自发消息），供后续 ID-only 引用解析正文 */
  function remember(msgId: string, digest: string): void {
    if (msgId === "" || digest === "") return;
    if (quotes.has(msgId)) quotes.delete(msgId);
    quotes.set(msgId, digest);
    while (quotes.size > QUOTE_MAX_ENTRIES) {
      const oldest = quotes.keys().next().value;
      if (oldest === undefined) break;
      quotes.delete(oldest);
    }
    quotesDirty = true;
    void persistQuotes();
  }

  // —— 入站：context_token 落缓存 + 图片解密富化 + 上行 ——

  async function ingestOne(m: WeixinMessage): Promise<void> {
    if (!isSupportedInbound(m)) return;
    const from = (m.from_user_id ?? "").trim();
    if (typeof m.context_token === "string" && m.context_token !== "") {
      setContextToken(from, m.context_token);
    }

    const payload: WeixinInboundPayload = { platform: "weixin", message: m };
    const refId = quoteRefIdOf(m);
    if (refId !== undefined && quotes.has(refId)) {
      payload.quoteText = quotes.get(refId);
    }

    let blobs: Record<string, string> = {};
    try {
      blobs = await enrichImages(m, {
        http: kit.http({ timeoutMs: 15_000 }),
        cdnBaseUrl: ILINK_CDN_BASE_URL,
        maxBytes: DEFAULT_MAX_INLINE_IMAGE_BYTES,
        onError: (e) => log.warn("image enrich failed", { reason: reasonOf(e) }),
      });
    } catch (e) {
      // 富化失败不挡消息摄取：parser 落空 url，get_media 给可操作错误
      log.warn("image enrich failed", { reason: reasonOf(e) });
    }
    if (Object.keys(blobs).length > 0) payload.mediaBlobs = blobs;

    host.ingest({ botId, payload, receivedAt: kit.now() });
    remember(weixinMsgIdOf(m), digestOf(m));
  }

  // —— 长轮询主循环（驱动承担机械不变量；wx 协议语义收在 spec） ——

  async function runLoop(signal: AbortSignal): Promise<void> {
    // 游标 = JSON 文本（StatePort B⁺ T6 字符串化；旧数据本就是 stringify 产物，兼容）
    const savedBuf = parseJsonWith(
      z.string(),
      (await host.state.get(STATE_BUF)) ?? "",
    );
    const resumed = savedBuf !== null && savedBuf !== "";
    await Promise.all([loadCtxTokens(), loadQuotes()]);

    // 在线状态对账（best-effort：失败不挡轮询）
    try {
      await api.notifyStart({ signal });
    } catch (e) {
      if (signal.aborted) return;
      log.warn("notifystart failed (ignored)", { reason: reasonOf(e) });
    }
    log.info(resumed ? "resuming from persisted cursor" : "starting fresh", {
      cursorBytes: (savedBuf ?? "").length,
    });

    // 客户端长轮询超时：自适应服务端建议值（hint + 余量，clamp 到 [5s, 90s]）
    let clientTimeoutMs = LONG_POLL_TIMEOUT_MS;
    let announced = false;
    let down = false;

    /** 首次成功：有游标=resumed（断线续拉），否则 ready；此后从断线恢复回 ready */
    const announce = (): void => {
      if (!announced) {
        announced = true;
        host.reportStatus(
          resumed
            ? { state: "resumed", detail: "从持久化游标续拉" }
            : { state: "ready" },
        );
        log.info("polling started");
      } else if (down) {
        down = false;
        host.reportStatus({ state: "ready" });
      }
    };

    try {
      await kit.longPoll(
        {
          loadCursor: async () => {
            const raw = await host.state.get(STATE_BUF);
            const v = parseJsonWith(z.string(), raw ?? "");
            return v !== null && v !== "" ? v : null;
          },
          saveCursor: async (buf) => {
            await host.state.set(STATE_BUF, JSON.stringify(buf));
          },
          // wx 语义：连败 ≥ maxFailures 且带旧游标 → 游标可能已失效（重绑/服务端
          // 重置）→ 清空重拉（至少一次语义由 core 按 msg_id 去重兜底）
          resetCursor: async () => {
            await host.state.delete(STATE_BUF).catch(() => undefined);
          },
          fetch: async (cursor, sig) => {
            const buf = cursor ?? "";
            let resp;
            try {
              resp = await api.getUpdates(buf, { signal: sig, timeoutMs: clientTimeoutMs });
            } catch (e) {
              if (e instanceof WeixinApiError && e.kind === "timeout") {
                // 长轮询挂起到点无消息：正常出口（不计失败、不报 disconnected）
                return { items: [] };
              }
              throw e;
            }
            if (
              typeof resp.longpolling_timeout_ms === "number" &&
              resp.longpolling_timeout_ms > 0
            ) {
              clientTimeoutMs = Math.min(
                POLL_MAX_MS,
                Math.max(POLL_MIN_MS, resp.longpolling_timeout_ms + POLL_MARGIN_MS),
              );
            }
            const code = bizCodeOf(resp);
            if (code !== undefined) {
              if (code === STALE_TOKEN_ERRCODE) {
                throw new WeixinApiError(
                  `getupdates errcode=-14 errmsg=${resp.errmsg ?? "(none)"}`,
                  "biz",
                  { code },
                );
              }
              log.warn("getupdates api error", {
                ret: resp.ret ?? null,
                errcode: resp.errcode ?? null,
              });
              throw new WeixinApiError(
                `getupdates ret=${resp.ret ?? "-"} errcode=${resp.errcode ?? "-"}`,
                "biz",
                { code },
              );
            }
            return {
              items: Array.isArray(resp.msgs) ? resp.msgs : [],
              // 服务端已按建议值挂起整个轮询周期；空批只补驱动最小空转间隔
              ...(resp.get_updates_buf !== undefined &&
              resp.get_updates_buf !== "" &&
              resp.get_updates_buf !== buf
                ? { next: resp.get_updates_buf }
                : {}),
            };
          },
          onItem: async (item) => {
            // 批次层已过 schema（api 层 GetUpdatesRespSchema）；此处是驱动契约
            // （items: unknown[]）的兜底窄化——违规告警后跳过，不挡同批
            const parsed = WeixinMessageSchema.safeParse(item);
            if (!parsed.success) {
              log.warn("poll item failed wire schema", {
                reason: parsed.error.issues[0]?.path.join(".") ?? "(root)",
              });
              return;
            }
            await ingestOne(parsed.data);
          },
          // -14 / 网关层 401/403 → fatal（重试无意义，等人工处理）
          isFatal: (e) =>
            e instanceof WeixinApiError &&
            ((e.kind === "biz" && e.code === STALE_TOKEN_ERRCODE) ||
              (e.kind === "http" && (e.status === 401 || e.status === 403))),
          onState: (s) => {
            if (s === "ready") {
              announce();
            } else if (s === "degraded") {
              // 驱动逐次失败上报（退避重试中）；细节在日志（fetch 内已记原因）
              down = true;
              host.reportStatus({ state: "disconnected" });
            }
          },
          policy: { ...DEFAULT_POLL_POLICY, ...(deps.policy ?? {}) },
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof WeixinApiError && e.kind === "biz" && e.code === STALE_TOKEN_ERRCODE) {
        // bot token 失效：重试无意义，fatal 退出等人工重新扫码
        log.error("bot token is stale", { code: e.code });
        host.reportStatus({ state: "fatal", detail: tt("wx_token_stale_status") });
        return;
      }
      if (
        e instanceof WeixinApiError &&
        e.kind === "http" &&
        (e.status === 401 || e.status === 403)
      ) {
        // 网关层直接拒绝凭据：同样 fatal
        log.error("bot token rejected", { status: e.status });
        host.reportStatus({
          state: "fatal",
          detail: tt("wx_token_invalid", { detail: `HTTP ${e.status}` }),
        });
        return;
      }
      // 理论不可达（isFatal 只放行上述两档）；保守按 fatal 上报
      host.reportStatus({ state: "fatal", detail: reasonOf(e) });
    } finally {
      // 在线状态对账（独立超时，不随已中止的轮询 signal）
      try {
        await api.notifyStop({ timeoutMs: STOP_NOTIFY_TIMEOUT_MS });
      } catch {
        /* best-effort */
      }
      log.info("poll loop ended");
    }
  }

  // —— 出站 ——

  /** 同一对端发送节流（软频控）——NetKit 机械 */
  const pace = kit.throttle(sendMinIntervalMs);

  /** 发单个 item（一条消息）；返回服务端消息 id（缺失回落 client_id） */
  async function sendItem(
    to: string,
    item: MessageItem,
    ctxToken: string | undefined,
    runId: string,
  ): Promise<string> {
    const clientId = `qsense-weixin:${kit.now()}-${randomBytes(4).toString("hex")}`;
    await pace(to);
    const resp = await api.sendMessage(
      buildBotMessage({ to, clientId, item, contextToken: ctxToken, runId }),
    );
    return resp.message_id?.trim() || clientId;
  }

  /** 错误翻译：平台错误 → 可操作文案；包内已可操作的文案原样透出 */
  function describeError(e: unknown): string {
    if (e instanceof WeixinError) return e.message;
    if (e instanceof WeixinApiError) {
      if (e.kind === "biz" && e.code === STALE_TOKEN_ERRCODE) {
        return tt("wx_token_invalid", { detail: `errcode ${e.code}` });
      }
      if (e.kind === "http" && (e.status === 401 || e.status === 403)) {
        return tt("wx_token_invalid", { detail: `HTTP ${e.status}` });
      }
      if (e.kind === "network") return tt("wx_unreachable", { reason: e.message });
      return tt("wx_send_failed", { reason: e.message });
    }
    return reasonOf(e);
  }

  async function sendWire(wire: ProactiveWire): Promise<{ providerMsgId: string }> {
    const to = wire.target.trim();
    if (to === "") throw new WeixinError(tt("wx_target_invalid"));
    const text = wire.content ?? "";
    const chars = [...text].length;
    if (chars > MAX_TEXT_CHARS) {
      throw new WeixinError(tt("wx_content_too_long", { len: chars }));
    }
    const media = wire.media;
    if (text === "" && media === undefined) {
      throw new WeixinError(tt("wx_content_empty"));
    }
    if (wire.quoteMsgId !== undefined) {
      // 出站引用的线上形状未核实（参照实现无发送路径）：不猜，按普通消息发
      log.debug("quoteMsgId ignored (weixin outbound quote unverified)");
    }
    const ctxToken = ctxTokens.get(to);
    if (ctxToken === undefined) {
      log.warn("context token missing; sending without context", { target: to });
    }

    // 配文与媒体分两条消息发（协议约定 item_list 恒单项），同一 run_id 串联
    const runId = randomUUID();
    let lastId: string | undefined;
    if (text !== "") {
      lastId = await sendItem(to, buildTextItem(text), ctxToken, runId);
      remember(lastId, text);
    }
    if (media !== undefined) {
      const plan = decodeHandle(media.handle);
      const item = buildMediaItem(plan);
      lastId = await sendItem(to, item, ctxToken, runId);
      remember(lastId, mediaLabelOf(item.type));
    }
    log.info("proactive sent", { target: to, media: media?.kind ?? "none" });
    return { providerMsgId: lastId! };
  }

  /** 媒体来源物化（字节进出归 NetKit；失败包可操作错误） */
  async function materialize(
    src: MediaSourceWire,
  ): Promise<{ buf: Buffer; name?: string }> {
    try {
      return await kit.materialize(src);
    } catch (e) {
      throw new WeixinError(tt("wx_media_source_failed", { reason: reasonOf(e) }));
    }
  }

  /** 上传即物化 + 加密直传 CDN；返回无状态句柄（编码全部素材事实） */
  async function upload(wire: UploadMediaWire): Promise<string> {
    const mat = await materialize(wire.source);
    if (mat.buf.length === 0) throw new WeixinError(tt("wx_media_empty"));
    if (mat.buf.length > MAX_UPLOAD_BYTES) {
      throw new WeixinError(
        tt("wx_media_too_large", {
          mb: (mat.buf.length / 1024 / 1024).toFixed(1),
        }),
      );
    }
    const plan = planUpload(mat.buf, mat.name);
    const up = await uploadMediaToCdn({
      api,
      buf: mat.buf,
      toUserId: wire.target,
      mediaType: plan.mediaType,
      cdnBaseUrl: ILINK_CDN_BASE_URL,
      http: kit.http({ timeoutMs: 60_000 }),
    });
    log.info("media uploaded to cdn", { kind: plan.kind, bytes: mat.buf.length });
    return encodeHandle({ kind: plan.kind, fileName: plan.fileName, up });
  }

  const net: ConnectorNet = {
    // passiveWindow=false 平台的唯一发送通道
    async proactive(wire) {
      try {
        return await sendWire(wire);
      } catch (e) {
        throw new Error(describeError(e));
      }
    },
    async uploadMedia(wire) {
      try {
        return { handle: await upload(wire) };
      } catch (e) {
        throw new Error(describeError(e));
      }
    },
    // caps.recall=false：core 不要求该原语，但基座工具面恒含 recall——调用时给可操作错误
    async recall(_wire: RecallWire): Promise<void> {
      throw new Error(tt("wx_recall_unsupported"));
    },
  };

  return {
    net,
    start(): Promise<void> {
      if (loop !== null) return loop;
      const c = new AbortController();
      controller = c;
      loop = runLoop(c.signal).finally(() => {
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
}
