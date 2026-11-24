// 宿主连接器装载器：config.toml 声明清单 → loadModule(包名) 动态 import →
// validatePlugin（含 sdkRange 兼容）→ 注册。部署拓扑归配置文件，SQLite 只留业务。
//
// 失败语义：单个平台装载失败不炸启动——记可操作错误 + failed 清单后继续起服务；
// 后果由两道显态闸门兜底：bot 接入时 runtime 报「平台未注册」，注册入口（POST /register /
// WebUI 添加机器人时 verify 硬拒绝（绝不静默跳过凭据校验入库）；已注册 bot 的
// 平台缺失则由启动期 fail-fast（missingPlatformBots）拒启。

import {
  ConnectorRegistry,
  GateError,
  loadModule,
  satisfiesRange,
  SDK_VERSION,
  type ConnectorLogger,
  type ConnectorPlugin,
} from "@qsense/connector-sdk";
import type { Logger } from "../utils/logger";
import type { ConnectorDecl } from "./decl";

export interface LoadOutcome {
  plugins: ConnectorRegistry;
  /** 成功装载的平台 id（有序） */
  loaded: string[];
  /** 装载失败清单（可操作 reason 已同步落日志） */
  failed: Array<{ platform: string; package: string; reason: string }>;
}

export interface LoaderDeps {
  log: Logger;
  /** config.toml 声明清单（decl.ts 产物；测试直接注入） */
  declarations: ConnectorDecl[];
  /** 缺省=SDK loadModule（动态 import 包说明符）；测试注入替身 */
  load?: (spec: string, init?: { log?: ConnectorLogger }) => Promise<ConnectorPlugin>;
}

export async function loadDeclaredConnectors(
  deps: LoaderDeps,
): Promise<LoadOutcome> {
  const plugins = new ConnectorRegistry();
  const loaded: string[] = [];
  const failed: LoadOutcome["failed"] = [];
  const load = deps.load ?? loadModule;
  for (const decl of deps.declarations) {
    try {
      const plugin = await load(decl.package, { log: deps.log });
      // 声明名与插件 id 一致性：platform 是 bots.platform 外键目标，装载期即对齐
      //（漂移=声明指向了别的平台的包，必然造成 fail-fast 误判）
      if (plugin.id !== decl.platform) {
        throw new GateError(
          `声明名与插件 id 不一致：config.toml 声明 "${decl.platform}"，插件 id 为 "${plugin.id}"。`,
        );
      }
      // toml range 钉版（可选二次锁：与插件自声明 sdkRange 双重校验）
      if (decl.range !== undefined && !satisfiesRange(SDK_VERSION, decl.range)) {
        throw new GateError(
          `config.toml 钉版 range "${decl.range}" 与宿主契约版本 ${SDK_VERSION} 不兼容。`,
        );
      }
      plugins.register(plugin); // register 内含 validatePlugin 全量闸门
      loaded.push(plugin.id);
      deps.log.info("connector loaded", {
        platform: plugin.id,
        package: decl.package,
        ...(decl.source !== undefined ? { source: decl.source } : {}),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failed.push({ platform: decl.platform, package: decl.package, reason });
      deps.log.error("connector load failed", {
        platform: decl.platform,
        package: decl.package,
        reason: reason.slice(0, 300),
      });
    }
  }
  return { plugins, loaded, failed };
}
