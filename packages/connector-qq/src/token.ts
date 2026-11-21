// access_token 生命周期管理（封装官方 SDK TokenManager：缓存 + 单飞 + 后台提前刷新）。
// 自 core/gateway/token.ts 原样迁入（P1 QQ 收口手术，2026-11-15）。
// 已核实事实（见 AGENTS.md「QQ 官方 API 关键事实」）：POST /app/getAppAccessToken，有效期 7200s，
// 有效期内重复获取幂等；过期前 60s 窗内获取返回新 token；业务错误在 body.code（HTTP 恒 200）。

import { TokenManager } from "@tencent-connect/qqbot-nodejs/protocol";
import type { ConnectorLogger } from "@qsense/connector-sdk";

/** QQ 凭据形状（bots 表列投影；P3 起由 BotCreds.credential JSON 承载） */
export interface QqApp {
  appid: string;
  secret: string;
  name?: string;
}

export class TokenService {
  private readonly manager: TokenManager;

  constructor(log: ConnectorLogger, baseUrl?: string) {
    this.manager = new TokenManager({
      logger: {
        info: (msg, meta) => log.debug(msg, meta),
        warn: (msg, meta) => log.warn(msg, meta),
        error: (msg, meta) => log.error(msg, meta),
        debug: (msg, meta) => log.debug(msg, meta),
      },
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
  }

  /** SDK TokenManager 实例（发送原语与网关共用同一 token 缓存） */
  get sdk(): TokenManager {
    return this.manager;
  }

  getAccessToken(app: QqApp): Promise<string> {
    return this.manager.getAccessToken(app.appid, app.secret);
  }

  /** 4004 token 失效时由网关连接回调，清掉本地缓存强制重新获取 */
  clear(app: QqApp): void {
    this.manager.clearCache(app.appid);
  }

  /** 启动后台提前刷新循环（与连接解耦，token 常备有效） */
  startBackground(app: QqApp): void {
    this.manager.startBackgroundRefresh(app.appid, app.secret);
  }

  stopAll(): void {
    this.manager.stopBackgroundRefresh();
  }
}
