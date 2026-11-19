// /wait 长轮询事件端点（宿主唤醒面）。
//
// 解耦红线（2026-11-18 定案）：网关只「吐事件 + 未读快照」，绝不 spawn/拉起智能
// 体——谁消费、何时唤醒、用什么调度器，全部是宿主侧的事。消费侧拿到事件后仍经
// MCP get_new 按水位消费（拉取即已读，at-most-once），/wait 只决定「何时去查」，
// 与 10 分钟定时兜底天然共存（双醒时第二棒看到 unread=0 空转退出，代价极低）。
//
// 发布侧：core ingest 管线 tap（去重后入库前）逐条 publish；本机外发补记
// （direction=1）不是事件。防抖按 (bot, session) 聚合（碎碎念连发等这口气发完），
// 未读快照在唤醒时刻现查（与水位天然一致）。
//
// 长轮询语义：hold 内有命中 → 返回事件 + 未读快照；到点无命中 → {timeout:true}。
// hold 期间服务端定期写空白字节保活（NAT/代理空闲计时器 + 静默断链即时察觉）；
// JSON 前导空白合法，消费端解析不受影响。

import type { Logger } from "../utils/logger";
import type { Repo } from "../store/repo";

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

type WaitScope = "group" | "chat";

/** 会话事实投影（发布侧从 NormalizedMessage 提取；匹配只用这些字段） */
export interface WaitFacts {
  botId: string;
  scope: WaitScope;
  /** 会话 id（私聊=对方 openid，群=群 openid，同 list_all 的 conversations[].id） */
  scopeId: string;
  /** @本bot 权威判定（契约 v2.1 atMe；undefined=平台无法权威判定） */
  atMe: boolean | undefined;
  /** 消息含 @ 实体数（mention 从宽兜底用） */
  mentionCount: number;
  /** 作者 openid（authors 过滤用） */
  authorOpenid: string;
}

/** 过滤器（四谓词；跨字段 AND、数组内 OR） */
export interface WaitFilter {
  scope?: WaitScope;
  sessions?: string[];
  authors?: string[];
  mention?: boolean;
}

/** 请求体（DNF：filter 为单个对象或对象数组，数组=跨对象 OR） */
export interface WaitBody {
  filter: WaitFilter[];
  /** hold 秒数（1-600，缺省 30） */
  hold: number;
}

/** 唤醒响应（timeout=true 时 events/unread 为空数组） */
export interface WaitResponse {
  timeout: boolean;
  events: Array<{ id: string; scope: WaitScope }>;
  unread: Array<{
    id: string;
    scope: WaitScope;
    unread: number;
    last_ts: number | null;
  }>;
}

const TIMEOUT_RESPONSE: WaitResponse = { timeout: true, events: [], unread: [] };
export { TIMEOUT_RESPONSE };

// ---------------------------------------------------------------------------
// 校验（未知键硬拒——与 config/decl 同哲学；错误消息可操作）
// ---------------------------------------------------------------------------

const FILTER_KEYS = new Set(["scope", "sessions", "authors", "mention"]);
const MAX_FILTER_TERMS = 10;
const MAX_ID_LIST = 50;
const HOLD_DEFAULT_S = 30;
const HOLD_MAX_S = 600;

function assertObject(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${label}：必须是对象`);
  }
  return v as Record<string, unknown>;
}

function idArrayOf(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`${label}：必须是非空字符串数组`);
  }
  if (v.length > MAX_ID_LIST) {
    throw new Error(`${label}：最多 ${MAX_ID_LIST} 个`);
  }
  for (const item of v) {
    if (typeof item !== "string" || item === "") {
      throw new Error(`${label}：必须是非空字符串数组`);
    }
  }
  return v as string[];
}

function validateFilterTerm(raw: unknown, label: string): WaitFilter {
  const obj = assertObject(raw, label);
  const unknown = Object.keys(obj).filter((k) => !FILTER_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `${label}：未知字段 ${unknown.join("/")}（可用 scope/sessions/authors/mention）`,
    );
  }
  const scope = obj["scope"];
  if (scope !== undefined && scope !== "group" && scope !== "chat") {
    throw new Error(`${label}.scope：必须是 "group" | "chat"`);
  }
  const sessions = obj["sessions"];
  const authors = obj["authors"];
  const mention = obj["mention"];
  if (mention !== undefined && typeof mention !== "boolean") {
    throw new Error(`${label}.mention：必须是布尔`);
  }
  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(sessions !== undefined
      ? { sessions: idArrayOf(sessions, `${label}.sessions`) }
      : {}),
    ...(authors !== undefined
      ? { authors: idArrayOf(authors, `${label}.authors`) }
      : {}),
    ...(mention !== undefined ? { mention } : {}),
  };
}

/** 请求体校验：缺省 {} = all + hold 30s；非法即抛错（路由转 400） */
export function validateWaitBody(raw: unknown): WaitBody {
  const body =
    raw === undefined || raw === null ? {} : assertObject(raw, "请求体");
  const unknown = Object.keys(body).filter((k) => k !== "filter" && k !== "hold");
  if (unknown.length > 0) {
    throw new Error(`请求体：未知字段 ${unknown.join("/")}（可用 filter/hold）`);
  }
  let filter: WaitFilter[];
  const rawFilter = body["filter"];
  if (rawFilter === undefined) {
    filter = [{}]; // all
  } else if (Array.isArray(rawFilter)) {
    if (rawFilter.length === 0 || rawFilter.length > MAX_FILTER_TERMS) {
      throw new Error(`请求体.filter：数组长度须在 1-${MAX_FILTER_TERMS}`);
    }
    filter = rawFilter.map((t, i) => validateFilterTerm(t, `请求体.filter[${i}]`));
  } else {
    filter = [validateFilterTerm(rawFilter, "请求体.filter")];
  }
  let hold = HOLD_DEFAULT_S;
  const rawHold = body["hold"];
  if (rawHold !== undefined) {
    if (
      typeof rawHold !== "number" ||
      !Number.isInteger(rawHold) ||
      rawHold < 1 ||
      rawHold > HOLD_MAX_S
    ) {
      throw new Error(
        `请求体.hold：整数秒 1-${HOLD_MAX_S}（缺省 ${HOLD_DEFAULT_S}）`,
      );
    }
    hold = rawHold;
  }
  return { filter, hold };
}

// ---------------------------------------------------------------------------
// 匹配：跨字段 AND、数组内 OR、filter 数组=跨对象 OR；
// mention 语义 = 私聊 或 群@本bot（QQ 经官方 mentions[].is_you 权威判定，几乎
// 总有 true/false；仅官方未带 mentions 时未知——未知且含@ 从宽兜底，不漏叫醒优先）
// ---------------------------------------------------------------------------

export function matchFacts(facts: WaitFacts, filters: WaitFilter[]): boolean {
  return filters.some((f) => matchTerm(facts, f));
}

function matchTerm(facts: WaitFacts, f: WaitFilter): boolean {
  if (f.scope !== undefined && facts.scope !== f.scope) return false;
  if (f.sessions !== undefined && !f.sessions.includes(facts.scopeId)) {
    return false;
  }
  if (f.authors !== undefined && !f.authors.includes(facts.authorOpenid)) {
    return false;
  }
  if (f.mention === true) {
    const addressed =
      facts.scope === "chat" ||
      facts.atMe === true ||
      (facts.atMe === undefined && facts.mentionCount > 0);
    if (!addressed) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// WaitHub：事件防抖聚合 + waiter 注册表
// ---------------------------------------------------------------------------

interface Waiter {
  botId: string;
  filters: WaitFilter[];
  resolve: (r: WaitResponse) => void;
  settled: boolean;
  timer: NodeJS.Timeout;
}

interface BucketEntry {
  scope: WaitScope;
  scopeId: string;
  /** 同会话窗口内聚合：任一条 atMe=true 即 true；混合 true/false 取 true；
   *  全 undefined 保持 undefined（未知从宽语义不被窗口内其他消息污染成 false） */
  atMe: boolean | undefined;
  mentionCount: number;
  authors: Set<string>;
  timer: NodeJS.Timeout;
}

const DEBOUNCE_MS_DEFAULT = 2500;
const MAX_WAITERS_PER_BOT = 4;

/** 每 bot 并发 waiter 超上限（路由转 429） */
export class WaitCapError extends Error {
  constructor(botId: string, cap: number) {
    super(`waiter 并发超上限（${cap}）：请复用挂起的请求或先等它们返回。bot=${botId}`);
  }
}

export interface WaitHubDeps {
  repo: Repo;
  log: Logger;
  /** 测试注入：防抖窗口（缺省 2500ms） */
  debounceMs?: number;
  /** 每 bot 并发 waiter 上限（缺省 4） */
  maxWaitersPerBot?: number;
}

export class WaitHub {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly buckets = new Map<string, Map<string, BucketEntry>>();
  private readonly debounceMs: number;
  private readonly cap: number;

  constructor(private readonly deps: WaitHubDeps) {
    this.debounceMs = deps.debounceMs ?? DEBOUNCE_MS_DEFAULT;
    this.cap = deps.maxWaitersPerBot ?? MAX_WAITERS_PER_BOT;
  }

  /** ingest tap 发布点：同 (bot, session) 防抖聚合，窗口到点统一唤醒 */
  publish(facts: WaitFacts): void {
    const key = `${facts.scope}:${facts.scopeId}`;
    let bucket = this.buckets.get(facts.botId);
    if (bucket === undefined) {
      bucket = new Map();
      this.buckets.set(facts.botId, bucket);
    }
    const existing = bucket.get(key);
    if (existing !== undefined) {
      existing.atMe =
        existing.atMe === true || facts.atMe === true
          ? true
          : existing.atMe === undefined || facts.atMe === undefined
            ? undefined
            : false;
      existing.mentionCount = Math.max(existing.mentionCount, facts.mentionCount);
      existing.authors.add(facts.authorOpenid);
      return;
    }
    const entry: BucketEntry = {
      scope: facts.scope,
      scopeId: facts.scopeId,
      atMe: facts.atMe,
      mentionCount: facts.mentionCount,
      authors: new Set([facts.authorOpenid]),
      timer: setTimeout(() => this.fire(facts.botId, key), this.debounceMs),
    };
    entry.timer.unref?.();
    bucket.set(key, entry);
  }

  /** 窗口到点：对每个 waiter 求匹配，命中即唤醒（带未读快照，唤醒时刻现查） */
  private fire(botId: string, key: string): void {
    const bucket = this.buckets.get(botId);
    const entry = bucket?.get(key);
    if (bucket === undefined || entry === undefined) return;
    bucket.delete(key);
    const pending = this.waiters.get(botId);
    if (pending === undefined || pending.size === 0) return;
    const facts: WaitFacts = {
      botId,
      scope: entry.scope,
      scopeId: entry.scopeId,
      atMe: entry.atMe,
      mentionCount: entry.mentionCount,
      authorOpenid: "",
    };
    // 命中的 waiter 收集出来后再查快照（没人命中不碰 repo）；authors 过滤按
    // 窗口内任一作者命中即算
    const woken: Waiter[] = [];
    for (const waiter of pending) {
      const authors = waiter.filters.some((f) => f.authors !== undefined);
      const hit = authors
        ? [...entry.authors].some((author) =>
            waiter.filters.some((f) =>
              matchTerm({ ...facts, authorOpenid: author }, f),
            ),
          )
        : waiter.filters.some((f) => matchTerm(facts, f));
      if (hit) woken.push(waiter);
    }
    if (woken.length === 0) return;
    const events = [{ id: entry.scopeId, scope: entry.scope }];
    const unread = this.snapshot(botId);
    for (const waiter of woken) {
      this.settle(waiter, { timeout: false, events, unread });
    }
  }

  /** 未读快照（list_new 同源查询）：仅未读>0 的会话，id 对齐 conversations[].id */
  private snapshot(botId: string): WaitResponse["unread"] {
    return this.deps.repo
      .listConversations(botId)
      .filter((c) => c.unread > 0)
      .map((c) => ({
        id: c.scopeId,
        scope: c.scope,
        unread: c.unread,
        last_ts: c.last_ts,
      }));
  }

  private settle(waiter: Waiter, response: WaitResponse): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const set = this.waiters.get(waiter.botId);
    if (set !== undefined) {
      set.delete(waiter);
      if (set.size === 0) this.waiters.delete(waiter.botId);
    }
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }

  /**
   * 挂起一个 waiter：hold 到点无命中返回 {timeout:true}；返回 cancel 供客户端
   * 断连时清理（对端 FIN/RST → 路由 res.close → cancel，waiter 不泄漏）。
   */
  wait(
    botId: string,
    filters: WaitFilter[],
    holdMs: number,
  ): { done: Promise<WaitResponse>; cancel: () => void } {
    let set = this.waiters.get(botId);
    if (set === undefined) {
      set = new Set();
      this.waiters.set(botId, set);
    }
    if (set.size >= this.cap) {
      throw new WaitCapError(botId, this.cap);
    }
    let timer: NodeJS.Timeout | undefined;
    const waiter = {} as Waiter;
    waiter.botId = botId;
    waiter.filters = filters;
    waiter.settled = false;
    const done = new Promise<WaitResponse>((resolve) => {
      waiter.resolve = resolve;
      timer = setTimeout(() => this.settle(waiter, TIMEOUT_RESPONSE), holdMs);
      waiter.timer = timer;
      timer.unref?.();
    });
    set.add(waiter);
    return {
      done,
      cancel: () => this.settle(waiter, TIMEOUT_RESPONSE),
    };
  }

  /** 每 bot 当前挂起数（测试断言用） */
  waiterCountOf(botId: string): number {
    return this.waiters.get(botId)?.size ?? 0;
  }

  /** 关停（服务 onClose）：全部立即按超时结算，防挂死连接与泄漏定时器 */
  abortAll(): void {
    const count = this.waiterCount();
    for (const set of [...this.waiters.values()]) {
      for (const waiter of [...set]) {
        this.settle(waiter, TIMEOUT_RESPONSE);
      }
    }
    for (const bucket of this.buckets.values()) {
      for (const entry of bucket.values()) clearTimeout(entry.timer);
      bucket.clear();
    }
    this.buckets.clear();
    if (count > 0) {
      this.deps.log.debug("wait hub aborted", { waiters: count });
    }
  }

  /** 全量挂起数（关停日志用） */
  private waiterCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }
}
