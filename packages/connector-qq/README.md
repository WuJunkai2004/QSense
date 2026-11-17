# @qsense/connector-qq

QSense QQ 官方机器人连接器插件。QQ 专属语义（WS 网关/token/线格式/额度/扫码配对）全在这里；core 是平台中立宿主。

## 形态（P2 独立仓，物理拆出零改动）

- root 仓以 **file: 依赖**引用（`"@qsense/connector-qq": "file:packages/connector-qq"`），npm workspaces 符号链接进 node_modules；宿主 esbuild 将其 **external**，运行时经 node_modules 解析到本包 **dist 产物**（`exports.default → dist/index.js`，由宿主 `build.mjs` 第二构建产出；`npm start` 前必须先 `npm run build`）。
- **默认导出 = 插件工厂**：`(init?: { log }) => ConnectorPlugin`。宿主 `loadModule(包名)`（SDK）动态 import 后注入宿主日志器。命名导出（`createQqConnector`/`createQrBindTask`/`dailyCountOf`/`beijingDate`/`QrBindError` 等）供宿主与测试按需引用。
- **sdkRange**（`^1.0.0`）对宿主 SDK 契约版本做加载时校验——三方（SDK→connector→宿主）锁版的唯一机制。

## 纪律

- **不得 import 宿主 `src/`**（含 i18n）：包内文案自包含（`src/texts.ts`），分仓后零宿主依赖。
- 对 `@qsense/connector-sdk` **只允许类型导入**（`import type`）：产物零 SDK 运行时依赖，`@tencent-connect/qqbot-nodejs` 是唯一 peerDependency（与宿主同源副本，SDK 类不跨包 instanceof）。
- 协议事实（线格式/官方限制常量）改动必须先核对 API-FACTS.md 与 `test/connector-qq-net.test.ts` 规格（真机验证形态，勿改断言）。
- 物理拆仓步骤（未来执行）：复制本目录为新 git 仓 → 宿主 root deps 改版本号引用 → connectors 表 package 不变（包名即声明）→ harness 全绿后发布。

## 目录

| 文件 | 职责 |
|---|---|
| `src/plugin.ts` | 声明面：caps/credentialSchema/login(qr-pair)/tools(quota)/hooks/webui + 工厂 |
| `src/instance.ts` | 每 bot 纯网络实例（GatewayConnection 生命周期/会话 StatePort/上行 host.ingest） |
| `src/net.ts` | 线格式组装（wire → msg_type 0/2/7 + message_reference + file_info）+ ConnectorNet |
| `src/quota.ts` | 令牌桶 + 日额度（StatePort 计数器 `qq:quota:{date}`，北京时间自然日） |
| `src/qrbind.ts` | q.qq.com lite 扫码绑定（bind_key 端到端解密 AppSecret） |
| `src/token.ts` / `src/url.ts` / `src/intents.ts` | access_token / 网关地址 / intents 订阅掩码 |
| `src/texts.ts` | 自包含文案（zh/en，进程内语言检测） |
