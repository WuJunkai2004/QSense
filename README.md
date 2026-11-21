# QSense

QQ / Telegram **官方**机器人 → MCP 网关。

机器人经官方接口收到的群聊、私聊消息被缓存在本地 SQLite，再以 MCP 工具的形式提供给本地 AI 客户端（如 OpenCode），让智能体具备"读群、记忆、发言"的环境感知能力。附带一个 QQ 桌面风格的 WebUI，供人类管理机器人、控制发送、浏览消息。

**合规是生存底线**：数据只来自官方 API，事件走官方 WebSocket Gateway（出站长连接，无需公网 IP / 域名 / TLS），不使用任何注入式协议端。

```
QQ / Telegram 官方服务器
   │  官方 WebSocket / 长轮询（出站，无需公网入站）
   ▼
┌───────────────────────────────────────────────┐
│ QSense 常驻服务（默认 127.0.0.1:8787）          │
│  ├─ 连接器插件（connector-qq / connector-telegram）│
│  ├─ 消息规范化 + SQLite 全量缓存（中文全文检索）  │
│  ├─ 发送器（被动窗口 / 额度记账 / 幂等账本）      │
│  ├─ MCP   /mcp（Streamable HTTP + Bearer）      │
│  ├─ 唤醒  /wait（长轮询事件）                    │
│  └─ WebUI /ui（人类管理端）                      │
└───────────────────────────────────────────────┘
   ▲ MCP 标准接口
   │
AI 客户端（OpenCode 等）· cron 定时任务
```

## 快速开始

前置：Node.js ≥ 20。

```bash
# 1. 安装依赖
npm ci

# 2. 构建 WebUI（ui 是 submodule，指向本仓库的 webui 分支）
cd ui && npm install && npm run build:only && cd ..

# 3. 生成配置（config.toml 是唯一配置权威；bot 凭据绝不写进这里）
cp config.toml.example config.toml

# 4. 构建并启动（未注册 bot 时空转等待）
npm run build && npm start
```

首次启动会在日志里**打印一次 admin token**（之后不再显示），用它登录 `http://127.0.0.1:8787/ui`，在「添加机器人」里填 appid/secret（服务端先过官方校验），得到只显示一次的 agent_token。

让 AI 客户端连上（以 OpenCode 为例，workspace 根 `opencode.jsonc`）：

```jsonc
{
  "mcp": {
    "servers": {
      "qq": {
        "type": "remote",
        "url": "http://127.0.0.1:8787/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer <该 bot 的 agent_token>" },
        "disabled": false,
      },
    },
  },
}
```

## 配置（config.toml）

| 键                         | 缺省              | 说明                                    |
| -------------------------- | ----------------- | --------------------------------------- |
| `host` / `port`            | 127.0.0.1 / 8787  | 反代或跨机访问时改 `0.0.0.0`            |
| `data_dir`                 | `./data`          | SQLite 目录（bot 注册、消息缓存都在这） |
| `ui_dist_dir`              | `./ui/dist`       | WebUI 静态产物目录                      |
| `log_content`              | `false`           | 日志记录消息正文，**生产禁止开启**      |
| `log_level` / `log_format` | `info` / `pretty` | pretty 人类可读 / json 给采集端         |
| `[connectors.*]`           | （无）            | 平台声明：存在即启用，详见模板注释      |

bot 的 appid/secret、agent_token、发送开关、群白名单全部存 SQLite，经 WebUI 或 `POST /register`（admin token）管理——**凭据绝不进 toml、不进 git**。

## MCP 工具面（基座 13 + 平台扩展）

| 类别                   | 工具                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| 会话                   | `list_all` / `list_new` / `list_members`                                                              |
| 读取                   | `get_new`（拉取即已读）/ `browse` / `search`（中文全文检索）/ `context` / `get_records` / `get_media` |
| 写（默认关，双重门禁） | `send` / `send_media` / `request_upload` / `recall`                                                   |
| 平台扩展               | `quota`（QQ 专属；每个 bot 只能看到自己平台的扩展工具）                                               |

- 会话标识统一用 `id`（= `list_all` 返回的 `conversations[].id`），群聊/私聊侧别由服务端自动探测，读写工具均无 `type` 参数。
- 智能体不能删除数据、不能注册 bot——破坏性与管理面操作只留给人类（WebUI / `POST /register`）。
- 完整调用契约（参数、返回形状、curl 配方）由运行中的服务提供：`GET /docs`。

## 事件唤醒（POST /wait）

长轮询"有事才醒"：新消息命中过滤条件（`scope` / `sessions` / `authors` / `mention`）立即返回事件和未读快照，否则挂起到超时。网关只吐事件，**绝不拉起智能体**；谁消费、何时唤醒由宿主自己决定，与定时巡检兜底天然共存。

## WebUI（/ui）

admin token 登录。功能：多机器人管理（运行时添加/移除、扫码配对）、发送总开关与群白名单、每 bot 接收/MCP 独立开关、agent token 轮换、消息浏览与发送（与 MCP 同一套门禁，无旁路）、成员名册、发送账本与额度水位、整群数据删除（二次确认）。

## 安全与合规

- 身份全程 openid（bot 维度隔离、不可逆），不获取、不存储真实 QQ 号
- 日志默认不含消息正文，敏感键自动剥离
- AppSecret / agent_token / admin token 只存服务器 SQLite；admin token 仅首启打印一次
- 消息缓存**永不自动清理**；唯一删除通道是 WebUI 整群删除（admin + 二次确认）
- 建议在群公告告知机器人存在与数据用途：

  > 本群启用了官方接口机器人：机器人会通过官方接口接收并本地缓存群消息用于智能回复，所有身份仅以不可逆的 openid 记录、长期保存（不自动清理），不做任何对外提供；如需删除全部缓存数据请联系群主。

## 开发

```bash
npm run build   # tsc --noEmit + esbuild 三构建（宿主 + 两个 connector dist）
npm test        # 208 用例全量（零真实网络依赖），改完必跑
npm start       # 起服务（读 config.toml，自动连官方网关）
```

目录速览：

| 路径                           | 内容                                                 |
| ------------------------------ | ---------------------------------------------------- |
| `src/`                         | core：MCP / 存储 / 发送编排 / WebUI 后端（平台中立） |
| `packages/connector-sdk/`      | 三面契约 + 加载闸门 + conformance harness            |
| `packages/connector-qq/`       | QQ 连接器插件（WS 网关 / 线格式 / 额度 / 扫码配对）  |
| `packages/connector-telegram/` | Telegram 连接器插件                                  |
| `ui/`                          | WebUI 前端（submodule，webui 分支）                  |
| `test/`                        | 全量测试                                             |
| `scripts/`                     | 运维 / 迁移演练 / 单工具调试脚本                     |

架构决策、官方 API 事实、开发约束与踩坑清单见 **AGENTS.md**（面向智能体与接续开发的唯一文档）。
