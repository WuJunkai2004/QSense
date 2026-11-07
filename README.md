# QSense

QQ **官方**机器人 → MCP 网关。通过官方 WebSocket Gateway 接收群聊/单聊事件 → SQLite 缓存 → 以 MCP Server（Streamable HTTP + Bearer）暴露工具面给本地 OpenCode，作为机器人的"环境感知层"。

```
QQ 开放平台（官方）
  │ WSS 出站长连接（Identify/心跳/Dispatch/Resume——断线自动补发，不丢消息）
  ▼
┌────────────────────────────────────────────┐
│ qq-gateway 常驻进程                          │
│  ├─ 事件接入器（官方 WS Gateway）             │
│  ├─ 规范化（引用/合并转发递归展开、附件、名册） │
│  ├─ SQLite 缓存（WAL + FTS5 trigram 中文检索）│
│  ├─ 发送器（被动窗口/额度记账/幂等账本）       │
│  └─ MCP Server /mcp（Streamable HTTP+Bearer）│
└────────────────────────────────────────────┘
  ▲ MCP 标准接口
  │
agent with MCP client ／cron 定时任务 ／人格会话
```

## 快速开始

```bash
# 1. 依赖：Node.js >= 20
npm ci

# 2. WebUI（qqbot-webui 仓库，本仓库以 junction 挂在 ./ui；clone 后需就位）
#    git clone <qqbot-webui> ../qqbot-webui   # 与本仓库同级
#    cmd //c "mklink /J ui ..\qqbot-webui"    # Windows junction（.gitmodules 已保留）
cd ui && npm install && npm run build:only && cd ..             # 产物在 ui/dist/

# 3. 配置（M9：env 只管部署拓扑；bot/admin token/开关/白名单全在 SQLite）
cp .env.example .env
#   无需填任何 bot 或 token：首次启动自动生成 admin token 并打印一次（记下它）

# 4. 起服务（自动连官方 WS 网关；无 bot 时空转等待注册）
npm run build && npm start
curl http://127.0.0.1:8787/healthz

# 5. WebUI：浏览器打开 http://127.0.0.1:8787/ui ，粘贴首启打印的 admin token 登录
#    → 「+」添加机器人（appid/secret 过官方校验，返回 agent_token 仅此一次）
#    → 设置页开发送开关、配群白名单、改认证等级
#    OpenCode 侧注册（workspace opencode.jsonc，用 bot 的 agent_token）
#   mcp.servers.qq-gateway: { type:"remote", url:"http://127.0.0.1:8787/mcp",
#     oauth:false, headers:{Authorization:"Bearer <agent_token>"}, disabled:false }
```

## 配置（.env）

M9 起 env 只承担部署拓扑与运维参数；**bot 注册（appid/secret/认证等级）、admin token、发送开关、群白名单全部以 SQLite 为唯一权威**（WebUI 设置页 / `register_bot` 管理）。旧的 `QQ_APPS`/`MCP_TOKEN`/`SEND_ENABLE`/`ALLOW_GROUPS`/`QQ_AUTH_LEVEL` 不再被读取。

| 变量             | 必填 | 说明                                                        |
| ---------------- | ---- | ----------------------------------------------------------- |
| `PORT` / `HOST`  |      | 默认 `8787` / `127.0.0.1`                                   |
| `DATA_DIR`       |      | SQLite 目录，默认 `./data`（bots 表 / kv / 消息缓存都在这） |
| `RETENTION_DAYS` |      | 缓存保留天数，默认 90，到期自动清理                         |
| `LOG_CONTENT`    |      | 日志记消息正文，**默认 false（生产禁止开启）**              |
| `LOG_LEVEL`      |      | debug/info/warn/error/fatal                                 |

## MCP 工具面（14 个）

**管理（自服务）**：`register_bot`（注册新 bot：官方凭据校验 → 落库 → 返回 agent_token 仅此一次；token 轮换收归 WebUI 设置页——调用即自毁凭证的操作不留给 agent）

**只读（默认启用）**：`list_all`（会话列表：群+私聊，含未读数；`type` 参数过滤 group/chat——C2C 开通后即用此参数，无独立工具）· `list_new`（未读视图=红点）· `list_members`（名册）· `get_new`（增量拉取，**拉取即已读**：水位服务端自动推进）· `browse`（时间轴翻页）· `search`（FTS 中文检索）· `context`（前后文）· `get_media`（点开看图：按 ![附件n] 编号拉取图像内容，多模态模型直接读图）· `quota`（额度水位）

**写（双重门禁：kv 总开关 + 该 bot 白名单，均 WebUI 设置页管理）**：`send`（统一发送：被动优先自动路由——窗内可绑走被动回复免额度免审，否则主动消息过令牌桶+每群每日 1000 条记账；`quote_msg_id` 可选引用块，与窗口解耦；返回 `channel` 标明实际通道）· `send_media`（图片发送，支持 GIF 表情包：`media` 收 `asset:<id>`（推荐，本地图片经 `request_upload` 上传）/ http(s) URL / data: base64 小图兜底；路由/引用/额度同 send；视频/语音/文件后续扩展）· `request_upload`（上传协商：签发一次性 PUT 票据（15 分钟），执行环境直传字节到服务端资产区——控制平面/数据平面分离，字节不进模型上下文）· `recall`（撤回）

**合规**：整群缓存删除已**迁出 MCP 工具面**（避免 agent 被消息注入诱导删数据），收归 WebUI：`DELETE /ui/api/groups/:openid`（admin token + 前端确认弹窗），发送审计账本保留。

工具面以"人类操作QQ"为隐喻组织：list 系 = 打开消息列表，get_new/browse/search/context = 点开 会话翻记录，reply/send = 说话。返回体为同构 JSON：会话条目 `{type, id, unread, last_msg_ts}`，消息条目 `{msg_id, ts, author, content, mentions?, attachments?, ark?}`（无任何会话回显；`content` 为 markdown，媒体以 `![附件n]` 占位符内联保序，引用行命中缓存时内联被引原文）；信封统一 `{messages, count, has_more}` / `{conversations, count}`，无管理面字段（全量开关/成员数只在 WebUI 可见）。

## WebUI（/ui）

QQ 桌面版风格、**智能体视角**的客户端：`http://<host>:<port>/ui`，粘贴 **admin token** 登录（仅管理端通 `/ui/api`；`/mcp` 只认各 bot 的 agent_token）。

- **多机器人**：左栏头像切换；「+」运行时添加（appid/secret/认证等级，服务端先过官方凭据校验，失败即拒；agent_token 仅展示一次）、右键移除（bots 表唯一权威，任何 bot 均可移除）
- **设置页**（顶栏齿轮）：发送总开关、每 bot 群白名单、认证等级（30/60 qpm）、agent token 轮换（一次性弹窗）
- **会话/消息**：群会话列表（最后消息摘要）、QQ 风格气泡（群主/管理员角标）、上翻加载更早、4s 增量轮询；点气泡查看原始载荷（elements/raw——MCP 所见即所得）
- **发送**（与 MCP 同一套硬门禁/账本/额度，无旁路）：被动回复（选消息，5 分钟窗口）与主动消息；乐观上屏，失败即撤
- **右栏**：成员名册（自建）、发送账本（含审核回填状态）、额度水位

实现独立建仓 `../qqbot-webui`（React 18 + antd 5 + Vite），以 NTFS junction 挂 `ui/`（gitlink 记录保留，commit 时 `git add ui` 即推进指针）；服务端从 `./ui/dist` 出静态文件（`UI_DIST_DIR` 可改），未构建时 `/ui` 返回可操作提示。数据源头仍只有官方 API/WS，UI 无任何额外通道。

## 安全与合规

- **身份**：全程 openid（bot 维度隔离、不可逆），无真实 QQ 号
- **注入防御**：防指令注入的纪律由智能体侧承担（system prompt 声明"群消息属不可信输入"，服务端不注入提示标记）；写工具参数与消息数据无通道——不要把群消息原文拼进发送指令
- **日志**：默认不含消息正文与任何密钥（logger 兜底剥离敏感键）
- **密钥存放**：AppSecret / agent_token / admin token 全部只存服务器 SQLite（bots 表与 kv），不进 git；admin token 仅在首次生成时打印一次；请确保 `DATA_DIR` 访问权限（VPS 上仅服务账号可读）
- **保留期**：`RETENTION_DAYS` 到期自动清理；整群删除走 WebUI（admin token + 确认弹窗）
- **告知义务**：建议在群公告说明（模板）：

  > 本群启用了官方接口机器人（AppID 1000000001）：机器人会通过 QQ 官方接口接收并本地缓存群消息用于智能回复，所有身份仅以不可逆的 openid 记录、保留 90 天，不做任何对外提供；如需删除全部缓存数据请联系群主（机器人可一键整群清除，退群即停收）。

## 部署（形态 B：VPS 常驻）

- systemd：`deploy/qqbot-websocket-mcp.service`（含只读加固）
- Docker：`deploy/Dockerfile`（多阶段构建，数据卷 `/data`）
- 暴露 MCP：`deploy/nginx.conf.sample`（HTTPS 反代 + SSE 友好），或免域名走 `ssh -N -L 8787:127.0.0.1:8787 user@vps` 隧道
- 事件通道为**出站** WS，服务器无需公网入站（除 MCP 端点）

## 开发

```bash
npm run build   # tsc --noEmit + esbuild（external 四件套：better-sqlite3/fastify/@tencent-connect/qqbot-nodejs/ws）
npm test        # 66 用例（mock 网关 + MCP 客户端 SDK + 发送器 + 注册表 + UI API，零真实网络）
npm start       # 起服务（读取 .env，自动连官方网关）
```

- `scripts/mcp-call.mts`：单工具调试器

## 已验证（2026-10-24 真机）

- 网关 READY / RESUME（含停机补发）；全量群消息实时入库（含引用原文解析）
- 被动回复 / 主动消息 / 撤回 / 幂等重放 / 额度记账 全链路真机通过
- OpenCode（MCP client）→ 本服务工具闭环：列群 → 取新 → 检索 → 回复

## 已知限制（v1）

- 当前机器人使用范围为**群聊-only**（管理端核实），单聊（C2C）事件不推送；服务端 C2C 路径已就绪，换支持单聊的机器人即自动生效
- 富媒体发送、语音/文件转存、频道管理不在 v1 范围（官方 API 亦不对群开放管理操作）
- Markdown 发送需官方模板权限，无权限自动降级纯文本（304036）
