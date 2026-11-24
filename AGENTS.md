# AGENTS.md — QSense 开发手册（唯一文档）

QQ / Telegram 官方机器人 → MCP 网关。本文件是项目**唯一文档**：架构决策、官方 API 事实、开发约束、踩坑清单都在这里；人类向介绍见 README.md。改代码前先通读本文。

## 当前状态（2026-11-21）

- **v1 全部里程碑（M0–M9）完成**（v0.2.0）：官方 WS 接入、SQLite 缓存、MCP 工具面、发送器、WebUI、多 bot 运行时、富媒体/资产上传、C2C 单聊、扫码配对、`/wait` 长轮询。
- **多平台解耦已完成**：P0 契约 SDK → P1 QQ 收口 → P2 分仓声明制 → P3 存储中立化（迁移 v12）→ P3.5 Telegram 试金石（真机双平台闭环）→ P5 契约 v2（parser 下沉插件、ingest 表驱动）+ 配置 toml 化（迁移 v13，env/`.env` 全面退役）。
- **P4 微信 connector（iLink 逆向）未启动**——见「路线图」。
- 测试基线 **208/208**（`npm test`，零真实网络依赖）。改完必跑。

## 硬约束（违反即返工）

1. **数据源头只允许官方 API**（QQ：q.qq.com / bot.q.qq.com / api.bot.qq.com；Telegram：api.telegram.org）。严禁引入 NapCat / LLOneBot / Lagrange / OpenShamrock 或任何注入客户端的协议端。全链路合规是本项目卖点和生存底线。
2. **交付形态必须是 MCP Server**（Streamable HTTP + Bearer），常驻服务；不是 OpenCode 插件，不是 CLI。
3. 事件接入**固定使用官方 WebSocket Gateway**（QQ，出站长连接，无需公网IP/域名/TLS；Resume 自动补发断线遗漏事件），**不使用 webhook 通道**；Telegram 用 getUpdates 长轮询。接入器与 MCP 同进程。
4. 写操作（send/send_media/recall，request_upload 上传协商同门禁）**默认关闭**：总开关在 kv `settings:runtime`，群白名单在 bots 表 `allow_groups`，经 WebUI 设置页管理、即时落库生效；写工具必须硬拒绝未授权请求。sendAuto 群聊自动把 `<@openid>` 翻译为出站格式 `<qqbot-at-user id="…"/>` 并升级 markdown（msg_type=2）——仅命中 members 名册的 openid 才替换；`<@everyone>` 不自动翻译（需管理员+每日 1 次）。
5. **工具面 = 基座恒定 13 + 本平台声明扩展**（QQ=+1 `quota`）。基座名单见 `src/tools/defs.ts`；平台扩展工具由连接器插件声明，per-session ToolRouter 按 `bots.platform` 聚合——每个 bot 只含自己平台的扩展（Telegram bot=13 无 quota，QQ bot=14）；跨平台调用报归属文案。`POST /register`、`POST /wait`、`GET /docs` 是 HTTP 管理/唤醒/文档面，**不是 MCP 工具**（不进 listTools 断言）。整群删除只在 WebUI（`DELETE /ui/api/groups/:openid`，防消息注入诱导 agent 删数据）；注册是管理面操作，**不要**把删除或注册以任何理由加回工具面。
6. 用户身份只有 open_id（bot 维度隔离，不可逆），**禁止**尝试获取/存储真实QQ号；所有缓存表主键含 `bot_id`。

## 架构速览

- **core（`src/`）平台中立**：MCP 传输与鉴权（Bearer→bot）、基座工具面、存储、发送编排、WebUI 后端。各层 Deps（ToolContext/SenderDeps/SupervisorDeps/UiDeps/ServerDeps/McpDeps）**不持有 Config**——既定解耦形态，别往回传。
- **connector 插件（`packages/connector-*`）纯网络**：连接生命周期、线格式、平台扩展工具与钩子；对 SDK 只允许类型导入，包内文案自包含，不得 import 宿主 `src/`。
- **上行唯一出口 = `host.ingest`**：插件 `normalize`（契约 v2 必备声明）产出成品 `NormalizedMessage` → 信封盖 `platform` 章 → ingest 表驱动按 `payload.platform` 路由 → 通用消息级去重（键=bot:scope:scopeId:msgId）→ 入库 + 效应落地。**新平台 core 零改动进场**。
- **会话侧别权威 = sessions 注册表**（v12）：ingest 入库/开关事件即登记 `(bot_id, session_id) → kind`；`detectSessionKind` 注册表先行、缓存/开关探测降级为兜底——不依赖「群 openid 与用户 openid 命名空间互斥」这一 QQ 保证。
- **发送器不变量**（`src/sender/`，策略半在 core、传输半在插件）：
  - `sendAuto` 被动优先自动路由：窗内可绑消息（群 5min/5次、单聊 60min/4次，跳过自发补记行）→ 被动回复免额度免审；否则主动消息过令牌桶 + 每群每日 1000 条记账。返回 `channel: passive|proactive`。
  - msg_seq 幂等：先 INSERT `sends(status=reserved, payload_hash)`，成功置 sent；同 `reply_msg_id+msg_seq` 重放返回首次结果。
  - 媒体发送 `sendMediaAuto`：官方约束一条消息仅一个 media 对象；`media` 收 `asset:<id>`（推荐）/ http(s) URL / data: base64 小图兜底，**不收本地路径**；上传失败不消耗通道额度。
  - `request_upload` 控制面/数据面分离：一次性 PUT 票据（HMAC 密钥=agent_token，15 分钟时效，落盘即作废），执行环境直传资产区（魔数嗅探把关）——字节全程不进模型上下文。
  - bot 自发消息官方不回推 → 发送成功后本地补记（direction=1），读取层标 `author.role=yourself`。
  - 发送错误语义：**先问插件**（connector-qq `qqSendError`：官方码→可操作文案 + 审核 pending + markdown 降级判定），core i18n 只留平台无关兜底。
  - MESSAGE_AUDIT 回填是启发式（定位最早 pending 行）——出现 304023/304024 审核场景时校准。
- **存储权威 = `src/store/migrations.ts`**（只追加 version N，现到 **v13**；v8 起支持 JS 步骤 `run`，数据重演与 DDL 同事务；同步 `test/store.test.ts` 版本断言）。表清单：
  | 表 | 用途 |
  |---|---|
  | `messages`（+FTS trigram） | 群/私聊合一（scope=group\|chat）；text=本条纯文本（FTS 唯一检索源）、content=渲染 markdown、quote_json/records_count/attachments_json/raw_json（迁移重演权威源） |
  | `message_records` | 聊天记录（102 元素）拍平子消息（ord/depth） |
  | `users` | 身份权威：QQ 昵称 last-write-wins，展示名一律以此为准 |
  | `members` / `groups` | 群名册（消息流自建，无枚举 API）/ 群注册表与开关状态 |
  | `bots` | bot 唯一权威注册表（platform 列、credentials_json、agent_token、双开关、auth_level、allow_groups） |
  | `sessions` | 会话侧别注册表（kind=group\|chat） |
  | `sends` | 发送账本（幂等 + 审计 + 审核回填） |
  | `quota_daily` | 空转保留（QQ 额度记账已走插件 StatePort 计数器，表不删避免重建风险） |
  | `kv` | 已读水位（cursor:*，存 messages rowid）、settings:runtime、admin:token、连接器状态键 |
- **教训（勿重蹈）**：kv 已读水位存 messages 表 rowid——**任何重建 messages 表的迁移都必须同步重定基游标**（v8 漏了导致两个群 get_new 哑火，v9 修复）。生产库升级前先按「手工构造旧版状态→跑增量」演练（`scripts/v8-rehearsal.mts` / `v12-rehearsal.mts` / `v13-rehearsal.mts`）。
- 保留策略：消息**永不自动清理**（人工清理仅 WebUI 整群删除一条通道）。

## 配置与凭证架构（config.toml 唯一权威，勿回退）

- **配置唯一权威 = config.toml**（仓库根，gitignore；入库模板 `config.toml.example`）：顶层服务键 `host`/`port`/`data_dir`/`ui_dist_dir`/`log_content`/`log_level`/`log_format`（全部可省略=缺省，未知键拒绝）+ `[connectors.*]` 平台声明。**服务不读任何环境变量**；例外：`NO_COLOR`/`FORCE_COLOR` 是终端惯例；脚本调用参数类 env（`MCP_TOKEN`/`TELEGRAM_TOKEN`/`DATA_DB` 等）是每次调用的入参不是服务配置。
- **凭据绝不进 toml**（decl.ts 对 connectors.* 未知键硬拒）——bot 凭据唯一权威在 SQLite `bots.credentials_json`（形状由连接器 credentialSchema 权威）；`bots.platform` = 声明名外键，`appid` 列=平台账号 id。
- **双 token**：`/mcp` 只认各 bot 的 agent_token（48hex 明文落 bots 表，1 token=1 bot，轮换旧值立即失效）；`/ui/api` 只认 admin token（kv `admin:token:v1`，首启自动生成并仅打印一次）。
- **平台声明权威 = config.toml**（v13 起）：`[connectors.<platform>]`（package/range/source）驱动启动时 `loadModule(包名)` 动态加载；**存在即启用**（删节=下线）；已注册 bot 的平台缺失 = 启动期 **fail-fast 拒启**（`missingPlatformBots`）；`POST /register`/WebUI 注册的 verifyCredential 同源硬拒绝。插件来源纪律：`file:` 零摩擦；npmjs/github 显式安装 + lockfile 钉版 + 首次人工确认，**启动零隐式网络拉取**。
- 日志：pretty（loguru 风格人类可读，TTY 着色）缺省；`LOG_FORMAT=json` 留给 journald/Docker 采集；两格式同等剥离敏感键。

## WebUI / `ui` submodule（极易踩）

- `ui/` 是 submodule，gitlink 指向**本仓库（QSense）的 `webui` 分支**（`.gitmodules`：url=QSense.git，branch=webui）。本机工作区（2026-11-21 起）：**webui worktree 的实体检出就在 `ui/` 本地**（`ui/.git` 文件 → `.git/worktrees/qqbot-webui`）；仓库外层的 `../webui`（`QSense/webui`）只是指向 `main/ui` 的 NTFS junction，无实体内容，仅为外部路径兼容保留：**严禁运行 `git submodule update`**——会以记录的 SHA 覆盖 worktree，毁掉本地 WebUI 改动。
- git 仍按 submodule 指针处理：MCP 仓库 commit 时 `git add ui` 即推进指针，**不需要** submodule update --remote。
- WebUI 更新流程：直接在 `ui/`（worktree，webui 分支）提交 → `git push origin webui` → 回 MCP 仓库 `git add ui` 推进 gitlink，单独提交推 main（全程快进，不重写历史）。
- `cd ui && npm run build:only` 后服务直接托管新产物（无需重启）。`/ui` 503 "未构建" 先查 `ui/dist` 是否存在。

## 分仓拓扑 / `packages/`

- `packages/connector-sdk`：三面契约（connector/hooks/tools+webui + normalize）+ 闸门（validatePlugin/sdkRange，normalize 必备）+ ToolRouter + conformance harness（normalize-shape 形状断言，connector 仓 CI 须给 normalizeSample）。**宿主自有**，随宿主 bundle 打包，不出包不 external。`NormalizedMessage`/`InboundEffect` 类型族权威在此（`src/message.ts`）。
- `packages/connector-qq`（sdkRange ^2.x，独立仓形态，物理拆出零改动）：
  - root deps 以 `file:packages/connector-qq` 声明（npm workspaces 符号链接进 node_modules）；esbuild external，独立 dist 由 build.mjs 第二构建产出（`exports.default → dist/index.js`，**`npm start` 前必须先 `npm run build`**）。
  - **默认导出 = 工厂** `(init?: {log}) => ConnectorPlugin`；命名导出（createQrBindTask/dailyCountOf/QrBindError/normalizeQqEnvelope/normalizeQqMessage 等）供宿主/测试按需引用——迁移 v8 raw_json 历史重演经 `normalizeQqMessage` 复用。
  - QQ parser 在包内（`src/normalize.ts` + `src/expand.ts`）；额度记账走 StatePort 计数器 `qq:quota:{date}`（北京时间自然日）；包内文案自包含（`src/texts.ts`）。
  - 包内文件：plugin.ts 声明面 / instance.ts 每 bot 网络实例 / net.ts 线格式（wire→msg_type 0/2/7 + message_reference + file_info）/ quota.ts 令牌桶+日额度 / qrbind.ts 扫码绑定 / token.ts·url.ts·intents.ts / errors.ts 发送错误语义 / texts.ts。
  - 协议事实（线格式/官方限制）改动必须先核对本文「QQ 官方 API 关键事实」与 `test/connector-qq-net.test.ts` 规格（真机验证形态，勿改断言）。
- `packages/connector-telegram`（试金石，真机闭环；零运行时依赖）：getUpdates 长轮询 + StatePort 持久化 poll offset（断线补拉）+ 发送 1.2s 节流；parser 在包内（`src/parser.ts`）；ingest 时顺带富化图片缩略图 data: URL。
- **新增一个平台 connector 的完整清单（契约 v2 终态，core 零改动）**：建 `packages/connector-<平台>`（默认导出工厂 + 声明面，**必须实现 normalize**）→ `config.toml` 加一节 `[connectors.<平台>]`（package 必填；npm/github 来源显式安装）→ harness 验收进场。
- 协同纪律（对齐 ui worktree 工作法）：物理拆仓时用 `git subtree split`/复制 + 版本号编排；sdkRange 兼容声明 + 加载时校验 + config.toml range 钉版是三方锁版机制；插件升级先过 harness 再进宿主。

## QQ 官方 API 关键事实（已核实，改动协议代码前先对这段）

- **身份**：只有 openid（bot 维度隔离，同一用户在不同 bot 视角 openid 不同）；无真实 QQ 号。
- **全量群消息**：事件 `GROUP_MESSAGE_CREATE`，intent `GROUP_AND_C2C_EVENT(1<<25)`（真机验证**无需申请**，加 `MESSAGE_AUDIT(1<<27)` 直接 READY）；前提=群主在管理端开「接收所有消息」，开关推送 `GROUP_MSG_RECEIVE/REJECT`；`GROUP_ADD_ROBOT` 入群事件存在；intents **无群成员进出事件**（名册只能从消息流自建）。
- **事件体要点**：`msg_elements` 递归——0=文本、3=ARK 卡片、101=并行消息、102=**聊天记录（递归）**、103=引用（**`content` 字段就是被引原文**，纯媒体被引时为空串——被引图片在元素自带 `attachments` 里，解析归 `quote.attachments`、不混入本条正文/附件，2026-11-24 修复；官方 `parallel_message` 会把被引图渲染成 `"[图片]"` 文本节点）；`message_scene.ext` 的 `msg_idx`=本条自己的引用锚（供他人引用），`ref_msg_idx`=引用目标；`mentions[].is_you` 是「@是否本bot」权威归属（@他人=false；官方未带 mentions=未知）；语音附件带 `voice_wav_url` + `asr_refer_text`（ASR 参考文本）；附件 URL 是限时签名链（rkey），长期可靠的是元数据与文本；测试造消息必须带 `author.member_openid`（群）/`user_openid`（单聊），否则 SDK 抛错丢事件。
- **发送**：`POST /v2/groups/{group_openid}/messages`（100 QPS）；`msg_type` 0=文本 / 2=Markdown（需模板权限，无权限自动降级，官方码 304036）/ 7=富媒体（media.file_info 来自 `POST /v2/groups/{openid}/files` uploadMedia，**file_info TTL 24h、同内容官方去重、可复用**）；可带 `message_reference` 引用（msg_type=7 需 sendRaw 手拼）。群消息不支持流式。
- **被动消息**：带 `msg_id`——群 5 分钟/5 次，单聊（C2C）60 分钟/4 次；`msg_seq` 与 msg_id 联用防重（重复会去重失败）。
- **主动消息**：认证 60 qpm / 未认证 30 qpm；单关系 20/min；**每群每天 1000 条**；用户可关「允许主动发送」（关闭后一律失败）；304023/304024=异步受理进人工审核，结果经 MESSAGE_AUDIT 事件回填。互动召回 `is_wakeup=true`（30 天内分周期各 1 条）未采用。
- **撤回**：`DELETE /v2/groups/{openid}/messages/{message_id}`；机器人须为该群管理员（否则只能撤自己的）。
- **access token**：`POST https://api.bot.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` → `{access_token, expires_in≈7200s}`；重复获取幂等；业务错误经 body `code` 返回且 **HTTP 恒 200**（100016=appid+secret 不配对、11298=源 IP 不在白名单——**白名单只挡 gateway/API 不挡 getAppAccessToken**，凭据校验必须两级：token + fetchGatewayUrl，防假阳性）；SDK TokenManager 已内置缓存+单飞+提前刷新。
- **WS Gateway 生命周期**：`GET /gateway` → `wss://api.bot.qq.com/websocket/`（出站）；op10 Hello（heartbeat_interval）→ op2 Identify（`token: "QQBot {AccessToken}"` + intents）→ READY（session_id 持久化）→ op1/op11 心跳；断线指数退避 → op6 Resume（自动补发遗漏）→ RESUMED；op7=要求重连、op9=参数错（弃 session 重新 Identify）。**官方管理端改动后 WS 会话不自动获得新授权——需重启服务重新 IDENTIFY（RESUME 沿旧会话）**。
- **常用错误码**：304036 无 markdown 权限（降级纯文本）｜304023/304024 审核中｜40034004 富媒体转存失败（重试）｜40034005/304027 回复窗口过期（转主动）｜40034100 主动超频控｜40034010 不允许发 URL（需报备）｜40034101 非群成员（标记失效）｜40054005 消息被去重（msg_seq 未递增）｜40054002 被禁言｜40034006 内容违规｜11298 IP 白名单。
- webhook 回调通道官方存在（端口 80/443/8080/8443，ed25519 验签）——**本项目固定 WS，不采用**，仅备查。
- 常用官方文档：https://bot.q.qq.com/wiki/develop/api-v2/ ｜ 开放平台 https://q.qq.com

## 技术栈与风格

- TypeScript + Node.js ≥ 20，ESM。esbuild external **六件套**：`better-sqlite3`/`fastify`/`@tencent-connect/qqbot-nodejs`/`ws`/`@qsense/connector-qq`/`@qsense/connector-telegram`（CJS 依赖链打进 ESM bundle 会 "Dynamic require of node:*" 崩溃；better-sqlite3 是原生 .node；connector 包独立出 dist，运行时经 node_modules 解析）。`@qsense/connector-sdk` 随 bundle 打包不 external；`smol-toml` 纯 JS 随 bundle 打包。
- s 序号/心跳/RESUME/关闭码语义由官方 SDK `@tencent-connect/qqbot-nodejs` 协议层权威实现；本项目层负责消息级 id 去重、token 生命周期、会话持久化、状态告警。
- better-sqlite3 语句类型必须显式 `Database.Statement<[...参数元组]>`；热路径语句构造器缓存（构造器 prepare，禁 inline 反复 prepare）。
- tsconfig 开着 `noUnusedLocals`/`noUnusedParameters`——死导入/死参数编译期即报。
- 存储更好-sqlite3（同步API，单进程）；FTS5 用 trigram（中文检索），<3 字符查询降级 LIKE。
- 代码风格：全局引擎单例、显式 validate 函数、中文 i18n 文案表（`src/i18n.ts`）、错误消息可操作。所有文件 UTF-8；注释与文档用中文。

## 测试与验收

- 每个功能必须有可重复的自动化验证（mock ws网关单测、resume补发、MCP/发送器/UI API 集成测试），不依赖真实QQ消息。真实联调只在用户可控的测试群（可开全量消息权限）。
- **加/删 MCP 工具必须同步**：`test/mcp.test.ts` 的 listTools 名单断言（已多次因工具数断言过期翻车）+ README 工具面清单。
- MCP 测试的 `client.close()` 必须放 finally（否则 `app.close()` 挂死，表现为测试文件级无输出挂死）；测试清理 rmSync 用 try/catch best-effort（EPERM 会顶掉真正的断言错误）。
- 常用命令：

```bash
npm run build      # tsc --noEmit + esbuild 三构建（改代码后先跑这个）
npm test           # 208 用例全量
npm start          # 起服务（读 config.toml，自动连官方 WS 网关；默认 127.0.0.1:8787）
npm run dev        # build + node --watch
# 停服：netstat -ano | grep ':8787' | grep LISTENING → taskkill //PID <pid> //F
# 单工具调试（token 传某 bot 的 agent_token，admin token 过不了 /mcp）：
#   MCP_TOKEN=<agent_token> CALL_TOOL=list_all CALL_ARGS='{}' npx tsx scripts/mcp-call.mts
```

## 踩坑清单（极易复发，改代码前先读）

1. esbuild external 六件套（CJS 链进 ESM bundle 崩；better-sqlite3 是原生 .node）。
2. `browseBefore/browseLatest` 降序（新→旧）；`qq_context` 升序。
3. FTS5 trigram：unicode61 不分词中文；<3 字符查询降级 LIKE。
4. 迁移只追加 version N + store.test 版本断言同步；**重建 messages 表必须重定基已读水位游标**（v9 教训）。
5. 测试造消息必须带 `author.member_openid`（群）/`user_openid`（单聊）；GROUP_MESSAGE_CREATE 走 onMessage，其余走 onRawEvent。
6. 群注册表证据规则：全量消息→ensureGroup(1)；AT消息→不改开关；ADD_ROBOT→0；RECEIVE/REJECT→1/0；DEL_ROBOT→删行。
7. OpenCode 不读 `{env:...}` MCP header 模板（实测）——Bearer 直接内联进 workspace opencode.jsonc。
8. 工具数断言：M3-2 listTools 名单——加/删工具必须同步（已多次踩）。
9. Fastify DELETE 带 `Content-Type: application/json` 但无 body → FST_ERR_CTP_EMPTY_JSON_BODY 400，请求不进 handler。DELETE 不要带 json 头。
10. 测试里 PORT 不能传 "0"（配置校验 1-65535）；测试 listen 用 `app.listen({port: 0})`。
11. 手写 curl 调 StreamableHTTP：必须 `Accept: application/json, text/event-stream`（缺→406）；initialize 后须发 `notifications/initialized` 再 tools/list。
12. `npx tsx -e` 多行脚本在本机 bash 静默无输出——临时验证逻辑一律落 `scripts/*.mts` 文件跑。
13. `assert.equal`（strict）对 better-sqlite3 `.get()` 返回对象是**引用相等**比较必炸——取字段比；list 顺序断言遇同毫秒时间戳竞态不稳定——集合式断言（`.sort()` 双侧）。
14. pretty 日志着色必须整段条件化（非 TTY 零 ESC，输出文件 `grep -c $'\x1b'` 验零）；验色只 import logger 模块，勿 require dist/index.js（顶层即起服务抢端口）。
15. **活体验证严禁对生产库 PUT 假配置**（曾覆盖用户真实 TTS 配置且 api_key 无法找回）——对真实库验证写端点：要么只读、要么用后恢复、要么 sqlite 直删自造键。
16. `git mv` 对未跟踪文件报 not under version control——新文件用 mv、跟踪文件用 git mv。
17. 管道/head 会吞 `process.exit(1)` 退出码——验证拒启要看文案与是否起服，别信管道退出码。
18. edit 工具大段替换后必须 diff/read 复查——曾把仍有效的相邻约束一并误删。

## 路线图 / 待办

- **P4 微信 connector（iLink 逆向自研，未启动）**：
  - **Spike 硬前置**：精读 `Tencent/openclaw-weixin` 源码逆向协议笔记（配对握手/心跳/信封/媒体收发/签名加密/断线语义），结论三选一：可行/降级/不可行，再投入实现。
  - 形态：`packages/connector-weixin` 纯网络仓——按契约 v2 进场 = 只写 connector 仓 + config.toml 一行声明，core 零改动（harness 验收）。
  - 红线：**不得使用 openclaw-weixin 包本体、不得桥接 OneBot 微信实现**（全是注入式，违反硬约束 #1）——只作协议说明书逆向自研。
  - 风险：iLink 协议逆向不确定（握手/签名可能绑设备指纹）；腾讯条款保留控制权（协议漂移、条款灰度）——pin 参考版本、conformance 回放回归、发送软频控保守默认开启、README 风险声明。
  - 平台语义：仅 chat、无被动窗口、无额度、无 recall（caps 声明，基座自动不出对应工具）；文本上限 4000 字符。
- **P5 收尾遗留**：sender core 残留 QQ 专属文案清理；WebUI 设置页按平台 caps 渲染收尾（quota/认证等级=QQ 专属面板）；微信版告知义务模板；npmjs/github 插件来源安装流程文档（decl.ts 校验已在，装包步骤待写）。
- **勿回退的既定决策**：契约 v2（normalize 必备 + ingest 表驱动 + parser 在插件仓）；config.toml 唯一配置权威（env 退役）；上行唯一出口 host.ingest；基座工具名单恒定 + 注册/删除不进工具面；凭据只落 SQLite；迁移只追加 version N。

## 工作法（用户指令）

- 文件编辑一律用 read+edit 工具，**禁 shell heredoc 改文件**。
- 长标识符/接口名以 `tsc --noEmit` 和测试为事实校验，不凭记忆。

## 禁止事项

- 不得把 AppSecret / agent_token / admin token / 任何密钥提交进 git（`.env` 已删除、`config.toml` gitignore；凭据唯一权威在 SQLite）。
- 不得在日志中记录消息正文（config.toml `log_content=false` 默认关，生产禁止开启）。
- 不得实现官方API之外的任何数据获取通道。
- 不得跳过事件完整性与顺序校验（id去重、s序号）"先把流程跑通"。
