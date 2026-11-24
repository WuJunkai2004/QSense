// 类型审计（B⁺ T0 验收工具，2026-11-24）：统计全项目 any / unknown / `as X`
// 盲断言的分布，输出增量报告。
//
// 用法：npx tsx scripts/type-audit.mts [--json]
//   默认输出人类可读报告；--json 输出机器可读汇总（供基线归档/后续对比）。
//   退出码恒 0（本脚本是度量工具，不拦截构建；拦截在 tsc 与测试）。
//
// unknown 口径（2026-11-24 用户定案，取代早先的白名单方案）：**零容忍**。
// 违禁项 = 源码出现 unknown / JsonValue / Record<string, unknown> / Record<string, any>
// 等「无结构万能类型」——消除 unknown 必须按实际读取的字段定义具体 interface/联合类型，
// 网络入口一律 zod 解析成具体类型（失败抛错/返回 null 由上层 catch）；
// 平台原始载荷类型隔离在各插件 *.types.ts，禁止向 core 泄漏。
// 引号内的 "unknown" 字面量（如网关状态值）与整行注释中的提及不算标注。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 扫描根：core 源码 + 测试 + 四个包源码（不含 dist / scripts / node_modules） */
const ROOTS = [
  "src",
  "test",
  "packages/connector-sdk/src",
  "packages/connector-qq/src",
  "packages/connector-telegram/src",
  "packages/connector-weixin/src",
] as const;

interface Hit {
  file: string;
  line: number;
  text: string;
}

interface KindStat {
  name: string;
  total: number;
  hits: Hit[];
}

/** 四类计数：any / unknown / 万能字典（JsonValue·Record<string,unknown|any>）目标恒 0；as 盲断言白名单外清零 */
function classifyLine(line: string): {
  any: boolean;
  unknown: boolean;
  megaDict: boolean;
  asAssert: boolean;
} {
  const code = stripComment(line);
  return {
    any: /\b(?:as any|:\s*any\b|<any[,>\s]|any\[\])/.test(code),
    // 引号内的 "unknown"（如网关状态字面量）不是类型标注
    unknown: /\bunknown\b/.test(code.replace(/(['"])unknown\1/g, "")),
    megaDict:
      /\bJsonValue\b/.test(code) ||
      /Record<\s*string\s*,\s*(?:unknown|any|never)\s*>/.test(code) ||
      /\[\s*key:\s*string\s*\]\??\s*:\s*(?:unknown|any)\b/.test(code),
    asAssert: /\bas\s+(?:const\b)/.test(code)
      ? false
      : /\bas\s+(?:[A-Z]\w*|string|number|boolean|bigint|symbol|object|null|undefined)\b/.test(code),
  };
}

/**
 * 剥注释：行尾 // 与整行注释（//、/*、* 开头——JSDoc 描述性提及不算代码标注；
 * 审计对字符串内 // 仍保守多报，不做语法级解析）。
 */
function stripComment(line: string): string {
  const trimmed = line.trim();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  ) {
    return "";
  }
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mts|cts)$/.test(name)) out.push(p);
  }
  return out;
}

function main(): void {
  const files: string[] = [];
  for (const root of ROOTS) {
    try {
      files.push(...walk(root));
    } catch {
      /* 根不存在（如尚未创建的包）跳过 */
    }
  }
  files.sort();

  const anyStat: KindStat = { name: "any", total: 0, hits: [] };
  const unknownRaw: KindStat = { name: "unknown", total: 0, hits: [] };
  const megaDict: KindStat = { name: "mega-dict", total: 0, hits: [] };
  const asStat: KindStat = { name: "as-assert", total: 0, hits: [] };

  for (const file of files) {
    const rel = file.replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const cls = classifyLine(lines[i]);
      const hit = { file: rel, line: i + 1, text: lines[i].trim().slice(0, 120) };
      if (cls.any) {
        anyStat.total++;
        anyStat.hits.push(hit);
      }
      if (cls.unknown) {
        unknownRaw.total++;
        unknownRaw.hits.push(hit);
      }
      if (cls.megaDict) {
        megaDict.total++;
        megaDict.hits.push(hit);
      }
      if (cls.asAssert) {
        asStat.total++;
        asStat.hits.push(hit);
      }
    }
  }

  const byFile = (hits: Hit[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const h of hits) m.set(h.file, (m.get(h.file) ?? 0) + 1);
    return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
  };

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          files: files.length,
          any: anyStat.total,
          unknownTotal: unknownRaw.total,
          megaDict: megaDict.total,
          asAssert: asStat.total,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("== QSense 类型审计 ==");
  console.log(`扫描文件：${files.length}`);
  console.log(`any：${anyStat.total}（目标恒 0）`);
  console.log(`unknown：${unknownRaw.total}（零容忍——必须按实际读取字段定义具体 interface）`);
  console.log(`万能字典：${megaDict.total}（JsonValue/Record<string,unknown|any> 违禁，目标 0）`);
  console.log(`as 盲断言：${asStat.total}（目标 0，白名单见 todo.md）`);
  for (const [label, stat] of [
    ["any", anyStat],
    ["unknown", unknownRaw],
    ["万能字典", megaDict],
    ["as 盲断言", asStat],
  ] as const) {
    if (stat.total === 0) continue;
    console.log(`\n—— ${label} 按文件 ——`);
    for (const [f, n] of byFile(stat.hits)) console.log(`  ${f}: ${n}`);
    console.log(`\n—— ${label} 明细（前 40） ——`);
    for (const h of stat.hits.slice(0, 40)) console.log(`  ${h.file}:${h.line}  ${h.text}`);
    if (stat.hits.length > 40) console.log(`  … 其余 ${stat.hits.length - 40} 条略`);
  }
}

main();
