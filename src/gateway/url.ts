// GET /gateway 取 WebSocket 接入点（官方出站 wss 地址，无需公网IP/域名/TLS）。

import { t } from "../i18n";

export const QQ_API_BASE = "https://api.bot.qq.com";

export async function fetchGatewayUrl(accessToken: string, base: string = QQ_API_BASE): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base}/gateway`, {
      headers: { Authorization: `QQBot ${accessToken}` },
    });
  } catch (e) {
    throw new Error(
      t("gw_url_fail", { status: "network", reason: e instanceof Error ? e.message : String(e) }),
    );
  }
  const body = (await res.json().catch(() => null)) as { url?: string } | null;
  if (!res.ok || typeof body?.url !== "string" || body.url === "") {
    const reason = body ? JSON.stringify(body).slice(0, 200) : "empty body";
    throw new Error(t("gw_url_fail", { status: res.status, reason }));
  }
  return body.url;
}
