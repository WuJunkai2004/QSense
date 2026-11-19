// GET /docs 返回的调用契约（text/markdown）。受众是 AI 智能体与写胶水脚本的
// 人类：把 /register（无 UI 注册）与 /wait 的完整调用方法（鉴权/参数/filter
// 真值表/响应/curl 配方/宿主集成两模式）放在网关自身，任何宿主拿到地址即可
// 自举，无需外部文档。

export const DOCS_MARKDOWN = `# QSense Gateway API 文档

QQ/Telegram 官方机器人 → MCP 多平台网关。同一进程暴露：

| 端点 | 用途 | 鉴权 |
|---|---|---|
| \`POST /mcp\` | MCP 工具面（Streamable HTTP）：list_all / get_new / send 等 | Bearer **agent_token**（每 bot 一把） |
| \`POST /wait\` | 长轮询事件唤醒：新消息命中过滤器即返回（本页重点） | Bearer **agent_token**（与 /mcp 同一把） |
| \`POST /register\` | 注册新 bot（无 UI 时的机器通道），返回一次性 agent_token | Bearer **admin token** |
| \`GET /docs\` | 本文档 | 无 |
| \`GET /healthz\` | 存活探针 | 无 |
| \`/ui\` | 管理界面 | admin token（浏览器） |

**双 token 纪律**：agent_token 只通 \`/mcp\` 与 \`/wait\`；admin token 只通 \`/ui/api\` 与
\`/register\`。token 来源：注册响应返回值（\`POST /register\` 或 WebUI 添加机器人，
**仅此一次**）；丢失请在 WebUI 设置页轮换。bot 的「MCP 访问」开关关闭后，该 token 的
\`/mcp\` 与 \`/wait\` 一律 403。

---

## POST /register —— 注册新 bot（无 UI 时的机器通道）

注册是**管理面操作**：MCP 工具面不含注册工具——智能体不应在对话里自助注册 bot
（返回值是一次性 agent_token，属人的运维决策）。有 WebUI 时走「添加机器人」；
无 UI 环境（VPS 首次部署、脚本化自举）用本端点。

### 请求

\`\`\`
POST /register
Authorization: Bearer <admin_token>
Content-Type: application/json

{ "platform": "qq", "credentials": { "appid": "…", "secret": "…" }, "name": "备注名", "auth_level": "uncertified" }
\`\`\`

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| \`platform\` | string | \`"qq"\` | 平台 id；可用平台 = config.toml \`[connectors.*]\` 声明（未声明的平台硬拒） |
| \`credentials\` | 对象 | **必填** | 平台凭据键值对，字段由该平台连接器声明权威（QQ=\`{appid, secret}\`，q.qq.com → 开发设置获取） |
| \`name\` | string | 账号 id | 备注名 |
| \`auth_level\` | string | \`uncertified\` | QQ 平台语义：主动消息频控预算 \`certified\`=60条/分、\`uncertified\`=30条/分 |

各平台凭据形状（由该平台连接器声明权威）：QQ=\`{"appid":"…","secret":"…"}\`；
Telegram=\`{"appid":"<bot数字id>","token":"<BotFather token，形如 123456:AA-xxx>"}\`。

服务端先过**官方凭据校验**（平台连接器 verifyCredential，未过官方校验绝不入库），
落库后自动拉起该 bot 的网关连接，返回：

\`\`\`json
{ "ok": true, "bot": { "appid": "1905935479", "platform": "qq", "name": "雅南" }, "agent_token": "<48hex，仅此一次>", "note": "…" }
\`\`\`

**错误**：401 admin token 缺失/错误；400 凭据校验被官方拒绝、bot 重复注册、
credentials 形状非法、auth_level 非法（错误消息指出具体原因）。

### curl 配方

\`\`\`bash
curl -sS -X POST http://127.0.0.1:8787/register \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"platform":"qq","credentials":{"appid":"…","secret":"…"},"name":"雅南"}'
\`\`\`

拿到 \`agent_token\` 后即可用它连接 \`/mcp\` 与 \`/wait\`（见上文）。

---

## POST /wait —— 长轮询事件唤醒

**架构契约（先读这段）**：网关只负责「吐事件 + 未读快照」，**绝不拉起任何智能体**。
谁消费本端点、何时唤醒、用什么调度器（cron / systemd / Codex 内部任务），全部是宿主
侧的事。拿到事件后请**仍经 MCP \`get_new\` 按水位消费**（拉取即已读，不会重复）；
\`/wait\` 只回答「什么时候值得去查」。

### 请求

\`\`\`
POST /wait
Authorization: Bearer <agent_token>
Content-Type: application/json

{ "filter": {...}, "hold": 30 }
\`\`\`

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| \`filter\` | 对象或对象数组 | \`{}\`（all） | 过滤器；传数组 = 跨对象 OR（DNF），最多 10 项 |
| \`hold\` | 整数秒 1-600 | 30 | 挂起时长；到点无命中返回 \`{timeout:true}\` |

**filter 四谓词**（单对象内跨字段 AND，数组字段内 OR）：

| 字段 | 类型 | 语义 |
|---|---|---|
| \`scope\` | \`"group"\\|\"chat\"\` | 只匹配群聊 / 只匹配私聊 |
| \`sessions\` | string[] ≤50 | 会话 id 白名单（= \`list_all\` 返回的 \`conversations[].id\`；私聊 id 即对方 openid） |
| \`authors\` | string[] ≤50 | 作者 openid 白名单（**此人无论在哪个会话发言都命中**） |
| \`mention\` | true | 「有人在找我」：群里 @本bot，或任何私聊消息 |

⚠️ **sessions 与 authors 的区别**：\`{"sessions":["某人的openid"]}\` 只命中「与该人的
**私聊会话**」里的消息——他在群里的发言属于另一个会话，**不会**命中；想「他到处发言
都叫我」请用 \`authors\`。

⚠️ **mention 判定口径**：QQ 经官方事件体 \`mentions[].is_you\` 权威判定「@是否本bot」
（@本bot=true；@普通用户或别的bot=false；AT 事件与全量消息事件口径一致）。仅当官方
载荷意外缺失该字段时回退**从宽**（含任意 @ 即命中，宁可多醒不漏醒）。Telegram 侧
经 getMe 身份比对，判定精确。

### 常用场景真值表

| 需求 | filter |
|---|---|
| 任何消息都叫我 | \`{}\`（或缺省） |
| 某人的私聊 | \`{"sessions":["<openid>"]}\` |
| 特定群里的 @ | \`{"sessions":["<群id>"],"mention":true}\` |
| 所有群里的 @ | \`{"scope":"group","mention":true}\` |
| 有人找我（群@我 或 任何私聊） | \`{"mention":true}\` |
| 某人在任何地方发言 | \`{"authors":["<openid>"]}\` |
| 特定群的所有消息 | \`{"sessions":["<群id>"]}\` |
| 群A的@ 或 老板私聊我 | \`[{"scope":"group","mention":true},{"scope":"chat","authors":["<老板openid>"]}]\` |

### 响应

**命中**（HTTP 200，长轮询返回）：

\`\`\`json
{
  "timeout": false,
  "events": [{ "id": "<会话id>", "scope": "group" }],
  "unread": [{ "id": "<会话id>", "scope": "group", "unread": 3, "last_ts": 1731910000000 }]
}
\`\`\`

- \`events\`：本次触发唤醒的会话（防抖窗口内按会话聚合）。
- \`unread\`：**全量未读快照**（unread>0 的会话，list_new 同源数据）——醒来直接按
  id 逐个 \`get_new\` 消费即可，无需再调 \`list_new\`。

**超时**：\`{"timeout": true, "events": [], "unread": []}\`（HTTP 200）。消费端直接
重挂下一棒即可。

**其他**：401 token 无效；403 MCP 访问被禁用；400 filter/hold 非法（错误消息会指出
具体字段）；429 该 bot 并发 waiter 超上限（≤4，请复用挂起请求）。

**保活**：hold 期间服务端每 15 秒写一个换行字节（JSON 前导空白，解析不受影响），
用于穿透 NAT/代理空闲超时并即时察觉断链。curl 建议 \`--max-time\` 略大于 hold。

### curl 配方

一次性挂起 55 秒（有人找我才醒）：

\`\`\`bash
curl -sS --max-time 60 -X POST http://127.0.0.1:8787/wait \\
  -H "Authorization: Bearer $AGENT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"filter":{"mention":true},"hold":55}'
\`\`\`

外部守护脚本（几十行即可接上，与网关零耦合）：

\`\`\`bash
while true; do
  resp=$(curl -sS --max-time 65 -X POST http://127.0.0.1:8787/wait \\
    -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \\
    -d '{"filter":{"mention":true},"hold":60}')
  if echo "$resp" | grep -q '"timeout": false'; then
    # 有事发生：把 resp（含未读快照）拼进启动词，拉起一次性 session 干完就退
    your-agent-runner "有新消息被叫醒，快照：$resp"
  fi
done
\`\`\`

### 宿主集成的两种模式

1. **外部守护**：上面的 while 循环脚本（systemd service 常驻）。网关不知道脚本存在。
2. **宿主内接力**（宿主自带调度器/后台任务时）：主调度器把一条阻塞的 /wait 请求挂到
   后台，自己休眠；请求返回（被唤醒或超时）即醒，拉一个**全新干净 session** 处理
   快照，再把下一棒 /wait 挂回后台。无需外部脚本，空转零 token。
3. 两种模式与「10 分钟定时兜底」并存不冲突：双醒时消费幂等（get_new 水位）。

### 边界

- \`receive_enabled=0\` 的 bot：网关不接入该平台，无事件产生，/wait 只会超时。
- 事件粒度是「会话有新消息」，不是消息内容本身——内容一律经 MCP 工具消费
  （内容不过脚本，避免绕过工具面的权限与审计）。
- 本端点不属于 MCP 工具面，不计入基座 13 + 平台扩展的工具清单。
`;
