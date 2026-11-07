// 资产暂存与上传票据（控制平面/数据平面分离，2026-10-27 定案）：
// request_upload 工具签发一次性 PUT 票据（HMAC-SHA256 按 bot 的 agent_token 派生密钥，
// 15 分钟时效）→ 执行环境（curl/fetch）直传数据端点 PUT /assets/{botId}/{assetId} →
// 字节落盘 DATA_DIR/assets/ → send_media 以 media:"asset:<id>" 引用发送。
// 文件字节不进 MCP 消息，也不进模型上下文（ADR：票据/预签名 URL 是 2026 最佳实践）。
// 资产全局共享（人类视角"本服务的素材库"），独立于消息缓存，不参与 RETENTION 清理。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const TICKET_TTL_MS = 15 * 60_000;

/** 图片魔数嗅探 → mime；非图片返回 null */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

/** 音频魔数嗅探 → mime（官方 file_type=3 语音支持 silk/mp3/wav，2026-11 接口文档核实）；
 * 非音频返回 null */
export function sniffAudioMime(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  // MP3：ID3v2 标签头，或裸 MPEG 帧同步字（0xFF + 111 同步位）
  if (
    buf.subarray(0, 3).toString("latin1") === "ID3" ||
    (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)
  ) {
    return "audio/mpeg";
  }
  // WAV：RIFF 容器 + WAVE 标识（8..12）
  if (
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.length >= 12 &&
    buf.subarray(8, 12).toString("latin1") === "WAVE"
  ) {
    return "audio/wav";
  }
  // SILK v3：QQ 语音原生格式，头部常带 1 字节 0x02 前缀（首字节偏移 0 或 1 均识别）
  const silk = "#!SILK";
  for (const off of [0, 1]) {
    if (
      buf.length >= off + 6 &&
      buf.subarray(off, off + 6).toString("latin1") === silk
    ) {
      return "audio/silk";
    }
  }
  return null;
}

/** 资产魔数嗅探（图片 + 语音）→ mime；均不匹配返回 null */
export function sniffAssetMime(buf: Buffer): string | null {
  return sniffImageMime(buf) ?? sniffAudioMime(buf);
}

/** 读文件头 16 字节嗅探资产 mime（send_media 的 file 源分类用：audio/* → 语音上传） */
export function sniffPathMime(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return sniffAssetMime(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/** 票据签名：密钥=该 bot 的 agent_token（轮换后旧票据自然失效） */
export function uploadSig(
  agentToken: string,
  botId: string,
  assetId: string,
  exp: number,
): string {
  return createHmac("sha256", agentToken)
    .update(`${botId}.${assetId}.${exp}`)
    .digest("hex");
}

export interface UploadTicket {
  assetId: string;
  /** 数据端点绝对路径（含 exp/sig query；host 由调用方按请求 Host 拼） */
  urlPath: string;
  /** 票据时效（秒） */
  expiresInSec: number;
  /** 可复制的直传命令模板（AI friendly：照抄即用） */
  curl: string;
}

export class AssetStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** 签发一次性 PUT 票据（15 分钟；落盘后即作废——文件存在即拒绝重传） */
  issueTicket(
    botId: string,
    agentToken: string,
    baseUrl: string,
  ): UploadTicket {
    const assetId = randomBytes(16).toString("hex");
    const exp = Date.now() + TICKET_TTL_MS;
    const sig = uploadSig(agentToken, botId, assetId, exp);
    const urlPath = `/assets/${botId}/${assetId}?exp=${exp}&sig=${sig}`;
    return {
      assetId,
      urlPath,
      expiresInSec: TICKET_TTL_MS / 1000,
      curl: `curl -X PUT -H 'Content-Type: application/octet-stream' --data-binary @文件路径 "${baseUrl}${urlPath}"`,
    };
  }

  /**
   * 数据端点校验。返回 null=通过；否则为应答 HTTP 状态码：
   * 400 参数缺失 / 403 bot 不存在或签名不符 / 409 已落盘（单次使用）/ 410 已过期
   */
  verifyPut(
    botId: string,
    assetId: string,
    agentToken: string | null,
    expRaw: unknown,
    sigRaw: unknown,
  ): number | null {
    if (!/^[0-9a-f]{32}$/.test(assetId)) return 404;
    const exp = typeof expRaw === "string" ? Number(expRaw) : NaN;
    const sig = typeof sigRaw === "string" ? sigRaw : "";
    if (!Number.isFinite(exp) || sig === "") return 400;
    if (agentToken === null) return 403; // bot 不存在（或 token 已轮换，旧票据自然失效）
    if (Date.now() > exp) return 410;
    const expect = Buffer.from(uploadSig(agentToken, botId, assetId, exp));
    const got = Buffer.from(sig);
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) {
      return 403;
    }
    if (this.pathOf(assetId) !== null) return 409; // 单次使用：同 id 已落盘
    return null;
  }

  /** 落盘并嗅探魔数；非图片/音频抛 RangeError（路由转 415） */
  save(assetId: string, buf: Buffer): { mime: string; size: number } {
    const mime = sniffAssetMime(buf);
    if (mime === null) throw new RangeError("not an image or audio");
    writeFileSync(join(this.dir, assetId), buf);
    return { mime, size: buf.length };
  }

  /** 资产文件路径（asset: 引用解析用）；不存在或 id 非法返回 null（防路径注入） */
  pathOf(assetId: string): string | null {
    if (!/^[0-9a-f]{32}$/.test(assetId)) return null;
    const p = join(this.dir, assetId);
    return existsSync(p) ? p : null;
  }
}
