// 微信扫码登录（配对握手）。协议事实（参照实现 2.4.10 auth/login-qr.ts，2026-11-24 解包核对）：
//   1) POST ilink/bot/get_bot_qrcode?bot_type=3  body {local_token_list}  → {qrcode, qrcode_img_content}
//      —— qrcode_img_content 是二维码内容（前端本地渲染）；qrcode 是轮询令牌（只留服务端内存）
//      —— local_token_list = 本端已注册 bot 的 token（至多 10 个）：服务端据此识别「已绑定到
//         本端」的 bot 并回 binded_redirect，避免重复发会话
//   2) GET ilink/bot/get_qrcode_status?qrcode=…  服务端长轮询挂起到状态变化，状态 7 态：
//      wait / scaned / confirmed / expired / scaned_but_redirect（IDC 就近：切换轮询入口）
//      / need_verifycode / verify_code_blocked / binded_redirect
//   3) confirmed 应答携带 bot_token（凭据）+ ilink_bot_id（机器人账号 id）+ baseurl（该账号
//      实际 API 入口）+ ilink_user_id（扫码人）
//
// 与参照实现的差异（形态使然，非协议差异）：WebUI 轮询是短请求，故本模块在服务端后台
// 跑长轮询状态机、poll 路由只回当前状态；二维码过期由用户重开任务（不自动换码——
// 前端渲染的二维码内容在任务期内不变）；配对码二次校验（need_verifycode）WebUI 流程
// 无输入通道，按可操作失败处理（见 README 待办）。
//
// 安全模型：bot_token 与 qrcode 令牌只在本进程内存；poll 路由只向浏览器回状态，
// 凭据经宿主中介（core 拦截 completed → verifyCredential → 注册）绝不下发浏览器。

import { randomUUID } from "node:crypto";
import type { ConnectorLogger, NetKit } from "@qsense/connector-sdk";
import { LONG_POLL_TIMEOUT_MS, WeixinApiError, type WeixinApi } from "./api";
import { WeixinError } from "./errors";
import { tt } from "./texts";
import { ILINK_BASE_URL, type QrcodeStatusResp } from "./types";

/** 扫码完成产出的凭据（credentialSchema 形状；落 bots.credentials_json） */
export interface QrCredential {
  /** 机器人账号 id 的安全形式（ilink_bot_id 的 @ 与 . → -；= bots 表主键） */
  appid: string;
  /** bot_token（密钥键） */
  token: string;
  /** 该账号实际 API 入口（confirmed 的 baseurl；缺省回退协议常量） */
  base_url?: string;
  /** 扫码人 ilink 用户 id（留档） */
  owner_id?: string;
}

export type QrLoginState =
  | { status: "pending"; scanned: boolean }
  | { status: "expired" }
  | { status: "completed"; credential: QrCredential }
  | { status: "failed"; reason: string; httpStatus: number };

/**
 * 账号 id 安全形式：`@` 与 `.` 换成 `-`（参照实现 normalizeAccountId 对 ilink id 的口径：
 * "hex@im.bot" → "hex-im-bot"，见其 deriveRawAccountId 的反向映射；路径/键安全）。
 */
export function normalizeBotId(raw: string): string {
  return raw.trim().replace(/[@.]+/g, "-");
}

/** https 入口校验：非 https / 非法 URL 返回 undefined（回退缺省入口，不信任任意 scheme） */
export function safeBaseUrl(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (s === undefined || s === "") return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** IDC 重定向主机名校验（只接受主机名[:端口]，拒绝带 scheme/路径/用户信息的值） */
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

export interface QrLoginManagerDeps {
  /** 无 token 客户端（扫码流程固定从缺省入口起步，按 IDC 重定向切换） */
  api: WeixinApi;
  log: ConnectorLogger;
  /** NetKit（时钟 now()/可中断休眠；测试注入 FakeNetKit 得到手动时钟） */
  net: NetKit;
  /** 任务存活上限（毫秒）：缺省 8 分钟（参照实现的登录等待上限 480s） */
  ttlMs?: number;
  pollTimeoutMs?: number;
  /** 可重试失败后的重试间隔（缺省 2s） */
  retryDelayMs?: number;
  /** 状态查询连续可重试失败的上限（缺省 8 次 → failed） */
  maxFailures?: number;
}

export interface QrLoginManager {
  /** 创建任务并启动后台状态机；返回任务 id 与二维码内容 */
  start(localTokenList: string[]): Promise<{ taskId: string; qrContent: string }>;
  /** 当前状态；任务不存在/已清理 → expired（前端据此重开任务） */
  poll(taskId: string): QrLoginState;
  /** 在途任务数（测试/诊断） */
  size(): number;
}

interface Task {
  id: string;
  qrcode: string;
  baseUrl: string;
  createdAt: number;
  state: QrLoginState;
  controller: AbortController;
}

function failed(reason: string, httpStatus: number): QrLoginState {
  return { status: "failed", reason, httpStatus };
}

/** confirmed 应答 → 凭据；缺机器人 id 或 token 视为不完整 */
export function credentialOfConfirmed(resp: QrcodeStatusResp): QrLoginState {
  const botIdRaw = resp.ilink_bot_id?.trim() ?? "";
  const token = resp.bot_token?.trim() ?? "";
  if (botIdRaw === "" || token === "") {
    return failed(tt("wx_qr_incomplete"), 502);
  }
  const credential: QrCredential = { appid: normalizeBotId(botIdRaw), token };
  const base = safeBaseUrl(resp.baseurl);
  if (base !== undefined) credential.base_url = base;
  const owner = resp.ilink_user_id?.trim();
  if (owner !== undefined && owner !== "") credential.owner_id = owner;
  return { status: "completed", credential };
}

export function createQrLoginManager(deps: QrLoginManagerDeps): QrLoginManager {
  const ttl = deps.ttlMs ?? 8 * 60_000;
  const pollTimeout = deps.pollTimeoutMs ?? LONG_POLL_TIMEOUT_MS;
  const retryDelay = deps.retryDelayMs ?? 2000;
  const maxFailures = deps.maxFailures ?? 8;
  const now = (): number => deps.net.now();
  const log = deps.log.child("qr");
  const tasks = new Map<string, Task>();

  function prune(): void {
    for (const [id, t] of tasks) {
      if (now() - t.createdAt > ttl) {
        t.controller.abort();
        tasks.delete(id);
      }
    }
  }

  async function run(task: Task): Promise<void> {
    let failures = 0;
    while (task.state.status === "pending") {
      if (now() - task.createdAt > ttl) {
        task.state = { status: "expired" };
        return;
      }
      try {
        const resp = await deps.api.getQrcodeStatus(task.qrcode, {
          baseUrl: task.baseUrl,
          signal: task.controller.signal,
          timeoutMs: pollTimeout,
        });
        failures = 0;
        const status = String(resp.status ?? "");
        switch (status) {
          case "wait":
            break;
          case "scaned":
            task.state = { status: "pending", scanned: true };
            break;
          case "scaned_but_redirect": {
            // IDC 就近：后续状态查询切到重定向主机（与参照实现一致）
            const host = resp.redirect_host?.trim();
            if (host !== undefined && host !== "" && HOST_RE.test(host)) {
              task.baseUrl = `https://${host}`;
              log.info("qr poll redirected", { host });
            }
            break;
          }
          case "expired":
            task.state = { status: "expired" };
            break;
          case "confirmed":
            task.state = credentialOfConfirmed(resp);
            break;
          case "binded_redirect":
            task.state = failed(tt("wx_qr_already_bound"), 409);
            break;
          case "verify_code_blocked":
            task.state = failed(tt("wx_qr_blocked"), 409);
            break;
          default:
            // need_verifycode（含 beta 的 confirmed_but_need_verifycode）：配对码二次校验
            if (status.includes("need_verifycode")) {
              task.state = failed(tt("wx_qr_need_verifycode"), 409);
              break;
            }
            // 未知状态（协议漂移容忍）：按等待继续，不失败
            log.warn("qr status unknown; treated as wait", { status });
            break;
        }
      } catch (e) {
        if (task.controller.signal.aborted) return;
        if (e instanceof WeixinApiError && e.kind === "timeout") {
          continue; // 长轮询挂起到点无状态变化：正常出口
        }
        failures += 1;
        const reason = e instanceof Error ? e.message : String(e);
        if (e instanceof WeixinApiError && (e.kind === "network" || e.kind === "http")) {
          if (failures >= maxFailures) {
            task.state = failed(tt("wx_qr_poll_failed", { reason }), 502);
            return;
          }
          try {
            await deps.net.sleep(retryDelay, task.controller.signal);
          } catch {
            return; // 停服中止（net.sleep 拒绝 NetError aborted）
          }
          continue;
        }
        task.state = failed(reason, 502);
        return;
      }
    }
  }

  return {
    async start(localTokenList) {
      prune();
      let resp;
      try {
        resp = await deps.api.getBotQrcode(localTokenList);
      } catch (e) {
        throw new WeixinError(
          e instanceof WeixinApiError && e.kind === "network"
            ? tt("wx_unreachable", { reason: e.message })
            : tt("wx_qr_invalid_resp"),
          502,
        );
      }
      const qrcode = resp.qrcode?.trim() ?? "";
      const qrContent = resp.qrcode_img_content?.trim() ?? "";
      if (qrcode === "" || qrContent === "") {
        throw new WeixinError(tt("wx_qr_invalid_resp"), 502);
      }
      const task: Task = {
        id: randomUUID(),
        qrcode,
        baseUrl: ILINK_BASE_URL,
        createdAt: now(),
        state: { status: "pending", scanned: false },
        controller: new AbortController(),
      };
      tasks.set(task.id, task);
      void run(task);
      return { taskId: task.id, qrContent };
    },

    poll(taskId) {
      const task = tasks.get(taskId.trim());
      return task === undefined ? { status: "expired" } : task.state;
    },

    size() {
      return tasks.size;
    },
  };
}
