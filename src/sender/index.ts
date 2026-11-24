// 发送器·策略半（P1 收口后形态）：被动窗口管理、msg_seq 幂等账本、
// 通道自动路由（被动优先）、双重门禁、Markdown 无权限自动降级、人工审核
// （304023/304024）pending 标记、官方错误码翻译、自发消息补记。
//
// 传输经 net.* 原语（ConnectorNet）：宿主装配时按 bot 绑定各平台 connector 实例
// （QQ=connector-qq 的 reply/proactive/recall/uploadMedia，线格式组装在连接器侧）。
// 额度门禁/记账经平台插件钩子（QQ=令牌桶+日额度，见 connector-qq/quota）；
// 未装配钩子的平台视为无额度语义，直接放行。
//
// 硬约束（AGENTS.md #4）：写操作默认关闭——所有入口先过双重门禁
// （发送总开关且目标群在该 bot 白名单），否则硬拒绝，一个包都不发。

import { createHash } from "node:crypto";
import type {
  ConnectorNet,
  MediaWire,
  PlatformCaps,
  ProactiveVerdict,
  ProactiveWire,
  RecallWire,
  ReplyWire,
  SendErrorSemantics,
  UploadMediaWire,
} from "@qsense/connector-sdk";
import type { BotRegistry } from "../bots";
import { sniffPathMime } from "../assets";
import { t } from "../i18n";
import type { Logger } from "../utils/logger";
import type { DB } from "../store/db";
import type { Repo } from "../store/repo";
import { describeSendError, extractBizCode } from "./errors";

/** 被动回复窗口（官方限制，见 AGENTS.md）：群 5 分钟/5 次；单聊 60 分钟/4 次 */
export const PASSIVE_WINDOW = {
  group: { ms: 5 * 60_000, max: 5 },
  c2c: { ms: 60 * 60_000, max: 4 },
} as const;

/** 被动窗口查表键（工具面会话类型 → 官方 scope 词汇）；wire 的 scope 字段直接传 kind */
function windowKeyOf(kind: "group" | "chat"): "group" | "c2c" {
  return kind === "chat" ? "c2c" : "group";
}

/** 消息内容官方上限 5000 字符 */
export const MAX_CONTENT_LEN = 5000;

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

/** 富媒体类别（本项目域层词汇）：image=图片(file_type=1)；voice=语音(file_type=3) */
export type MediaKind = "image" | "voice";

/** 富媒体来源（传输自足：MCP 服务可能与智能体不同机，不收智能体侧本地路径；
 * "file" 为服务端资产（DATA_DIR/assets，经 request_upload 票据上传），跨机安全）
 * （与 SDK MediaSourceWire 同形；P1 保留本名以稳测试导入） */
export type MediaSource = import("@qsense/connector-sdk").MediaSourceWire;

/** 回复/主动共用的媒体载荷：handle=官方转存句柄（file_info），label=补记占位符标签 */
export interface OutgoingMedia {
  kind: MediaKind;
  handle: string;
  label: string;
}

/** 来源 → 富媒体类别：
 * file 源按魔数嗅探（audio/* → 语音，图片魔数/未知 → 图片）；b64 仅 data:image/* → 图片；
 * url 无字节可嗅，按扩展名映射（.mp3/.wav/.silk → 语音） */
function mediaTypeOf(src: MediaSource): MediaKind {
  if (src.kind === "file") {
    return sniffPathMime(src.path)?.startsWith("audio/") ? "voice" : "image";
  }
  if (src.kind === "url" && /\.(mp3|wav|silk)([?#]|$)/i.test(src.url)) {
    return "voice";
  }
  return "image";
}

/** 类别 → 补记占位符标签（与读取层附件占位符约定一致） */
function labelOf(mediaType: MediaKind): string {
  return mediaType === "voice" ? "语音" : "图片";
}

/** 解析 send_media 的 media 参数：http(s):// URL 或 data:image/...;base64,… 内联 */
export function parseMediaSource(media: string): MediaSource {
  const trimmed = media.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { kind: "url", url: trimmed };
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    trimmed,
  );
  if (m) return { kind: "b64", data: m[2]!.replace(/\s+/g, "") };
  throw new Error(t("media_source_invalid"));
}

/** 平台策略钩子（宿主按 bot 绑定后注入；与 ConnectorHooks 的差别是免 ctx 参数） */
export interface BoundConnectorHooks {
  proactiveGate?(botId: string, target: string): Promise<ProactiveVerdict>;
  proactiveRecord?(botId: string, target: string): void | Promise<void>;
}

export interface SenderDeps {
  log: Logger;
  /** 历史遗留字段（旧测试仍在传）；P1 后策略半不再直连 DB */
  db?: DB;
  repo: Repo;
  /** 机器人注册表（bots 表域层）：bot 查找、白名单、认证等级展示 */
  bots?: BotRegistry;
  /** 传输原语按 bot 解析（宿主运行时装配；测试注入 mock）；缺省=写路径硬拒绝 */
  transportFor?: (botId: string) => ConnectorNet | undefined;
  /**
   * 平台 caps 按 bot 解析（P3.5 caps 感知路由）：passiveWindow=false 平台
   * （Telegram）发送恒走主动通道、原语校验放宽；缺省=严格校验（QQ 现行为不变）
   */
  capsFor?: (botId: string) => PlatformCaps | undefined;
  /** 每 bot 发送错误语义面（契约 v2.2.2）：平台官方码判定与文案由连接器声明；
   * 缺省=平台无对应语义（如 Telegram），全部走 core 通用兜底 */
  sendErrorFor?: (botId: string) => SendErrorSemantics | undefined;
  /** 平台策略钩子（QQ=额度门禁/记账）；缺省=无额度语义平台，直接放行 */
  hooks?: BoundConnectorHooks;
  /** 资产存储（send_media 的 asset:<id> 引用解析）；缺省=资产功能未装配 */
  assets?: import("../assets").AssetStore;
}

export class Sender {
  private readonly log: Logger;

  constructor(private readonly deps: SenderDeps) {
    this.log = deps.log.child("sender");
  }

  /**
   * 传输原语解析；未装配=发送面关闭，硬拒绝。原语必备性按 caps 判定
   * （P3.5 caps 感知）：caps 未装配=现行严格校验（QQ 现行为/存量测试不变）；
   * passiveWindow=false 平台不需要 reply；recall=false 不需要 recall；
   * media 全关不需要 uploadMedia。proactive 恒必备。
   */
  private transport(botId: string): {
    reply(wire: ReplyWire): Promise<{ providerMsgId: string }>;
    proactive(wire: ProactiveWire): Promise<{ providerMsgId: string }>;
    recall(wire: RecallWire): Promise<void>;
    uploadMedia(wire: UploadMediaWire): Promise<{ handle: string }>;
  } {
    const net = this.deps.transportFor?.(botId);
    if (net === undefined) {
      throw new Error(
        "发送功能未装配：服务端未装配平台传输（写工具面关闭）。",
      );
    }
    const caps = this.deps.capsFor?.(botId);
    const missing: string[] = [];
    if (caps?.passiveWindow !== false && net.reply === undefined) {
      missing.push("reply");
    }
    if (net.proactive === undefined) missing.push("proactive");
    if (caps?.recall !== false && net.recall === undefined) {
      missing.push("recall");
    }
    if (
      (caps === undefined ||
        caps.media.image ||
        caps.media.voice ||
        caps.media.video ||
        caps.media.file) &&
      net.uploadMedia === undefined
    ) {
      missing.push("uploadMedia");
    }
    if (missing.length > 0) {
      throw new Error(
        `发送功能未装配：平台传输缺少原语 ${missing.join("/")}（写工具面关闭）。`,
      );
    }
    return {
      // 消灭 `net.reply!` 非空断言（曾让 passiveWindow=false 平台的 reply 直呼
      // 变成 TypeError "reply is not a function"——2026-11-24 微信真机爆雷）：
      // 未实现原语 → 可操作错误。正常路由不会触达（resolveChannel 的 caps 收口
      // 使 passiveWindow=false 平台恒走 proactive）；此兜底防未来新的直呼入口。
      reply:
        net.reply ??
        (async (): Promise<{ providerMsgId: string }> => {
          throw new Error(t("send_reply_unsupported"));
        }),
      proactive: net.proactive!,
      recall: net.recall!,
      uploadMedia: net.uploadMedia!,
    };
  }

  /** 双重门禁（M8 读库版）：发送总开关（kv settings）+ 会话级发送条件——
   * 群=该 bot 白名单（bots 表）；私聊=用户未拒绝（C2C_MSG_REJECT 置 false 即硬拒），
   * 主动消息另需用户已同意（C2C_MSG_RECEIVE，requireOptIn=true 时校验）。硬拒绝不发任何请求。 */
  private gate(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
    requireOptIn = false,
  ): void {
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
      // opt-in 校验是 QQ C2C 语义（C2C_MSG_RECEIVE 置位）；平台声明无 opt 概念
      // （proactiveOptIn=false，微信 iLink / Telegram）→ 跳过，「能对话即能发」
      if (
        requireOptIn &&
        optIn !== true &&
        this.deps.capsFor?.(botId)?.proactiveOptIn !== false
      ) {
        throw new Error(t("send_c2c_not_optin", { user: targetId }));
      }
    }
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
    /** 富媒体（图片/语音）：handle 由 transport.uploadMedia 预先取得，
     * label 为补记占位符标签（图片/语音，与读取层附件占位符约定一致） */
    media?: OutgoingMedia,
    /** 会话类型（缺省群聊）：决定被动窗口（群 5 分钟/5 次、单聊 60 分钟/4 次）与缓存查询表 */
    kind: "group" | "chat" = "group",
  ): Promise<SendResult> {
    this.gate(botId, kind, targetId);
    const content = text === undefined ? "" : this.checkContent(text);
    const payloadHash =
      media !== undefined
        ? sha256(`img\0${media.handle}\0${content}`)
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
    const inbound = this.deps.repo.getMessageByMsgId(
      botId,
      kind,
      targetId,
      replyMsgId,
    );
    if (inbound === null || inbound.ts === null)
      throw new Error(t("send_window_no_msg", { msg_id: replyMsgId }));
    const win = PASSIVE_WINDOW[windowKeyOf(kind)];
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
      const mediaWire: MediaWire | undefined =
        media !== undefined
          ? { kind: media.kind, handle: media.handle }
          : undefined;
      try {
        const receipt = await this.transport(botId).reply({
          botId,
          target: targetId,
          scope: kind,
          content,
          msgId: replyMsgId,
          msgSeq: seq,
          markdown: asMarkdown || undefined,
          quoteMsgId: quote ? replyMsgId : undefined,
          media: mediaWire,
        });
        this.deps.repo.updateSendStatus(reservation, "sent", receipt.providerMsgId);
        this.recordOutgoing(
          botId,
          kind,
          targetId,
          receipt.providerMsgId,
          media !== undefined
            ? `![${media.label}]${content === "" ? "" : ` ${content}`}`
            : content,
        );
        this.log.info("passive sent", {
          kind,
          target: targetId,
          seq,
          provider: receipt.providerMsgId,
        });
        return {
          status: "sent",
          channel: "passive",
          msg_seq: seq,
          provider_msg_id: receipt.providerMsgId,
        };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const biz = extractBizCode(err);
        const sem = this.deps.sendErrorFor?.(botId);
        if (sem?.isAuditPending?.(err) === true) {
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
            detail: sem.describe?.(err) ?? t("send_audit_pending", { code: biz ?? 0 }),
          };
        }
        this.deps.repo.updateSendStatus(
          reservation,
          "failed",
          undefined,
          biz ?? undefined,
        );
        throw err;
      }
    };

    if (markdown) {
      try {
        return await send(true, this.deps.repo.nextMsgSeq(botId, replyMsgId));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const sem = this.deps.sendErrorFor?.(botId);
        if (sem?.isMarkdownDowngrade?.(err) !== true) {
          throw new Error(describeSendError(err, sem));
        }
        // 平台判定 Markdown 无权限 → 自动降级纯文本（新账本行，失败行不计窗口次数）
        const result = await send(
          false,
          this.deps.repo.nextMsgSeq(botId, replyMsgId),
        );
        return {
          ...result,
          status: "downgraded",
          detail: sem.describe?.(err) ?? t("send_markdown_downgraded"),
        };
      }
    }
    try {
      return await send(false, this.deps.repo.nextMsgSeq(botId, replyMsgId));
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (extractBizCode(err) !== null)
        throw new Error(describeSendError(err, this.deps.sendErrorFor?.(botId)));
      throw err;
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
    /** 富媒体（图片/语音）：handle 由 transport.uploadMedia 预先取得 */
    media?: OutgoingMedia,
    /** 会话类型（缺省群聊）；私聊主动消息额外要求用户已同意（C2C_MSG_RECEIVE） */
    kind: "group" | "chat" = "group",
    /** markdown 语义（QQ: msg_type=2；出站 AT 标签自动置位，见 sendAuto） */
    markdown = false,
  ): Promise<SendResult> {
    this.gate(botId, kind, targetId, true);
    const content = text === undefined ? "" : this.checkContent(text);
    const payloadHash =
      media !== undefined
        ? sha256(`img\0${media.handle}\0${content}`)
        : sha256(`${markdown ? "md" : "text"}\0${content}`);
    const repo = this.deps.repo;

    // 额度门禁/记账：平台插件钩子（QQ=日额度+令牌桶，拒绝时 reason 面向 AI/用户可操作）；
    // 未装配钩子=无额度语义平台，直接放行。
    if (this.deps.hooks?.proactiveGate !== undefined) {
      const verdict = await this.deps.hooks.proactiveGate(botId, targetId);
      if (!verdict.ok) {
        throw new Error(verdict.reason ?? "平台策略拒绝本次发送。");
      }
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
    const mediaWire: MediaWire | undefined =
      media !== undefined ? { kind: media.kind, handle: media.handle } : undefined;
    try {
      const receipt = await this.transport(botId).proactive({
        botId,
        target: targetId,
        scope: kind,
        content,
        markdown: markdown || undefined,
        quoteMsgId,
        media: mediaWire,
      });
      repo.updateSendStatus(reservation, "sent", receipt.providerMsgId);
      await this.deps.hooks?.proactiveRecord?.(botId, targetId);
      this.recordOutgoing(
        botId,
        kind,
        targetId,
        receipt.providerMsgId,
        media !== undefined
          ? `![${media.label}]${content === "" ? "" : ` ${content}`}`
          : content,
      );
      this.log.info("proactive sent", {
        kind,
        target: targetId,
        provider: receipt.providerMsgId,
      });
      return {
        status: "sent",
        channel: "proactive",
        provider_msg_id: receipt.providerMsgId,
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const biz = extractBizCode(err);
      const sem = this.deps.sendErrorFor?.(botId);
      if (sem?.isAuditPending?.(err) === true) {
        // 审核受理同样占用官方当日额度，记账保守 +1
        repo.updateSendStatus(
          reservation,
          "pending_audit",
          undefined,
          biz ?? undefined,
        );
        await this.deps.hooks?.proactiveRecord?.(botId, targetId);
        return {
          status: "pending_audit",
          channel: "proactive",
          detail: sem.describe?.(err) ?? t("send_audit_pending", { code: biz ?? 0 }),
        };
      }
      repo.updateSendStatus(reservation, "failed", undefined, biz ?? undefined);
      throw new Error(describeSendError(err, sem));
    }
  }

  // —— 统一发送入口（send 工具）：被动优先自动路由 ——
  // 依据：被动/主动在用户端观感一致（被动默认不带引用块），差异只是官方计费口径
  // （被动免额度但限 5 分钟 5 次；主动计额度可能进审核）。通道选择是系统优化问题，
  // 不应暴露给智能体。路由全部落在已真机验证的形态上：
  //   A. 被动 + 绑定（引用可有可无，引用目标=绑定目标）——WebUI quote=true 同款
  //   B. 主动 + 引用块（目标任意时效）——2026-10-26 真机验证受理

  /** 官方出站 AT 新格式直写检测（文档「消息交互→文本交互」）：
   * `<qqbot-at-user id="…"/>` / `<qqbot-at-everyone/>` 仅 markdown 消息渲染 */
  static #OUTBOUND_AT_RE = /<qqbot-at-(?:user|everyone)\b/;

  /** 入站旧格式 AT 表示候选（官方事件 content 的 `<@openid>` 形态，agent 照抄即自然意图）。
   * everyone 不在翻译范围：新格式 @everyone 需管理员身份+每群每日 1 次，自动升级风险大。 */
  static #LEGACY_AT_RE = /<@([A-Za-z0-9]+)>/g;

  /**
   * 出站 AT 翻译（群聊限定）：`<@openid>` → `<qqbot-at-user id="openid"/>`。
   * 只有命中该群成员名册（members 关系事实，消息流自建）的 openid 才替换——
   * 正文里的字面量或陌生 id 原样保留，宁可发纯文本也不误升级 markdown。
   * 有替换（或显式直写新格式标签）才升级 markdown，纯文本通道 AT 不渲染。
   */
  #translateLegacyAt(botId: string, groupOpenid: string, text: string): string {
    if (!text.includes("<@")) return text; // 快速预检：无候选零查询
    const candidates = new Set(
      [...text.matchAll(Sender.#LEGACY_AT_RE)]
        .map((m) => m[1])
        .filter((id): id is string => id !== undefined && id !== "everyone"),
    );
    if (candidates.size === 0) return text;
    const members = this.deps.repo.groupMemberIds(botId, groupOpenid);
    let out = text;
    let hit = false;
    for (const id of candidates) {
      if (!members.has(id)) continue;
      out = out.replaceAll(`<@${id}>`, `<qqbot-at-user id="${id}"/>`);
      hit = true;
    }
    return hit ? out : text;
  }

  async sendAuto(
    botId: string,
    targetId: string,
    text: string,
    /** 可选：引用会话内某条消息（客户端显示引用样式）。须为缓存中存在的官方消息ID */
    quoteMsgId?: string,
    /** 会话类型（缺省群聊） */
    kind: "group" | "chat" = "group",
    /** markdown 语义；缺省按内容自动识别（含可渲染 AT → markdown） */
    markdown = false,
  ): Promise<SendResult> {
    const rendered =
      kind === "group" ? this.#translateLegacyAt(botId, targetId, text) : text;
    const asMarkdown =
      markdown ||
      rendered !== text ||
      Sender.#OUTBOUND_AT_RE.test(rendered);
    const { bindMsgId, quote } = this.resolveChannel(
      botId,
      kind,
      targetId,
      quoteMsgId,
    );
    if (bindMsgId !== undefined) {
      return this.reply(
        botId,
        targetId,
        bindMsgId,
        rendered,
        asMarkdown,
        quote,
        undefined,
        kind,
      );
    }
    return this.proactive(
      botId,
      targetId,
      rendered,
      quoteMsgId,
      undefined,
      kind,
      asMarkdown,
    );
  }

  /** send_media 工具入口：富媒体（图片/语音），通道自动路由（与 sendAuto 同款被动优先）。
   * 2026-10-27 真机验证：msg_type=7 被动/主动/引用块三形态官方均受理。
   * 语音（2026-11）：file_type=3，file 源按魔数嗅探、url 源按扩展名分类。 */
  async sendMediaAuto(
    botId: string,
    targetId: string,
    /** 媒体来源：http(s):// URL、data:image/...;base64 内联、或 asset:<id>（服务端资产） */
    mediaParam: string,
    /** 可选配文（msg_type=7 的 content） */
    text?: string,
    /** 可选：引用会话内某条消息（须在缓存中） */
    quoteMsgId?: string,
    /** 会话类型（缺省群聊） */
    kind: "group" | "chat" = "group",
  ): Promise<SendResult> {
    this.gate(botId, kind, targetId); // 先门禁：上传同属写路径前置
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
    return this.doSendMedia(botId, targetId, src, text, quoteMsgId, kind);
  }

  /** TTS 直发入口（send_media 的 "tts:<文本>" 来源）：合成产物（mp3 字节）已在内存，
   *  即用即弃不落资产区，强制按语音条发送（b64 源默认归类图片，这里显式 override）。 */
  async sendVoiceBytes(
    botId: string,
    targetId: string,
    buf: Buffer,
    text?: string,
    quoteMsgId?: string,
    kind: "group" | "chat" = "group",
  ): Promise<SendResult> {
    this.gate(botId, kind, targetId);
    return this.doSendMedia(
      botId,
      targetId,
      { kind: "b64", data: buf.toString("base64") },
      text,
      quoteMsgId,
      kind,
      "voice",
    );
  }

  /** sendMediaAuto/sendVoiceBytes 共用尾段：通道判定 → 官方转存（transport.uploadMedia）→ reply/proactive */
  private async doSendMedia(
    botId: string,
    targetId: string,
    src: MediaSource,
    text: string | undefined,
    quoteMsgId: string | undefined,
    kind: "group" | "chat",
    mediaTypeOverride?: MediaKind,
  ): Promise<SendResult> {
    const { bindMsgId, quote } = this.resolveChannel(
      botId,
      kind,
      targetId,
      quoteMsgId,
    );
    // 上传转存（官方对同内容返回相同 file_info，TTL 24h；失败不消耗通道额度）。
    // 类别在来源解析后即定：file 源魔数嗅探 / url 源扩展名（audio → file_type=3 语音条）
    const mediaType = mediaTypeOverride ?? mediaTypeOf(src);
    let handle: string;
    try {
      const up = await this.transport(botId).uploadMedia({
        botId,
        target: targetId,
        scope: kind,
        kind: mediaType,
        source: src,
      });
      handle = up.handle;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(
        t("media_upload_failed", {
          reason: describeSendError(err, this.deps.sendErrorFor?.(botId)),
        }),
      );
    }
    this.log.info("media uploaded", {
      kind,
      target: targetId,
      mediaType,
      file_info_len: handle.length,
    });
    const media: OutgoingMedia = { kind: mediaType, handle, label: labelOf(mediaType) };
    if (bindMsgId !== undefined) {
      return this.reply(botId, targetId, bindMsgId, text, false, quote, media, kind);
    }
    return this.proactive(botId, targetId, text, quoteMsgId, media, kind);
  }

  /** 通道判定（sendAuto/sendMediaAuto 共用）：引用目标窗内→绑=引（形态A）；
   * 无引用→绑最新可绑消息（白嫖被动）；否则主动兜底。
   * P3.5：passiveWindow=false 平台（Telegram）无官方窗口/次数语义——绑定与
   * 窗口查表不适用，恒走主动通道（引用照传，平台侧渲染 reply 样式）。 */
  private resolveChannel(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
    quoteMsgId?: string,
  ): { bindMsgId?: string; quote: boolean } {
    if (quoteMsgId !== undefined) {
      const q = this.deps.repo.getMessageByMsgId(
        botId,
        kind,
        targetId,
        quoteMsgId,
      );
      if (q === null || q.ts === null) {
        throw new Error(t("send_quote_not_found", { msg_id: quoteMsgId }));
      }
    }
    if (this.deps.capsFor?.(botId)?.passiveWindow === false) {
      return { bindMsgId: undefined, quote: false };
    }
    let bindMsgId: string | undefined;
    if (
      quoteMsgId !== undefined &&
      this.bindable(botId, kind, targetId, quoteMsgId)
    ) {
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
    const row = this.deps.repo.getMessageByMsgId(botId, kind, targetId, msgId);
    if (row === null || row.ts === null) return false;
    if (Date.now() - row.ts > PASSIVE_WINDOW[windowKeyOf(kind)].ms)
      return false;
    return (
      this.deps.repo.countPassiveSends(botId, msgId) <
      PASSIVE_WINDOW[windowKeyOf(kind)].max
    );
  }

  /** 最新可绑消息：新→旧扫 10 条，跳过自发补记行（direction=1，被动窗口语义是回复他人），
   * 第一条窗内且未超次的（窗内分钟级，10 条充裕） */
  private latestBindable(
    botId: string,
    kind: "group" | "chat",
    targetId: string,
  ): string | undefined {
    const rows = this.deps.repo.browseLatest(botId, kind, targetId, 10);
    for (const row of rows) {
      if (row.direction === 1) continue;
      if (
        row.ts !== null &&
        Date.now() - row.ts <= PASSIVE_WINDOW[windowKeyOf(kind)].ms &&
        this.deps.repo.countPassiveSends(botId, row.msg_id) <
          PASSIVE_WINDOW[windowKeyOf(kind)].max
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
        this.deps.bots?.list().find((b) => b.botId === botId)?.name ?? null;
      this.deps.repo.saveOutgoing({
        botId,
        scope: kind,
        scopeId: targetId,
        msgId: providerMsgId,
        content,
        ts: Date.now(),
        authorName,
      });
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
    this.gate(botId, kind, targetId);
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
      await this.transport(botId).recall({
        botId,
        target: targetId,
        scope: kind,
        providerMsgId: messageId,
      });
      this.deps.repo.updateSendStatus(reservation, "sent");
      this.log.info("message recalled", {
        kind,
        target: targetId,
        messageId,
      });
      return { recalled: messageId };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.deps.repo.updateSendStatus(
        reservation,
        "failed",
        undefined,
        extractBizCode(err) ?? undefined,
      );
      throw new Error(describeSendError(err, this.deps.sendErrorFor?.(botId)));
    }
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
