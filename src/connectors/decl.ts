// 连接器声明解析：config.toml 是「启用了哪些平台、用哪个包」的唯一权威。
// 部署拓扑归配置文件，SQLite 只保存业务数据。
// 形态：
//   [connectors.<platform>]
//   package = "@qsense/connector-qq"        # 动态 import 说明符（必填）
//   range   = "^2.0.0"                      # 可选 sdkRange 钉版（插件自声明之外的二次锁）
//   source  = "file:packages/connector-qq"  # 供应链标注（文档性）
//
// 三条红线：
// - 凭据不进 toml（credentials_json 在 bots 表的唯一权威不动）
// - platform 不在声明 → 插件不装载 → 注册入口（POST /register/WebUI）verify 硬拒绝
// - 供应链信任边界：npmjs/github 来源须显式安装 + lockfile 钉版 + 首次人工确认；
//   本加载器启动零隐式网络拉取（只 import 已安装的包说明符）
//
// 存在即启用：整节删除/注释 = 平台下线；bots 表指向已删声明的 platform 由
// 启动期 fail-fast 检查（missingPlatformBots）拒启——显态失败优于静默降级。

import { readFileSync } from "node:fs";
import { parse, type TomlTable, type TomlValue } from "smol-toml";

/** 平台声明键规则（与 ConnectorPlugin.id 同一正则） */
const PLATFORM_KEY_RE = /^[a-z][a-z0-9-]*$/;

export class DeclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclError";
  }
}

export interface ConnectorDecl {
  /** 声明名（bots.platform 外键目标；须与插件 id 一致——装载时校验） */
  platform: string;
  /** 动态 import 的包说明符（如 "@qsense/connector-qq" / "file:./conn-foo"） */
  package: string;
  /** 可选 sdkRange 钉版（semver-lite；与插件自声明双重校验） */
  range?: string;
  /** 供应链标注：file / npmjs / github */
  source?: string;
}

/** TOML 值 → 纯表判定（TomlDate/数组/原始值不算表；smol-toml 强类型自带判别基础） */
function isTomlTable(v: TomlValue): v is TomlTable {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)
  );
}

/** config.toml 源文 → 声明清单；语法/结构错误抛 DeclError（拒启，可操作文案） */
export function parseConnectorsToml(source: string): ConnectorDecl[] {
  let doc: TomlTable;
  try {
    doc = parse(source);
  } catch (e) {
    throw new DeclError(
      `config.toml 解析失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return connectorDeclsOf(doc);
}

/** 已解析的 config.toml 顶层文档 → 连接器声明清单（loadConfig 复用，避免二次 parse） */
export function connectorDeclsOf(doc: TomlTable): ConnectorDecl[] {
  const conns = doc["connectors"];
  if (conns === undefined) return []; // 无 [connectors] 节 = 零声明（合法）
  if (!isTomlTable(conns)) {
    throw new DeclError(
      "config.toml：[connectors] 必须是表（形如 [connectors.qq]）。",
    );
  }
  const out: ConnectorDecl[] = [];
  for (const [platform, raw] of Object.entries(conns)) {
    if (!PLATFORM_KEY_RE.test(platform)) {
      throw new DeclError(
        `config.toml：connectors.${platform} 平台名非法（须匹配 ${PLATFORM_KEY_RE}）。`,
      );
    }
    if (!isTomlTable(raw)) {
      throw new DeclError(
        `config.toml：connectors.${platform} 必须是表（package = "…"）。`,
      );
    }
    const pkg = raw["package"];
    if (typeof pkg !== "string" || pkg.trim() === "") {
      throw new DeclError(
        `config.toml：connectors.${platform}.package 必须是非空字符串（动态 import 说明符）。`,
      );
    }
    const range = raw["range"];
    if (
      range !== undefined &&
      (typeof range !== "string" || range.trim() === "")
    ) {
      throw new DeclError(
        `config.toml：connectors.${platform}.range 必须是非空字符串（semver-lite，如 "^2.0.0"）。`,
      );
    }
    const src = raw["source"];
    if (src !== undefined && (typeof src !== "string" || src.trim() === "")) {
      throw new DeclError(
        `config.toml：connectors.${platform}.source 必须是非空字符串（供应链标注）。`,
      );
    }
    for (const key of Object.keys(raw)) {
      if (key !== "package" && key !== "range" && key !== "source") {
        throw new DeclError(
          `config.toml：connectors.${platform} 存在未知键 "${key}"（允许 package/range/source；凭据绝不进 toml）。`,
        );
      }
    }
    out.push({
      platform,
      package: pkg,
      ...(range !== undefined ? { range } : {}),
      ...(src !== undefined ? { source: src } : {}),
    });
  }
  return out;
}

/**
 * 读 config.toml → 声明清单。文件缺失返回 []（全新部署合法——无 bot 即可起服，
 * 有 bot 则由 fail-fast 检查拦截）；存在但语法错误抛 DeclError（拒启）。
 */
export function loadConnectorDeclarations(path: string): ConnectorDecl[] {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new DeclError(
      `config.toml 读取失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return parseConnectorsToml(source);
}

/**
 * 启动期 fail-fast 检查：每个已注册 bot 的 platform 必须有「声明且装载
 * 成功」的连接器。声明缺失/包损坏 → 返回孤儿清单（index.ts 据此拒启并给可操作文案）。
 */
export function missingPlatformBots(
  bots: Array<{ botId: string; platform: string }>,
  loadedPlatforms: ReadonlySet<string>,
): Array<{ botId: string; platform: string }> {
  return bots.filter((b) => !loadedPlatforms.has(b.platform));
}
