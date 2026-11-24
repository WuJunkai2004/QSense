// 历史回放验收（B⁺ T2，2026-11-24）：对生产库全量 raw_json 重演
// 「normalize → UnifiedMessageSchema safeParse」，验证 zod 网关对存量数据零违规
// ——enforce 的安全前提（复用迁移 v8 raw_json 历史重演先例）。
//
// 用法：npx tsx scripts/replay-normalize.mts [数据库路径]（默认 data/qqbot.db）
//   只读打开（readonly），不干扰运行中的服务。退出码：违规>0 → 1。
//
// raw_json 粒度（parser 权威事实）：qq=事件 data / telegram=update 对象 /
// weixin=WeixinMessage（context_token 已打码）。信封按平台重建后走
// plugin.normalize（声明面入口，与生产管线同一路径）。

import { basename } from "node:path";
import Database from "better-sqlite3";
import {
  formatZodIssues,
  InboundEffectSchema,
  UnifiedInboundSchema,
  UnifiedMessageSchema,
  type ConnectorPlugin,
  type NormalizedInbound,
} from "@qsense/connector-sdk";
import { createQqConnector } from "@qsense/connector-qq";
import { createTelegramConnector } from "@qsense/connector-telegram";
import { createWeixinConnector } from "@qsense/connector-weixin";

function main(): void {
  const dbPath = process.argv[2] ?? "data/qqbot.db";
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  // bot → platform 映射（bots 表权威）
  const botPlatform = new Map<string, string>();
  for (const row of db.prepare("SELECT appid, platform FROM bots").all()) {
    botPlatform.set(String(row.appid), String(row.platform));
  }

  // 各平台插件（normalize 走声明面入口，与生产 ingest 同路径）
  const plugins = new Map<string, ConnectorPlugin>();
  plugins.set("qq", createQqConnector() as unknown as ConnectorPlugin);
  plugins.set("telegram", createTelegramConnector() as unknown as ConnectorPlugin);
  plugins.set("weixin", createWeixinConnector() as unknown as ConnectorPlugin);

  interface Row {
    bot_id: string;
    scope: string;
    msg_id: string;
    raw_json: string | null;
  }
  const rows = db
    .prepare(
      "SELECT bot_id, scope, msg_id, raw_json FROM messages ORDER BY rowid",
    )
    .all() as Row[];

  let total = 0; // 有 raw 的行
  let replayed = 0; // normalize 产出消息数
  let parseOk = 0;
  const violations: string[] = [];
  const byPlatform = new Map<string, { rows: number; ok: number }>();
  const skipped = new Map<string, number>(); // 无插件/无raw 等，按原因计

  for (const row of rows) {
    if (row.raw_json === null) {
      skipped.set("no-raw(补记行)", (skipped.get("no-raw(补记行)") ?? 0) + 1);
      continue;
    }
    const platform = botPlatform.get(row.bot_id) ?? `unknown-bot:${row.bot_id}`;
    const plugin = plugins.get(platform);
    const stat = byPlatform.get(platform) ?? { rows: 0, ok: 0 };
    byPlatform.set(platform, stat);
    if (plugin === undefined) {
      skipped.set(`no-plugin:${platform}`, (skipped.get(`no-plugin:${platform}`) ?? 0) + 1);
      continue;
    }
    total++;
    stat.rows++;
    let raw: unknown;
    try {
      raw = JSON.parse(row.raw_json) as unknown;
    } catch {
      violations.push(`[${platform}] ${row.bot_id}/${row.msg_id}: raw_json 非 JSON`);
      continue;
    }
    // 按平台重建上行信封（与连接器摄取期的信封形状一致）
    const envelope =
      platform === "qq"
        ? {
            platform: "qq",
            type: row.scope === "group" ? "GROUP_MESSAGE_CREATE" : "C2C_MESSAGE_CREATE",
            data: raw,
          }
        : platform === "telegram"
          ? { platform: "telegram", update: raw }
          : { platform: "weixin", message: raw };
    let inbound: NormalizedInbound | null;
    try {
      inbound = plugin.normalize(row.bot_id, envelope) as NormalizedInbound | null;
    } catch (e) {
      violations.push(
        `[${platform}] ${row.bot_id}/${row.msg_id}: normalize 抛错 ${(e as Error).message.slice(0, 120)}`,
      );
      continue;
    }
    if (inbound === null) {
      skipped.set(`normalize-null:${platform}`, (skipped.get(`normalize-null:${platform}`) ?? 0) + 1);
      continue;
    }
    for (const m of inbound.messages) {
      replayed++;
      const r = UnifiedMessageSchema.safeParse(m);
      if (r.success) {
        parseOk++;
        stat.ok++;
      } else {
        violations.push(
          `[${platform}] ${row.bot_id}/${row.msg_id}: ${formatZodIssues(r.error, "message")}`,
        );
      }
    }
    const fxr = UnifiedInboundSchema.safeParse({ messages: [], effects: inbound.effects });
    if (!fxr.success) {
      violations.push(
        `[${platform}] ${row.bot_id}/${row.msg_id}: effects ${formatZodIssues(fxr.error, "effects")}`,
      );
    }
  }
  db.close();

  console.log(`== normalize + zod 历史回放：${basename(dbPath)} ==`);
  console.log(`messages 行：${rows.length}（有 raw ${total}，重演消息 ${replayed}，parse 通过 ${parseOk}）`);
  for (const [p, s] of byPlatform) {
    console.log(`  ${p}: 行 ${s.rows}，消息 parse 通过 ${s.ok}`);
  }
  for (const [k, n] of skipped) console.log(`  跳过 ${k}: ${n}`);
  if (violations.length > 0) {
    console.log(`\n违规 ${violations.length} 条（前 20）：`);
    for (const v of violations.slice(0, 20)) console.log(`  ${v}`);
    process.exit(1);
  }
  console.log("\n零违规 ✓");
}

main();
