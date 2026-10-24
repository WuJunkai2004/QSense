// 机器人注册表：QQ_APPS env 基座（权威、UI 不可移除）+ 运行时动态添加（kv 持久化，WebUI/管理面操作）。
//
// 设计决策（2026-10-24 用户拍板）：动态 bot 的 AppSecret 存 SQLite kv（键 bots:dynamic:v1），
// 换取「UI 免重启添加/移除机器人」；密钥落库面扩大已在 README 安全声明中标注。
// - 纪律：本模块不 log 任何 secret（logger 兜底剥离仅是最后防线，源头不打）；
// - 添加必过 verify（生产=TokenService 拉真 access_token，凭据错误即拒绝），未验证不入库不生效；
// - env 基座优先：动态列表与 QQ_APPS 撞 appid 时以 env 为准（load 时跳过，add 时拒绝）。

import type Database from "better-sqlite3";
import type { BotApp } from "./config";
import type { DB } from "./store/db";

/** 语句的匿名绑定参数元组类型（better-sqlite3 prepare 泛型默认值会退化为单元素元组，需显式声明） */
type Stmt<P extends unknown[] = unknown[]> = Database.Statement<P>;

const KV_KEY = "bots:dynamic:v1";

export interface BotRegistryDeps {
  /** QQ_APPS 解析出的基座 bot：来源标记 config，不可经运行时接口移除 */
  base: BotApp[];
  db: DB;
  /** 添加时的凭据校验；缺省=跳过校验（仅测试用） */
  verify?: (app: BotApp) => Promise<void>;
}

/** add 的入参校验错误：消息可操作（提示去哪核对） */
export class BotRegistryError extends Error {}

export class BotRegistry {
  private readonly dyn = new Map<string, BotApp>();
  private readonly verify: (app: BotApp) => Promise<void>;
  private readonly kvGet: Stmt<[string]>;
  private readonly kvSet: Stmt<[string, string]>;

  constructor(private readonly deps: BotRegistryDeps) {
    this.verify = deps.verify ?? (async () => {});
    this.kvGet = deps.db.prepare("SELECT v FROM kv WHERE k = ?");
    this.kvSet = deps.db.prepare(
      "INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
    this.load();
  }

  /** 启动时从 kv 恢复动态 bot；坏数据/条目残缺逐条跳过（不崩溃，env 基座优先） */
  private load(): void {
    const row = this.kvGet.get(KV_KEY) as { v: string } | undefined;
    if (row === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.v);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      const rec = item as Record<string, unknown>;
      const appid = typeof rec.appid === "string" ? rec.appid.trim() : "";
      const secret = typeof rec.secret === "string" ? rec.secret.trim() : "";
      if (appid === "" || secret === "") continue;
      if (this.deps.base.some((b) => b.appid === appid)) continue;
      const name =
        typeof rec.name === "string" && rec.name.trim() !== ""
          ? rec.name.trim()
          : appid;
      this.dyn.set(appid, { appid, secret, name });
    }
  }

  private persist(): void {
    this.kvSet.run(KV_KEY, JSON.stringify([...this.dyn.values()]));
  }

  /** 全量列表：env 基座在前、动态在后（展示顺序稳定） */
  list(): BotApp[] {
    return [...this.deps.base, ...this.dyn.values()];
  }

  get(appid: string): BotApp | undefined {
    return (
      this.deps.base.find((b) => b.appid === appid) ?? this.dyn.get(appid)
    );
  }

  /** 是否运行时动态 bot（决定 UI 能否移除） */
  isDynamic(appid: string): boolean {
    return this.dyn.has(appid);
  }

  /**
   * 添加动态 bot：参数校验 → 查重 → verify 凭据（失败不落库）→ 持久化。
   * 不负责启动连接——调用方（UI API）拿到返回值后自行触发网关接入。
   */
  async add(input: {
    appid: string;
    secret: string;
    name?: string;
  }): Promise<BotApp> {
    const appid = input.appid.trim();
    const secret = input.secret.trim();
    const name = input.name?.trim() || appid;
    if (appid === "" || secret === "") {
      throw new BotRegistryError(
        "参数无效：appid 与 secret 均不能为空（appid 在 q.qq.com 开发设置，secret 为对应 AppSecret）。",
      );
    }
    if (this.get(appid) !== undefined) {
      throw new BotRegistryError(
        `添加失败：appid=${appid} 已注册（QQ_APPS 配置或运行时列表），请勿重复添加。`,
      );
    }
    const app: BotApp = { appid, secret, name };
    try {
      await this.verify(app);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new BotRegistryError(
        `凭据校验失败：官方 token 接口拒绝（${reason}）。请核对 appid 与 AppSecret（q.qq.com → 开发设置）。`,
      );
    }
    this.dyn.set(appid, app);
    this.persist();
    return app;
  }

  /**
   * 移除动态 bot（env 基座拒绝）。不负责断连接/清会话——调用方拿到 BotApp 后自行处理。
   */
  remove(appid: string): BotApp {
    const app = this.dyn.get(appid);
    if (app === undefined) {
      throw new BotRegistryError(
        this.deps.base.some((b) => b.appid === appid)
          ? `移除失败：appid=${appid} 来自 QQ_APPS 配置，只能修改配置文件并重启来移除。`
          : `移除失败：appid=${appid} 不在运行时列表中。`,
      );
    }
    this.dyn.delete(appid);
    this.persist();
    return app;
  }
}
