// 类型审计：统计全项目弱类型与盲断言的分布。
// 计数类别：any / unknown / 万能字典 / object / as 断言。
//
// 用法：npx tsx scripts/type-audit.mts [--json]
//   默认输出人类可读报告；--json 输出机器可读汇总。
//   退出码恒 0（度量工具，不拦截构建；拦截在 tsc 与测试）。
//
// 约束：源码不出现 unknown、JsonValue、Record<string, unknown|any> 等无结构类型。
// 动态边界用 zod 解析为具体类型；平台原始载荷类型隔离在各插件，禁止进入 core。
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

/** 五类计数：any / unknown / 万能字典 / object 目标恒 0；as 断言逐步清零 */
function classifyLine(line: string): {
  any: boolean;
  unknown: boolean;
  megaDict: boolean;
  weakObject: boolean;
  asAssert: boolean;
} {
  const code = stripComment(line);
  // 引号/反引号内整段字符串剥离：日志文案或状态字面量里的英文单词（如 "unknown"）
  // 不是类型标注（类型标注不会出现在字符串字面量里）
  const bare = code
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return {
    any: /\b(?:as any|:\s*any\b|<any[,>\s]|any\[\])/.test(code),
    unknown: /\bunknown\b/.test(bare),
    megaDict:
      /\bJsonValue\b/.test(code) ||
      /Record<\s*string\s*,\s*(?:unknown|any|never)\s*>/.test(code) ||
      /\[\s*key:\s*string\s*\]\??\s*:\s*(?:unknown|any)\b/.test(code),
    // object 是万能代指：`: object` / `<object>` / `as object` / `object[]` /
    // `Promise<object>` 均违禁——具体形状用接口/联合/泛型表达
    weakObject:
      /:\s*object\b/.test(code) ||
      /<object>/.test(code) ||
      /\bas\s+object\b/.test(code) ||
      /object\[\]/.test(code),
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
  const weakObject: KindStat = { name: "weak-object", total: 0, hits: [] };
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
      if (cls.weakObject) {
        weakObject.total++;
        weakObject.hits.push(hit);
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
          weakObject: weakObject.total,
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
  console.log(`object 弱类型：${weakObject.total}（object 万能代指违禁，目标 0）`);
  console.log(`as 盲断言：${asStat.total}（目标 0，白名单见 todo.md）`);
  for (const [label, stat] of [
    ["any", anyStat],
    ["unknown", unknownRaw],
    ["万能字典", megaDict],
    ["object 弱类型", weakObject],
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
