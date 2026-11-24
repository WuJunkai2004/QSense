// 微信连接器实例（每 bot 一个）：getupdates 长轮询生命周期 + 状态上报 + 入站图片解密富化 +
// 原始载荷上行（host.ingest）+ 发送原语（net.*）。
//
// 断线连续性 = StatePort 持久化的 get_updates_buf 游标（重启凭它续拉；至少一次语义由
// core 按 msg_id 幂等入库兜底——批次全部摄取完成后才推进游标，与 Telegram offset 同纪律）。
// 无被动窗口/无额度语义（caps.passiveWindow=false / quota=false）：发送只有 proactive
// 通道（net.reply 不实现，core caps 感知路由后不会走到）。
//
// 协议事实（参照实现 2.4.10 monitor/monitor.ts、messaging/inbound.ts、messaging/send.ts，
// 2026-11-24 解包核对）：
// - 启动 notifystart、停止 notifystop（在线状态对账，best-effort）
// - 应答体 ret/errcode 非零 = 业务错误：-14 是 bot token 失效（fatal，需重新扫码）；
//   其余按 retryDelay 重试、连续 3 次后退避 backoffDelay
// - longpolling_timeout_ms 是服务端建议的下一次挂起时长（客户端超时取它 + 余量，
//   避免与服务端应答同时到点而误废一次请求）
// - context_token 随每条入站消息下发，出站必须原样回带（按对端用户缓存，StatePort 持久化）
// - 发送间保守节流（软频控，缺省 1s；突发靠间隔避开频控）

import { randomBytes, randomUUID } from "node:crypto";
import type {
  ConnectorInstance,
  ConnectorNet,
  HostApi,
  MediaSourceWire,
  ProactiveWire,
  RecallWire,
  UploadMediaWire,
} from "@qsense/connector-sdk";
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

export interface WeixinInstanceOverrides {
  /** 缺省 globalThis.fetch；测试注入假实现 */
  fetch?: typeof globalThis.fetch;
  /** 缺省协议常量 ILINK_CDN_BASE_URL */
  cdnBaseUrl?: string;
  /** 长轮询客户端超时（缺省 35000；服务端建议值只在未覆写时生效）；测试注入短值 */
  pollTimeoutMs?: number;
  /** 业务错误/网络失败后的重试间隔（缺省 2000） */
  retryDelayMs?: number;
  /** 连续失败后的退避间隔（缺省 30000） */
  backoffDelayMs?: number;
  /** 同一对端两次发送的最小间隔（缺省 1000；软频控） */
  sendMinIntervalMs?: number;
  /** 内联图片上限（解密后字节；缺省 2MB） */
  maxInlineImageBytes?: number;
  /** 入站富化替身（测试注入：不碰网络） */
  enrich?: (message: WeixinMessage) => Promise<Record<string, string>>;
}

export interface WeixinInstanceDeps {
  host: HostApi;
  botId: string;
  api: WeixinApi;
  overrides?: WeixinInstanceOverrides;
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
/** 连续失败多少次后进入长退避 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 客户端长轮询超时相对服务端建议值的余量 */
const POLL_MARGIN_MS = 5_000;
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 90_000;
/** 停服通知的超时（独立于已中止的轮询 signal） */
const STOP_NOTIFY_TIMEOUT_MS = 5_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createWeixinInstance(deps: WeixinInstanceDeps): ConnectorInstance {
  const { host, botId, api } = deps;
  const ov = deps.overrides ?? {};
  const log = host.log.child("poll").child(botId);
  const fetchImpl = ov.fetch ?? globalThis.fetch;
  const cdnBaseUrl = ov.cdnBaseUrl ?? ILINK_CDN_BASE_URL;
  const retryDelayMs = ov.retryDelayMs ?? 2000;
  const backoffDelayMs = ov.backoffDelayMs ?? 30_000;
  const sendMinIntervalMs = ov.sendMinIntervalMs ?? 1000;
  const maxInlineImageBytes = ov.maxInlineImageBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES;

  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  // —— context_token 缓存（内存为主、StatePort 持久化，重启存活） ——
  const ctxTokens = new Map<string, string>();

  async function loadCtxTokens(): Promise<void> {
    const saved = await host.state.get<unknown>(STATE_CTX);
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") ctxTokens.set(k, v);
    }
  }

  async function persistCtxTokens(): Promise<void> {
    try {
      await host.state.set(STATE_CTX, Object.fromEntries(ctxTokens));
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
    const saved = await host.state.get<{ q?: unknown }>(STATE_QUOTES);
    const pairs = saved?.q;
    if (!Array.isArray(pairs)) return;
    for (const pair of pairs) {
      if (
        Array.isArray(pair) &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string"
      ) {
        quotes.set(pair[0], pair[1]);
      }
    }
  }

  async function persistQuotes(): Promise<void> {
    if (!quotesDirty) return;
    quotesDirty = false;
    try {
      await host.state.set(STATE_QUOTES, { q: [...quotes] });
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
      blobs = ov.enrich
        ? await ov.enrich(m)
        : await enrichImages(m, {
            fetchImpl,
            cdnBaseUrl,
            maxBytes: maxInlineImageBytes,
            onError: (e) => log.warn("image enrich failed", { reason: reasonOf(e) }),
          });
    } catch (e) {
      // 富化失败不挡消息摄取：parser 落空 url，get_media 给可操作错误
      log.warn("image enrich failed", { reason: reasonOf(e) });
    }
    if (Object.keys(blobs).length > 0) payload.mediaBlobs = blobs;

    host.ingest({ botId, payload, receivedAt: Date.now() });
    remember(weixinMsgIdOf(m), digestOf(m));
  }

  // —— 长轮询主循环 ——

  async function runLoop(signal: AbortSignal): Promise<void> {
    let buf = await host.state.get<string>(STATE_BUF);
    if (typeof buf !== "string") buf = "";
    const resumed = buf !== "";
    await Promise.all([loadCtxTokens(), loadQuotes()]);

    // 在线状态对账（best-effort：失败不挡轮询）
    try {
      await api.notifyStart({ signal });
    } catch (e) {
      if (signal.aborted) return;
      log.warn("notifystart failed (ignored)", { reason: reasonOf(e) });
    }
    log.info(resumed ? "resuming from persisted cursor" : "starting fresh", {
      cursorBytes: buf.length,
    });

    let timeoutMs = ov.pollTimeoutMs ?? LONG_POLL_TIMEOUT_MS;
    let failures = 0;
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
      while (!signal.aborted) {
        try {
          const resp = await api.getUpdates(buf, { signal, timeoutMs });
          if (
            ov.pollTimeoutMs === undefined &&
            typeof resp.longpolling_timeout_ms === "number" &&
            resp.longpolling_timeout_ms > 0
          ) {
            timeoutMs = Math.min(
              POLL_MAX_MS,
              Math.max(POLL_MIN_MS, resp.longpolling_timeout_ms + POLL_MARGIN_MS),
            );
          }

          const code = bizCodeOf(resp);
          if (code !== undefined) {
            if (code === STALE_TOKEN_ERRCODE) {
              // bot token 失效：重试无意义，fatal 退出等人工重新扫码
              log.error("bot token is stale", { code });
              host.reportStatus({
                state: "fatal",
                detail: tt("wx_token_stale_status"),
              });
              return;
            }
            failures += 1;
            log.warn("getupdates api error", {
              ret: resp.ret,
              errcode: resp.errcode,
              failures,
            });
            // 持续报错且带着旧游标：游标可能已失效（重绑/服务端重置）→ 清空重拉
            //（至少一次语义由 core 按 msg_id 去重兜底）
            if (failures >= 2 && buf !== "") {
              buf = "";
              await host.state.delete(STATE_BUF).catch(() => undefined);
            }
            down = true;
            host.reportStatus({
              state: "disconnected",
              detail: `ret=${resp.ret ?? "-"} errcode=${resp.errcode ?? "-"}`,
            });
            await sleep(
              failures >= MAX_CONSECUTIVE_FAILURES ? backoffDelayMs : retryDelayMs,
              signal,
            );
            if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
            continue;
          }

          announce();
          failures = 0;

          // 批内顺序处理；中途停服则不推进游标（下轮重拉，core 去重）
          for (const m of Array.isArray(resp.msgs) ? resp.msgs : []) {
            if (signal.aborted) break;
            await ingestOne(m);
          }
          const next = resp.get_updates_buf;
          if (typeof next === "string" && next !== "" && next !== buf) {
            buf = next;
            await host.state.set(STATE_BUF, buf);
          }
        } catch (e) {
          if (signal.aborted) break;
          if (e instanceof WeixinApiError && e.kind === "timeout") {
            // 长轮询挂起到点无消息：正常出口（服务端已接受连接）
            announce();
            failures = 0;
            continue;
          }
          if (e instanceof WeixinApiError && e.kind === "aborted") break;
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
          failures += 1;
          const detail = reasonOf(e);
          log.warn("getupdates error; will retry", {
            failures,
            detail,
            kind: e instanceof WeixinApiError ? e.kind : "unknown",
          });
          down = true;
          host.reportStatus({ state: "disconnected", detail });
          await sleep(
            failures >= MAX_CONSECUTIVE_FAILURES ? backoffDelayMs : retryDelayMs,
            signal,
          );
          if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
        }
      }
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

  /** 同一对端发送节流（软频控） */
  const lastSendAt = new Map<string, number>();
  async function pace(target: string): Promise<void> {
    const wait = (lastSendAt.get(target) ?? 0) + sendMinIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSendAt.set(target, Date.now());
  }

  /** 发单个 item（一条消息）；返回服务端消息 id（缺失回落 client_id） */
  async function sendItem(
    to: string,
    item: MessageItem,
    ctxToken: string | undefined,
    runId: string,
  ): Promise<string> {
    const clientId = `qsense-weixin:${Date.now()}-${randomBytes(4).toString("hex")}`;
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

  /** 媒体来源物化（connector 只做字节进出：下载/解码/读盘） */
  async function materialize(
    src: MediaSourceWire,
  ): Promise<{ buf: Buffer; name?: string }> {
    if (src.kind === "url") {
      let res: Response;
      try {
        res = await fetchImpl(src.url, { signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        throw new WeixinError(tt("wx_media_source_failed", { reason: reasonOf(e) }));
      }
      if (!res.ok) {
        throw new WeixinError(
          tt("wx_media_source_failed", { reason: `HTTP ${res.status}` }),
        );
      }
      let name: string | undefined;
      try {
        const last = decodeURIComponent(new URL(src.url).pathname.split("/").pop() ?? "");
        name = last === "" ? undefined : last;
      } catch {
        name = undefined;
      }
      return {
        buf: Buffer.from(await res.arrayBuffer()),
        ...(name !== undefined ? { name } : {}),
      };
    }
    if (src.kind === "b64") return { buf: Buffer.from(src.data, "base64") };
    try {
      const { readFile } = await import("node:fs/promises");
      const name = src.path.split(/[\\/]/).pop();
      return {
        buf: await readFile(src.path),
        ...(name !== undefined && name !== "" ? { name } : {}),
      };
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
      cdnBaseUrl,
      fetchImpl,
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
