import * as esbuild from "esbuild";

// 独立服务构建（不是 OpenCode 插件，与 opencode-schedule-cron 的插件式构建无关）：
// 只打包 src/ 自有代码，运行时依赖全部 external、随 node_modules 部署（常驻服务不需要单文件分发）：
// - better-sqlite3：原生模块（.node 二进制），esbuild 本就不能打包；
// - fastify / @tencent-connect/qqbot-nodejs：依赖链含 CJS（avvio、ws 等），打进 ESM bundle 会产生
//   "Dynamic require of node:*" 运行时错误，external 化最稳；
// - @qsense/connector-qq：P2 分仓声明制——插件包宿主不打包（external），运行时经
//   node_modules（workspace 符号链接）解析到其独立 dist 产物（下方第二构建产出），
//   声明制 loadModule(包名) 与静态 import（如 ui.ts 的 QrBindError）解析到同一模块实例，
//   instanceof 跨界不串。@qsense/connector-sdk 是宿主自有契约层，随 bundle 打包（不 external）。
await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  sourcemap: true,
  external: [
    "better-sqlite3",
    "fastify",
    "@tencent-connect/qqbot-nodejs",
    "ws",
    "@qsense/connector-qq",
    "@qsense/connector-telegram",
  ],
});

// connector 插件包独立构建：packages/connector-qq/dist/index.js（ESM，qqbot-nodejs
// external 复用宿主安装的同源副本）。类型层 SDK 引用编译期即消失，产物零 SDK 运行时依赖。
// npm start 前必须先跑本构建（package.json 的 exports.default 指向这里）。
await esbuild.build({
  entryPoints: ["packages/connector-qq/src/index.ts"],
  outfile: "packages/connector-qq/dist/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  sourcemap: true,
  external: ["@tencent-connect/qqbot-nodejs"],
});

// connector-telegram 独立构建：零运行时依赖（Node 20 全局 fetch/FormData/Blob），
// 产物天然自足；core 的 normalize/telegram 以 type-only 引用其类型（编译期消失）。
await esbuild.build({
  entryPoints: ["packages/connector-telegram/src/index.ts"],
  outfile: "packages/connector-telegram/dist/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  sourcemap: true,
});

// connector-weixin 独立构建：零运行时依赖（Node 20 全局 fetch + node:crypto），对 SDK
// 只做类型导入（编译期消失）。协议参照 @tencent-weixin/openclaw-weixin 2.4.10 解包自研，
// 不使用参照包本体。
await esbuild.build({
  entryPoints: ["packages/connector-weixin/src/index.ts"],
  outfile: "packages/connector-weixin/dist/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  sourcemap: true,
});
