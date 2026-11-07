// 发送器（DESIGN.md §3.5）：被动窗口管理、msg_seq 幂等账本、主动消息令牌桶与额度记账、
// 官方错误码翻译、Markdown 无权限自动降级、人工审核（304023/304024）pending 标记。
//
// 硬约束（AGENTS.md #4）：写操作默认关闭——所有入口先过双重门禁
// （SEND_ENABLE=true 且目标群在 ALLOW_GROUPS 白名单），否则硬拒绝，API 一个包都不发。
// 发送通道仅官方 API（SDK MessageApi.sendRaw / recallMessage）；msg_seq 由本项目账本权威分配，
// 不用 SDK 内置计数器（进程重启即丢，不满足幂等要求）。

import { createHash } from "node:crypto";
import {
  ApiClient,
  MediaApi,
  MediaFileType,
  MessageApi,
  type TokenManager,
} from "@tencent-connect/qqbot-nodejs/protocol";
import type { BotApp } from "../config";
import type { BotRegistry } from "../bots";
import { t } from "../i18n";
import type { Logger } from "../logger";
import type { DB } from "../store/db";
import type { Repo } from "../store/repo";
import {
  describeSendError,
  extractBizCode,
  isAuditPendingCode,
  isMarkdownPermissionError,
} from "./errors";

/** 被动回复窗口（API-FACTS #3，官方限制）：群 5 分钟/5 次；单聊 60 分钟/4 次 */
export const PASSIVE_WINDOW = {
  group: { ms: 5 * 60_000, max: 5 },
  c2c: { ms: 60 * 60_000, max: 4 },
} as const;

/** 工具面会话类型（group/chat）→ 官方 API scope（group/c2c）：两套词汇在发送边界转换 */
function scopeOf(kind: "group" | "chat"): "group" | "c2c" {
  return kind === "chat" ? "c2c" : "group";
}

/** 官方限制常量：单关系（每群）主动消息 20 条/分钟、1000 条/天 */
export const PER_RELATION_QPM = 20;
export const PER_GROUP_DAILY = 1000;
/** 消息内容官方上限 5000 字符 */
export const MAX_CONTENT_LEN = 5000;

export interface SendLimits {
  /** bot 级主动消息条/分钟：认证 60 / 未认证 30（config.authLevel 决定默认值） */
  qpm: number;
  perRelationQpm: number;
  perGroupDaily: number;
}

export type SendStatus = "sent" | "replayed" | "downgraded" | "pending_audit";

export interface SendResult {
  status: SendStatus;
  /** 实际通道：passive=被动回复（不计额度）| proactive=主动消息（计额度） */
  channel?: "passive" | "proactive";
  /** 本次发送使用的 msg_seq（被动回复） */
  msg_seq?: number;
  /** 官方返回的消息 ID */
  provider_msg_id?: string;
  /** 补充说明（降级/审核提示等） */
  detail?: string;
}

/** 发送 API 最小接口（生产=SDK MessageApi/MediaApi 适配；测试=记录调用的 mock） */
export interface SendApi {
  sendRaw(
    scope: "group" | "c2c",
    targetId: string,
    creds: { appId: string; clientSecret: string },
    body: Record<string, unknown>,
  ): Promise<{ id: string }>;
  recallMessage(
    scope: "group" | "c2c",
    targetId: string,
    messageId: string,
    creds: { appId: string; clientSecret: string },
  ): Promise<void>;
  /** 富媒体上传（首版仅图片 IMAGE），返回官方 file_info（TTL 24h，可复用） */
  uploadMedia(
    scope: "group" | "c2c",
    targetId: string,
    creds: { appId: string; clientSecret: string },
    src: MediaSource,
  ): Promise<string>;}

/** 富媒体来源（传输自足：MCP 服务可能与智能体不同机，不收智能体侧本地路径；
 * "file" 为服务端资产（DATA_DIR/assets，经 request_upload 票据上传），跨机安全） */
export type MediaSource =
  | { kind: "url"; url: string }
  | { kind: "b64"; data: string }
  | { kind: "file"; path: string };

/** 解析 send_media 的 media 参数：http(s):// URL 或 data:image/...;base64,… 内联 */
export function parseMediaSource(media: string): MediaSource {
  const trimmed = media.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { kind: "url", url: trimmed };
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (m) return { kind: "b64", data: m[2]!.replace(/\s+/g, "") };
  throw new Error(t("media_source_invalid"));
}

export interface SenderDeps {
  log: Logger;
  db: DB;
  repo: Repo;
  /** SDK TokenManager（与网关共用同一实例，token 缓存复用） */
  tokenManager: TokenManager;
  /** 机器人注册表（bots 表域层）：bot 查找、白名单、认证等级频控档位 */
  bots?: BotRegistry;
  /** 测试注入：覆盖限额默认值 */
  limits?: Partial<SendLimits>;
  /** 测试注入：替换真实 MessageApi/MediaApi */
  apiFor?: (app: BotApp) => SendApi;
  /** 资产存储（send_media 的 asset:<id> 引用解析）；缺省=资产功能未装配 */
  assets?: import("../assets").AssetStore;
}

/** 内存令牌桶：容量=配额，按 refillPerMin 匀速回填 */
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerMin: number,
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 60_000) * this.refillPerMin,
    );
    this.last = now;
  }
  tryTake(): { ok: boolean; waitMs: number } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, waitMs: 0 };
    }
    return {
      ok: false,
      waitMs: Math.ceil(((1 - this.tokens) / this.refillPerMin) * 60_000),
    };
  }
  get remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** 额度日期串：官方 1000 条/天按北京时间自然日计 */
export function beijingDate(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

export class Sender {
  private readonly log: Logger;
  private readonly limits: SendLimits;
  private readonly apis = new Map<string, SendApi>();
  /** bot 级主动消息令牌桶（appid → bucket） */
  private readonly botBuckets = new Map<string, TokenBucket>();
  /** 单关系令牌桶（`appid:group_openid` → bucket） */
  private readonly relationBuckets = new Map<string, TokenBucket>();

  constructor(private readonly deps: SenderDeps) {
    this.log = deps.log.child("sender");
    this.limits = {
      qpm: deps.limits?.qpm ?? 0, // 0=按 bot 的 auth_level 现算（60/30），见 qpmOf
      perRelationQpm: deps.limits?.perRelationQpm ?? PER_RELATION_QPM,
      perGroupDaily: deps.limits?.perGroupDaily ?? PER_GROUP_DAILY,
    };
  }

  /**
   * M9：主动消息 qpm 预算按 bot 的 auth_level 现算（certified=60 / uncertified=30）；
   * limits.qpm 显式注入时覆盖所有 bot（测试用）。
   */
  private qpmOf(botId: string): number {
    if (this.limits.qpm > 0) return this.limits.qpm;
    return this.deps.bots?.authLevelOf(botId) === "certified" ? 60 : 30;
  }

  /** 指定 bot 的发送 API（生产懒建 SDK MessageApi/MediaApi 适配；测试用注入） */
  private api(app: BotApp): SendApi {
    const injected = this.deps.apiFor?.(app);
    if (injected !== undefined) return injected;
    let api = this.apis.get(app.appid);
    if (api === undefined) {
      const client = new ApiClient({
        logger: {
          info: (msg, meta) => this.log.debug(msg, meta),
          error: (msg, meta) => this.log.error(msg, meta),
          warn: (msg, meta) => this.log.warn(msg, meta),
          debug: (msg, meta) => this.log.debug(msg, meta),
        },
      });
      const messageApi = new MessageApi(client, this.deps.tokenManager, {
        markdownSupport: true,
      });
      const mediaApi = new MediaApi(client, this.deps.tokenManager);
      api = {
        sendRaw: (scope, targetId, creds, body) =>
          messageApi.sendRaw(scope, targetId, creds, body),
        recallMessage: (scope, targetId, messageId, creds) =>
          messageApi.recallMessage(scope, targetId, messageId, creds),
        uploadMedia: (scope, targetId, creds, src) =>
          mediaApi
            .uploadMedia(
              scope,
              targetId,
              MediaFileType.IMAGE,
              creds,
              src.kind === "url"
                ? { url: src.url }
                : src.kind === "file"
                  ? { localPath: src.path }
                  : { fileData: src.data },
            )
            .then((up) => up.file_info),
      };
      this.apis.set(app.appid, api);
    }
    return api;
  }

  private appOf(botId: string): BotApp {
    const bots = this.deps.bots?.list() ?? [];
    const app = bots.find((a) => a.appid === botId);
    if (app === undefined)
      throw new Error(
        `bot 不存在：${botId}。可用：${bots.map((a) => a.appid).join(", ") || "（无）"}`,
      );
    return app;
  }

  /** 双重门禁（M8 读库版）：发送总开关（kv settings）+ 会话级发送条件——
   * 群=该 bot 白名单（bots 表）；私聊=用户未拒绝（C2C_MSG_REJECT 置 false 即硬拒），
   * 主动消息另需用户已同意（C2C_MSG_RECEIVE，requireOptIn=true 时校验）。硬拒绝不发任何请求。 */
  private gate(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
    requireOptIn = false,
  ): BotApp {
    const sendEnabled = this.deps.repo.getSendEnable();
    if (!sendEnabled) {
      throw new Error(
        t("send_disabled", {
          enabled: String(sendEnabled),
          allow: this.deps.bots?.allowGroupsOf(botId).length ?? 0,
        }),
      );
    }
    if (kind === "group") {
      const allowGroups = this.deps.bots?.allowGroupsOf(botId) ?? [];
      if (!allowGroups.includes(targetId)) {
        throw new Error(t("send_not_allowlisted", { group: targetId }));
      }
    } else {
      const optIn = this.deps.repo.getC2cSwitch(botId, targetId);
      if (optIn === false) {
        throw new Error(t("send_c2c_optout", { user: targetId }));
      }
      if (requireOptIn && optIn !== true) {
        throw new Error(t("send_c2c_not_optin", { user: targetId }));
      }
    }
    return this.appOf(botId);
  }

  private checkContent(text: string): string {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("消息内容为空。请提供要发送的文本。");
    if ([...trimmed].length > MAX_CONTENT_LEN) {
      throw new Error(t("send_text_too_long", { len: [...trimmed].length }));
    }
    return trimmed;
  }

  // —— 被动回复 ——

  async reply(
    botId: string,
    targetId: string,
    replyMsgId: string,
    /** 文本/markdown 内容；媒体发送时为可选配文（可空） */
    text: string | undefined,
    markdown = false,
    /** true=附带 message_reference 引用块（客户端展示引用样式）；false=纯被动回复（仅窗口绑定） */
    quote = false,
    /** 富媒体（首版仅图片）：msg_type=7，text 降级为配文；file_info 由 uploadMedia 预先取得 */
    media?: { fileInfo: string },
    /** 会话类型（缺省群聊）：决定被动窗口（群 5 分钟/5 次、单聊 60 分钟/4 次）与缓存查询表 */
    kind: "group" | "chat" = "group",
  ): Promise<SendResult> {
    const app = this.gate(botId, kind, targetId);
    const content = text === undefined ? "" : this.checkContent(text);
    const payloadHash =
      media !== undefined
        ? sha256(`img\0${media.fileInfo}\0${content}`)
        : sha256(`${markdown ? "md" : "text"}\0${content}`);

    // 幂等重放：同 回复目标+payload 已成功受理（sent/pending_audit）→ 直接返回首次结果
    const replayed = this.deps.repo.findSendReplay(
      botId,
      "passive",
      replyMsgId,
      payloadHash,
    );
    if (replayed !== null) {
      this.log.info("passive replay (idempotent)", {
        msgId: replyMsgId,
        seq: replayed.msg_seq,
      });
      return {
        status: "replayed",
        channel: "passive",
        msg_seq: replayed.msg_seq ?? undefined,
        provider_msg_id: replayed.provider_msg_id ?? undefined,
        detail: "同内容回复此前已成功提交（幂等账本命中），未重复发送。",
      };
    }

    // 窗口与次数（官方限制：群 5 分钟/5 次、单聊 60 分钟/4 次）
    const inbound =
      kind === "chat"
        ? this.deps.repo.getC2cMessageByMsgId(botId, targetId, replyMsgId)
        : this.deps.repo.getMessageByMsgId(botId, targetId, replyMsgId);
    if (inbound === null || inbound.ts === null)
      throw new Error(t("send_window_no_msg", { msg_id: replyMsgId }));
    const win = PASSIVE_WINDOW[scopeOf(kind)];
    if (Date.now() - inbound.ts > win.ms)
      throw new Error(
        kind === "chat"
          ? t("send_window_expired_c2c")
          : t("send_window_expired"),
      );
    const used = this.deps.repo.countPassiveSends(botId, replyMsgId);
    if (used >= win.max)
      throw new Error(
        kind === "chat"
          ? t("send_window_exhausted_c2c", { used, max: win.max })
          : t("send_window_exhausted", { used, max: win.max }),
      );

    const send = async (
      asMarkdown: boolean,
      seq: number,
    ): Promise<SendResult> => {
      const reservation = this.deps.repo.insertSend({
        bot_id: botId,
        target_openid: targetId,
        kind: "passive",
        reply_msg_id: replyMsgId,
        msg_seq: seq,
        payload_hash: payloadHash,
        status: "reserved",
      });
      // 官方群聊引用块（2026-03 v2 autogen 文档收录 message_reference，真机实测返回 ext_info.ref_idx）：
      // 显式引用（quote=true）时附带，QQ 客户端以引用样式展示；ignore_get_message_error=true 兜底——
      // 原消息详情拉取失败（如被撤回）时仍送达，仅丢失引用样式（送达优先于样式）。
      // 纯被动回复（quote=false）只做 msg_id 窗口绑定，不带引用块。
      const messageReference = quote
        ? {
            message_id: replyMsgId,
            ignore_get_message_error: true,
          }
        : undefined;
      const body: Record<string, unknown> = media
        ? {
            // 富媒体（2026-10-27 真机验证：msg_type=7 可走被动窗口，可带 message_reference 引用块）
            msg_type: 7,
            content,
            media: { file_info: media.fileInfo },
            msg_id: replyMsgId,
            msg_seq: seq,
            ...(messageReference !== undefined
              ? { message_reference: messageReference }
              : {}),
          }
        : asMarkdown
        ? {
            msg_type: 2,
            markdown: { content },
            msg_id: replyMsgId,
            msg_seq: seq,
            ...(messageReference !== undefined
              ? { message_reference: messageReference }
              : {}),
          }
        : {
            msg_type: 0,
            content,
            msg_id: replyMsgId,
            msg_seq: seq,
            ...(messageReference !== undefined
              ? { message_reference: messageReference }
              : {}),
          };
      try {
        const resp = await this.api(app).sendRaw(
          scopeOf(kind),
          targetId,
          credsOf(app),
          body,
        );
        this.deps.repo.updateSendStatus(reservation, "sent", resp.id);
        this.recordOutgoing(
          botId,
          kind,
          targetId,
          resp.id,
          media !== undefined
            ? `![图片]${content === "" ? "" : ` ${content}`}`
            : content,
        );
        this.log.info("passive sent", {
          kind,
          target: targetId,
          seq,
          provider: resp.id,
        });
        return { status: "sent", channel: "passive", msg_seq: seq, provider_msg_id: resp.id };
      } catch (e) {
        const biz = extractBizCode(e);
        if (isAuditPendingCode(biz)) {
          this.deps.repo.updateSendStatus(
            reservation,
            "pending_audit",
            undefined,
            biz ?? undefined,
          );
          return {
            status: "pending_audit",
            channel: "passive",
            msg_seq: seq,
            detail: t("send_audit_pending", { code: biz ?? 0 }),
          };
        }
        this.deps.repo.updateSendStatus(
          reservation,
          "failed",
          undefined,
          biz ?? undefined,
        );
        throw e;
      }
    };

    if (markdown) {
      try {
        return await send(true, this.deps.repo.nextMsgSeq(botId, replyMsgId));
      } catch (e) {
        if (!isMarkdownPermissionError(e)) {
          throw new Error(describeSendError(e));
        }
        // 304036：Markdown 无模板权限 → 自动降级纯文本（新账本行，失败行不计窗口次数）
        const result = await send(
          false,
          this.deps.repo.nextMsgSeq(botId, replyMsgId),
        );
        return {
          ...result,
          status: "downgraded",
          detail: t("send_markdown_downgraded"),
        };
      }
    }
    try {
      return await send(false, this.deps.repo.nextMsgSeq(botId, replyMsgId));
    } catch (e) {
      if (extractBizCode(e) !== null) throw new Error(describeSendError(e));
      throw e;
    }
  }

  // —— 主动消息 ——

  async proactive(
    botId: string,
    targetId: string,
    /** 文本/markdown 内容；媒体发送时为可选配文（可空） */
    text: string | undefined,
    /**
     * 可选引用块目标（message_reference）。引用样式与被动窗口解耦（官方已真机验证：
     * 主动消息携带 message_reference 照常受理，目标超窗亦可），仅影响客户端展示。
     */
    quoteMsgId?: string,
    /** 富媒体（首版仅图片）：msg_type=7，text 降级为配文；file_info 由 uploadMedia 预先取得 */
    media?: { fileInfo: string },
    /** 会话类型（缺省群聊）；私聊主动消息额外要求用户已同意（C2C_MSG_RECEIVE） */
    kind: "group" | "chat" = "group",
  ): Promise<SendResult> {
    const app = this.gate(botId, kind, targetId, true);
    const content = text === undefined ? "" : this.checkContent(text);
    const payloadHash =
      media !== undefined
        ? sha256(`img\0${media.fileInfo}\0${content}`)
        : sha256(`text\0${content}`);
    const repo = this.deps.repo;
    const date = beijingDate();

    // 日额度（官方 1000 条/天/单关系）：先查后记，超限明确报错不重试
    const usedToday = repo.proactiveCountFor(botId, targetId, date);
    if (usedToday >= this.limits.perGroupDaily) {
      throw new Error(
        t("send_quota_daily", {
          group: targetId,
          used: usedToday,
          limit: this.limits.perGroupDaily,
        }),
      );
    }

    // 令牌桶：bot 级 → 单关系级
    const waitOf = (r: { ok: boolean; waitMs: number }): number =>
      Math.max(1, Math.ceil(r.waitMs / 1000));
    const botBucket = this.botBucket(botId);
    const botTake = botBucket.tryTake();
    if (!botTake.ok) {
      throw new Error(
        t("send_rate_limited_bot", {
          qpm: this.qpmOf(botId),
          level: this.deps.bots?.authLevelOf(botId) ?? "uncertified",
          wait: waitOf(botTake),
        }),
      );
    }
    const relTake = this.relationBucket(botId, targetId).tryTake();
    if (!relTake.ok) {
      throw new Error(
        t("send_rate_limited_relation", { wait: waitOf(relTake) }),
      );
    }

    const reservation = repo.insertSend({
      bot_id: botId,
      target_openid: targetId,
      kind: "proactive",
      reply_msg_id: null,
      msg_seq: null,
      payload_hash: payloadHash,
      status: "reserved",
    });
    try {
      const resp = await this.api(app).sendRaw(
        scopeOf(kind),
        targetId,
        credsOf(app),
        {
          ...(media !== undefined
            ? {
                // 富媒体（2026-10-27 真机验证：主动 msg_type=7 受理，可带引用块）
                msg_type: 7,
                media: { file_info: media.fileInfo },
              }
            : { msg_type: 0 }),
          content,
          ...(quoteMsgId !== undefined
            ? {
                message_reference: {
                  message_id: quoteMsgId,
                  ignore_get_message_error: true,
                },
              }
            : {}),
        },
      );
      repo.updateSendStatus(reservation, "sent", resp.id);
      repo.incrQuotaDaily(botId, targetId, date);
      this.recordOutgoing(
        botId,
        kind,
        targetId,
        resp.id,
        media !== undefined
          ? `![图片]${content === "" ? "" : ` ${content}`}`
          : content,
      );
      this.log.info("proactive sent", {
        kind,
        target: targetId,
        provider: resp.id,
      });
      return { status: "sent", channel: "proactive", provider_msg_id: resp.id };
    } catch (e) {
      const biz = extractBizCode(e);
      if (isAuditPendingCode(biz)) {
        // 审核受理同样占用官方当日额度，记账保守 +1
        repo.updateSendStatus(
          reservation,
          "pending_audit",
          undefined,
          biz ?? undefined,
        );
        repo.incrQuotaDaily(botId, targetId, date);
        return {
          status: "pending_audit",
          channel: "proactive",
          detail: t("send_audit_pending", { code: biz ?? 0 }),
        };
      }
      repo.updateSendStatus(reservation, "failed", undefined, biz ?? undefined);
      throw new Error(describeSendError(e));
    }
  }

  // —— 统一发送入口（send 工具）：被动优先自动路由 ——
  // 依据：被动/主动在用户端观感一致（被动默认不带引用块），差异只是官方计费口径
  // （被动免额度但限 5 分钟 5 次；主动计额度可能进审核）。通道选择是系统优化问题，
  // 不应暴露给智能体。路由全部落在已真机验证的形态上：
  //   A. 被动 + 绑定（引用可有可无，引用目标=绑定目标）——WebUI quote=true 同款
  //   B. 主动 + 引用块（目标任意时效）——2026-10-26 真机验证受理
  async sendAuto(
    botId: string,
    targetId: string,
    text: string,
    /** 可选：引用会话内某条消息（客户端显示引用样式）。须为缓存中存在的官方消息ID */
    quoteMsgId?: string,
    /** 会话类型（缺省群聊） */
    kind: "group" | "chat" = "group",
  ): Promise<SendResult> {
    const { bindMsgId, quote } = this.resolveChannel(
      botId,
      kind,
      targetId,
      quoteMsgId,
    );
    if (bindMsgId !== undefined) {
      return this.reply(botId, targetId, bindMsgId, text, false, quote, undefined, kind);
    }
    return this.proactive(botId, targetId, text, quoteMsgId, undefined, kind);
  }

  /** send_media 工具入口：富媒体（首版仅图片），通道自动路由（与 sendAuto 同款被动优先）。
   * 2026-10-27 真机验证：msg_type=7 被动/主动/引用块三形态官方均受理。 */
  async sendMediaAuto(
    botId: string,
    targetId: string,
    /** 图片来源：http(s):// URL 或 data:image/...;base64（传输自足，跨机安全） */
    mediaParam: string,
    /** 可选配文（msg_type=7 的 content） */
    text?: string,
    /** 可选：引用会话内某条消息（须在缓存中） */
    quoteMsgId?: string,
    /** 会话类型（缺省群聊） */
    kind: "group" | "chat" = "group",
  ): Promise<SendResult> {
    const app = this.gate(botId, kind, targetId); // 先门禁：上传同属写路径前置
    // 来源解析：asset:<id>（服务端资产）→ file；其余按 URL / data: 内联
    let src: MediaSource;
    if (mediaParam.startsWith("asset:")) {
      const id = mediaParam.slice("asset:".length).trim();
      const p = this.deps.assets?.pathOf(id) ?? null;
      if (p === null) throw new Error(t("asset_not_found", { id }));
      src = { kind: "file", path: p };
    } else {
      src = parseMediaSource(mediaParam);
    }
    const { bindMsgId, quote } = this.resolveChannel(
      botId,
      kind,
      targetId,
      quoteMsgId,
    );
    // 上传转存（官方对同内容返回相同 file_info，TTL 24h；失败不消耗通道额度）
    let fileInfo: string;
    try {
      fileInfo = await this
        .api(app)
        .uploadMedia(scopeOf(kind), targetId, credsOf(app), src);
    } catch (e) {
      throw new Error(
        t("media_upload_failed", { reason: describeSendError(e) }),
      );
    }
    this.log.info("media uploaded", {
      kind,
      target: targetId,
      file_info_len: fileInfo.length,
    });
    if (bindMsgId !== undefined) {
      return this.reply(botId, targetId, bindMsgId, text, false, quote, {
        fileInfo,
      }, kind);
    }
    return this.proactive(botId, targetId, text, quoteMsgId, { fileInfo }, kind);
  }

  /** 通道判定（sendAuto/sendMediaAuto 共用）：引用目标窗内→绑=引（形态A）；
   * 无引用→绑最新可绑消息（白嫖被动）；否则主动兜底 */
  private resolveChannel(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
    quoteMsgId?: string,
  ): { bindMsgId?: string; quote: boolean } {
    if (quoteMsgId !== undefined) {
      const q =
        kind === "chat"
          ? this.deps.repo.getC2cMessageByMsgId(botId, targetId, quoteMsgId)
          : this.deps.repo.getMessageByMsgId(botId, targetId, quoteMsgId);
      if (q === null || q.ts === null) {
        throw new Error(t("send_quote_not_found", { msg_id: quoteMsgId }));
      }
    }
    let bindMsgId: string | undefined;
    if (quoteMsgId !== undefined && this.bindable(botId, kind, targetId, quoteMsgId)) {
      bindMsgId = quoteMsgId;
    } else if (quoteMsgId === undefined) {
      bindMsgId = this.latestBindable(botId, kind, targetId);
    }
    return {
      bindMsgId,
      quote: bindMsgId !== undefined && bindMsgId === quoteMsgId,
    };
  }

  /** 消息可否作被动绑定目标：在缓存、窗内（群 5 分钟/单聊 60 分钟）、未用尽次数 */
  private bindable(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
    msgId: string,
  ): boolean {
    const row =
      kind === "chat"
        ? this.deps.repo.getC2cMessageByMsgId(botId, targetId, msgId)
        : this.deps.repo.getMessageByMsgId(botId, targetId, msgId);
    if (row === null || row.ts === null) return false;
    if (Date.now() - row.ts > PASSIVE_WINDOW[scopeOf(kind)].ms) return false;
    return (
      this.deps.repo.countPassiveSends(botId, msgId) <
      PASSIVE_WINDOW[scopeOf(kind)].max
    );
  }

  /** 最新可绑消息：新→旧扫 10 条，跳过自发补记行（direction=1，被动窗口语义是回复他人），
   * 第一条窗内且未超次的（窗内分钟级，10 条充裕） */
  private latestBindable(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
  ): string | undefined {
    const rows =
      kind === "chat"
        ? this.deps.repo.browseC2cLatest(botId, targetId, 10)
        : this.deps.repo.browseLatest(botId, targetId, 10);
    for (const row of rows) {
      if (row.direction === 1) continue;
      if (
        row.ts !== null &&
        Date.now() - row.ts <= PASSIVE_WINDOW[scopeOf(kind)].ms &&
        this.deps.repo.countPassiveSends(botId, row.msg_id) <
          PASSIVE_WINDOW[scopeOf(kind)].max
      ) {
        return row.msg_id;
      }
    }
    return undefined;
  }

  /**
   * 发送成功后本地补记（官方不回推 bot 自发消息）：进缓存供读取层连续性与
   * yourself 标注。author_name 取 bots 表备注名（与 WebUI 补记同源）。
   * 落库失败不影响发送结果（消息已出账，只记日志）。
   */
  private recordOutgoing(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
    providerMsgId: string,
    content: string,
  ): void {
    try {
      const authorName =
        this.deps.bots?.list().find((b) => b.appid === botId)?.name ?? null;
      if (kind === "chat") {
        this.deps.repo.saveOutgoingC2cMessage({
          botId,
          userOpenid: targetId,
          msgId: providerMsgId,
          content,
          ts: Date.now(),
          authorName,
        });
      } else {
        this.deps.repo.saveOutgoingGroupMessage({
          botId,
          groupOpenid: targetId,
          msgId: providerMsgId,
          content,
          ts: Date.now(),
          authorName,
        });
      }
    } catch (e) {
      this.log.warn("outgoing message persist failed", {
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // —— 撤回 ——

  async recall(
    botId: string,
    targetId: string,
    messageId: string,
    /** 会话类型（缺省群聊） */
    kind: "group" | "chat" = "group",
  ): Promise<{ recalled: string }> {
    const app = this.gate(botId, kind, targetId);
    const reservation = this.deps.repo.insertSend({
      bot_id: botId,
      target_openid: targetId,
      kind: "recall",
      reply_msg_id: messageId,
      msg_seq: null,
      payload_hash: sha256(`recall\0${messageId}`),
      status: "reserved",
    });
    try {
      await this.api(app).recallMessage(
        scopeOf(kind),
        targetId,
        messageId,
        credsOf(app),
      );
      this.deps.repo.updateSendStatus(reservation, "sent");
      this.log.info("message recalled", {
        kind,
        target: targetId,
        messageId,
      });
      return { recalled: messageId };
    } catch (e) {
      this.deps.repo.updateSendStatus(
        reservation,
        "failed",
        undefined,
        extractBizCode(e) ?? undefined,
      );
      throw new Error(describeSendError(e));
    }
  }

  // —— 额度水位（quota 工具用） ——

  snapshot(botId: string): {
    limits: SendLimits;
    bot_bucket_remaining: number;
    today_by_group: Array<{ group: string; used: number }>;
    relation_remaining: Record<string, number>;
  } {
    const date = beijingDate();
    const allowGroups = this.deps.bots?.allowGroupsOf(botId) ?? [];
    return {
      limits: this.limits,
      bot_bucket_remaining: this.botBucket(botId).remaining,
      today_by_group: allowGroups.map((g) => ({
        group: g,
        used: this.deps.repo.proactiveCountFor(botId, g, date),
      })),
      relation_remaining: Object.fromEntries(
        allowGroups.map((g) => [g, this.relationBucket(botId, g).remaining]),
      ),
    };
  }

  private botBucket(appid: string): TokenBucket {
    let b = this.botBuckets.get(appid);
    if (b === undefined) {
      const qpm = this.qpmOf(appid);
      b = new TokenBucket(qpm, qpm);
      this.botBuckets.set(appid, b);
    }
    return b;
  }

  private relationBucket(appid: string, groupOpenid: string): TokenBucket {
    const key = `${appid}:${groupOpenid}`;
    let b = this.relationBuckets.get(key);
    if (b === undefined) {
      b = new TokenBucket(
        this.limits.perRelationQpm,
        this.limits.perRelationQpm,
      );
      this.relationBuckets.set(key, b);
    }
    return b;
  }
}

/** BotApp → SDK Credentials 字段名映射 */
function credsOf(app: BotApp): { appId: string; clientSecret: string } {
  return { appId: app.appid, clientSecret: app.secret };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
