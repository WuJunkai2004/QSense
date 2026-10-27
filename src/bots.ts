// 机器人注册表：SQLite bots 表是唯一权威存储（2026-10-25 用户定案）。
//
// 演进：M7 = QQ_APPS env 基座 + kv 动态列表；M8 = env/旧 kv 降级为「首次播种源」；
// M9 起（用户定案）播种彻底退役——bot 只能经 register_bot（MCP）或 WebUI 添加/移除，
// 重启后以 bots 表为准连接全部 bot，env 里不再有任何 bot 相关字段。
//
// - 每个 bot 一个 agent_token（明文落库，用户拍板不做加密）：/mcp Bearer 按表反查绑定 bot；
//   轮换后旧 token 立即失效，新值只返回一次，由调用方（智能体/WebUI）自行保存。
// - 每 bot 独立发送白名单 allow_groups（与「一个 token 一个 bot」的权限域一致）。
// - 每 bot 独立认证等级 auth_level（M9 落库，原 env QQ_AUTH_LEVEL 全局档位退役）：
//   决定主动消息频控预算 certified=60qpm / uncertified=30qpm，缺省未认证（保守）。
// - 纪律：本模块不 log 任何 secret/token（logger 兜底剥离仅是最后防线，源头不打）；
// - add 必过 verify（生产=TokenService 拉真 access_token + 网关地址探测），未验证不入库。

import { randomBytes } from "node:crypto";
import type { AuthLevel, BotApp } from "./config";
import type { DB } from "./store/db";

export interface BotRegistryDeps {
  db: DB;
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
  auth_level: string;
}

const AUTH_LEVELS: readonly AuthLevel[] = ["certified", "uncertified"];

/** 认证等级白名单校验：非法值报可操作错误 */
export function parseAuthLevel(raw: unknown): AuthLevel {
  if (raw === "certified" || raw === "uncertified") return raw;
  throw new BotRegistryError(
    "auth_level 无效：只接受 certified（已认证，主动消息 60 条/分钟）或 uncertified（未认证，30 条/分钟）。",
  );
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

function parseAuthLevelColumn(raw: string): AuthLevel {
  return raw === "certified" ? "certified" : "uncertified"; // 坏数据按保守档处理
}

function rowToApp(row: Pick<BotRow, "appid" | "name" | "secret">): BotApp {
  return { appid: row.appid, secret: row.secret, name: row.name };
}

export class BotRegistry {
  private readonly verify: (app: BotApp) => Promise<void>;

  constructor(private readonly deps: BotRegistryDeps) {
    this.verify = deps.verify ?? (async () => {});
  }

  // —— 运行时读写（全部走表） ——

  /** 全量列表（注册序：created_at 升序，展示顺序稳定） */
  list(): BotApp[] {
    const rows = this.deps.db
      .prepare(
        "SELECT appid, name, secret FROM bots ORDER BY created_at, appid",
      )
      .all() as Array<Pick<BotRow, "appid" | "name" | "secret">>;
    return rows.map(rowToApp);
  }

  get(appid: string): BotApp | undefined {
    const row = this.deps.db
      .prepare("SELECT appid, name, secret FROM bots WHERE appid = ?")
      .get(appid) as Pick<BotRow, "appid" | "name" | "secret"> | undefined;
    return row === undefined ? undefined : rowToApp(row);
  }

  /** 所有 bot 均由运行时注册管理；保留方法名以兼容 UI 的来源展示 */
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
    /** 认证等级（缺省 uncertified：主动消息 30 条/分钟的保守预算） */
    authLevel?: AuthLevel;
  }): Promise<RegisteredBot> {
    const appid = input.appid.trim();
    const secret = input.secret.trim();
    const name = input.name?.trim() || appid;
    if (appid === "" || secret === "") {
      throw new BotRegistryError(
        "参数无效：appid 与 secret 均不能为空（appid 在 q.qq.com 开发设置，secret 为对应 AppSecret）。",
      );
    }
    const authLevel = input.authLevel
      ? parseAuthLevel(input.authLevel)
      : "uncertified";
    if (this.get(appid) !== undefined) {
      throw new BotRegistryError(
        `注册失败：appid=${appid} 已存在。重复注册请走 WebUI 设置页轮换 token 或管理 bot。`,
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
        `INSERT INTO bots(appid, name, secret, agent_token, allow_groups, auth_level, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        appid,
        name,
        secret,
        agentToken,
        JSON.stringify(input.allowGroups ?? []),
        authLevel,
        Date.now(),
      );
    return { app, agentToken };
  }

  /**
   * 移除 bot（bots 表是唯一来源，任何 bot 均可移除）。
   * 不负责断连接/清会话，调用方自行处理。
   */
  remove(appid: string): BotApp {
    const row = this.deps.db
      .prepare("DELETE FROM bots WHERE appid = ? RETURNING appid, name, secret")
      .get(appid) as Pick<BotRow, "appid" | "name" | "secret"> | undefined;
    if (row === undefined) {
      throw new BotRegistryError(
        `移除失败：appid=${appid} 不在注册表中。已注册：${
          this.list()
            .map((b) => b.appid)
            .join(", ") || "（无）"
        }。`,
      );
    }
    return rowToApp(row);
  }

  /** 改备注名（WebUI 设置页）：空名回落 appid；仅本地展示与自发消息补记作者名，不触官方 */
  rename(appid: string, name: string): Pick<BotRow, "appid" | "name"> {
    const trimmed = name.trim().slice(0, 32);
    const final = trimmed === "" ? appid : trimmed;
    const row = this.deps.db
      .prepare("UPDATE bots SET name = ? WHERE appid = ? RETURNING appid, name")
      .get(final, appid) as Pick<BotRow, "appid" | "name"> | undefined;
    if (row === undefined) {
      throw new BotRegistryError(
        `改名失败：appid=${appid} 不在注册表中。已注册：${
          this.list()
            .map((b) => b.appid)
            .join(", ") || "（无）"
        }。`,
      );
    }
    return row;
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

  /** 每 bot 认证等级（主动消息频控预算档位；缺省未认证） */
  authLevelOf(appid: string): AuthLevel {
    const row = this.deps.db
      .prepare("SELECT auth_level FROM bots WHERE appid = ?")
      .get(appid) as { auth_level: string } | undefined;
    return row === undefined
      ? "uncertified"
      : parseAuthLevelColumn(row.auth_level);
  }

  setAuthLevel(appid: string, level: AuthLevel): void {
    const r = this.deps.db
      .prepare("UPDATE bots SET auth_level = ? WHERE appid = ?")
      .run(parseAuthLevel(level), appid);
    if (r.changes !== 1) {
      throw new BotRegistryError(`更新失败：appid=${appid} 不在注册表中。`);
    }
  }

  /** 轮换 agent token：旧值立即失效，新值只在返回中出现一次 */
  rotateToken(appid: string): string {
    if (this.get(appid) === undefined) {
      throw new BotRegistryError(
        `轮换失败：appid=${appid} 不在注册表中。可用 register_bot 注册新 bot。`,
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

  /** 资产上传票据签发/校验：appid → agent_token（bot 不存在或已轮换=null） */
  agentTokenOf(appid: string): string | null {
    const row = this.deps.db
      .prepare("SELECT agent_token FROM bots WHERE appid = ?")
      .get(appid) as { agent_token: string } | undefined;
    return row?.agent_token ?? null;
  }
}

function newAgentToken(): string {
  return randomBytes(24).toString("hex"); // 48 字符十六进制，碰撞概率可忽略
}
