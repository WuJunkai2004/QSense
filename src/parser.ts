// Telegram parser（P5 契约 v2 自 core 下沉，2026-11-17）：Update → NormalizedMessage
// + InboundEffect。解读权在插件（决策 #8）——core ingest 表驱动按 payload.platform
// 路由到 plugin.normalize，core 不再持有任何平台 parser（src/normalize/telegram.ts 已删）。
//
// 映射决策（每条都是平台语义翻译，不是猜测）：
// - scope：chat.type=private → "chat"；group/supergroup → "group"（channel 不消费）
// - 会话/成员 id：chat.id / from.id 十进制字符串（Telegram 数字 id 在群/私聊间
//   群为负、私聊为正，天然不撞；sessions 注册表已消除对命名空间互斥的依赖）
// - msg_id：message_id 十进制字符串（chat 内唯一，与 (bot,scope,scope_id) 主键一致）
// - 私聊 opt-in 等价映射：Telegram 无 C2C_MSG_RECEIVE 事件，私聊消息即视为
//   用户在场同意（chat-opt 效应，core 落 setC2cSwitch true）——发送门禁语义对齐 QQ 模型
// - 群注册表：群消息即全量在册证据（privacy 关闭后推送全量消息）→ group-seen fullMsg=true
// - 引用：reply_to_message → quote_json（msgId=被引 message_id；body 快照首 50 字）
// - 附件：photo/voice/video/document → ![附件n] 约定（url 来自摄取期缩略图富化
//   mediaBlobs——connector 网络职责，core 只消费）；缩略图缺失时 url 为空串
// - 无聊天记录（102）等价物：records 恒空；无 ark 卡片；无 msg_idx 令牌

import type {
  NormalizedAttachment,
  NormalizedInbound,
  NormalizedMessage,
  NormalizedMention,
  MsgScope,
} from "@qsense/connector-sdk";
import type {
  TelegramInboundPayload,
  TelegramMessage,
  TelegramUser,
} from "./api";

function userNameOf(u: TelegramUser | undefined): string | undefined {
  if (u === undefined) return undefined;
  const name = [u.first_name, u.last_name].filter((s) => typeof s === "string" && s !== "").join(" ").trim();
  return name === "" ? undefined : name;
}

/** 实体 → mentions（mention=@username 文本切片；text_mention 带用户对象）。
 * 实体结构由 wire schema 保证（type/offset/length/user 已类型化）——无防御 typeof。 */
function parseMentions(
  msg: TelegramMessage,
): NormalizedMention[] {
  const text = msg.text ?? "";
  const out: NormalizedMention[] = [];
  for (const e of msg.entities ?? []) {
    if (e.type === undefined || e.offset === undefined || e.length === undefined) continue;
    if (e.offset < 0 || e.length <= 0 || e.offset + e.length > text.length) continue;
    const slice = text.slice(e.offset, e.offset + e.length);
    if (e.type === "mention") {
      out.push({ id: slice }); // @username（Telegram 侧定位标识）
    } else if (e.type === "text_mention" && e.user !== undefined) {
      out.push({ id: String(e.user.id), name: userNameOf(e.user) });
    }
  }
  return out;
}

/** 自身身份（getMe；atMe 判定依据） */
export interface TelegramSelf {
  id: number;
  username?: string;
}

/** 群消息是否 @ 本 bot：text_mention 比对数字 id；mention 实体比对 @username（大小写不敏感）。
 * 实体结构由 wire schema 保证——无防御 typeof。 */
function mentionedSelf(msg: TelegramMessage, self: TelegramSelf): boolean {
  const text = msg.text ?? "";
  for (const e of msg.entities ?? []) {
    if (e.type === "text_mention") {
      if (e.user !== undefined && e.user.id === self.id) return true;
    } else if (e.type === "mention" && self.username !== undefined) {
      if (e.offset === undefined || e.length === undefined) continue;
      if (e.offset < 0 || e.length <= 0 || e.offset + e.length > text.length) continue;
      const slice = text.slice(e.offset, e.offset + e.length);
      if (slice.toLowerCase() === `@${self.username.toLowerCase()}`) return true;
    }
  }
  return false;
}

/** 附件 → ![附件n] 约定（url=摄取期缩略图 data:URL；缺失时空串——get_media 给可操作错误） */
function parseAttachments(
  msg: TelegramMessage,
  blobs: Record<string, string>,
): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  if (msg.photo !== undefined && msg.photo.length > 0) {
    const meta = msg.photo[msg.photo.length - 1]!; // 最大尺寸＝元数据权威
    const thumbId = msg.photo[0]!.file_id; // 最小尺寸＝缩略图富化目标
    out.push({
      kind: "image",
      url: blobs[thumbId] ?? "",
      width: meta.width,
      height: meta.height,
      ...(meta.file_size !== undefined ? { size: meta.file_size } : {}),
      content_type: "image/jpeg",
    });
  }
  if (msg.voice !== undefined) {
    out.push({
      kind: "voice",
      url: "",
      duration: msg.voice.duration,
      ...(msg.voice.file_size !== undefined ? { size: msg.voice.file_size } : {}),
      content_type: msg.voice.mime_type ?? "audio/ogg",
    });
  }
  if (msg.video !== undefined) {
    out.push({
      kind: "video",
      url: "",
      duration: msg.video.duration,
      width: msg.video.width,
      height: msg.video.height,
      ...(msg.video.file_size !== undefined ? { size: msg.video.file_size } : {}),
      content_type: msg.video.mime_type ?? "video/mp4",
    });
  }
  if (msg.document !== undefined) {
    out.push({
      kind: "file",
      url: "",
      ...(msg.document.file_name !== undefined
        ? { filename: msg.document.file_name }
        : {}),
      ...(msg.document.file_size !== undefined ? { size: msg.document.file_size } : {}),
      content_type: msg.document.mime_type ?? "application/octet-stream",
    });
  }
  return out;
}

/** 引用快照（reply_to_message → quote_json；作者身份可被 ingest 懒补命中缓存） */
function parseQuote(msg: TelegramMessage): NormalizedMessage["quote"] {  const r = msg.reply_to_message;
  if (r === undefined) return null;
  const body = (r.text ?? r.caption ?? "").trim();
  const firstLine = body.split("\n")[0] ?? "";
  return {
    msgId: String(r.message_id),
    body: [...firstLine].slice(0, 50).join(""),
    authorOpenid: r.from !== undefined ? String(r.from.id) : null,
    authorName: userNameOf(r.from) ?? null,
  };
}

/**
 * 服务消息（群生命周期）→ 可读括注行：与 QQ [卡片]/[聊天记录·N条] 括注约定同风格。
 * text 列留空（不进 FTS 检索——结构标记非正文）；真机 2026-11-16 全型核验
 * （new_chat_members / new_chat_photo×3 / new_chat_title）。
 */
function serviceTextOf(msg: TelegramMessage): string | null {
  if (msg.new_chat_members !== undefined) {
    const names = msg.new_chat_members
      .map((u) => userNameOf(u) ?? String(u.id))
      .join("、");
    return `[入群] ${names} 加入了群聊`;
  }
  if (msg.left_chat_member !== undefined) {
    const name = userNameOf(msg.left_chat_member) ?? String(msg.left_chat_member.id);
    return `[退群] ${name} 离开了群聊`;
  }
  if (msg.new_chat_title !== undefined) return `[群名] ${msg.new_chat_title}`;
  if (msg.new_chat_photo !== undefined) return "[群头像] 已更新";
  if (msg.delete_chat_photo !== undefined) return "[群头像] 已移除";
  if (msg.pinned_message !== undefined) {
    const p = msg.pinned_message;
    const body = (p.text ?? p.caption ?? "").trim();
    return `[置顶] ${body !== "" ? [...body].slice(0, 30).join("") : `消息 ${p.message_id}`}`;
  }
  if (msg.group_chat_created !== undefined) return "[建群] 群聊已创建";
  return null;
}

/**
 * Telegram Update → NormalizedMessage。仅消费 update.message（edited/channel 等
 * 事件 v1 不入库）；无法定位会话/作者时返回 null（容错丢弃，与 QQ parser 同纪律）。
 */
export function normalizeTelegramUpdate(
  botId: string,
  payload: TelegramInboundPayload,
  self?: TelegramSelf,
): NormalizedMessage | null {
  const msg = payload.update.message;
  if (msg === undefined) return null;
  const chatType = msg.chat.type;
  if (chatType !== "private" && chatType !== "group" && chatType !== "supergroup") {
    return null;
  }
  const scope: MsgScope = chatType === "private" ? "chat" : "group";
  const scopeId = String(msg.chat.id);
  const authorOpenid = msg.from !== undefined ? String(msg.from.id) : scopeId;
  const authorName = userNameOf(msg.from) ?? msg.chat.title;

  // —— 服务消息：content=括注行，text 留空，无附件 ——
  const service = serviceTextOf(msg);
  if (service !== null) {
    return {
      botId,
      scope,
      scopeId,
      msgId: String(msg.message_id),
      authorOpenid,
      ...(authorName !== undefined ? { authorName } : {}),
      ts: msg.date !== undefined ? msg.date * 1000 : null,
      text: "",
      content: service,
      quote: null,
      records: [],
      mentions: [],
      attachments: [],
      raw: payload.update,
    };
  }

  const text = msg.text ?? msg.caption ?? "";
  const attachments = parseAttachments(msg, payload.mediaBlobs ?? {});

  // —— 贴纸：无 text/caption 字段，emoji 进括注（[贴纸] 🎉）——
  if (msg.sticker !== undefined && text === "") {
    const emoji = msg.sticker.emoji ?? "";
    return {
      botId,
      scope,
      scopeId,
      msgId: String(msg.message_id),
      authorOpenid,
      ...(authorName !== undefined ? { authorName } : {}),
      ts: msg.date !== undefined ? msg.date * 1000 : null,
      text: emoji,
      content: `[贴纸] ${emoji}`.trim(),
      quote: parseQuote(msg),
      records: [],
      mentions: [],
      attachments: [],
      raw: payload.update,
    };
  }

  // content 渲染：媒体占位符在前（每附件一行），caption 文本随后——与读取层
  // 「占位符 + 正文」约定一致；text 列只存 caption 纯文本（FTS 检索源）
  let content = "";
  for (let i = 0; i < attachments.length; i += 1) {
    content += `![附件${i + 1}]`;
    if (i < attachments.length - 1) content += "\n";
  }
  if (content !== "" && text !== "") content += ` ${text}`;
  if (content === "") content = text;

  return {
    botId,
    scope,
    scopeId,
    msgId: String(msg.message_id),
    authorOpenid,
    ...(authorName !== undefined ? { authorName } : {}),
    ts: msg.date !== undefined ? msg.date * 1000 : null,
    text,
    content,
    quote: parseQuote(msg),
    records: [],
    mentions: parseMentions(msg),
    attachments,
    // @本bot 精确判定（身份可得时）；未知（getMe 未回）省略 → wait 层从宽兜底
    ...(scope === "group" && self !== undefined
      ? { atMe: mentionedSelf(msg, self) }
      : {}),
    raw: payload.update,
  };
}

/**
 * 信封 → NormalizedInbound（plugin.normalize 入口）：
 * message.update 未产出消息（edited/channel 等事件 v1 不入库、无法定位会话/作者）
 * 返回 null；群消息附 group-seen（全量在册），私聊附 chat-opt（opt-in 等价映射，
 * 无 opt-out 通道——Telegram 用户侧屏蔽 bot 即收不到消息，无需本地开关）。
 */
export function normalizeTelegramInbound(
  botId: string,
  payload: TelegramInboundPayload,
  self?: TelegramSelf,
): NormalizedInbound | null {
  const m = normalizeTelegramUpdate(botId, payload, self);
  if (m === null) return null;
  return {
    messages: [m],
    effects:
      m.scope === "group"
        ? [{ kind: "group-seen", scopeId: m.scopeId, fullMsg: true }]
        : [{ kind: "chat-opt", scopeId: m.scopeId, allow: true }],
  };
}
