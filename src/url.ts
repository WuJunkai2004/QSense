// GET /gateway 取 WebSocket 接入点（官方出站 wss 地址，无需公网IP/域名/TLS）。
// B⁺ T4.3：传输走 NetKit（HttpClient），应答 schema 参数化——盲转型清零；
// http 由调用方注入（实例=ctx.net；测试=FakeNetKit 脚本化网关地址）。

import { z } from "zod";
import type { HttpClient, HttpResponse } from "@qsense/connector-sdk";
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
  const raw: unknown = await res.json().catch(() => null);
  const parsed =
    res.status >= 200 && res.status < 300
      ? GatewayUrlSchema.safeParse(raw)
      : null;
  if (parsed !== null && parsed.success) {
    return parsed.data.url;
  }
  const reason = raw !== null ? JSON.stringify(raw).slice(0, 200) : "empty body";
  throw new Error(tt("gw_url_fail", { status: res.status, reason }));
}
