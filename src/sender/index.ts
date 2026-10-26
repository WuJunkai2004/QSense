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

/** 被动回复窗口（API-FACTS #3，官方限制）：群 5 分钟/5 次；单聊 60 分钟/4 次（v1 工具面仅群聊） */
export const PASSIVE_WINDOW = {
  group: { ms: 5 * 60_000, max: 5 },
  c2c: { ms: 60 * 60_000, max: 4 },
} as const;

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
  /** 本次发送使用的 msg_seq（被动回复） */
  msg_seq?: number;
  /** 官方返回的消息 ID */
  provider_msg_id?: string;
  /** 补充说明（降级/审核提示等） */
  detail?: string;
}

/** 发送 API 最小接口（生产=SDK MessageApi；测试=记录调用的 mock） */
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
  /** 测试注入：替换真实 MessageApi */
  apiFor?: (app: BotApp) => SendApi;
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

  /** 指定 bot 的发送 API（生产懒建 SDK MessageApi；测试用注入） */
  private api(app: BotApp): SendApi {
    const injected = this.deps.apiFor?.(app);
    if (injected !== undefined) return injected;
    let api = this.apis.get(app.appid);
    if (api === undefined) {
      const messageApi = new MessageApi(
        new ApiClient({
          logger: {
            info: (msg, meta) => this.log.debug(msg, meta),
            error: (msg, meta) => this.log.error(msg, meta),
            warn: (msg, meta) => this.log.warn(msg, meta),
            debug: (msg, meta) => this.log.debug(msg, meta),
          },
        }),
        this.deps.tokenManager,
        { markdownSupport: true },
      );
      api = messageApi;
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

  /** 双重门禁（M8 读库版）：发送总开关（kv settings）+ 该 bot 白名单（bots 表）。硬拒绝不发任何请求。 */
  private gate(botId: string, groupOpenid: string): BotApp {
    const sendEnabled = this.deps.repo.getSendEnable();
    const allowGroups = this.deps.bots?.allowGroupsOf(botId) ?? [];
    if (!sendEnabled || !allowGroups.includes(groupOpenid)) {
      throw new Error(
        allowGroups.includes(groupOpenid)
          ? t("send_disabled", {
              enabled: String(sendEnabled),
              allow: allowGroups.length,
            })
          : t("send_not_allowlisted", { group: groupOpenid }),
      );
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
    groupOpenid: string,
    replyMsgId: string,
    text: string,
    markdown = false,
    /** true=附带 message_reference 引用块（客户端展示引用样式）；false=纯被动回复（仅窗口绑定） */
    quote = false,
  ): Promise<SendResult> {
    const app = this.gate(botId, groupOpenid);
    const content = this.checkContent(text);
    const payloadHash = sha256(`${markdown ? "md" : "text"}\0${content}`);

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
        msg_seq: replayed.msg_seq ?? undefined,
        provider_msg_id: replayed.provider_msg_id ?? undefined,
        detail: "同内容回复此前已成功提交（幂等账本命中），未重复发送。",
      };
    }

    // 窗口与次数（官方限制：群 5 分钟/5 次）
    const inbound = this.deps.repo.getMessageByMsgId(
      botId,
      groupOpenid,
      replyMsgId,
    );
    if (inbound === null || inbound.ts === null)
      throw new Error(t("send_window_no_msg", { msg_id: replyMsgId }));
    const win = PASSIVE_WINDOW.group;
    if (Date.now() - inbound.ts > win.ms)
      throw new Error(t("send_window_expired"));
    const used = this.deps.repo.countPassiveSends(botId, replyMsgId);
    if (used >= win.max)
      throw new Error(t("send_window_exhausted", { used, max: win.max }));

    const send = async (
      asMarkdown: boolean,
      seq: number,
    ): Promise<SendResult> => {
      const reservation = this.deps.repo.insertSend({
        bot_id: botId,
        target_openid: groupOpenid,
        kind: "passive",
        reply_msg_id: replyMsgId,
        msg_seq: seq,
        payload_hash: sha256(`${asMarkdown ? "md" : "text"}\0${content}`),
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
      const body: Record<string, unknown> = asMarkdown
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
          "group",
          groupOpenid,
          credsOf(app),
          body,
        );
        this.deps.repo.updateSendStatus(reservation, "sent", resp.id);
        this.log.info("passive sent", {
          group: groupOpenid,
          seq,
          provider: resp.id,
        });
        return { status: "sent", msg_seq: seq, provider_msg_id: resp.id };
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
    groupOpenid: string,
    text: string,
  ): Promise<SendResult> {
    const app = this.gate(botId, groupOpenid);
    const content = this.checkContent(text);
    const repo = this.deps.repo;
    const date = beijingDate();

    // 日额度（官方 1000 条/天/群）：先查后记，超限明确报错不重试
    const usedToday = repo.proactiveCountFor(botId, groupOpenid, date);
    if (usedToday >= this.limits.perGroupDaily) {
      throw new Error(
        t("send_quota_daily", {
          group: groupOpenid,
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
    const relTake = this.relationBucket(botId, groupOpenid).tryTake();
    if (!relTake.ok) {
      throw new Error(
        t("send_rate_limited_relation", { wait: waitOf(relTake) }),
      );
    }

    const reservation = repo.insertSend({
      bot_id: botId,
      target_openid: groupOpenid,
      kind: "proactive",
      reply_msg_id: null,
      msg_seq: null,
      payload_hash: sha256(`text\0${content}`),
      status: "reserved",
    });
    try {
      const resp = await this.api(app).sendRaw(
        "group",
        groupOpenid,
        credsOf(app),
        { msg_type: 0, content },
      );
      repo.updateSendStatus(reservation, "sent", resp.id);
      repo.incrQuotaDaily(botId, groupOpenid, date);
      this.log.info("proactive sent", {
        group: groupOpenid,
        provider: resp.id,
      });
      return { status: "sent", provider_msg_id: resp.id };
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
        repo.incrQuotaDaily(botId, groupOpenid, date);
        return {
          status: "pending_audit",
          detail: t("send_audit_pending", { code: biz ?? 0 }),
        };
      }
      repo.updateSendStatus(reservation, "failed", undefined, biz ?? undefined);
      throw new Error(describeSendError(e));
    }
  }

  // —— 撤回 ——

  async recall(
    botId: string,
    groupOpenid: string,
    messageId: string,
  ): Promise<{ recalled: string }> {
    const app = this.gate(botId, groupOpenid);
    const reservation = this.deps.repo.insertSend({
      bot_id: botId,
      target_openid: groupOpenid,
      kind: "recall",
      reply_msg_id: messageId,
      msg_seq: null,
      payload_hash: sha256(`recall\0${messageId}`),
      status: "reserved",
    });
    try {
      await this.api(app).recallMessage(
        "group",
        groupOpenid,
        messageId,
        credsOf(app),
      );
      this.deps.repo.updateSendStatus(reservation, "sent");
      this.log.info("message recalled", { group: groupOpenid, messageId });
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

  // —— 额度水位（qq_quota 工具用） ——

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
