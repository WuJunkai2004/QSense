// 微信 iLink bot API 客户端（每 bot 一个）：JSON over HTTPS + Bearer ilink_bot_token。
// 零运行时依赖（Node 20 全局 fetch）；测试经 overrides.fetch / baseUrl 注入假端点。
// 分仓纪律：connector 只做网络（字节进出与机械编解码），消息解读权在本包 parser。
//
// 线格式事实（参照实现 2.4.10 src/api/api.ts，2026-11-24 解包核对）：
// - 每个请求带 iLink-App-Id / iLink-App-ClientVersion（0x00MMNNPP）；
//   POST 另带 AuthorizationType: ilink_bot_token + X-WECHAT-UIN（随机 uint32 的十进制再 base64）
//   + Authorization: Bearer <bot_token> + 请求体 base_info{channel_version, bot_agent}
// - uint64 id（message_id / msg_id / svr_id）在线上是 JSON 数字：须先加引号再 JSON.parse
//   才无损（parseWeixinJson 只改写对象属性位置的数字，不碰字符串内部）
// - 业务错误走应答体 ret / errcode（HTTP 可能仍 200）；-14 = bot token 失效

import { randomBytes } from "node:crypto";
import {
  CONNECTOR_VERSION,
  ILINK_APP_ID,
  ILINK_BASE_URL,
  ILINK_CHANNEL_VERSION,
  type BaseInfo,
  type BotQrcodeResp,
  type GetUploadUrlReq,
  type GetUploadUrlResp,
  type GetUpdatesResp,
  type QrcodeStatusResp,
  type SendMessageResp,
  type WeixinMessage,
} from "./types";

/** 错误分档：调用侧据此决定重试/致命/可操作文案 */
export type WeixinApiKind =
  /** HTTP 非 2xx（status 字段可取） */
  | "http"
  /** 应答体 ret / errcode 非零（code 字段可取） */
  | "biz"
  /** DNS / TCP / TLS 等网络层失败 */
  | "network"
  /** 客户端超时中止（长轮询无消息时的正常出口） */
  | "timeout"
  /** 外部 signal 中止（停服/热重载） */
  | "aborted";

export class WeixinApiError extends Error {
  readonly kind: WeixinApiKind;
  /** HTTP 状态码（kind=http） */
  readonly status: number | undefined;
  /** 平台错误码 ret / errcode（kind=biz） */
  readonly code: number | undefined;

  constructor(
    message: string,
    kind: WeixinApiKind,
    extra: { status?: number; code?: number } = {},
  ) {
    super(message);
    this.name = "WeixinApiError";
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
  }
}

/** 长轮询缺省挂起上限（客户端侧）；服务端经 longpolling_timeout_ms 建议下一次的值 */
export const LONG_POLL_TIMEOUT_MS = 35_000;
/** 普通请求（sendMessage / getuploadurl）缺省超时 */
export const API_TIMEOUT_MS = 15_000;
/** 轻量请求（notifystart / notifystop / 扫码）缺省超时 */
export const LIGHT_TIMEOUT_MS = 10_000;

/** 自报身份（UA 风格 Name/Version；仅观测，不参与鉴权/路由） */
const BOT_AGENT = `QSense-weixin/${CONNECTOR_VERSION}`;

/**
 * iLink-App-ClientVersion：uint32 编码为 0x00MMNNPP（高 8 位恒 0）。
 * 如 "2.4.10" → 0x0002040A = 132106。
 */
export function clientVersionOf(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const CLIENT_VERSION = clientVersionOf(ILINK_CHANNEL_VERSION);

/** 每个请求体都携带的公共元数据 */
export function baseInfo(): BaseInfo {
  return { channel_version: ILINK_CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

/** X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64（参照实现同款；非身份凭据） */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString(
    "base64",
  );
}

const LOSSLESS_ID_KEYS = new Set(["message_id", "msg_id", "svr_id"]);

/**
 * 无损解析：把 LOSSLESS_ID_KEYS 键位置的 JSON 数字先改写成字符串再 JSON.parse。
 * 扫描器只在「字符串键 + 冒号」之后改写裸数字，绝不触碰字符串内部的内容。
 */
export function parseWeixinJson(raw: string): unknown {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i++];
      continue;
    }
    const start = i;
    i += 1;
    let escaped = false;
    while (i < raw.length) {
      const ch = raw[i++];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') break;
    }
    const token = raw.slice(start, i);
    out += token;

    let cursor = i;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] !== ":") continue;

    let key: unknown;
    try {
      key = JSON.parse(token) as unknown;
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_KEYS.has(key)) continue;

    out += raw.slice(i, cursor + 1);
    cursor += 1;
    while (/\s/.test(raw[cursor] ?? "")) out += raw[cursor++];
    const numStart = cursor;
    if (raw[cursor] === "-") cursor += 1;
    while (/\d/.test(raw[cursor] ?? "")) cursor += 1;
    const hasDigits =
      cursor > numStart &&
      !(cursor === numStart + 1 && raw[numStart] === "-");
    if (hasDigits) {
      out += `"${raw.slice(numStart, cursor)}"`;
      i = cursor;
    } else {
      i = numStart;
    }
  }
  return JSON.parse(out) as unknown;
}

/** 应答体业务码：errcode 优先（如 -14），其次 ret；全为 0/缺省返回 undefined */
export function bizCodeOf(resp: { ret?: number; errcode?: number }): number | undefined {
  if (typeof resp.errcode === "number" && resp.errcode !== 0) return resp.errcode;
  if (typeof resp.ret === "number" && resp.ret !== 0) return resp.ret;
  return undefined;
}

function bizError(label: string, resp: { ret?: number; errcode?: number; errmsg?: string }): WeixinApiError {
  return new WeixinApiError(
    `${label} ret=${resp.ret ?? "-"} errcode=${resp.errcode ?? "-"} errmsg=${resp.errmsg ?? "(none)"}`,
    "biz",
    { code: bizCodeOf(resp) },
  );
}

export interface WeixinApiOverrides {
  /** 缺省 globalThis.fetch；测试注入假实现 */
  fetch?: typeof globalThis.fetch;
  /** 缺省 https://ilinkai.weixin.qq.com；账号实际入口（confirmed 的 baseurl）由此覆盖 */
  baseUrl?: string;
}

export interface RequestOptions {
  /** 外部中止（停服即时打断在途请求） */
  signal?: AbortSignal;
  /** 缺省按方法分级（长轮询 35s / 普通 15s / 轻量 10s） */
  timeoutMs?: number;
}

export interface WeixinApi {
  /** 本客户端的 API 入口（已规范化，无尾斜杠） */
  readonly baseUrl: string;
  /** 长轮询取消息。应答体业务错误不抛（返回原样交轮询循环判定，-14=token 失效） */
  getUpdates(getUpdatesBuf: string, opts?: RequestOptions): Promise<GetUpdatesResp>;
  /** 发送一条消息（应答体 ret/errcode 非零即抛 biz 错） */
  sendMessage(msg: WeixinMessage, opts?: RequestOptions): Promise<SendMessageResp>;
  /** 取 CDN 上传地址（预签名） */
  getUploadUrl(req: GetUploadUrlReq, opts?: RequestOptions): Promise<GetUploadUrlResp>;
  /** 通知服务端本客户端启动（在线状态对账；best-effort 语义由调用侧把握） */
  notifyStart(opts?: RequestOptions): Promise<void>;
  /** 通知服务端本客户端停止 */
  notifyStop(opts?: RequestOptions): Promise<void>;
  /** 取扫码登录二维码（无需 token） */
  getBotQrcode(localTokenList: string[]): Promise<BotQrcodeResp>;
  /** 查询扫码状态（服务端长轮询挂起到状态变化或超时；无需 token） */
  getQrcodeStatus(
    qrcode: string,
    opts?: RequestOptions & { baseUrl?: string; verifyCode?: string },
  ): Promise<QrcodeStatusResp>;
}

function ensureNoTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createWeixinApi(
  token: string,
  overrides: WeixinApiOverrides = {},
): WeixinApi {
  const doFetch = overrides.fetch ?? globalThis.fetch;
  const baseUrl = ensureNoTrailingSlash(
    overrides.baseUrl?.trim() || ILINK_BASE_URL,
  );
  const bearer = token.trim();

  async function request(
    path: string,
    init: {
      method: "GET" | "POST";
      body?: string;
      /** 本次请求的入口（覆盖 baseUrl：扫码流程的 IDC 重定向） */
      base?: string;
      defaultTimeout: number;
    },
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const base = ensureNoTrailingSlash(init.base ?? baseUrl);
    const url = new URL(path, `${base}/`);
    const timeoutMs = opts.timeoutMs ?? init.defaultTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 超时定时器不独自撑住事件循环：进程停服时在途请求（如扫码状态机的后台长轮询）
    // 不应把退出拖到定时器到点——运行期进程由宿主 HTTP 服务与连接句柄持有
    timer.unref?.();
    const onExternalAbort = (): void => controller.abort();
    const external = opts.signal;
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    const headers: Record<string, string> = {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(CLIENT_VERSION),
    };
    if (init.method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["AuthorizationType"] = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = randomWechatUin();
      if (bearer !== "") headers["Authorization"] = `Bearer ${bearer}`;
    }

    try {
      let res: Response;
      let text: string;
      try {
        res = await doFetch(url.toString(), {
          method: init.method,
          headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          signal: controller.signal,
        });
        text = await res.text();
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          throw new WeixinApiError(
            external?.aborted === true ? "请求已取消" : `请求超时（${timeoutMs}ms）`,
            external?.aborted === true ? "aborted" : "timeout",
          );
        }
        throw new WeixinApiError(
          `网络请求失败：${e instanceof Error ? e.message : String(e)}`,
          "network",
        );
      }
      if (!res.ok) {
        throw new WeixinApiError(
          `HTTP ${res.status}${text !== "" ? `：${text.slice(0, 200)}` : ""}`,
          "http",
          { status: res.status },
        );
      }
      if (text === "") return {};
      return parseWeixinJson(text);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }

  return {
    baseUrl,
    async getUpdates(getUpdatesBuf, opts = {}) {
      const resp = (await request(
        "ilink/bot/getupdates",
        {
          method: "POST",
          body: JSON.stringify({
            get_updates_buf: getUpdatesBuf ?? "",
            base_info: baseInfo(),
          }),
          defaultTimeout: LONG_POLL_TIMEOUT_MS,
        },
        opts,
      )) as GetUpdatesResp;
      return resp ?? {};
    },

    async sendMessage(msg, opts = {}) {
      const resp = (await request(
        "ilink/bot/sendmessage",
        {
          method: "POST",
          body: JSON.stringify({ msg, base_info: baseInfo() }),
          defaultTimeout: API_TIMEOUT_MS,
        },
        opts,
      )) as SendMessageResp;
      const code = bizCodeOf(resp ?? {});
      if (code !== undefined) throw bizError("sendMessage", resp);
      return resp ?? {};
    },

    async getUploadUrl(req, opts = {}) {
      const resp = (await request(
        "ilink/bot/getuploadurl",
        {
          method: "POST",
          body: JSON.stringify({ ...req, base_info: baseInfo() }),
          defaultTimeout: API_TIMEOUT_MS,
        },
        opts,
      )) as GetUploadUrlResp & { ret?: number; errcode?: number; errmsg?: string };
      const code = bizCodeOf(resp ?? {});
      if (code !== undefined) throw bizError("getUploadUrl", resp);
      return resp ?? {};
    },

    async notifyStart(opts = {}) {
      const resp = (await request(
        "ilink/bot/msg/notifystart",
        { method: "POST", body: JSON.stringify({ base_info: baseInfo() }), defaultTimeout: LIGHT_TIMEOUT_MS },
        opts,
      )) as { ret?: number; errcode?: number; errmsg?: string };
      const code = bizCodeOf(resp ?? {});
      if (code !== undefined) throw bizError("notifyStart", resp);
    },

    async notifyStop(opts = {}) {
      const resp = (await request(
        "ilink/bot/msg/notifystop",
        { method: "POST", body: JSON.stringify({ base_info: baseInfo() }), defaultTimeout: LIGHT_TIMEOUT_MS },
        opts,
      )) as { ret?: number; errcode?: number; errmsg?: string };
      const code = bizCodeOf(resp ?? {});
      if (code !== undefined) throw bizError("notifyStop", resp);
    },

    async getBotQrcode(localTokenList) {
      const resp = (await request(
        `ilink/bot/get_bot_qrcode?bot_type=3`,
        {
          method: "POST",
          body: JSON.stringify({ local_token_list: localTokenList }),
          defaultTimeout: LIGHT_TIMEOUT_MS,
        },
      )) as BotQrcodeResp;
      return resp ?? ({} as BotQrcodeResp);
    },

    async getQrcodeStatus(qrcode, opts = {}) {
      const verify = opts.verifyCode?.trim();
      const query = `qrcode=${encodeURIComponent(qrcode)}${
        verify ? `&verify_code=${encodeURIComponent(verify)}` : ""
      }`;
      const resp = (await request(
        `ilink/bot/get_qrcode_status?${query}`,
        {
          method: "GET",
          base: opts.baseUrl,
          defaultTimeout: LONG_POLL_TIMEOUT_MS,
        },
        opts,
      )) as QrcodeStatusResp;
      return resp ?? ({} as QrcodeStatusResp);
    },
  };
}
