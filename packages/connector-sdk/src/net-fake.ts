// FakeNetKit——测试驱动权的落点（B⁺ T3）：脚本化假端点 + 请求记录断言 + 手动时钟。
// 连接器包内不再自持 overrides.fetch / 假端点管道——全部经 PluginContext.net 注入
// 本假件驱动（连接器测试「先 build 再跑」纪律不变，踩坑 23）。
//
// 设计口径：
// - http：路由（URL 前缀或谓词）→ 应答（全局 Response，与真 fetch 返回类型统一；
//   JSON 体由测试侧 JSON.stringify 显式序列化，Error 直接抛）；全部请求记录进
//   requests 供断言（url/method/headers/body/fake 时钟）
// - 时钟：手动游标（tick 推进）；sleep 立即返回并推进时钟（退避循环测试不真睡）
// - throttle：立即通过（节流时序的验证归真 NetKit 单测，不在假件语义内）
// - backoff / sniffMime / longPoll：真实现（纯机械或由测试供给 spec 驱动）
// - materialize：url 源走脚本表（file()/fileError() 注册）；b64/file 源走真实现
//
// B⁺ T6：脚本应答不再用自定义 FakeReply 形状——直接产全局 Response（具体类型），
// 「这是 JSON 文本」在测试侧显式（JSON.stringify），假件零自定义弱类型。

import {
  type BackoffController,
  type HttpClient,
  type HttpClientDefaults,
  type HttpRequestInit,
  type HttpResponse,
  type LongPollSpec,
  type Materialized,
  type NetKit,
  backoff as realBackoff,
  jsonVia,
  longPoll as realLongPoll,
  parseJsonBody,
  sniffMime as realSniffMime,
} from "./net";
import type { ZodType } from "zod";
import type { MediaSourceWire } from "./types";

/** 一次假 HTTP 请求的记录（headers 键已小写化） */
export interface FakeRequestLog {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | FormData;
  /** fake 时钟（请求发生时刻） */
  at: number;
}

/**
 * 测试侧 JSON 应答便捷构造：status 缺省 200；body 经 JSON.stringify 显式序列化
 * （「这是 JSON」在调用点可见，B 由调用点的具体 wire 类型推断）；headers 透传。
 */
export function jsonResponse<B>(
  body: B,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    ...(init?.headers !== undefined ? { headers: init.headers } : {}),
  });
}

type FakeHandler = (
  req: FakeRequestLog,
) => Response | Error | Promise<Response | Error>;

interface FakeRoute {
  match: (url: string) => boolean;
  handle: FakeHandler;
}

export class FakeNetKit implements NetKit {
  readonly requests: FakeRequestLog[] = [];
  private t = 0;
  private readonly routes: FakeRoute[] = [];
  private readonly files = new Map<string, Buffer | Error>();

  // —— 时钟控制 ——
  now(): number {
    return this.t;
  }

  /** 手动推进时钟 */
  tick(ms: number): void {
    this.t += ms;
  }

  // —— 路由注册 ——
  /** 按 URL 前缀注册应答（handler 可返回 Response / Error / Promise） */
  on(prefix: string, handle: FakeHandler): this {
    this.routes.push({ match: (u) => u.startsWith(prefix), handle });
    return this;
  }

  /** 按谓词注册应答 */
  onMatch(match: (url: string) => boolean, handle: FakeHandler): this {
    this.routes.push({ match, handle });
    return this;
  }

  /** 队列式应答：每次命中弹一项（Error 即抛），耗尽后抛 network 档错 */
  queue(prefix: string, replies: Array<Response | Error>): this {
    const q = [...replies];
    this.on(prefix, () => {
      const next = q.shift();
      if (next === undefined) {
        return new Error(`FakeNetKit: queue exhausted for ${prefix}`);
      }
      return next;
    });
    return this;
  }

  /** materialize 脚本：url → 字节 */
  file(url: string, buf: Buffer): this {
    this.files.set(url, buf);
    return this;
  }

  /** materialize 脚本：url → 错误（模拟下载失败） */
  fileError(url: string, err: Error): this {
    this.files.set(url, err);
    return this;
  }

  /** 断言辅助：某前缀的请求次数 */
  count(prefix: string): number {
    return this.requests.filter((r) => r.url.startsWith(prefix)).length;
  }

  // —— NetKit 成员 ——
  http(_defaults?: HttpClientDefaults): HttpClient {
    const client: HttpClient = {
      request: async (url, init) => this.doRequest(url, init),
      json: async (url, schema, init) =>
        jsonVia(client.request, url, schema, init),
    };
    return client;
  }

  private async doRequest(
    url: string,
    init?: HttpRequestInit,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const log: FakeRequestLog = {
      url,
      method: init?.method ?? "GET",
      headers,
      ...(init?.body !== undefined ? { body: init.body } : {}),
      at: this.t,
    };
    this.requests.push(log);
    const route = this.routes.find((r) => r.match(url));
    if (route === undefined) {
      throw new Error(`FakeNetKit: no route for ${url}`);
    }
    const res = await route.handle(log);
    if (res instanceof Error) throw res;
    const map = new Map<string, string>();
    res.headers.forEach((v, k) => map.set(k.toLowerCase(), v));
    return {
      status: res.status,
      header: (name) => map.get(name.toLowerCase()),
      text: () => res.text(),
      // 与真 client 同路（net.ts parseJsonBody）：schema 解析收口
      json: <T>(schema: ZodType<T>) => parseJsonBody(res, schema, res.status),
      raw: res,
    };
  }

  throttle(_minIntervalMs: number): (key: string) => Promise<void> {
    return async () => undefined; // fake：立即通过
  }

  async materialize(
    src: MediaSourceWire,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Materialized> {
    void opts;
    if (src.kind === "url") {
      const scripted = this.files.get(src.url);
      if (scripted instanceof Error) throw scripted;
      if (scripted === undefined) {
        throw new Error(`FakeNetKit: no materialize script for ${src.url}`);
      }
      return { buf: scripted, name: src.url.split("/").pop() };
    }
    if (src.kind === "b64") {
      return { buf: Buffer.from(src.data, "base64") };
    }
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(src.path);
    return { buf, name: src.path.split(/[\\/]/).pop() };
  }

  sniffMime(buf: Buffer, fallback?: string): string {
    return realSniffMime(buf, fallback);
  }

  backoff(policy?: Parameters<NetKit["backoff"]>[0]): BackoffController {
    return realBackoff(policy);
  }

  /** fake：立即返回并推进时钟（退避循环测试不真睡） */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    void signal;
    this.t += ms;
    return Promise.resolve();
  }

  longPoll<C, I>(spec: LongPollSpec<C, I>, signal: AbortSignal): Promise<void> {
    return realLongPoll(spec, signal);
  }
}
