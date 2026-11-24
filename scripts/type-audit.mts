// 类型审计（B⁺ T0 验收工具，2026-11-24）：统计全项目 any / unknown / `as X`
// 盲断言的分布，与合法边界白名单 diff，输出增量报告。
//
// 用法：npx tsx scripts/type-audit.mts [--json]
//   默认输出人类可读报告；--json 输出机器可读汇总（供基线归档/后续对比）。
//   退出码恒 0（本脚本是度量工具，不拦截构建；拦截在 tsc 与测试）。
//
// 白名单口径（todo.md「现状盘点」固化）：`raw` / `payload` / `ark` 的
// `: unknown` 标注、`[key: string]: unknown` 透传键、JsonSchema 递归面。
// 这些是刻意的「平台原始载荷不透明边界」，其余 unknown 一律类型化或 schema 化。

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

/** 三类计数：any（目标恒 0）、unknown（白名单外清零）、as 盲断言（白名单外清零） */
function classifyLine(line: string): { any: boolean; unknown: boolean; asAssert: boolean } {
  const code = stripTrailingComment(line);
  return {
    any: /\b(?:as any|:\s*any\b|<any[,>\s]|any\[\])/.test(code),
    unknown: /\bunknown\b/.test(code),
    asAssert: /\bas\s+(?:const\b)/.test(code)
      ? false
      : /\bas\s+(?:[A-Z]\w*|string|number|boolean|bigint|symbol|object|null|undefined)\b/.test(code),
  };
}

/** 剥掉行尾 // 注释（不处理块注释与字符串内 //——审计宁可保守多报，不做语法级解析） */
function stripTrailingComment(line: string): string {
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}

/** unknown 合法边界白名单：命中任一即不计入「白名单外」 */
function whitelistedUnknown(code: string): boolean {
  return (
    /\b(?:raw|payload|ark)\??\s*:\s*unknown\b/.test(code) ||
    /\[\s*key:\s*string\s*\]\??\s*:\s*unknown\b/.test(code) ||
    /\bJsonSchema\b|jsonSchema/.test(code)
  );
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
  const unknownOff: KindStat = { name: "unknown-off", total: 0, hits: [] };
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
        if (!whitelistedUnknown(stripTrailingComment(lines[i]))) {
          unknownOff.total++;
          unknownOff.hits.push(hit);
        }
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
          unknownOffWhitelist: unknownOff.total,
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
  console.log(
    `unknown：${unknownRaw.total} 总（白名单外 ${unknownOff.total}——目标 0）`,
  );
  console.log(`as 盲断言：${asStat.total}（目标 0，白名单见 todo.md）`);
  for (const [label, stat] of [
    ["any", anyStat],
    ["白名单外 unknown", unknownOff],
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
