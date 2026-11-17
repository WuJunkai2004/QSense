// conformance harness：各 connector 仓 CI 复用的标准测试套件。
//
// 固定检查（声明面 + 生命周期 + 宿主环境）+ 可选 probe（连接器自定义探针，
// 如注入假网关验证上行/原语行为）。报告式输出，CI 断言 report.passed === true。

import { validatePlugin } from "./gates";
import { createMemoryHost } from "./memory";
import { assertNormalizedInbound } from "./message";
import type {
  BotCreds,
  ConnectorInstance,
  ConnectorLogger,
  ConnectorPlugin,
  HostApi,
} from "./types";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  pluginId: string;
  passed: boolean;
  checks: ConformanceCheck[];
}

export interface HarnessOptions {
  /** 缺省合成 { botId: "bot-conformance", platform: plugin.id, credential: {} } */
  creds?: BotCreds;
  log?: ConnectorLogger;
  /**
   * 连接器自定义探针：在新实例 start() 之后、stop() 之前执行。
   * 用途：注入假网关 → 断言 host.ingest 收到回放载荷 / net.* 原语行为。
   * 抛错即 probe 检查失败（detail 取 message）。
   */
  probe?(host: HostApi, instance: ConnectorInstance): Promise<void>;
  /**
   * normalize 形状探针样本（契约 v2）：一份有代表性的真实载荷（如群文本消息）。
   * 提供后 harness 跑 normalize-shape 检查——normalize 产物过 assertNormalizedInbound
   * 形状断言（消息必填字段/词表/结构列形状）。connector 仓 CI 必须提供样本。
   */
  normalizeSample?: unknown;
}

function fail(checks: ConformanceCheck[], name: string, e: unknown): void {
  checks.push({
    name,
    ok: false,
    detail: e instanceof Error ? e.message : String(e),
  });
}

export async function runConformance(
  plugin: ConnectorPlugin,
  opts: HarnessOptions = {},
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const creds: BotCreds =
    opts.creds ?? {
      botId: "bot-conformance",
      platform: plugin.id,
      credential: {},
    };

  // 1. 声明面闸门（含 sdkRange 兼容、schema、保留名、webui/login 引用一致性）
  try {
    validatePlugin(plugin);
    checks.push({ name: "declaration-gates", ok: true });
  } catch (e) {
    fail(checks, "declaration-gates", e);
  }

  // 2. 生命周期：create → start → stop → 重建实例再走一遍（宿主重启语义）
  try {
    const h1 = createMemoryHost({ log: opts.log });
    const i1 = plugin.create(h1.host, creds);
    await i1.start();
    i1.stop();
    const i2 = plugin.create(h1.host, creds);
    await i2.start();
    i2.stop();
    checks.push({ name: "lifecycle", ok: true });
  } catch (e) {
    fail(checks, "lifecycle", e);
  }

  // 3. 宿主环境自证：StatePort roundtrip（验证 harness 提供的 host 实现正确）
  try {
    const h = createMemoryHost();
    await h.state.set("k", { v: 1 });
    const got = await h.state.get<{ v: number }>("k");
    if (got === null || got.v !== 1) throw new Error("state roundtrip 值不符");
    await h.state.delete("k");
    if ((await h.state.get("k")) !== null) throw new Error("state delete 未生效");
    checks.push({ name: "host-state-roundtrip", ok: true });
  } catch (e) {
    fail(checks, "host-state-roundtrip", e);
  }

  // 4. 网络原语与 caps 声明一致：
  //    passiveWindow=true → net.reply 必备；否则 net.proactive 必备。
  //    caps.recall=true → net.recall；caps.media 任一 true → net.uploadMedia。
  try {
    const h = createMemoryHost({ log: opts.log });
    const inst = plugin.create(h.host, creds);
    const missing: string[] = [];
    if (plugin.caps.passiveWindow && inst.net.reply === undefined) {
      missing.push("net.reply（caps.passiveWindow=true）");
    }
    if (!plugin.caps.passiveWindow && inst.net.proactive === undefined) {
      missing.push("net.proactive（caps.passiveWindow=false）");
    }
    if (plugin.caps.recall && inst.net.recall === undefined) {
      missing.push("net.recall（caps.recall=true）");
    }
    const hasMedia = Object.values(plugin.caps.media).some((v) => v === true);
    if (hasMedia && inst.net.uploadMedia === undefined) {
      missing.push("net.uploadMedia（caps.media 有 true 项）");
    }
    if (missing.length > 0) {
      throw new Error(`缺少网络原语：${missing.join("；")}`);
    }
    checks.push({ name: "net-primitives", ok: true });
  } catch (e) {
    fail(checks, "net-primitives", e);
  }

  // 5. normalize 形状探针（契约 v2；样本由 connector 仓 CI 提供）
  if (opts.normalizeSample !== undefined) {
    try {
      const inbound = plugin.normalize(creds.botId, opts.normalizeSample);
      if (inbound !== null) {
        assertNormalizedInbound(inbound);
      }
      checks.push({
        name: "normalize-shape",
        ok: true,
        ...(inbound === null ? { detail: "样本未产出消息（null）" } : {}),
      });
    } catch (e) {
      fail(checks, "normalize-shape", e);
    }
  }

  // 6. 连接器自定义探针（可选）
  if (opts.probe !== undefined) {
    const h = createMemoryHost({ log: opts.log });
    try {
      const inst = plugin.create(h.host, creds);
      await inst.start();
      try {
        await opts.probe(h.host, inst);
      } finally {
        inst.stop();
      }
      checks.push({ name: "probe", ok: true });
    } catch (e) {
      fail(checks, "probe", e);
    }
  }

  return {
    pluginId: plugin.id,
    passed: checks.every((c) => c.ok),
    checks,
  };
}
