// 机器人注册表：SQLite bots 表是唯一权威存储。bot 只能经 WebUI 或 HTTP POST
// /register 注册；重启后按 bots 表连接全部 bot。
//
// - platform 列标识连接器；凭据统一存 credentials_json，形状由该平台连接器的
//   credentialSchema 定义，宿主不感知具体键。appid 列是平台账号 id（主键）。
// - 每个 bot 一个 agent_token（明文落库）：/mcp Bearer 按表反查绑定 bot；轮换后
//   原 token 立即失效，新值只返回一次，由调用方自行保存。
// - 每 bot 独立发送白名单 allow_groups（与「一个 token 一个 bot」的权限域一致）。
// - 每 bot 独立认证等级 auth_level：决定主动消息频控预算 certified=60qpm /
//   uncertified=30qpm，缺省未认证（保守）。
// - 纪律：本模块不 log 任何 secret/token（logger 兜底剥离仅是最后防线）。
// - add 必过 verify（平台连接器 hooks.verifyCredential），未验证不入库。

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthLevel } from "./utils/config";
import type { DB } from "./store/db";

export interface BotRegistryDeps {
  db: DB;
  /**
   * 添加时的凭据校验（按平台解析到连接器 hooks.verifyCredential）；缺省=跳过校验（仅测试用）。
   * 宿主装配（index.ts）注入：plugins.get(platform)?.hooks?.verifyCredential，未加载即抛。
   */
  verify?: (
    platform: string,
    credentials: Record<string, string>,
  ) => Promise<void>;
}

/** add/remove/rotate 的校验错误：消息可操作（提示去哪核对） */
export class BotRegistryError extends Error {}

/** 平台中立的 bot 记录（bots 表行投影；凭据键值对形状由连接器声明权威） */
export interface BotRecord {
  /** 平台账号 id（bots 表主键；QQ=appid，其他平台为各自唯一账号标识） */
  botId: string;
  platform: string;
  name: string;
  /** 平台凭据（QQ={appid, secret}；密钥不落日志） */
  credentials: Record<string, string>;
}

export interface RegisteredBot {
  /** 注册完成的 bot 记录（调用方据此拉起连接） */
  bot: BotRecord;
  /** 明文 agent token：仅在注册/轮换返回中出现一次，调用方必须立即保存 */
  agentToken: string;
}

interface BotRow {
  appid: string;
  name: string;
  secret: string;
  allow_groups: string;
  auth_level: string;
  platform: string;
  credentials_json: string;
}

/** 认证等级白名单校验：非法值报可操作错误 */
export function parseAuthLevel(raw: string): AuthLevel {
  if (raw === "certified" || raw === "uncertified") return raw;
  throw new BotRegistryError(
    "auth_level 无效：只接受 certified（已认证，主动消息 60 条/分钟）或 uncertified（未认证，30 条/分钟）。",
  );
}

function parseAllowGroups(raw: string): string[] {
  try {
    // JSON.parse 返回 any（库签名）：Array.isArray 现场窄化后逐项收字符串
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is string => typeof g === "string" && g !== "");
  } catch {
    return []; // 坏数据按空白名单处理（安全默认：不发）
  }
}

function parseAuthLevelColumn(raw: string): AuthLevel {
  return raw === "certified" ? "certified" : "uncertified"; // 坏数据按保守档处理
}

/** 凭据 JSON 解析：只保留字符串值键；坏数据按空凭据处理（读路径安全默认） */
function parseCredentials(raw: string): Record<string, string> {
  try {
    // JSON.parse 返回 any（库签名）：对象形状现场窄化，逐键 typeof 收字符串
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function rowToRecord(row: {
  appid: string;
  name: string;
  platform: string;
  credentials_json: string;
}): BotRecord {
  return {
    botId: row.appid,
    platform: row.platform,
    name: row.name,
    credentials: parseCredentials(row.credentials_json),
  };
}

export class BotRegistry {
  private readonly verify: (
    platform: string,
    credentials: Record<string, string>,
  ) => Promise<void>;
  /**
   * 热路径读 stmt 缓存（对齐 repo.ts 的既定模式）：appIdByToken=每 MCP 请求必经；
   * allowGroupsOf=发送门禁+侧别探测兜底；agentTokenOf=资产票据签发/校验；authLevelOf=quota。
   * 管理面写操作（add/remove/rename/setAllowGroups/setAuthLevel/rotate）低频，保持 inline prepare。
   */
  private readonly appIdByTokenStmt: Database.Statement<[string]>;
  private readonly allowGroupsStmt: Database.Statement<[string]>;
  private readonly agentTokenStmt: Database.Statement<[string]>;
  private readonly authLevelStmt: Database.Statement<[string]>;
  private readonly receiveEnabledStmt: Database.Statement<[string]>;
  private readonly mcpEnabledStmt: Database.Statement<[string]>;

  constructor(private readonly deps: BotRegistryDeps) {
    this.verify = deps.verify ?? (async () => {});
    this.appIdByTokenStmt = deps.db.prepare(
      "SELECT appid FROM bots WHERE agent_token = ?",
    );
    this.allowGroupsStmt = deps.db.prepare(
      "SELECT allow_groups FROM bots WHERE appid = ?",
    );
    this.agentTokenStmt = deps.db.prepare(
      "SELECT agent_token FROM bots WHERE appid = ?",
    );
    this.authLevelStmt = deps.db.prepare(
      "SELECT auth_level FROM bots WHERE appid = ?",
    );
    this.receiveEnabledStmt = deps.db.prepare(
      "SELECT receive_enabled FROM bots WHERE appid = ?",
    );
    this.mcpEnabledStmt = deps.db.prepare(
      "SELECT mcp_enabled FROM bots WHERE appid = ?",
    );
  }

  // —— 运行时读写（全部走表） ——

  /** 全量列表（注册序：created_at 升序，展示顺序稳定） */
  list(): BotRecord[] {
    const rows = this.deps.db
      .prepare(
        "SELECT appid, name, platform, credentials_json FROM bots ORDER BY created_at, appid",
      )
      .all() as Array<{
      appid: string;
      name: string;
      platform: string;
      credentials_json: string;
    }>;
    return rows.map(rowToRecord);
  }

  get(appid: string): BotRecord | undefined {
    const row = this.deps.db
      .prepare(
        "SELECT appid, name, platform, credentials_json FROM bots WHERE appid = ?",
      )
      .get(appid) as
      | {
          appid: string;
          name: string;
          platform: string;
          credentials_json: string;
        }
      | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  /** 平台归属（bot 不存在=null）；runtime 按 platform 选连接器插件 */
  platformOf(appid: string): string | null {
    const row = this.deps.db
      .prepare("SELECT platform FROM bots WHERE appid = ?")
      .get(appid) as { platform: string } | undefined;
    return row?.platform ?? null;
  }

  /** 所有 bot 均由运行时注册管理；保留方法名以兼容 UI 的来源展示 */
  isDynamic(appid: string): boolean {
    return this.get(appid) !== undefined;
  }

  /**
   * 注册新 bot：参数校验 → 查重 → verify 凭据（失败不落库）→ 落库 + 生成 agent token。
   * 平台缺省 qq（基座）；凭据形状由该平台连接器 credentialSchema 权威（QQ={appid, secret}）。
   * 不负责启动连接——调用方拿到返回值后自行触发接入。
   */
  async add(input: {
    /** 平台 id（缺省 qq） */
    platform?: string;
    /** 平台凭据键值对（QQ={appid, secret}） */
    credentials: Record<string, string>;
    name?: string;
    /** 初始发送白名单（缺省=空：发送默认关，需在 WebUI 设置页放开） */
    allowGroups?: string[];
    /** 认证等级（缺省 uncertified：主动消息 30 条/分钟的保守预算） */
    authLevel?: AuthLevel;
  }): Promise<RegisteredBot> {
    const platform = input.platform ?? "qq";
    const credentials = input.credentials;
    if (credentials === null || typeof credentials !== "object") {
      throw new BotRegistryError(
        "参数无效：credentials 必须是键值对对象（各平台凭据字段见其连接器声明；QQ=appid+secret）。",
      );
    }
    // 平台账号 id：凭据中的身份键（QQ=appid；其他平台约定 appid 或 id 键承载）
    const accountId = (credentials["appid"] ?? credentials["id"] ?? "").trim();
    if (accountId === "") {
      throw new BotRegistryError(
        "参数无效：credentials 缺少账号标识键（appid/id 均未提供）。QQ 平台请传 {appid, secret}。",
      );
    }
    const name = input.name?.trim() || accountId;
    const authLevel = input.authLevel
      ? parseAuthLevel(input.authLevel)
      : "uncertified";
    if (this.get(accountId) !== undefined) {
      throw new BotRegistryError(
        `注册失败：bot ${accountId} 已存在。重复注册请走 WebUI 设置页轮换 token 或管理 bot。`,
      );
    }
    try {
      await this.verify(platform, credentials);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // 平台专属核对提示由连接器 verifyCredential 自带（QQ=q.qq.com/11298 白名单提示）；
      // 宿主包装只承担统一前缀与通用指引。
      throw new BotRegistryError(
        `凭据校验失败（平台 ${platform}）：官方接口拒绝（${reason}）。请核对该平台凭据——字段定义见 WebUI「添加机器人」表单。`,
      );
    }
    const agentToken = newAgentToken();
    this.deps.db
      .prepare(
        `INSERT INTO bots(appid, name, secret, agent_token, allow_groups, auth_level, created_at, platform, credentials_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        accountId,
        name,
        "", // secret 物理列为追加式迁移保留；凭据权威在 credentials_json
        agentToken,
        JSON.stringify(input.allowGroups ?? []),
        authLevel,
        Date.now(),
        platform,
        JSON.stringify(credentials),
      );
    return {
      bot: { botId: accountId, platform, name, credentials },
      agentToken,
    };
  }

  /**
   * 移除 bot（bots 表是唯一来源，任何 bot 均可移除）。
   * 不负责断连接/清会话，调用方自行处理。
   */
  remove(appid: string): BotRecord {
    const row = this.deps.db
      .prepare(
        "DELETE FROM bots WHERE appid = ? RETURNING appid, name, platform, credentials_json",
      )
      .get(appid) as
      | {
          appid: string;
          name: string;
          platform: string;
          credentials_json: string;
        }
      | undefined;
    if (row === undefined) {
      throw new BotRegistryError(
        `移除失败：bot ${appid} 不在注册表中。已注册：${
          this.list()
            .map((b) => b.botId)
            .join(", ") || "（无）"
        }。`,
      );
    }
    return rowToRecord(row);
  }

  /** 改备注名（WebUI 设置页）：空名回落账号 id；仅本地展示与自发消息补记作者名，不触平台 */
  rename(appid: string, name: string): Pick<BotRow, "appid" | "name"> {
    const trimmed = name.trim().slice(0, 32);
    const final = trimmed === "" ? appid : trimmed;
    const row = this.deps.db
      .prepare("UPDATE bots SET name = ? WHERE appid = ? RETURNING appid, name")
      .get(final, appid) as Pick<BotRow, "appid" | "name"> | undefined;
    if (row === undefined) {
      throw new BotRegistryError(
        `改名失败：bot ${appid} 不在注册表中。已注册：${
          this.list()
            .map((b) => b.botId)
            .join(", ") || "（无）"
        }。`,
      );
    }
    return row;
  }

  /** 每 bot 发送白名单（gate 的权限域） */
  allowGroupsOf(appid: string): string[] {
    const row = this.allowGroupsStmt.get(appid) as
      { allow_groups: string } | undefined;
    return row === undefined ? [] : parseAllowGroups(row.allow_groups);
  }

  setAllowGroups(appid: string, groups: string[]): void {
    const r = this.deps.db
      .prepare("UPDATE bots SET allow_groups = ? WHERE appid = ?")
      .run(JSON.stringify(groups.filter((g) => g !== "")), appid);
    if (r.changes !== 1) {
      throw new BotRegistryError(`更新失败：bot ${appid} 不在注册表中。`);
    }
  }

  /** 每 bot 认证等级（主动消息频控预算档位；缺省未认证） */
  authLevelOf(appid: string): AuthLevel {
    const row = this.authLevelStmt.get(appid) as
      { auth_level: string } | undefined;
    return row === undefined
      ? "uncertified"
      : parseAuthLevelColumn(row.auth_level);
  }

  setAuthLevel(appid: string, level: AuthLevel): void {
    const r = this.deps.db
      .prepare("UPDATE bots SET auth_level = ? WHERE appid = ?")
      .run(parseAuthLevel(level), appid);
    if (r.changes !== 1) {
      throw new BotRegistryError(`更新失败：bot ${appid} 不在注册表中。`);
    }
  }

  /** 是否接收网关消息（WebUI「接收消息」开关；未知 bot 保守返回 false） */
  receiveEnabledOf(appid: string): boolean {
    const row = this.receiveEnabledStmt.get(appid) as
      { receive_enabled: number } | undefined;
    return row?.receive_enabled === 1;
  }

  setReceiveEnabled(appid: string, enabled: boolean): void {
    const r = this.deps.db
      .prepare("UPDATE bots SET receive_enabled = ? WHERE appid = ?")
      .run(enabled ? 1 : 0, appid);
    if (r.changes !== 1) {
      throw new BotRegistryError(`更新失败：bot ${appid} 不在注册表中。`);
    }
  }

  /** 是否允许 MCP 访问（WebUI「MCP 访问」开关；未知 bot 保守返回 false） */
  mcpEnabledOf(appid: string): boolean {
    const row = this.mcpEnabledStmt.get(appid) as
      { mcp_enabled: number } | undefined;
    return row?.mcp_enabled === 1;
  }

  setMcpEnabled(appid: string, enabled: boolean): void {
    const r = this.deps.db
      .prepare("UPDATE bots SET mcp_enabled = ? WHERE appid = ?")
      .run(enabled ? 1 : 0, appid);
    if (r.changes !== 1) {
      throw new BotRegistryError(`更新失败：bot ${appid} 不在注册表中。`);
    }
  }

  /** 轮换 agent token：旧值立即失效，新值只在返回中出现一次 */
  rotateToken(appid: string): string {
    if (this.get(appid) === undefined) {
      throw new BotRegistryError(
        `轮换失败：bot ${appid} 不在注册表中。可经 WebUI「添加机器人」或 HTTP POST /register（admin token）注册新 bot。`,
      );
    }
    const token = newAgentToken();
    this.deps.db
      .prepare("UPDATE bots SET agent_token = ? WHERE appid = ?")
      .run(token, appid);
    return token;
  }

  /** /mcp 鉴权：token → 绑定的 bot 账号 id（未命中=null） */
  appIdByToken(token: string): string | null {
    const row = this.appIdByTokenStmt.get(token) as
      { appid: string } | undefined;
    return row?.appid ?? null;
  }

  /** 资产上传票据签发/校验：账号 id → agent_token（bot 不存在或已轮换=null） */
  agentTokenOf(appid: string): string | null {
    const row = this.agentTokenStmt.get(appid) as
      { agent_token: string } | undefined;
    return row?.agent_token ?? null;
  }
}

function newAgentToken(): string {
  return randomBytes(24).toString("hex"); // 48 字符十六进制，碰撞概率可忽略
}
