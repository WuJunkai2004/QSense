// 宿主侧 ConnectorRegistry：插件注册表。
// P0：进程内 register（QQ 本地注册先声后形）。
// P2：loadModule(spec) 动态 import 分仓包默认导出 → validatePlugin → register。

import { validatePlugin } from "./gates";
import {
  type BotCreds,
  type ConnectorInstance,
  type ConnectorPlugin,
  type ConnectorPluginFactory,
  type PluginContext,
  type PluginModuleInit,
} from "./types";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export class ConnectorRegistry {
  private readonly plugins = new Map<string, ConnectorPlugin>();

  /** 注册（validatePlugin 全量闸门 + id 唯一）。重复 id 报可操作错误 */
  register(plugin: ConnectorPlugin): void {
    const v = validatePlugin(plugin);
    if (this.plugins.has(v.id)) {
      throw new RegistryError(`平台 ${v.id} 已注册，不得重复注册。`);
    }
    this.plugins.set(v.id, v);
  }

  get(id: string): ConnectorPlugin | undefined {
    return this.plugins.get(id);
  }

  require(id: string): ConnectorPlugin {
    const p = this.plugins.get(id);
    if (p === undefined) {
      const known = [...this.plugins.keys()].join(", ") || "（无）";
      throw new RegistryError(
        `平台 ${id} 未注册。已注册平台：${known}。请检查 connectors 声明与插件包安装。`,
      );
    }
    return p;
  }

  list(): ConnectorPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 创建实例（宿主装配用；creds.platform 必须与插件 id 一致） */
  instantiate(
    id: string,
    host: PluginContext,
    creds: BotCreds,
  ): ConnectorInstance {
    const plugin = this.require(id);
    if (creds.platform !== id) {
      throw new RegistryError(
        `凭据 platform（${creds.platform}）与目标插件（${id}）不一致。`,
      );
    }
    return plugin.create(host, creds);
  }
}

/**
 * P2 分仓加载：动态 import 插件包默认导出 → （工厂则注入 init 执行）→
 * validatePlugin（含 sdkRange 校验）→ 返回声明面。
 * 加载失败 / 非法声明 / sdkRange 不兼容都以可操作错误抛出。
 */
export async function loadModule(
  spec: string,
  init?: PluginModuleInit,
): Promise<ConnectorPlugin> {
  let mod: unknown;
  try {
    mod = await import(/* webpackIgnore: true */ spec);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new RegistryError(
      `connector 包加载失败：${spec}（${reason.slice(0, 200)}）。请确认包已安装且导出合法。`,
    );
  }
  const rec = mod as { default?: unknown } | null;
  const def = rec !== null && typeof rec === "object" ? rec.default : undefined;
  if (def === undefined) {
    throw new RegistryError(
      `connector 包 ${spec} 缺少默认导出（ConnectorPlugin 声明或工厂）。`,
    );
  }
  // 工厂形态（推荐）：宿主注入 init（log 等）；执行失败同样可操作报错
  let candidate: unknown = def;
  if (typeof def === "function") {
    try {
      candidate = await (def as ConnectorPluginFactory)(init);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new RegistryError(
        `connector 包 ${spec} 默认导出工厂执行失败：${reason.slice(0, 200)}。`,
      );
    }
  }
  if (candidate === null || typeof candidate !== "object") {
    throw new RegistryError(
      `connector 包 ${spec} 默认导出不是合法的插件声明（对象或返回对象的工厂）。`,
    );
  }
  return validatePlugin(candidate);
}
