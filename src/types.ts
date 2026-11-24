// 微信 iLink bot API 线格式类型（协议基准：@tencent-weixin/openclaw-weixin 2.4.10，
// 2026-11-24 解包核对；beta 3.0.0-beta-1 的 src/api/types.ts 与端点/请求头零差异）。
//
// 分仓纪律（AGENTS.md P4 红线）：本包零运行时依赖，**不使用参照包本体**——它只作
// 协议说明书，协议操作在此自研实现。只声明本项目消费的字段；未知键透传不解读。
// 参照包由安装器 @tencent-weixin/openclaw-weixin-cli 按 COMPAT_MATRIX 装入
// （latest → 2.4.10），本文件即对应该版本。

/** iLink API 缺省入口（扫码流程固定从这里起步；账号实际入口以 confirmed 的 baseurl 为准） */
export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

/** 媒体 CDN 缺省入口（upload/download 的 full_url 缺失时的回退拼接基址） */
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/**
 * iLink-App-Id 请求头：参照包 package.json 顶层 ilink_appid 的静态值（"bot"），
 * 是 iLink bot 接入点的公开标识，非凭据。
 */
export const ILINK_APP_ID = "bot";

/**
 * 协议基准版本：iLink-App-ClientVersion / base_info.channel_version 按它编码。
 * 服务端可能据此做能力门控——与已验证的参照实现保持一致，**勿随本包版本漂移**
 * （协议升级时连同实现一起改，并更新 README 的基准版本声明）。
 */
export const ILINK_CHANNEL_VERSION = "2.4.10";

/** 本包版本（base_info.bot_agent 自报身份用：观测字段，不参与鉴权/路由） */
export const CONNECTOR_VERSION = "0.1.0";

/** proto: MessageType（消息方向：用户发来 / 机器人发出） */
export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

/** proto: MessageItemType（item_list 元素类型） */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** proto: MessageState */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

/** proto: UploadMediaType */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

/** getupdates 应答体 errcode：bot token 失效（参照实现 session-guard 的 STALE_TOKEN_ERRCODE） */
export const STALE_TOKEN_ERRCODE = -14;

/** 每个请求体都携带的公共元数据 */
export interface BaseInfo {
  channel_version: string;
  /** UA 风格自报身份（Name/Version 可多个，ASCII，≤256 字节）；仅观测用 */
  bot_agent: string;
}

/** CDN 媒体引用；aes_key 在 JSON 里是 base64 字符串 */
export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 加密类型：0=只加密 fileid，1=打包缩略图/中图等信息 */
  encrypt_type?: number;
  /** 完整下载 URL（服务端直接返回；缺失时回退按 encrypt_query_param 拼接） */
  full_url?: string;
}

export interface TextItem {
  text?: string;
}

export interface ImageItem {
  /** 中图/原图 CDN 引用 */
  media?: CdnMedia;
  /** 缩略图 CDN 引用 */
  thumb_media?: CdnMedia;
  /** 16 字节 AES key 的 hex 形式（入站解密优先用它） */
  aeskey?: string;
  url?: string;
  /** 密文字节数 */
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CdnMedia;
  /** 编码：1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  /** 语音长度（毫秒） */
  playtime?: number;
  /** 语音转文字（平台 ASR） */
  text?: string;
}

export interface FileItem {
  media?: CdnMedia;
  file_name?: string;
  md5?: string;
  /** 明文字节数（字符串形式） */
  len?: string;
}

export interface VideoItem {
  media?: CdnMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CdnMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

/** 局部引用（被引消息的选区） */
export interface PartialText {
  start?: string;
  end?: string;
  startindex?: number;
  endindex?: number;
  quotemd5?: string;
}

export interface RefMessage {
  message_item?: MessageItem;
  /** 摘要 */
  title?: string;
  /** 被引消息的服务端 id（新版客户端只给 id，不给正文） */
  svr_id?: string;
  partial_text?: PartialText;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  /** uint64：经无损解析后是字符串 */
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  [key: string]: unknown;
}

/** 统一消息（proto: WeixinMessage）。uint64 id 字段无损解析为字符串 */
export interface WeixinMessage {
  seq?: number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  /** 会话上下文令牌：出站必须原样回带（敏感，不落日志/不入 raw） */
  context_token?: string;
  run_id?: string;
  [key: string]: unknown;
}

export interface GetUpdatesResp {
  ret?: number;
  /** 请求失败时的错误码（如 -14 = token 失效） */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** 下次请求原样带回的游标（空串 = 从头/重置） */
  get_updates_buf?: string;
  /** 服务端建议的下一次长轮询挂起时长（毫秒） */
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
  /** uint64：无损解析为字符串 */
  message_id?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  /** 原文件明文大小 */
  rawsize: number;
  /** 原文件明文 MD5 */
  rawfilemd5: string;
  /** 原文件密文大小（AES-128-ECB 加密后） */
  filesize: number;
  /** 不需要缩略图上传 URL */
  no_need_thumb?: boolean;
  /** 加密 key（16 字节 hex） */
  aeskey: string;
}

export interface GetUploadUrlResp {
  /** 原图上传加密参数 */
  upload_param?: string;
  thumb_upload_param?: string;
  /** 完整上传 URL（服务端直接返回，无需客户端拼接） */
  upload_full_url?: string;
}

export interface NotifyResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** 扫码状态（2.4.10 已知 7 态；未知值宽容按等待处理） */
export type QrcodeStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect"
  // 未知状态（协议漂移容忍）：仍按字符串接收，由调用侧决定宽容度
  | (string & {});

export interface BotQrcodeResp {
  /** 轮询令牌（敏感：只留在服务端内存，绝不下发浏览器） */
  qrcode: string;
  /** 二维码内容（前端本地渲染成二维码） */
  qrcode_img_content: string;
}

export interface QrcodeStatusResp {
  status: QrcodeStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  /** 该账号实际 API 入口（IDC 就近；缺失回退缺省入口） */
  baseurl?: string;
  /** 扫码人的 ilink 用户 id */
  ilink_user_id?: string;
  /** IDC 重定向主机（scaned_but_redirect 时切换轮询入口） */
  redirect_host?: string;
}
