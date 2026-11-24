// 插件声明面工厂：webuiRoute / webuiJsonRoute / pluginTool。
//
// 异构声明（每条路由/每个工具的 body·args 类型各不相同）与统一分发点（core
// 只见原始 JSON 文本）之间的类型矛盾，用「泛型在工厂闭包内绑定」化解：A 由
// bodySchema/argsSchema 推断，运行时闭包携带 schema 与 handler；统一接口上 A
// 不可见，core 不经手任何具体 body/args 类型。
//
// 无请求体路由用 webuiRoute（body 恒 undefined）；带请求体路由用
// webuiJsonRoute（bodySchema 必备，解析产物 = handler 的 req.body）。

import type { z } from "zod";
import type {
  JsonSchema,
  PluginToolCtx,
  PluginToolDecl,
  PluginWebuiRequest,
  PluginWebuiRoute,
  ToolPayload,
  WebuiMethod,
  WebuiRouteOut,
} from "./types";
import { ConnectorError } from "./types";
import { formatZodIssues } from "./message";

/** 无请求体的 webui 路由：handler 的 req.body 恒 undefined */
export function webuiRoute(decl: {
  method: WebuiMethod;
  path: string;
  summary?: string;
  handler(req: PluginWebuiRequest<undefined>): Promise<WebuiRouteOut>;
}): PluginWebuiRoute {
  return {
    method: decl.method,
    path: decl.path,
    ...(decl.summary !== undefined ? { summary: decl.summary } : {}),
    handle: (input) =>
      decl.handler({
        method: decl.method,
        path: input.path,
        params: input.params,
        query: input.query,
        body: undefined,
        configOf: input.configOf,
        stateOf: input.stateOf,
      }),
  };
}

/**
 * 带请求体的 webui 路由：core 代理点喂 PluginWebuiInput（原始 JSON 文本），
 * 本闭包完成 bodySchema 解析（形状违规 → ConnectorError(400)，core mapError
 * 直达浏览器）并以解析产物（A）调 handler。坏 JSON / 缺 body 统一进 schema
 * 校验（JSON.parse(null)→null 不合对象形状）。
 */
export function webuiJsonRoute<A>(decl: {
  method: WebuiMethod;
  path: string;
  summary?: string;
  /** 请求体 wire schema（zod）：解析产物 = handler 的 req.body（A） */
  bodySchema: z.ZodType<A>;
  handler(req: PluginWebuiRequest<A>): Promise<WebuiRouteOut>;
}): PluginWebuiRoute {
  return {
    method: decl.method,
    path: decl.path,
    ...(decl.summary !== undefined ? { summary: decl.summary } : {}),
    handle: async (input) => {
      const gate = decl.bodySchema.safeParse(JSON.parse(input.rawBody ?? "null"));
      if (!gate.success) {
        throw new ConnectorError(formatZodIssues(gate.error, "请求体"), 400);
      }
      return decl.handler({
        method: decl.method,
        path: input.path,
        params: input.params,
        query: input.query,
        body: gate.data,
        configOf: input.configOf,
        stateOf: input.stateOf,
      });
    },
  };
}

/**
 * 插件工具工厂：core 分发点喂 MCP arguments 的 JSON 文本（无参调用 undefined），
 * 本闭包完成 argsSchema 解析（形状违规 → isError 可操作文案，与插件 run 内
 * 抛错同路规范化）并以解析产物（A）调 run。
 */
export function pluginTool<A>(decl: {
  name: string;
  description: string;
  /** MCP 协议面对外声明（listTools 下发） */
  inputSchema: JsonSchema;
  /** 入参 wire schema（zod）：解析产物 = run 的 args（A） */
  argsSchema: z.ZodType<A>;
  run(args: A, ctx: PluginToolCtx): Promise<ToolPayload>;
}): PluginToolDecl {
  return {
    name: decl.name,
    description: decl.description,
    inputSchema: decl.inputSchema,
    call: async (rawArgs, ctx) => {
      // 无参调用（arguments undefined）按空对象进校验——由 argsSchema 判定是否合法
      const gate = decl.argsSchema.safeParse(
        rawArgs === undefined ? {} : JSON.parse(rawArgs),
      );
      if (!gate.success) {
        return {
          content: [
            {
              type: "text",
              text: `工具 ${decl.name} 参数不合法：${formatZodIssues(gate.error, "args")}`,
            },
          ],
          isError: true,
        };
      }
      return decl.run(gate.data, ctx);
    },
  };
}
