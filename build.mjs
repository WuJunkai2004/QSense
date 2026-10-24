import * as esbuild from "esbuild";

// 独立服务构建（不是 OpenCode 插件，与 opencode-schedule-cron 的插件式构建无关）：
// 单入口单 bundle，tsc 只做类型检查（见 package.json 的 build 脚本）。
// external 两项，均随 node_modules 部署：
// - better-sqlite3：原生模块（.node 二进制），esbuild 本就不能打包；
// - fastify：依赖链（avvio 等）为 CJS，打进 ESM bundle 会产生 "Dynamic require of node:*" 运行时错误，
//   常驻服务不需要单文件分发，external 化最稳。
await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  sourcemap: true,
  external: ["better-sqlite3", "fastify"],
});
