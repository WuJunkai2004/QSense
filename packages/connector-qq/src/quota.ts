// QQ 额度语义（插件自有）：令牌桶（bot 级 + 单关系）、日额度记账、水位快照。
// 自 core/sender 迁入（P1 QQ 收口手术，2026-11-15）；记账从 repo quota_daily 表
// 改为 StatePort JSON 计数器（core 表结构空转保留，P3 统一处置）。
//
// 官方限制常量：单关系（每群）主动消息 20 条/分钟、1000 条/天；bot 级 qpm 按认证档位
// （certified=60 / uncertified=30，limits.qpm 显式注入时覆盖——测试用）。

import type {
  BotConfigSnapshot,
  PluginHookCtx,
  ProactiveVerdict,
  StatePort,
} from "@qsense/connector-sdk";
import { tt } from "./texts";

export const PER_RELATION_QPM = 20;
export const PER_GROUP_DAILY = 1000;

export interface QqSendLimits {
  /** bot 级主动消息条/分钟：认证 60 / 未认证 30（config.authLevel 决定默认值） */
  qpm: number;
  perRelationQpm: number;
  perGroupDaily: number;
}

/** 额度日期串：官方 1000 条/天按北京时间自然日计 */
export function beijingDate(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
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

// —— 日额度（StatePort JSON 计数器；键按北京时间自然日） ——

const quotaKey = (date: string): string => `qq:quota:${date}`;

interface DailyStore {
  targets: Record<string, number>;
}

async function readStore(state: StatePort, date: string): Promise<DailyStore> {
  return (await state.get<DailyStore>(quotaKey(date))) ?? { targets: {} };
}

/** 单关系当日已发（原 repo.proactiveCountFor 语义） */
export async function dailyCountOf(
  state: StatePort,
  date: string,
  target: string,
): Promise<number> {
  const store = await readStore(state, date);
  return store.targets[target] ?? 0;
}

/** 当日已发合计（原 repo.proactiveSentToday 语义） */
export async function dailyTotalOf(
  state: StatePort,
  date: string,
): Promise<number> {
  const store = await readStore(state, date);
  return Object.values(store.targets).reduce((a, b) => a + b, 0);
}

async function incrDaily(
  state: StatePort,
  date: string,
  target: string,
): Promise<void> {
  const store = await readStore(state, date);
  store.targets[target] = (store.targets[target] ?? 0) + 1;
  await state.set(quotaKey(date), store);
}

// —— 额度模块（门禁 + 记账 + 快照） ——

export interface QuotaSnapshot {
  limits: QqSendLimits;
  bot_bucket_remaining: number;
  today_by_group: Array<{ group: string; used: number }>;
  relation_remaining: Record<string, number>;
}

export interface QuotaModule {
  /** 原始限额配置（qpm=0 表示按认证档位现算；快照按旧形状原样透出） */
  readonly limits: QqSendLimits;
  /** bot 级 qpm 预算（certified=60 / uncertified=30；limits.qpm 注入时覆盖） */
  qpmOf(config: BotConfigSnapshot): number;
  /** 主动发送门禁：日额度 → bot 级令牌桶 → 单关系令牌桶（顺序与旧实现一致） */
  gate(ctx: PluginHookCtx, botId: string, target: string): Promise<ProactiveVerdict>;
  /** 主动发送受理成功（sent/pending_audit）后记账 +1（core 会 await，保证先记后查一致） */
  record(ctx: PluginHookCtx, botId: string, target: string): Promise<void>;
  /** 水位快照（quota 工具 / WebUI /quota 共用；形状与旧 Sender.snapshot 一致） */
  snapshot(
    botId: string,
    config: BotConfigSnapshot,
    state: StatePort,
  ): Promise<QuotaSnapshot>;
}

export function createQuota(limitsOverride?: Partial<QqSendLimits>): QuotaModule {
  const limits: QqSendLimits = {
    qpm: limitsOverride?.qpm ?? 0, // 0=按 bot 的 authLevel 现算（60/30）
    perRelationQpm: limitsOverride?.perRelationQpm ?? PER_RELATION_QPM,
    perGroupDaily: limitsOverride?.perGroupDaily ?? PER_GROUP_DAILY,
  };
  const botBuckets = new Map<string, TokenBucket>();
  const relationBuckets = new Map<string, TokenBucket>();

  const qpmOf = (config: BotConfigSnapshot): number => {
    if (limits.qpm > 0) return limits.qpm;
    return config.authLevel === "certified" ? 60 : 30;
  };

  const botBucket = (botId: string, config: BotConfigSnapshot): TokenBucket => {
    let b = botBuckets.get(botId);
    if (b === undefined) {
      const qpm = qpmOf(config);
      b = new TokenBucket(qpm, qpm);
      botBuckets.set(botId, b);
    }
    return b;
  };

  const relationBucket = (botId: string, target: string): TokenBucket => {
    const key = `${botId}:${target}`;
    let b = relationBuckets.get(key);
    if (b === undefined) {
      b = new TokenBucket(limits.perRelationQpm, limits.perRelationQpm);
      relationBuckets.set(key, b);
    }
    return b;
  };

  const waitOf = (r: { ok: boolean; waitMs: number }): number =>
    Math.max(1, Math.ceil(r.waitMs / 1000));

  return {
    limits,
    qpmOf,
    async gate(ctx, botId, target) {
      const date = beijingDate();
      const state = ctx.host.state;
      // 日额度（官方 1000 条/天/单关系）：先查后记，超限明确报错不重试
      const usedToday = await dailyCountOf(state, date, target);
      if (usedToday >= limits.perGroupDaily) {
        return {
          ok: false,
          reason: tt("send_quota_daily", {
            group: target,
            used: usedToday,
            limit: limits.perGroupDaily,
          }),
        };
      }
      // 令牌桶：bot 级 → 单关系级
      const botTake = botBucket(botId, ctx.config).tryTake();
      if (!botTake.ok) {
        return {
          ok: false,
          reason: tt("send_rate_limited_bot", {
            qpm: qpmOf(ctx.config),
            level: ctx.config.authLevel ?? "uncertified",
            wait: waitOf(botTake),
          }),
        };
      }
      const relTake = relationBucket(botId, target).tryTake();
      if (!relTake.ok) {
        return {
          ok: false,
          reason: tt("send_rate_limited_relation", { wait: waitOf(relTake) }),
        };
      }
      return { ok: true };
    },
    record(ctx, _botId, target) {
      // 记账（受理成功含 pending_audit，与旧 incrQuotaDaily 时机一致）；core await
      return incrDaily(ctx.host.state, beijingDate(), target);
    },
    async snapshot(botId, config, state) {
      const date = beijingDate();
      const allowGroups = config.allowGroups ?? [];
      const todayByGroup: Array<{ group: string; used: number }> = [];
      for (const g of allowGroups) {
        todayByGroup.push({ group: g, used: await dailyCountOf(state, date, g) });
      }
      const relationRemaining: Record<string, number> = {};
      for (const g of allowGroups) {
        relationRemaining[g] = relationBucket(botId, g).remaining;
      }
      return {
        limits,
        bot_bucket_remaining: botBucket(botId, config).remaining,
        today_by_group: todayByGroup,
        relation_remaining: relationRemaining,
      };
    },
  };
}
