// GET /gateway 取 WebSocket 接入点（官方出站 wss 地址，无需公网IP/域名/TLS）。
// B⁺ T4.3：传输走 NetKit（HttpClient），应答 schema 参数化——盲转型清零；
// http 由调用方注入（实例=ctx.net；测试=FakeNetKit 脚本化网关地址）。

import { z } from "zod";
import type { HttpClient, HttpResponse } from "@qsense/connector-sdk";
import { parseJsonWith } from "@qsense/connector-sdk";
import { tt } from "./texts";

export const QQ_API_BASE = "https://api.bot.qq.com";

const GatewayUrlSchema = z.looseObject({ url: z.string().min(1) });

export async function fetchGatewayUrl(
  http: HttpClient,
  accessToken: string,
  base: string = QQ_API_BASE,
): Promise<string> {
  let res: HttpResponse;
  try {
    res = await http.request(`${base}/gateway`, {
      headers: { Authorization: `QQBot ${accessToken}` },
    });
  } catch (e) {
    throw new Error(
      tt("gw_url_fail", {
        status: "network",
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
  }
  // 应答体 JSON 文本 → parseJsonWith（schema 把关；坏 JSON/形状不符 → null）
  const text = await res.text().catch(() => "");
  const url =
    res.status >= 200 && res.status < 300
      ? parseJsonWith(GatewayUrlSchema, text)?.url
      : undefined;
  if (url !== undefined && url !== "") {
    return url;
  }
  const reason = text !== "" ? text.slice(0, 200) : "empty body";
  throw new Error(tt("gw_url_fail", { status: res.status, reason }));
}
