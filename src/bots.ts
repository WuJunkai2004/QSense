// 机器人注册表：SQLite bots 表是唯一权威存储（2026-10-25 用户定案）。
//
// 演进：M7 = QQ_APPS env 基座 + kv 动态列表；M8 起 .env 退化为「首次播种源」——
// BotRegistry 构造时把 env QQ_APPS 与旧 kv bots:dynamic:v1 幂等灌入 bots 表
// （INSERT OR IGNORE，已有行不覆盖），此后运行时读写全部走表，旧 kv 键删除。
//
// - 每个 bot 一个 agent_token（明文落库，用户拍板不做加密）：/mcp Bearer 按表反查绑定 bot；
//   轮换后旧 token 立即失效，新值只返回一次，由调用方（智能体/WebUI）自行保存。
// - 每 bot 独立发送白名单 allow_groups（与「一个 token 一个 bot」的权限域一致）。
// - 纪律：本模块不 log 任何 secret/token（logger 兜底剥离仅是最后防线，源头不打）；
// - add 必过 verify（生产=TokenService 拉真 access_token + 网关地址探测），未验证不入库。

import { randomBytes } from "node:crypto";
import type { BotApp } from "./config";
import type { DB } from "./store/db";

const LEGACY_KV_KEY = "bots:dynamic:v1";

export interface BotRegistryDeps {
  db: DB;
  /** 首次播种源：env QQ_APPS + 启动时全局白名单（仅补缺行，幂等） */
  seed: {
    apps: BotApp[];
    /** 播种 bot 的初始发送白名单（沿用旧全局 ALLOW_GROUPS 语义） */
    allowGroups: string[];
  };
  /** 添加时的凭据校验；缺省=跳过校验（仅测试用） */
  verify?: (app: BotApp) => Promise<void>;
}

/** add/remove/rotate 的校验错误：消息可操作（提示去哪核对） */
export class BotRegistryError extends Error {}

export interface RegisteredBot {
  app: BotApp;
  /** 明文 agent token：仅在注册/轮换返回中出现一次，调用方必须立即保存 */
  agentToken: string;
}

interface BotRow {
  appid: string;
  name: string;
  secret: string;
  allow_groups: string;
}

function parseAllowGroups(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is string => typeof g === "string" && g !== "");
  } catch {
    return []; // 坏数据按空白名单处理（安全默认：不发）
  }
}

function rowToApp(row: Pick<BotRow, "appid" | "name" | "secret">): BotApp {
  return { appid: row.appid, secret: row.secret, name: row.name };
}

export class BotRegistry {
  private readonly verify: (app: BotApp) => Promise<void>;
  private readonly seedAllowGroups: string[];

  constructor(private readonly deps: BotRegistryDeps) {
    this.verify = deps.verify ?? (async () => {});
    this.seedAllowGroups = deps.seed.allowGroups;
    this.migrateLegacyKv();
    this.seedFromEnv();
  }

  // —— 播种（构造期一次性，幂等） ——

  /** 旧 kv 动态列表 → bots 表（表里已有的 appid 跳过），完成后删除旧键 */
  private migrateLegacyKv(): void {
    const row = this.deps.db
      .prepare("SELECT v FROM kv WHERE k = ?")
      .get(LEGACY_KV_KEY) as { v: string } | undefined;
    if (row === undefined) return;
    try {
      const parsed: unknown = JSON.parse(row.v);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const rec = item as Record<string, unknown>;
          const appid = typeof rec.appid === "string" ? rec.appid.trim() : "";
          const secret = typeof rec.secret === "string" ? rec.secret.trim() : "";
          if (appid === "" || secret === "") continue;
          this.insertSeed({
            appid,
            secret,
            name:
              typeof rec.name === "string" && rec.name.trim() !== ""
                ? rec.name.trim()
                : appid,
          });
        }
      }
    } catch {
      // 坏数据不迁移不崩溃，交由 env 播种兜底
    }
    this.deps.db.prepare("DELETE FROM kv WHERE k = ?").run(LEGACY_KV_KEY);
  }

  /** env QQ_APPS 播种：表里已存在的 appid 不覆盖（UI 侧改动不被重启冲掉） */
  private seedFromEnv(): void {
    for (const app of this.deps.seed.apps) this.insertSeed(app);
  }

  private insertSeed(app: BotApp): void {
    this.deps.db
      .prepare(
        `INSERT OR IGNORE INTO bots(appid, name, secret, agent_token, allow_groups, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        app.appid,
        app.name,
        app.secret,
        newAgentToken(),
        JSON.stringify(this.seedAllowGroups),
        Date.now(),
      );
  }

  // —— 运行时读写（全部走表） ——

  /** 全量列表（播种序：created_at 升序，展示顺序稳定） */
  list(): BotApp[] {
    const rows = this.deps.db
      .prepare("SELECT appid, name, secret FROM bots ORDER BY created_at, appid")
      .all() as Array<Pick<BotRow, "appid" | "name" | "secret">>;
    return rows.map(rowToApp);
  }

  get(appid: string): BotApp | undefined {
    const row = this.deps.db
      .prepare("SELECT appid, name, secret FROM bots WHERE appid = ?")
      .get(appid) as Pick<BotRow, "appid" | "name" | "secret"> | undefined;
    return row === undefined ? undefined : rowToApp(row);
  }

  /** 所有 bot 现在都由运行时管理（env 仅首次播种）；保留方法名以兼容 UI 的来源展示 */
  isDynamic(appid: string): boolean {
    return this.get(appid) !== undefined;
  }

  /**
   * 注册新 bot：参数校验 → 查重 → verify 凭据（失败不落库）→ 落库 + 生成 agent token。
   * 不负责启动连接——调用方拿到返回值后自行触发网关接入。
   */
  async add(input: {
    appid: string;
    secret: string;
    name?: string;
    /** 初始发送白名单（缺省=空：发送默认关，需在 WebUI 设置页放开） */
    allowGroups?: string[];
  }): Promise<RegisteredBot> {
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
        `注册失败：appid=${appid} 已存在。重复注册请改用 qq_token_refresh 轮换 token，或在 WebUI 设置页操作。`,
      );
    }
    const app: BotApp = { appid, secret, name };
    try {
      await this.verify(app);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new BotRegistryError(
        `凭据校验失败：官方接口拒绝（${reason}）。请核对 appid 与 AppSecret（q.qq.com → 开发设置）；` +
          "若报「接口访问源IP不在白名单」（code 11298），需在该机器人管理端关闭 IP 白名单或把本机公网 IP 加入白名单。",
      );
    }
    const agentToken = newAgentToken();
    this.deps.db
      .prepare(
        `INSERT INTO bots(appid, name, secret, agent_token, allow_groups, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        appid,
        name,
        secret,
        agentToken,
        JSON.stringify(input.allowGroups ?? []),
        Date.now(),
      );
    return { app, agentToken };
  }

  /**
   * 移除 bot（bots 表是唯一来源，任何 bot 均可移除；env 播种源若未同步删除，
   * 重启会以新 token 重新播种——文档已标注）。不负责断连接/清会话，调用方自行处理。
   */
  remove(appid: string): BotApp {
    const row = this.deps.db
      .prepare("DELETE FROM bots WHERE appid = ? RETURNING appid, name, secret")
      .get(appid) as Pick<BotRow, "appid" | "name" | "secret"> | undefined;
    if (row === undefined) {
      throw new BotRegistryError(
        `移除失败：appid=${appid} 不在注册表中。已注册：${this.list().map((b) => b.appid).join(", ") || "（无）"}。`,
      );
    }
    return rowToApp(row);
  }

  /** 每 bot 发送白名单（gate 的权限域） */
  allowGroupsOf(appid: string): string[] {
    const row = this.deps.db
      .prepare("SELECT allow_groups FROM bots WHERE appid = ?")
      .get(appid) as { allow_groups: string } | undefined;
    return row === undefined ? [] : parseAllowGroups(row.allow_groups);
  }

  setAllowGroups(appid: string, groups: string[]): void {
    const r = this.deps.db
      .prepare("UPDATE bots SET allow_groups = ? WHERE appid = ?")
      .run(JSON.stringify(groups.filter((g) => g !== "")), appid);
    if (r.changes !== 1) {
      throw new BotRegistryError(`更新失败：appid=${appid} 不在注册表中。`);
    }
  }

  /** 轮换 agent token：旧值立即失效，新值只在返回中出现一次 */
  rotateToken(appid: string): string {
    if (this.get(appid) === undefined) {
      throw new BotRegistryError(
        `轮换失败：appid=${appid} 不在注册表中。可用 qq_register_bot 注册新 bot。`,
      );
    }
    const token = newAgentToken();
    this.deps.db
      .prepare("UPDATE bots SET agent_token = ? WHERE appid = ?")
      .run(token, appid);
    return token;
  }

  /** /mcp 鉴权：token → 绑定的 bot appid（未命中=null） */
  appIdByToken(token: string): string | null {
    const row = this.deps.db
      .prepare("SELECT appid FROM bots WHERE agent_token = ?")
      .get(token) as { appid: string } | undefined;
    return row?.appid ?? null;
  }
}

function newAgentToken(): string {
  return randomBytes(24).toString("hex"); // 48 字符十六进制，碰撞概率可忽略
}
