// access_token 生命周期管理（封装官方 SDK TokenManager：缓存 + 单飞 + 后台提前刷新）。
// 已核实事实（API-FACTS.md #6）：POST /app/getAppAccessToken，有效期 7200s，
// 有效期内重复获取幂等；过期前 60s 窗内获取返回新 token；业务错误在 body.code（HTTP 恒 200）。

import { TokenManager } from "@tencent-connect/qqbot-nodejs/protocol";
import type { BotApp } from "../config";
import type { Logger } from "../logger";

export class TokenService {
  private readonly manager: TokenManager;

  constructor(log: Logger, baseUrl?: string) {
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

  getAccessToken(app: BotApp): Promise<string> {
    return this.manager.getAccessToken(app.appid, app.secret);
  }

  /** 4004 token 失效时由网关连接回调，清掉本地缓存强制重新获取 */
  clear(app: BotApp): void {
    this.manager.clearCache(app.appid);
  }

  /** 启动后台提前刷新循环（与连接解耦，token 常备有效） */
  startBackground(app: BotApp): void {
    this.manager.startBackgroundRefresh(app.appid, app.secret);
  }

  stopAll(): void {
    this.manager.stopBackgroundRefresh();
  }
}
