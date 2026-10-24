# qqbot-webui

QQ Bot 网关的 WebUI：**QQ 桌面版风格、智能体视角的客户端**。由 [`qqbot-websocket-mcp`](../qqbot-websocket-mcp) 以 git submodule 形式挂载在 `ui/`，并托管于 `http://<host>:<port>/ui`。

React 18 + antd 5 + Vite 构建，产物为纯静态文件（`dist/`），由 MCP 服务（Fastify）直接出。

## 功能

- **鉴权**：登录页粘贴 `MCP_TOKEN`（与 `/mcp` 同一 token），localStorage 保存，`Authorization: Bearer` 携带；401 自动回落登录页
- **多机器人**：左栏头像切换；运行时添加（输入 AppID/AppSecret，服务端先拉官方 access_token 校验，免重启接入）、右键移除（仅运行时 bot；`QQ_APPS` 配置 bot 需改配置文件）
- **会话列表**：按最后消息排序、搜索（群 openid/备注/消息摘要）、备注名（仅本机）
- **消息流**：QQ 风格气泡（群主/管理员角标）、上翻加载更早、4s 增量轮询；点气泡看**原始载荷**（elements/mentions/attachments/ark/raw——MCP 工具所见即所得）
- **发送**（与 MCP 同一套硬门禁：`SEND_ENABLE=true` + 群白名单）：被动回复（选消息，5 分钟窗口）与主动消息（额度提示），乐观上屏，失败即撤
- **右栏**：群资料与成员名册（自建）、发送账本（含审核回填状态）、额度水位（令牌桶快照）

## 开发

```bash
npm install
npm run dev        # http://localhost:5173，/ui/api 代理到 127.0.0.1:8787
```

## 构建与部署

```bash
npm run build      # 产物 dist/
```

MCP 侧默认从 `./ui/dist` 读取（`UI_DIST_DIR` 环境变量可改）。完整步骤：

```bash
cd qqbot-websocket-mcp
git submodule update --init ui   # 首次
cd ui && npm install && npm run build
cd .. && npm run build && npm start
# 浏览器打开 http://127.0.0.1:8787/ui，粘贴 MCP_TOKEN 登录
```

## 安全说明

- AppSecret：运行时添加的 bot 存于服务端 SQLite `kv` 表（`bots:dynamic:v1`）——用户知情决策（2026-10-24），换取免重启添加；`QQ_APPS` 的 secret 仍只在 `.env`
- token：仅存浏览器 localStorage；API 全部走 Bearer 头，无 cookie，无 CSRF 面
- 消息正文只在内存渲染，不入浏览器持久化存储

## 数据源头声明

本 UI 不引入任何额外数据通道，全部数据来自 `qqbot-websocket-mcp` 的缓存（源头为 QQ 官方机器人 API/WS Gateway），发送亦经其 Sender（官方 API + 门禁 + 账本）。
