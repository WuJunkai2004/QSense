// core ingest 管线（P5 契约 v2 表驱动，2026-11-17）：connector 实例经 host.ingest
// 上行的信封按 payload.platform 路由到对应插件 normalize（解读权在插件，决策 #8）
// → 通用消息级去重 → repo 入库/效应落地。core 对平台零硬编码——第三方插件零
// core 改动进场；历史上的 isTelegramPayload / unwrapQqPayload / 平台 handler
// 分支已随 parser 下沉退役。
//
// 效应（InboundEffect）是平台语义到 core 中立词汇表的翻译：群注册表/开关/审核
// 回执由 core 按 repo 语义落地；botId 以信封为权威盖章（防插件填错 bot 跨 bot 污染）。

import {
  ConnectorRegistry,
  formatZodIssues,
  InboundEffectSchema,
  UnifiedMessageSchema,
  type InboundEffect,
  type NormalizedMessage,
} from "@qsense/connector-sdk";
import { t } from "../i18n";
import type { Logger } from "../utils/logger";
import type { Repo } from "../store/repo";
import { BoundedDedup } from "./dedup";

export interface IngestDeps {
  repo: Repo;
  log: Logger;
  /** 表驱动路由表：payload.platform → 插件 normalize（宿主装载产物） */
  plugins: ConnectorRegistry;
  /** 测试观测点：normalize 后、入库前（生产不传） */
  tap?: (inbound: {
    messages: NormalizedMessage[];
    effects: InboundEffect[];
  }) => void;
}

/** 信封 platform 键（= plugin.id）；缺失/非字符串 = 未知信封 */
function platformKeyOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = (payload as Record<string, unknown>)["platform"];
  return typeof p === "string" && p !== "" ? p : null;
}

/** 效应落地：平台中立词汇 → repo 状态变更（botId 以信封为权威） */
function applyEffect(repo: Repo, botId: string, fx: InboundEffect): void {
  switch (fx.kind) {
    case "group-seen":
      repo.ensureGroup(botId, fx.scopeId, fx.fullMsg === undefined ? null : fx.fullMsg ? 1 : 0);
      return;
    case "group-added":
      repo.addGroup(botId, fx.scopeId);
      return;
    case "group-removed":
      repo.removeGroup(botId, fx.scopeId);
      return;
    case "group-opt":
      repo.setGroupSwitch(botId, fx.scopeId, fx.allow);
      return;
    case "chat-opt":
      repo.setC2cSwitch(botId, fx.scopeId, fx.allow);
      return;
    case "audit":
      repo.applyAuditResult(botId, fx.target, fx.pass ? "audit_pass" : "audit_reject");
      return;
  }
}

/**
 * ingest 管线工厂：返回 (e: RawInbound) => void 形状的宿主 ingest 实现。
 * 每条消息路径绝不抛错由调用方兜底（与旧 onEvent 纪律一致）。
 * 消息级去重键平台中立：(botId, scope, scopeId, msgId)——即 saveMessage 的幂等主键；
 * Telegram 无事件级去重键（update_id 至少一次），同键重投在此挡下。
 */
export function createIngestPipeline(deps: IngestDeps): (raw: {
  botId: string;
  payload: unknown;
}) => void {
  const dedup = new BoundedDedup(4096);
  return (raw) => {
    const platform = platformKeyOf(raw.payload);
    if (platform === null) {
      deps.log.warn(t("ingest_no_platform", { bot: raw.botId }));
      return;
    }
    const plugin = deps.plugins.get(platform);
    if (plugin?.normalize === undefined) {
      deps.log.warn(
        t("ingest_platform_unloaded", { platform, bot: raw.botId }),
      );
      return;
    }
    let inbound: { messages: NormalizedMessage[]; effects: InboundEffect[] } | null;
    try {
      inbound = plugin.normalize(raw.botId, raw.payload);
    } catch (e) {
      // parser 抛错不炸管线（每条消息路径绝不抛错纪律）
      deps.log.warn(t("ingest_parse_fail", {
        platform,
        reason: e instanceof Error ? e.message : String(e),
      }));
      return;
    }
    if (inbound === null) return;

    // botId 以信封为权威（成品消息逐条盖章）。次序纪律（T1 加固）：去重只检查、
    // 入库成功才标记——旧的「检查即标记」与单条入库失败组合，曾造成连接器重拉
    // 同批时全部命中去重被滤、游标照样推进，进程生命周期内静默丢整批。
    // 每条消息/效应各自 try/catch：单条失败不炸整批、不上抛（绝不抛错纪律），
    // 连接器轮询循环不会把入库问题误当轮询错误触发退避与状态抖动。
    // T2 zod 网关：normalize 产物逐条过 UnifiedMessageSchema / InboundEffectSchema
    // ——校验清洗在前（违者隔离告警、不占去重窗口），去重与入库只处理清洁产物。
    const pending: Array<{ m: NormalizedMessage; key: string }> = [];
    for (const m0 of inbound.messages) {
      m0.botId = raw.botId;
      const parsed = UnifiedMessageSchema.safeParse(m0);
      if (!parsed.success) {
        deps.log.warn(t("ingest_shape_fail", {
          platform,
          id: typeof m0.msgId === "string" ? m0.msgId : "?",
          reason: formatZodIssues(parsed.error, "message"),
        }));
        continue; // 违规隔离：不入库、不去重标记，重拉同批时再次可观测
      }
      const m = parsed.data;
      const key = `${m.botId}:${m.scope}:${m.scopeId}:${m.msgId}`;
      if (!dedup.isNew(key)) {
        deps.log.warn(t("gw_event_dedup", { type: "message", id: m.msgId }));
        continue;
      }
      pending.push({ m, key });
    }
    const effects: InboundEffect[] = [];
    for (const fx0 of inbound.effects) {
      const parsed = InboundEffectSchema.safeParse(fx0);
      if (!parsed.success) {
        deps.log.warn(t("ingest_effect_shape_fail", {
          platform,
          reason: formatZodIssues(parsed.error, "effect"),
        }));
        continue;
      }
      effects.push(parsed.data);
    }
    deps.tap?.({
      messages: pending.map((p) => p.m),
      effects,
    });
    for (const { m, key } of pending) {
      try {
        deps.repo.saveMessage(m);
      } catch (e) {
        deps.log.warn(t("ingest_save_fail", {
          platform,
          id: m.msgId,
          reason: shortReason(e),
        }));
        continue; // 未标记去重：重拉同批时本条仍有机会重新入库
      }
      dedup.mark(key);
    }
    for (const fx of effects) {
      try {
        applyEffect(deps.repo, raw.botId, fx);
      } catch (e) {
        deps.log.warn(t("ingest_effect_fail", {
          platform,
          kind: fx.kind,
          reason: shortReason(e),
        }));
      }
    }
  };
}

/** 告警用错误摘要：截断防日志膨胀；不含消息正文（log_content 纪律） */
function shortReason(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
