// 微信 CDN 媒体加密原语：AES-128-ECB + PKCS7（协议事实，参照实现 cdn/aes-ecb.ts 与
// cdn/pic-decrypt.ts 的 parseAesKey）。上传前加密、下载后解密共用本文件。
// 用 node:crypto 标准实现，零第三方依赖。

import { createCipheriv, createDecipheriv } from "node:crypto";

/** AES-128-ECB 加密（PKCS7 填充为缺省行为） */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-128-ECB 解密（PKCS7）；密文/密钥不匹配时抛错（由调用侧翻译为可操作文案） */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB 密文长度（PKCS7 填充到 16 字节边界；明文恰为整块时补一整块） */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 解析线上的 aes_key（base64）为 16 字节原始密钥。线上存在两种编码：
 *   - base64(原始 16 字节)              → 图片
 *   - base64(32 字符的 hex 文本)        → 文件 / 语音 / 视频
 * 后者 base64 解码得到 32 个 ASCII hex 字符，须再按 hex 解出真正的 16 字节。
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `aes_key 须解码为 16 字节原始密钥或 32 字符 hex 文本（实际 ${decoded.length} 字节）`,
  );
}

/** 16 字节原始密钥 → 入站解密用的 base64(原始字节) 形式（统一走 parseAesKey） */
export function rawKeyToBase64(raw: Buffer): string {
  return raw.toString("base64");
}
