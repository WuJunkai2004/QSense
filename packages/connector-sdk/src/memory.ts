// 内存实现：StatePort / HostApi —— 供 harness 与各 connector 测试使用。
// 生产实现（SQLite kv 落盘）在宿主侧，不在此包。

import type { NetKit } from "./net";
import { createNetKit } from "./net";
import type {
  ConnectorLogger,
  ConnectorStatus,
  PluginContext,
  RawEnvelope,
  RawInbound,
  StatePort,
} from "./types";

export class MemoryStatePort implements StatePort {
  /** 值 = JSON 文本（与生产 StatePort 契约一致） */
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }

  async set(key: string, value: string): Promise<void> {
    // 模拟宿主持持久化纪律：只收 JSON 文本（坏文本在消费方 schema 解析时暴露）
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

export function noopLogger(scope = "sdk"): ConnectorLogger {
  const noop = (): void => undefined;
  const logger: ConnectorLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: (childScope: string) => noopLogger(`${scope}:${childScope}`),
  };
  return logger;
}

export interface MemoryHostHandle {
  /** 宿主注入面 v3：HostApi + net（缺省真 NetKit；测试可注入 FakeNetKit） */
  host: PluginContext;
  /** 经 ingest 上行的原始载荷（顺序记录） */
  ingested: RawInbound[];
  /** 生命周期状态上报（顺序记录） */
  statuses: ConnectorStatus[];
  state: MemoryStatePort;
}

export function createMemoryHost(opts?: {
  log?: ConnectorLogger;
  botId?: string;
  onIngest?: (e: RawInbound) => void;
  /** 缺省真 NetKit；连接器测试注入 FakeNetKit 驱动假端点 */
  net?: NetKit;
}): MemoryHostHandle {
  const ingested: RawInbound[] = [];
  const statuses: ConnectorStatus[] = [];
  const state = new MemoryStatePort();
  const log = opts?.log ?? noopLogger();
  const host: PluginContext = {
    log,
    state,
    ingest<P extends RawEnvelope>(e: RawInbound<P>): void {
      ingested.push({
        ...e,
        botId: e.botId ?? opts?.botId ?? "bot-memory",
        receivedAt: e.receivedAt ?? Date.now(),
      });
      opts?.onIngest?.(e);
    },
    reportStatus(s: ConnectorStatus): void {
      statuses.push(s);
    },
    net: opts?.net ?? createNetKit(),
  };
  return { host, ingested, statuses, state };
}
