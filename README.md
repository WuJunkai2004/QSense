# @qsense/connector-weixin

微信连接器插件（QSense P4）：经腾讯 **iLink bot API** 接入微信——扫码配对、`getupdates` 长轮询收消息、`sendmessage` 发消息、CDN 加密收发媒体。零运行时依赖（Node 20 全局 `fetch` + `node:crypto`），对 `@qsense/connector-sdk` 只做类型导入。

> **状态（2026-11-24）**：协议面开发完成，单测覆盖（57 用例，零真实网络）。配对握手段已对微信官方服务端**实测通过**（取二维码 / 状态长轮询）；**收发段待真机验收**（见文末清单）。实验性，协议存在漂移风险。

## 协议来源与红线

- **协议说明书**：`@tencent-weixin/openclaw-weixin` **2.4.10**（npm `latest`；安装器 `@tencent-weixin/openclaw-weixin-cli` 2.1.4 按其 `COMPAT_MATRIX` 装入的版本）解包核对。beta `3.0.0-beta-1` 的线格式类型 / 端点 / 请求头与 2.4.10 **零差异**，只多了可选字段（绑定他人 bot 的实名/防刷票据）与一个新状态（`confirmed_but_need_verifycode`，本包按「需配对码」宽容处理）。
- **红线**：不使用参照包本体（运行时零依赖）、不桥接 OneBot 微信实现、不使用任何注入客户端——参照包只作协议说明书，协议操作在本包自研实现。
- **协议基准版本**：`ILINK_CHANNEL_VERSION`（= `iLink-App-ClientVersion` 与 `base_info.channel_version`）。服务端可能据此做能力门控，**勿随本包版本漂移**；协议升级时连同实现一起改并更新本文。

## 能力面（caps）

| 维度        | 取值   | 说明                                                                                                   |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `scopes`    | chat   | iLink 是 1:1 机器人会话；带 `group_id` 的消息超出能力面，不消费                                          |
| 被动窗口    | false  | 无被动窗口概念，任意时刻可发（须回带入站 `context_token`）→ 发送只走 proactive 通道                      |
| `quota`     | false  | 无官方额度语义；连接器内做发送节流（同一对端 ≥1s，软频控）                                               |
| `recall`    | false  | 协议无撤回通道；调用 `recall` 给可操作错误                                                               |
| 媒体        | 四项   | 图 / 视频 / 文件可发；**语音条出站线格式未核实 → 音频按文件附件降级**；入站语音只取平台转写文本          |
| 文本上限    | 4000   | 码点计，超出给可操作错误（不自动分段）                                                                   |

工具面 = 基座 13，无平台扩展工具。

## 绑定流程

1. `config.toml` 声明 `[connectors.weixin]`（见 `config.toml.example`），重启服务。
2. WebUI「添加机器人」→ 平台选「微信（iLink）」→ 扫码。
3. 服务端后台跑状态机（`get_bot_qrcode` → 长轮询 `get_qrcode_status`），确认后产出凭据，**经宿主中介直接注册**（`verifyCredential` 探活 → 落库 → 拉起轮询）；浏览器只拿到一次性的 agent_token，凭据绝不下发。
4. 也可手动填凭据（`POST /register` 或表单）：`{appid, token[, base_url][, owner_id]}`。`appid` = `ilink_bot_id` 的安全形式（`@` 与 `.` 换成 `-`，如 `abc123@im.bot` → `abc123-im-bot`）。

**token 失效**（轮询报 `errcode -14`，实例转 `fatal`）后：在 WebUI 移除该 bot → 重新扫码注册（agent_token 会更换，需更新宿主侧配置）。凭据热更新暂未提供。

## 协议事实速查（2.4.10 核对）

**传输**：HTTPS + JSON。入口 `https://ilinkai.weixin.qq.com`（账号实际入口以扫码确认应答的 `baseurl` 为准，存进凭据 `base_url`）。

**请求头**：POST 带 `Content-Type: application/json`、`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、`X-WECHAT-UIN`（随机 uint32 的十进制再 base64）、`iLink-App-Id: bot`、`iLink-App-ClientVersion`（`0x00MMNNPP`）；所有请求带后两个。每个 POST 请求体带 `base_info{channel_version, bot_agent}`。

| 端点（均为 POST，除标注外）                    | 用途                                                       |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `ilink/bot/getupdates`                         | 长轮询取消息；体 `{get_updates_buf}`；游标原样回带            |
| `ilink/bot/sendmessage`                        | 发消息；体 `{msg}`；回 `message_id`                         |
| `ilink/bot/getuploadurl`                       | 取 CDN 预签名上传地址                                        |
| `ilink/bot/msg/notifystart` / `notifystop`     | 在线状态对账（启动 / 停止，best-effort）                     |
| `ilink/bot/get_bot_qrcode?bot_type=3`          | 取登录二维码（无 token）；体 `{local_token_list}`             |
| `ilink/bot/get_qrcode_status?qrcode=…`（GET）  | 扫码状态，服务端长轮询挂起；7 态见 `src/qrlogin.ts`          |

**uint64**：`message_id` / `msg_id` / `svr_id` 在线上是 JSON 数字，须先加引号再 `JSON.parse` 才无损（`parseWeixinJson`）。

**消息信封** `WeixinMessage`：`message_id`、`from_user_id`、`message_type`（1 用户 / 2 机器人）、`item_list[]`（`type`：1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频）、`context_token`、`create_time_ms`。引用挂在文本 item 的 `ref_msg`（`svr_id` + 可选 `message_item` 快照 / `title` 摘要 / `partial_text` 选区）。

**出站**：`message_type=2`、`message_state=2`、`from_user_id=""`、`client_id` 客户端生成、`item_list` **恒单项**（配文与媒体分两条发，同一 `run_id`）、`context_token` 原样回带。媒体 `aes_key` 线上编码是 **base64(hex 文本)**（不是 base64(原始字节)），与入站 `parseAesKey` 的第二种编码同形。

**媒体 CDN**：AES-128-ECB + PKCS7。上传 = `getuploadurl`（明文大小 / MD5 / 密文大小 / 随机 16 字节 key 的 hex）→ 密文 POST 到 `upload_full_url` → 回执头 `x-encrypted-param` 即下载参数。下载 = `full_url` 或 `{cdn}/download?encrypted_query_param=…` → 解密。

**错误**：业务错误走应答体 `ret` / `errcode`（HTTP 可能仍 200）；`-14` = bot token 失效。

## 设计决策（与参照实现的差异，均为形态差异而非协议差异）

- **扫码状态机在服务端后台跑**，`poll` 路由即时返回状态——WebUI 是短请求轮询，不能让每个浏览器请求都变成一次 35s 上行长轮询。
- **不自动换码**：前端渲染的二维码内容在任务期内不变，过期由用户点「重新获取」。
- **游标后推进**：批次全部摄取完成后才持久化 `get_updates_buf`（至少一次语义，core 按 msg_id 去重兜底）；参照实现是先存后处理。
- **长轮询超时取服务端建议值 + 5s 余量**，避免与服务端应答同时到点而误废一次请求。
- **`context_token` 单独持久化**（StatePort `ctx-tokens`），入库的 `raw` 里打码——它是出站回带凭据，不随消息行扩散。
- **引用正文三级来源**：服务端快照 → 本地引用缓存（StatePort `quote-cache`，含机器人自发消息）→ `title` 摘要。`quote.msgIdx = msgId = svr_id`，既供 core 懒补被引作者，也在未命中时保有锚点。
- **入站图片摄取期解密内联**（中图 ≤2MB，否则缩略图），以 data:URL 落附件——微信媒体是 CDN 加密的，URL 本身不可用；core 的 `get_media` 通用 `fetch` 即可取图，零改动。语音（SILK）/文件/视频只留元数据。
- **未核实的线上形状不猜**：出站引用、语音条发送均不实现（见下）。

## 风险声明

- **协议非公开文档化**：iLink bot API 由腾讯面向其开源插件下发，无公开稳定契约，可能无预警变更。本包以 2.4.10 为基准并容忍未知扫码状态，但消息 / 媒体字段漂移仍可能导致收发异常。
- **平台条款**：微信对机器人能力、主动发送、内容审核有平台侧控制权，条款可能调整或灰度；使用者需自行确认符合微信相关规定，并对机器人行为负责。
- **凭据与身份**：`bot_token` 是长期凭据（只存服务端 SQLite）；平台只提供 iLink 用户 id，本包不获取、不存储真实微信号。
- **入站图片内联落库**：解密后的图片以 base64 存进 `messages.attachments_json`（单张 ≤2MB），会增大库体积；消息缓存按项目约定不自动清理。

## 待真机验证

已实测（2026-11-24，对 `ilinkai.weixin.qq.com`）：`get_bot_qrcode` 返回 200 与二维码内容；`get_qrcode_status` 被服务端长轮询挂起（未扫码不返回）。

待真人扫码后验收：

1. `confirmed` 应答字段（`bot_token` / `ilink_bot_id` / `baseurl` / `ilink_user_id`）与 `appid` 安全形式是否与实际一致。
2. `getupdates` 的真实消息形状：`item_list` 类型、`message_id` 位数、`context_token` 下发时机、空游标首拉是否回补历史。
3. 出站 `sendmessage` 是否被受理（`context_token` 回带是否必需）、`message_id` 回执。
4. 图片 CDN 下载解密（两种 `aes_key` 编码）、上传直传（`upload_full_url` / 回执头）。
5. 入站语音 `voice_item.text`（平台转写）是否有值。
6. 是否出现 `need_verifycode`（配对码二次校验）——当前流程不支持输入配对码，会以可操作错误终止。
7. `notifystart` / `notifystop` 对有效 / 失效 token 的真实应答（`verifyCredential` 以此探活）。
8. token 有效期与失效信号（`errcode -14` 的实际出现场景）。

## 已知限制

- 出站引用（`quote_msg_id`）不生效：参照实现无发送路径，线上形状未核实，按普通消息发。
- 语音条不能发送（音频按文件附件降级）；入站语音只有转写文本，不内联音频。
- 配对码二次校验（`need_verifycode`）无输入通道。
- token 失效后需移除 bot 重新扫码；凭据热更新与 `binded_redirect` 后的凭据刷新未提供。
- 群聊不支持（协议信封有 `group_id` 字段，但参照实现只做单聊）。

## 文件结构与测试

| 文件            | 职责                                                             |
| --------------- | ---------------------------------------------------------------- |
| `src/api.ts`    | HTTP 客户端：请求头、`base_info`、uint64 无损解析、错误分档       |
| `src/types.ts`  | 线格式类型与协议常量                                              |
| `src/aes.ts`    | AES-128-ECB 原语与两种 key 编码                                   |
| `src/cdn.ts`    | CDN 加密上传 / 下载解密（含重试分档）                             |
| `src/wire.ts`   | 出站素材嗅探、item 组装、无状态句柄编解码                          |
| `src/enrich.ts` | 入站图片解密内联（中图优先 / 缩略图回落 / 尺寸闸门）              |
| `src/quote.ts`  | 引用摘要与局部引用解析                                            |
| `src/parser.ts` | `WeixinMessage` → `NormalizedMessage`（契约 v2，解读权在插件）    |
| `src/qrlogin.ts`| 扫码登录状态机                                                    |
| `src/instance.ts`| 每 bot 实例：长轮询循环、状态持久化、收发原语                     |
| `src/plugin.ts` | 插件声明面（caps / 凭据 / 扫码路由 / 校验钩子）                   |
| `src/texts.ts`  | 包内文案（zh/en）                                                 |

测试位于宿主仓 `test/weixin-*.test.ts`（parser / api / media / connector / qrlogin 五个文件，含 SDK conformance harness 验收），全部使用假 fetch 或本地 HTTP 台架，零真实网络。改协议代码前先核对本文「协议事实速查」与 `test/weixin-api.test.ts`、`test/weixin-media.test.ts` 的规格。
