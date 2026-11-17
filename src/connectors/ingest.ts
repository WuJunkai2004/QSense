// core ingest 管线（P5 契约 v2 表驱动，2026-11-17）：connector 实例经 host.ingest
// 上行的信封按 payload.platform 路由到对应插件 normalize（解读权在插件，决策 #8）
// → 通用消息级去重 → repo 入库/效应落地。core 对平台零硬编码——第三方插件零
// core 改动进场；历史上的 isTelegramPayload / unwrapQqPayload / 平台 handler
// 分支已随 parser 下沉退役。
//
// 效应（InboundEffect）是平台语义到 core 中立词汇表的翻译：群注册表/开关/审核
// 回执由 core 按 repo 语义落地；botId 以信封为权威盖章（防插件填错 bot 跨 bot 污染）。

import type {
  ConnectorRegistry,
  InboundEffect,
  NormalizedMessage,
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

    // botId 以信封为权威（成品消息逐条盖章）；消息级去重先行
    const messages: NormalizedMessage[] = [];
    for (const m of inbound.messages) {
      m.botId = raw.botId;
      const key = `${m.botId}:${m.scope}:${m.scopeId}:${m.msgId}`;
      if (!dedup.isNew(key)) {
        deps.log.warn(t("gw_event_dedup", { type: "message", id: m.msgId }));
        continue;
      }
      messages.push(m);
    }
    deps.tap?.({ messages, effects: inbound.effects });
    for (const m of messages) deps.repo.saveMessage(m);
    for (const fx of inbound.effects) applyEffect(deps.repo, raw.botId, fx);
  };
}
