// 微信 CDN 媒体层：上传（明文 → AES-128-ECB 密文 → getuploadurl 预签名地址直传 →
// 回执 x-encrypted-param 即下载参数）与下载（CDN 取密文 → AES-128-ECB 解密）。
//
// 协议事实（参照实现 2.4.10 cdn/upload.ts、cdn/cdn-upload.ts、cdn/cdn-url.ts、
// cdn/pic-decrypt.ts，2026-11-24 解包核对）：
// - getuploadurl 入参：filekey（随机 16 字节 hex）、media_type（1 图 / 2 视频 / 3 文件）、
//   to_user_id、rawsize / rawfilemd5（明文）、filesize（密文长度）、no_need_thumb=true、
//   aeskey（16 字节随机 key 的 hex）
// - 上传地址：优先服务端返回的 upload_full_url；否则
//   {cdn}/upload?encrypted_query_param={upload_param}&filekey={filekey}
// - 上传：POST application/octet-stream 密文字节；200 的 x-encrypted-param 响应头 =
//   下载参数（填 CDNMedia.encrypt_query_param）；4xx 立即失败（x-error-message），
//   5xx/网络失败重试至多 3 次
// - 下载地址：优先 CDNMedia.full_url；否则 {cdn}/download?encrypted_query_param=…
// - 出站 aes_key 线上编码 = base64(hex 文本的 UTF-8)，即「base64(hex 字符串)」形态
//   （与入站 parseAesKey 的第二种编码同形）——照参照实现逐字节一致，勿改成 base64(原始字节)

import { createHash, randomBytes } from "node:crypto";
import type { WeixinApi } from "./api";
import {
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
  rawKeyToBase64,
} from "./aes";
import { tt } from "./texts";
import type { CdnMedia, GetUploadUrlResp } from "./types";

/** CDN 上传最大尝试次数（4xx 不重试） */
const UPLOAD_MAX_RETRIES = 3;

/** 上传完成后的素材事实（出站消息 item 据此组装；handle 编码它的子集） */
export interface CdnUploadResult {
  filekey: string;
  /** 16 字节 AES key 的 hex 形式 */
  aesKeyHex: string;
  /** 明文字节数 */
  rawSize: number;
  rawMd5: string;
  /** 密文字节数 */
  cipherSize: number;
  /** CDN 回执的下载参数（填 CDNMedia.encrypt_query_param） */
  downloadParam: string;
}

/** 出站 CDNMedia.aes_key：base64(hex 文本)——与参照实现逐字节一致的线上编码 */
export function outboundAesKey(aesKeyHex: string): string {
  return Buffer.from(aesKeyHex, "utf-8").toString("base64");
}

export function cdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function cdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return (
    `${params.cdnBaseUrl}/upload?encrypted_query_param=` +
    `${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`
  );
}

/**
 * 入站图片的 AES key（base64 形式）：优先 image_item.aeskey（hex），否则 media.aes_key。
 * 两者皆无 → undefined（无法解密，调用侧降级为仅元数据）。
 */
export function inboundImageKey(
  media: CdnMedia | undefined,
  aeskeyHex: string | undefined,
): string | undefined {
  const hex = aeskeyHex?.trim();
  if (hex !== undefined && /^[0-9a-fA-F]{32}$/.test(hex)) {
    return rawKeyToBase64(Buffer.from(hex, "hex"));
  }
  const b64 = media?.aes_key?.trim();
  return b64 !== undefined && b64 !== "" ? b64 : undefined;
}

/** 下载并解密一个 CDN 媒体（图片/语音/文件/视频同流程） */
export async function downloadAndDecrypt(params: {
  media: CdnMedia;
  /** base64 形式 key（inboundImageKey 或 media.aes_key） */
  aesKeyBase64: string;
  cdnBaseUrl: string;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<Buffer> {
  const { media } = params;
  const param = media.encrypt_query_param?.trim() ?? "";
  const fullUrl = media.full_url?.trim() ?? "";
  // 下载地址：优先服务端直返的 full_url；否则按 encrypt_query_param 拼接
  const url =
    fullUrl !== ""
      ? fullUrl
      : param !== ""
        ? cdnDownloadUrl(param, params.cdnBaseUrl)
        : undefined;
  if (url === undefined) {
    throw new Error(
      tt("wx_cdn_download_failed", { reason: "缺 encrypt_query_param 与 full_url" }),
    );
  }
  const key = parseAesKey(params.aesKeyBase64);
  let res: Response;
  try {
    res = await params.fetchImpl(url, {
      signal: AbortSignal.timeout(params.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new Error(
      tt("wx_cdn_download_failed", { reason: e instanceof Error ? e.message : String(e) }),
    );
  }
  if (!res.ok) {
    throw new Error(tt("wx_cdn_download_failed", { reason: `HTTP ${res.status}` }));
  }
  const encrypted = Buffer.from(await res.arrayBuffer());
  try {
    return decryptAesEcb(encrypted, key);
  } catch {
    throw new Error(tt("wx_cdn_download_failed", { reason: "解密失败（密钥不匹配或密文损坏）" }));
  }
}

/** POST 密文到 CDN；返回下载参数（x-encrypted-param） */
async function postCdn(
  url: string,
  ciphertext: Buffer,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(60_000),
      });
      const errHeader = res.headers.get("x-error-message");
      if (res.status >= 400 && res.status < 500) {
        throw new WeixinCdnClientError(
          `HTTP ${res.status}：${errHeader ?? (await res.text().catch(() => ""))}`,
        );
      }
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}：${errHeader ?? "无错误说明"}`);
      }
      const param = res.headers.get("x-encrypted-param");
      if (!param) throw new Error("应答缺 x-encrypted-param 响应头");
      return param;
    } catch (e) {
      // 4xx 客户端错误不重试（重试也不会成功）；其余至多重试到上限
      if (e instanceof WeixinCdnClientError) {
        throw new Error(tt("wx_cdn_upload_failed", { reason: e.message }));
      }
      lastError = e;
    }
  }
  throw new Error(
    tt("wx_cdn_upload_failed", {
      reason: lastError instanceof Error ? lastError.message : String(lastError),
    }),
  );
}

/** 4xx 客户端错误标记（不重试） */
class WeixinCdnClientError extends Error {}

/**
 * 上传一个缓冲到微信 CDN：getuploadurl 取预签名地址 → 加密直传 → 回执下载参数。
 * 调用侧（instance.uploadMedia）负责把结果编码成 handle。
 */
export async function uploadMediaToCdn(params: {
  api: WeixinApi;
  buf: Buffer;
  toUserId: string;
  /** proto UploadMediaType：1 图 / 2 视频 / 3 文件 */
  mediaType: number;
  cdnBaseUrl: string;
  fetchImpl: typeof globalThis.fetch;
}): Promise<CdnUploadResult> {
  const plaintext = params.buf;
  const rawSize = plaintext.length;
  const rawMd5 = createHash("md5").update(plaintext).digest("hex");
  const cipherSize = aesEcbPaddedSize(rawSize);
  const filekey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");

  const urlResp: GetUploadUrlResp = await params.api.getUploadUrl({
    filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: rawSize,
    rawfilemd5: rawMd5,
    filesize: cipherSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
  });
  const fullUrl = urlResp.upload_full_url?.trim();
  const uploadParam = urlResp.upload_param?.trim();
  const target =
    fullUrl !== undefined && fullUrl !== ""
      ? fullUrl
      : uploadParam !== undefined && uploadParam !== ""
        ? cdnUploadUrl({ cdnBaseUrl: params.cdnBaseUrl, uploadParam, filekey })
        : undefined;
  if (target === undefined) throw new Error(tt("wx_upload_no_url"));

  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const downloadParam = await postCdn(target, ciphertext, params.fetchImpl);
  return {
    filekey,
    aesKeyHex,
    rawSize,
    rawMd5,
    cipherSize,
    downloadParam,
  };
}
