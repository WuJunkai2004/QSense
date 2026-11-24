// NetKit——协议无关的传输机械层（B⁺ T3，2026-11-24）。接口红线：只含机械，
// 任何平台名/平台语义的参数进不来（评审卡死）；策略由插件定（backoff 封顶、
// fatal 判定、游标推进），机械归 NetKit（超时/中止/重试/节流/物化/嗅探/休眠）。
//
// 打包形态（T3-D2 定案 A）：本文件随宿主 bundle + 连接器 dist bundle——
// NetError 跨包副本 instanceof 不成立（踩坑 20 同源教训），统一用 isNetError
// 鸭子判定。连接器对 SDK 的值导入自此允许（类型照旧 type-only 照旧）。
//
// 驱动族（T3-D1 定案）：按需建员，不预建目录。longPoll 是唯一有真实用户的
// 成员（tg/wx）；net.ws（QQ 走官方 SDK 权威）与 webhook 接收器留槽不建。
// 驱动自有不变量（平台不可覆盖）：批次全部摄取完成才推进游标（至少一次，
// core 去重兜底）、失败指数退避、定时器一律 unref、abort 即时生效。

import type { ZodType } from "zod";
import type { MediaSourceWire } from "./types";

// ---------------------------------------------------------------------------
// 统一错误分档：timeout / aborted / network / http(status)。平台业务码由插件映射。
// ---------------------------------------------------------------------------

export type NetErrorKind = "timeout" | "aborted" | "network" | "http";

export class NetError extends Error {
  readonly kind: NetErrorKind;
  readonly status?: number;

  constructor(kind: NetErrorKind, message: string, status?: number) {
    super(message);
    this.name = "NetError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** 鸭子判定（跨打包副本 instanceof 不成立——SDK 会被打包多份） */
export function isNetError(e: unknown): e is NetError {
  if (!(e instanceof Error)) return false;
  const k = (e as { kind?: unknown }).kind;
  return k === "timeout" || k === "aborted" || k === "network" || k === "http";
}

// ---------------------------------------------------------------------------
// 时钟与休眠（可中断；定时器一律 unref——不独自撑住事件循环）
// ---------------------------------------------------------------------------

export function nowMs(): number {
  return Date.now();
}

/** 可中断 sleep：外部中止即时 reject（NetError aborted / 外部 reason）。
 * 注意：不 unref——这是轮询主循环的心跳（事件循环空时它必须撑住进程；
 * 「纯超时守卫」才 unref，见 httpClient 的请求超时定时器）。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    function cleanup(): void {
      signal?.removeEventListener("abort", onAbort);
    }
  });
}

/** abort 的拒绝原因：外部 reason 若已是 NetError 原样透传，否则归 aborted 档 */
function abortReason(signal: AbortSignal): NetError {
  const reason = (signal as { reason?: unknown }).reason;
  if (isNetError(reason)) return reason;
  return new NetError("aborted", "aborted");
}

// ---------------------------------------------------------------------------
// 同 key 最小间隔节流（tg pace / wx 软频控公共骨架）
// ---------------------------------------------------------------------------

export function throttle(
  minIntervalMs: number,
): (key: string) => Promise<void> {
  const last = new Map<string, number>();
  return async (key) => {
    const prev = last.get(key);
    if (prev !== undefined) {
      const wait = prev + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    last.set(key, Date.now());
  };
}

// ---------------------------------------------------------------------------
// 退避控制器：策略（首退避/指数/封顶）插件定参数，机械（计数/增长/重置）共享
// ---------------------------------------------------------------------------

export interface BackoffPolicy {
  /** 首次失败等待（缺省 1000ms） */
  retryMs?: number;
  /** 指数基数（缺省 2） */
  backoffMs?: number;
  /** 单次等待封顶（缺省 30000ms） */
  maxDelayMs?: number;
}

export interface BackoffController {
  /** 记一次失败 → 本次应等待 ms（retryMs × backoffMs^n 封顶） */
  fail(): number;
  /** 成功重置 */
  reset(): void;
  /** 当前连败计数（wx「连败 N 次清游标」类平台策略的判据） */
  readonly failures: number;
}

export function backoff(policy: BackoffPolicy = {}): BackoffController {
  const retryMs = policy.retryMs ?? 1000;
  const backoffMs = policy.backoffMs ?? 2;
  const maxDelayMs = policy.maxDelayMs ?? 30000;
  let n = 0;
  return {
    fail(): number {
      const delay = Math.min(retryMs * Math.pow(backoffMs, n), maxDelayMs);
      n++;
      return delay;
    },
    reset(): void {
      n = 0;
    },
    get failures(): number {
      return n;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP 客户端：统一超时 + 外部中止合并 + unref 定时器 + 重试 + NetError 分档
// + schema 参数化 JSON 请求（响应即插件声明类型——网络层出来的数据不再盲转）
// ---------------------------------------------------------------------------

export interface HttpClientDefaults {
  /** 单请求超时（缺省 30000ms） */
  timeoutMs?: number;
  /** 网络档（timeout/network）重试次数（缺省 0——HTTP 档不自动重试，插件自行判断） */
  retries?: number;
  /** 重试间隔基数（缺省 500ms，线性） */
  retryMs?: number;
  /** 外部中止信号（合并进每次请求） */
  signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  /** 响应头（键已小写化） */
  header(name: string): string | undefined;
  /** 响应体文本 */
  text(): Promise<string>;
  /** 响应体 JSON（未经 schema——建议用 json() 带 schema 的版本） */
  json(): Promise<unknown>;
  /** 原始 Response（multipart / CDN 流式等逃生门） */
  readonly raw: Response;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** 覆盖 client 缺省超时 */
  timeoutMs?: number;
  /** 覆盖外部中止信号 */
  signal?: AbortSignal;
}

export interface HttpClient {
  request(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
  /**
   * schema 参数化 JSON 请求：响应体经 schema safeParse，返回插件声明类型。
   * HTTP 非 2xx → NetError http 档（携带 status）；schema 违规 → 同样 http 档，
   * message 含字段路径（可定位、不含数据值）。
   */
  json<T>(url: string, schema: ZodType<T>, init?: HttpRequestInit): Promise<T>;
}

export function httpClient(defaults: HttpClientDefaults = {}): HttpClient {
  const baseTimeout = defaults.timeoutMs ?? 30000;
  const retries = defaults.retries ?? 0;
  const retryMs = defaults.retryMs ?? 500;
  return {
    async request(url, init = {}) {
      const total = Math.max(0, retries) + 1;
      let lastErr: NetError | undefined;
      for (let attempt = 0; attempt < total; attempt++) {
        if (attempt > 0) await sleep(retryMs * attempt, init.signal ?? defaults.signal);
        try {
          return await requestOnce(url, init, baseTimeout, init.signal ?? defaults.signal);
        } catch (e) {
          const err = toNetError(e);
          // 仅机械档重试（timeout/network）；aborted 是外部意图、http 是服务端应答
          if (err.kind !== "timeout" && err.kind !== "network") throw err;
          lastErr = err;
        }
      }
      throw lastErr!;
    },
    async json(url, schema, init) {
      return jsonVia(this.request, url, schema, init);
    },
  };
}

/**
 * schema 参数化 JSON 请求的公共实现（真 client 与 FakeNetKit 共用）：
 * 非 2xx → NetError http 档；非 JSON → http 档；schema 违规 → http 档 + 字段路径。
 */
export async function jsonVia<T>(
  requester: (url: string, init?: HttpRequestInit) => Promise<HttpResponse>,
  url: string,
  schema: ZodType<T>,
  init?: HttpRequestInit,
): Promise<T> {
  const res = await requester(url, init);
  if (res.status < 200 || res.status >= 300) {
    throw new NetError("http", `HTTP ${res.status} from ${url}`, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new NetError("http", `响应体非 JSON（HTTP ${res.status}）`, res.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .slice(0, 5)
      .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
      .join("; ");
    throw new NetError("http", `响应不符合 wire schema：${paths}`, res.status);
  }
  return parsed.data;
}

async function requestOnce(
  url: string,
  init: HttpRequestInit,
  baseTimeout: number,
  external?: AbortSignal,
): Promise<HttpResponse> {
  const timeoutMs = init.timeoutMs ?? baseTimeout;
  const merged = new AbortController();
  const onExternal = () => merged.abort(external?.reason);
  if (external !== undefined) {
    if (external.aborted) onExternal();
    else external.addEventListener("abort", onExternal, { once: true });
  }
  const timer = setTimeout(
    () => merged.abort(new NetError("timeout", `timeout after ${timeoutMs}ms: ${url}`)),
    timeoutMs,
  );
  timer.unref?.();
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      signal: merged.signal,
    });
  } catch (e) {
    throw toNetError(e);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternal);
  }
  const headers = new Map<string, string>();
  res.headers.forEach((v, k) => headers.set(k.toLowerCase(), v));
  return {
    status: res.status,
    header: (name) => headers.get(name.toLowerCase()),
    text: () => res.text(),
    json: () => res.json(),
    raw: res,
  };
}

/** fetch 层错误 → NetError 分档（abort reason 透传：超时挂 timeout 档 NetError） */
function toNetError(e: unknown): NetError {
  if (isNetError(e)) return e;
  if (e instanceof Error && e.name === "AbortError") {
    const reason = (e as { cause?: unknown }).cause;
    if (isNetError(reason)) return reason;
    return new NetError("aborted", "aborted");
  }
  return new NetError(
    "network",
    `network error: ${e instanceof Error ? e.message : String(e)}`,
  );
}

// ---------------------------------------------------------------------------
// 媒体来源物化与魔数嗅探（三平台/核心 assets 三份嗅探合流；机械编码非语义）
// ---------------------------------------------------------------------------

export interface Materialized {
  buf: Buffer;
  /** 文件名（url 路径尾段 / file basename；b64 源无） */
  name?: string;
}

/** 媒体来源物化：url 下载 / b64 解码 / file 读盘 → 字节（零平台语义） */
export async function materialize(
  src: MediaSourceWire,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Materialized> {
  if (src.kind === "url") {
    const client = httpClient({ timeoutMs: opts.timeoutMs ?? 30000 });
    const res = await client.request(src.url, { signal: opts.signal });
    if (res.status < 200 || res.status >= 300) {
      throw new NetError("http", `HTTP ${res.status} downloading ${src.url}`, res.status);
    }
    const buf = Buffer.from(await res.raw.arrayBuffer());
    return { buf, name: urlBasename(src.url) };
  }
  if (src.kind === "b64") {
    return { buf: Buffer.from(src.data, "base64") };
  }
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(src.path);
  return { buf, name: pathBasename(src.path) };
}

function urlBasename(url: string): string | undefined {
  const m = /\/([^/?#]+)(?:$|[?#])/i.exec(url);
  const seg = m?.[1];
  return seg !== undefined && seg !== "" && seg.includes(".") ? seg : undefined;
}

function pathBasename(path: string): string {
  const seg = path.split(/[\\/]/).pop();
  return seg !== undefined && seg !== "" ? seg : "file";
}

/** 魔数嗅探 → mime（png/jpeg/gif/webp/bmp/mp3/wav/silk/ogg/mp4）；无匹配回 fallback */
export function sniffMime(buf: Buffer, fallback = "application/octet-stream"): string {
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 3 && buf.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (
    buf.length >= 3 &&
    (buf.subarray(0, 3).toString("latin1") === "ID3" ||
      (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0))
  ) {
    return "audio/mpeg";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WAVE"
  ) {
    return "audio/wav";
  }
  for (const off of [0, 1]) {
    if (
      buf.length >= off + 6 &&
      buf.subarray(off, off + 6).toString("latin1") === "#!SILK"
    ) {
      return "audio/silk";
    }
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "OggS") return "audio/ogg";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  return fallback;
}

// ---------------------------------------------------------------------------
// 长轮询驱动（驱动族首成员；协议差异全部收在 spec 的深度 hook 面）
// ---------------------------------------------------------------------------

export type LongPollState = "starting" | "ready" | "degraded";

export interface LongPollPolicy {
  /** 失败首退避（缺省 1000ms） */
  retryMs?: number;
  /** 指数基数（缺省 2） */
  backoffMs?: number;
  /** 退避封顶（缺省 30000ms） */
  maxDelayMs?: number;
  /** 连败阈值：达到且有 resetCursor hook 时清游标重拉（wx 语义；缺省 2） */
  maxFailures?: number;
  /** 空批空转下限 ms（防忙转，缺省 250） */
  minPollMs?: number;
  /** 空批空转上限 ms（缺省 60000） */
  maxPollMs?: number;
}

export interface LongPollBatch<C> {
  items: unknown[];
  /** 下一游标；undefined=游标不变。驱动在批次全部摄取完成后才持久化（至少一次） */
  next?: C;
  /** 服务端建议挂起时长 ms（如 wx longpolling_timeout_ms）——驱动据此校准空转等待 */
  timeoutHintMs?: number;
}

export interface LongPollSpec<C> {
  /** 游标生命周期（深度 hook）：读/存/清（清=wx 连败语义，tg 不实现） */
  loadCursor(): Promise<C | null>;
  saveCursor(c: C): Promise<void>;
  resetCursor?(): Promise<void>;
  /** 批次获取：平台协议差异全部收在这一个函数（含挂起时长、在带业务码判定）；null=无游标首拉 */
  fetch(cursor: C | null, signal: AbortSignal): Promise<LongPollBatch<C>>;
  /** 逐条摄取（内部调 host.ingest；抛错=批失败，游标不推进——至少一次） */
  onItem(item: unknown): Promise<void> | void;  /** 平台 fatal 判定（tg 401/409；wx -14/401/403）——命中则驱动上抛，调用方决定停/重启 */
  isFatal(e: unknown): boolean;
  /** 状态迁移上报（平台映射 host.reportStatus） */
  onState?(s: LongPollState): void;
  policy?: LongPollPolicy;
}

/**
 * 长轮询驱动。正常路径永不返回（直到 abort）；fatal 时原样上抛。
 * 驱动自有不变量：批全摄完才存游标 / 失败指数退避 / 定时器 unref / abort 即时生效。
 */
export async function longPoll<C>(
  spec: LongPollSpec<C>,
  signal: AbortSignal,
): Promise<void> {
  const policy = spec.policy ?? {};
  const retryMs = policy.retryMs ?? 1000;
  const backoffMs = policy.backoffMs ?? 2;
  const maxDelayMs = policy.maxDelayMs ?? 30000;
  const maxFailures = policy.maxFailures ?? 2;
  const minPollMs = policy.minPollMs ?? 250;
  const maxPollMs = policy.maxPollMs ?? 60000;

  let cursor: C | null = await spec.loadCursor();
  let failures = 0;
  let ready = false;
  spec.onState?.("starting");
  while (!signal.aborted) {
    try {
      const batch = await spec.fetch(cursor, signal);
      // 批次全部摄取完成才推进游标（onItem 抛错 → catch 分支，游标不动）
      for (const item of batch.items) {
        await spec.onItem(item);
      }
      if (batch.next !== undefined && batch.next !== cursor) {
        await spec.saveCursor(batch.next);
        cursor = batch.next;
      }
      if (failures > 0) failures = 0;
      if (!ready) {
        ready = true;
        spec.onState?.("ready");
      }
      // 空批空转：timeoutHintMs（服务端建议）经 clamp；有批立即下一轮（抓紧清积压）
      if (batch.items.length === 0) {
        const wait = Math.min(
          Math.max(batch.timeoutHintMs ?? minPollMs, minPollMs),
          maxPollMs,
        );
        await sleep(wait, signal);
      }
    } catch (e) {
      if (signal.aborted) return; // abort 即时生效，不算错误
      if (spec.isFatal(e)) {
        spec.onState?.("degraded");
        throw e;
      }
      failures++;
      // wx 语义（连败 ≥ 阈值且带旧游标 → 游标可能已失效）：清游标重拉；
      // 至少一次语义由 core 按 msg_id 去重兜底。清游标分支同样退避（防忙转）
      if (spec.resetCursor !== undefined && failures >= maxFailures) {
        await spec.resetCursor();
        cursor = await spec.loadCursor();
        spec.onState?.("degraded");
      }
      await sleep(
        Math.min(retryMs * Math.pow(backoffMs, failures - 1), maxDelayMs),
        signal,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// NetKit 聚合与宿主实现
// ---------------------------------------------------------------------------

export interface NetKit {
  /** HTTP 客户端（按调用域配缺省超时/重试） */
  http(defaults?: HttpClientDefaults): HttpClient;
  /** 同 key 最小间隔节流 */
  throttle(minIntervalMs: number): (key: string) => Promise<void>;
  /** 媒体来源物化（url/b64/file → 字节 + 文件名） */
  materialize(
    src: MediaSourceWire,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Materialized>;
  /** 魔数嗅探 */
  sniffMime(buf: Buffer, fallback?: string): string;
  /** 退避控制器 */
  backoff(policy?: BackoffPolicy): BackoffController;
  /** 可中断休眠（定时器 unref） */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** 统一时钟（测试注入点） */
  now(): number;
  /** 长轮询驱动（驱动族首成员） */
  longPoll<C>(spec: LongPollSpec<C>, signal: AbortSignal): Promise<void>;
}

/** 宿主真实 NetKit（生产注入）；测试用 FakeNetKit（net-fake.ts） */
export function createNetKit(): NetKit {
  return {
    http: (defaults) => httpClient(defaults),
    throttle: (minIntervalMs) => throttle(minIntervalMs),
    materialize,
    sniffMime,
    backoff,
    sleep,
    now: nowMs,
    longPoll,
  };
}
