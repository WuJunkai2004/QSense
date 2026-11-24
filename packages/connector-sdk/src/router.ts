// 工具路由器：基座表（core 14）→ 插件表（平台声明扩展）的名字解析与插件侧调用。
//
// core 侧用法：MCP callTool 先 resolve(name)——base 走基座管线；
// plugin 走 callPluginTool（包装 PluginToolCtx = { host, botId }，错误规范化）。

import { GateError } from "./gates";
import {
  type ConnectorPlugin,
  type PluginToolCtx,
  type PluginToolDecl,
  type ToolPayload,
} from "./types";

export interface ToolRoute {
  source: "base" | "plugin";
  name: string;
  /** source === "plugin" 时携带 */
  plugin?: ConnectorPlugin;
  tool?: PluginToolDecl;
}

export class ToolRouter {
  private readonly base: ReadonlySet<string>;
  private readonly plugins = new Map<string, ConnectorPlugin>();

  constructor(baseNames: Iterable<string>) {
    this.base = new Set(baseNames);
  }

  /** 注册插件（调用方须已 validatePlugin；这里补跨插件工具名唯一性） */
  registerPlugin(plugin: ConnectorPlugin): void {
    for (const tool of plugin.tools ?? []) {
      if (this.base.has(tool.name)) {
        throw new GateError(
          `插件 ${plugin.id} 工具与基座保留名冲突：${tool.name}`,
        );
      }
      const owner = this.findPluginOwner(tool.name);
      if (owner !== undefined && owner.id !== plugin.id) {
        throw new GateError(
          `插件工具名跨平台冲突：${tool.name} 已由 ${owner.id} 声明（${plugin.id} 不得重复声明）。`,
        );
      }
    }
    this.plugins.set(plugin.id, plugin);
  }

  unregisterPlugin(id: string): void {
    this.plugins.delete(id);
  }

  private findPluginOwner(name: string): ConnectorPlugin | undefined {
    for (const p of this.plugins.values()) {
      if ((p.tools ?? []).some((t) => t.name === name)) return p;
    }
    return undefined;
  }

  resolve(name: string): ToolRoute | null {
    if (this.base.has(name)) return { source: "base", name };
    for (const p of this.plugins.values()) {
      const tool = (p.tools ?? []).find((t) => t.name === name);
      if (tool !== undefined) return { source: "plugin", name, plugin: p, tool };
    }
    return null;
  }

  /** 全集工具名（基座 + 已注册插件声明），排序输出（listTools 断言用） */
  names(): string[] {
    const all = new Set(this.base);
    for (const p of this.plugins.values()) {
      for (const t of p.tools ?? []) all.add(t.name);
    }
    return [...all].sort();
  }
}

// ---------------------------------------------------------------------------
// 插件工具调用：错误规范化 + 日志（敏感字段由 core logger 兜底剥离）
// ---------------------------------------------------------------------------

function errPayload(text: string): ToolPayload {
  return { content: [{ type: "text", text }], isError: true };
}

export async function callPluginTool(
  plugin: ConnectorPlugin,
  name: string,
  rawArgs: string | undefined,
  ctx: PluginToolCtx,
): Promise<ToolPayload> {
  const tool = (plugin.tools ?? []).find((t) => t.name === name);
  if (tool === undefined) {
    return errPayload(`工具 ${name} 不属于平台 ${plugin.id} 的声明扩展。`);
  }
  try {
    return await tool.call(rawArgs, ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.host.log.warn("plugin tool failed", {
      platform: plugin.id,
      tool: name,
      reason: message.slice(0, 200),
    });
    return errPayload(message);
  }
}
