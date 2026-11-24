// 微信媒体与线格式层测试（P4）：AES-128-ECB 原语与两种 key 编码、CDN 上传/下载全流程
// （FakeNetKit 假端点 + 假 api，零真实网络）、重试分档、出站素材嗅探与 item 组装、
// 无状态句柄编解码、入站图片富化策略（中图优先/缩略图回落/尺寸闸门/被引图归属）、
// 引用摘要与局部引用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FakeNetKit,
  type HttpClient,
} from "@qsense/connector-sdk";
import {
  MessageItemType,
  MessageState,
  MessageType,
  UploadMediaType,
  aesEcbPaddedSize,
  buildBotMessage,
  buildMediaItem,
  buildTextItem,
  cdnDownloadUrl,
  decodeHandle,
  decryptAesEcb,
  digestOf,
  downloadAndDecrypt,
  encodeHandle,
  encryptAesEcb,
  enrichImages,
  inboundImageKey,
  mediaLabelOf,
  outboundAesKey,
  parseAesKey,
  planUpload,
  resolvePartialQuote,
  sanitizeFileName,
  sniffImageMime,
  sniffOutbound,
  uploadMediaToCdn,
  type CdnUploadResult,
  type WeixinApi,
} from "@qsense/connector-weixin";

const CDN = "https://novac2c.cdn.weixin.qq.com/c2c";
const KEY_HEX = "000102030405060708090a0b0c0d0e0f";
const KEY = Buffer.from(KEY_HEX, "hex");

function pngBytes(size: number, fill: number): Buffer {
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.alloc(size, fill),
  ]);
}

function jpegBytes(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
}

type FetchHandler = (url: string, req: { method: string; headers: Record<string, string>; body?: string | Uint8Array | FormData }) => Response | Error;

/** 假 CDN 传输（FakeNetKit 全路由捕获）：记录调用，按处理器应答 */
function fakeHttp(handler: FetchHandler): { http: HttpClient; kit: FakeNetKit } {
  const kit = new FakeNetKit();
  kit.onMatch(
    () => true,
    (req) => handler(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) }),
  );
  return { http: kit.http(), kit };
}

interface FakeApi extends WeixinApi {
  uploadReqs: Array<Record<string, unknown>>;
}

/** 假 iLink api：只关心 getuploadurl 入参 */
function fakeApi(getUploadUrl?: WeixinApi["getUploadUrl"]): FakeApi {
  const uploadReqs: Array<Record<string, unknown>> = [];
  return {
    baseUrl: "https://ilinkai.weixin.qq.com",
    uploadReqs,
    async getUploadUrl(req) {
      uploadReqs.push(req as unknown as Record<string, unknown>);
      return getUploadUrl !== undefined
        ? getUploadUrl(req)
        : { upload_full_url: "https://cdn.example/up?sig=1" };
    },
    async getUpdates() {
      return {};
    },
    async sendMessage() {
      return {};
    },
    async notifyStart() {},
    async notifyStop() {},
    async getBotQrcode() {
      return { qrcode: "", qrcode_img_content: "" };
    },
    async getQrcodeStatus() {
      return { status: "wait" };
    },
  };
}

// —— AES ——

test("AES-128-ECB：加解密往返、PKCS7 填充长度、错钥必不等于明文", () => {
  assert.equal(aesEcbPaddedSize(0), 16);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(16), 32); // 恰为整块时补一整块
  assert.equal(aesEcbPaddedSize(17), 32);
  for (const n of [1, 15, 16, 17, 1000, 65_536]) {
    const plain = createHash("sha256").update(String(n)).digest(); // 32 字节伪随机
    const buf = Buffer.concat(Array(Math.ceil(n / 32)).fill(plain)).subarray(0, n);
    const cipher = encryptAesEcb(buf, KEY);
    assert.equal(cipher.length, aesEcbPaddedSize(n));
    assert.equal(cipher.length % 16, 0);
    assert.deepEqual(decryptAesEcb(cipher, KEY), Buffer.from(buf));
  }
  // 错钥：要么填充校验失败抛错，要么结果必不等于明文
  const cipher = encryptAesEcb(Buffer.from("hello weixin", "utf-8"), KEY);
  for (let i = 1; i <= 4; i += 1) {
    const wrong = Buffer.from(`${i}${KEY_HEX.slice(1)}`, "hex");
    let out: Buffer | null = null;
    try {
      out = decryptAesEcb(cipher, wrong);
    } catch {
      out = null;
    }
    assert.notEqual(out?.toString("utf-8"), "hello weixin");
  }
});

test("parseAesKey 两种线上编码；出站 aes_key = base64(hex 文本) 与之互逆", () => {
  // base64(原始 16 字节)
  assert.deepEqual(parseAesKey(KEY.toString("base64")), KEY);
  // base64(32 字符 hex 文本)
  assert.deepEqual(
    parseAesKey(Buffer.from(KEY_HEX, "utf-8").toString("base64")),
    KEY,
  );
  // 出站编码 = 第二种形态（照参照实现逐字节一致）
  assert.equal(outboundAesKey(KEY_HEX), Buffer.from(KEY_HEX, "utf-8").toString("base64"));
  assert.deepEqual(parseAesKey(outboundAesKey(KEY_HEX)), KEY);
  assert.throws(() => parseAesKey(Buffer.from("short").toString("base64")), /aes_key/);
});

// —— CDN 上传 ——

test("CDN 上传：getuploadurl 入参 → 密文直传 full_url → 回执下载参数", async () => {
  const plain = pngBytes(300, 1);
  const api = fakeApi();
  const f = fakeHttp((url, req) => {
    assert.equal(url, "https://cdn.example/up?sig=1");
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/octet-stream");
    const body = Buffer.from(req.body as Uint8Array);
    assert.equal(body.length, aesEcbPaddedSize(plain.length));
    // 密文用 getuploadurl 上送的那把随机 key 可解回明文
    const aesKey = Buffer.from(String(api.uploadReqs[0]!.aeskey), "hex");
    assert.deepEqual(decryptAesEcb(body, aesKey), plain);
    return new Response(undefined, { headers: { "x-encrypted-param": "DL-PARAM" } });
  });
  const r = await uploadMediaToCdn({
    api,
    buf: plain,
    toUserId: "u1@im.wechat",
    mediaType: UploadMediaType.IMAGE,
    cdnBaseUrl: CDN,
    http: f.http,
  });
  assert.equal(r.downloadParam, "DL-PARAM");
  assert.equal(r.rawSize, 308);
  assert.equal(r.cipherSize, 320);
  assert.match(r.aesKeyHex, /^[0-9a-f]{32}$/); // 每次上传随机生成 16 字节 key
  assert.match(r.filekey, /^[0-9a-f]{32}$/);
  assert.equal(r.rawMd5, createHash("md5").update(plain).digest("hex"));
  assert.equal(f.kit.requests.length, 1);
  // getuploadurl 入参与参照实现一致
  const req = api.uploadReqs[0]!;
  assert.deepEqual(req, {
    filekey: r.filekey,
    media_type: 1,
    to_user_id: "u1@im.wechat",
    rawsize: 308,
    rawfilemd5: r.rawMd5,
    filesize: 320,
    no_need_thumb: true,
    aeskey: r.aesKeyHex,
  });
});

test("CDN 上传：只有 upload_param 时回退拼接地址；无地址报错；4xx 不重试；5xx 重试至多 3 次", async () => {
  const plain = Buffer.from("abc");
  // 回退拼接
  const fb = fakeHttp((url, req) => {
    assert.equal(
      url.startsWith(`${CDN}/upload?encrypted_query_param=UP%20PARAM&filekey=`),
      true,
    );
    assert.equal(req.method, "POST");
    return new Response(undefined, { headers: { "x-encrypted-param": "DL" } });
  });
  const fallback = await uploadMediaToCdn({
    api: fakeApi(async () => ({ upload_param: "UP PARAM" })),
    buf: plain,
    toUserId: "u",
    mediaType: UploadMediaType.FILE,
    cdnBaseUrl: CDN,
    http: fb.http,
  });
  assert.equal(fallback.downloadParam, "DL");
  // 无地址
  await assert.rejects(
    () =>
      uploadMediaToCdn({
        api: fakeApi(async () => ({})),
        buf: plain,
        toUserId: "u",
        mediaType: UploadMediaType.FILE,
        cdnBaseUrl: CDN,
        http: fakeHttp(() => new Response(undefined, { status: 200 })).http,
      }),
    /上传地址/,
  );
  // 4xx：立即失败，仅 1 次请求
  const f4 = fakeHttp(() => new Response(undefined, { status: 400, headers: { "x-error-message": "bad key" } }));
  await assert.rejects(
    () =>
      uploadMediaToCdn({
        api: fakeApi(),
        buf: plain,
        toUserId: "u",
        mediaType: 3,
        cdnBaseUrl: CDN,
        http: f4.http,
      }),
    /400：bad key/,
  );
  assert.equal(f4.kit.requests.length, 1);
  // 5xx 两次后成功：3 次请求
  let n = 0;
  const f5 = fakeHttp(() => {
    n += 1;
    return n < 3
      ? new Response(undefined, { status: 502 })
      : new Response(undefined, { status: 200, headers: { "x-encrypted-param": "OK" } });
  });
  const ok = await uploadMediaToCdn({
    api: fakeApi(),
    buf: plain,
    toUserId: "u",
    mediaType: 3,
    cdnBaseUrl: CDN,
    http: f5.http,
  });
  assert.equal(ok.downloadParam, "OK");
  assert.equal(f5.kit.requests.length, 3);
  // 恒 5xx / 网络异常 / 缺回执头：3 次后失败
  for (const handler of [
    () => new Response(undefined, { status: 500 }),
    () => new Error("network down"),
    () => new Response(undefined, { status: 200 }),
  ] as FetchHandler[]) {
    const fx = fakeHttp(handler);
    await assert.rejects(() =>
      uploadMediaToCdn({
        api: fakeApi(),
        buf: plain,
        toUserId: "u",
        mediaType: 3,
        cdnBaseUrl: CDN,
        http: fx.http,
      }),
    );
    assert.equal(fx.kit.requests.length, 3);
  }
});

// —— CDN 下载 ——

test("CDN 下载：full_url 优先 / 回退拼接 / 解密 / 错钥与 HTTP 错误", async () => {
  const plain = jpegBytes();
  const enc = encryptAesEcb(plain, KEY);
  const keyB64 = KEY.toString("base64");
  const f = fakeHttp((url) => {
    if (url === "https://cdn.example/full?x=1") return new Response(enc);
    if (url === cdnDownloadUrl("P 1", CDN)) return new Response(enc);
    return new Response(undefined, { status: 500 });
  });
  const full = await downloadAndDecrypt({
    media: { full_url: "https://cdn.example/full?x=1", encrypt_query_param: "P 1" },
    aesKeyBase64: keyB64,
    cdnBaseUrl: CDN,
    http: f.http,
  });
  assert.deepEqual(Buffer.from(full), plain);
  assert.equal(f.kit.requests[0]!.url, "https://cdn.example/full?x=1");
  const fallback = await downloadAndDecrypt({
    media: { encrypt_query_param: "P 1" },
    aesKeyBase64: outboundAesKey(KEY_HEX), // 第二种编码同样可解
    cdnBaseUrl: CDN,
    http: f.http,
  });
  assert.deepEqual(Buffer.from(fallback), plain);
  assert.equal(
    f.kit.requests[1]!.url,
    `${CDN}/download?encrypted_query_param=P%201`,
  );
  await assert.rejects(() =>
    downloadAndDecrypt({
      media: { encrypt_query_param: "P 1" },
      aesKeyBase64: Buffer.alloc(16, 9).toString("base64"),
      cdnBaseUrl: CDN,
      http: f.http,
    }),
  );
  await assert.rejects(() =>
    downloadAndDecrypt({
      media: {},
      aesKeyBase64: keyB64,
      cdnBaseUrl: CDN,
      http: f.http,
    }),
  );
});

test("inboundImageKey：hex aeskey 优先；否则 media.aes_key；皆无 undefined", () => {
  assert.equal(inboundImageKey({ aes_key: "AAA=" }, KEY_HEX), KEY.toString("base64"));
  assert.equal(inboundImageKey({ aes_key: "BBB=" }, undefined), "BBB=");
  assert.equal(inboundImageKey({ aes_key: "not-hex" }, "zz"), "not-hex");
  assert.equal(inboundImageKey({}, undefined), undefined);
  assert.equal(inboundImageKey(undefined, undefined), undefined);
});

// —— 出站嗅探与线格式 ——

test("sniffOutbound / planUpload：图/视频/音频降级文件/未知；文件名沿用或按嗅探补扩展名", () => {
  assert.equal(sniffOutbound(jpegBytes()).kind, "image");
  assert.equal(sniffOutbound(pngBytes(8, 0)).mime, "image/png");
  assert.equal(sniffOutbound(Buffer.from("GIF89a....")).ext, ".gif");
  assert.equal(
    sniffOutbound(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])).kind,
    "image",
  );
  assert.equal(sniffOutbound(Buffer.from("BM......")).kind, "image");
  assert.equal(
    sniffOutbound(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")])).kind,
    "video",
  );
  assert.equal(sniffOutbound(Buffer.from("1a45dfa3", "hex")).mime, "video/x-matroska");
  assert.equal(
    sniffOutbound(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI ")])).ext,
    ".avi",
  );
  assert.equal(sniffOutbound(Buffer.from("ID3xxxx")).mime, "audio/mpeg");
  assert.equal(sniffOutbound(Buffer.from("OggSaaaa")).ext, ".ogg");
  assert.equal(
    sniffOutbound(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])).mime,
    "audio/wav",
  );
  assert.deepEqual(sniffOutbound(Buffer.from("whatever")), {
    kind: "file",
    mime: "application/octet-stream",
    ext: ".bin",
  });

  // 规划：音频字节 → 文件附件降级（media_type=3）
  assert.deepEqual(planUpload(Buffer.from("ID3xxxx")), {
    kind: "file",
    mediaType: UploadMediaType.FILE,
    fileName: "audio.mp3",
  });
  assert.deepEqual(planUpload(pngBytes(8, 0), "C:\\tmp\\photo.PNG"), {
    kind: "image",
    mediaType: UploadMediaType.IMAGE,
    fileName: "photo.PNG",
  });
  assert.equal(planUpload(jpegBytes(), "noext").fileName, "image.jpg");
  assert.equal(
    planUpload(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")])).mediaType,
    UploadMediaType.VIDEO,
  );
  assert.equal(sanitizeFileName("a/b\\c:de<p>.txt"), "c_de_p_.txt");
  assert.equal(sanitizeFileName("..."), undefined);
  assert.equal(sanitizeFileName(undefined), undefined);
});

test("句柄编解码：无状态往返；篡改/前缀错给可操作错误", () => {
  const plan = {
    kind: "image" as const,
    fileName: "a.png",
    up: {
      filekey: "fk",
      aesKeyHex: KEY_HEX,
      rawSize: 8,
      rawMd5: "md5",
      cipherSize: 16,
      downloadParam: "DL",
    } satisfies CdnUploadResult,
  };
  const handle = encodeHandle(plan);
  assert.match(handle, /^wxm1\./);
  assert.deepEqual(decodeHandle(handle), plan);
  assert.throws(() => decodeHandle("QQFILEINFO"), /句柄/);
  assert.throws(() => decodeHandle(`${handle.slice(0, -3)}abc`), /句柄/);
  assert.throws(() => decodeHandle("wxm1.bm90LWpzb24"), /句柄/);
});

test("线格式组装：媒体 item 三形态 + 文本 item + 出站信封", () => {
  const up = {
    filekey: "fk",
    aesKeyHex: KEY_HEX,
    rawSize: 308,
    rawMd5: "md5",
    cipherSize: 320,
    downloadParam: "DL",
  };
  const media = {
    encrypt_query_param: "DL",
    aes_key: outboundAesKey(KEY_HEX),
    encrypt_type: 1,
  };
  assert.deepEqual(buildMediaItem({ kind: "image", fileName: "a.png", up }), {
    type: MessageItemType.IMAGE,
    image_item: { media, mid_size: 320 },
  });
  assert.deepEqual(buildMediaItem({ kind: "video", fileName: "v.mp4", up }), {
    type: MessageItemType.VIDEO,
    video_item: { media, video_size: 320 },
  });
  assert.deepEqual(buildMediaItem({ kind: "file", fileName: "报告.pdf", up }), {
    type: MessageItemType.FILE,
    file_item: { media, file_name: "报告.pdf", len: "308" },
  });
  assert.deepEqual(buildTextItem("你好"), {
    type: MessageItemType.TEXT,
    text_item: { text: "你好" },
  });
  const msg = buildBotMessage({
    to: "u1@im.wechat",
    clientId: "c-1",
    item: buildTextItem("你好"),
    contextToken: "CTX",
    runId: "run-1",
  });
  assert.deepEqual(msg, {
    from_user_id: "",
    to_user_id: "u1@im.wechat",
    client_id: "c-1",
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "你好" } }],
    context_token: "CTX",
    run_id: "run-1",
  });
  // 无令牌/无 runId：不带对应键
  const bare = buildBotMessage({ to: "u", clientId: "c", item: buildTextItem("x") });
  assert.equal("context_token" in bare, false);
  assert.equal("run_id" in bare, false);
});

// —— 入站富化 ——

function imageItem(param: string, keyHex = KEY_HEX, midSize?: number) {
  return {
    type: MessageItemType.IMAGE,
    image_item: {
      media: { encrypt_query_param: param, aes_key: "ignored-when-aeskey" },
      aeskey: keyHex,
      ...(midSize !== undefined ? { mid_size: midSize } : {}),
    },
  };
}

/** 假 CDN：按 param 回不同明文的密文（FakeNetKit 二进制直传应答体） */
function cdnKit(plainOf: (param: string) => Buffer | null): { http: HttpClient; kit: FakeNetKit } {
  return fakeHttp((url) => {
    const param = new URL(url).searchParams.get("encrypted_query_param") ?? "";
    const plain = plainOf(param);
    if (plain === null) return new Response(undefined, { status: 500 });
    return new Response(new Uint8Array(encryptAesEcb(plain, KEY)));
  });
}

test("enrichImages：中图优先；中图失败/声明超限回落缩略图；键=下标", async () => {
  const big = pngBytes(5000, 1);
  const small = pngBytes(200, 2);
  const f = cdnKit((p) => (p === "MID" ? big : p === "THUMB" ? small : null));
  const mk = (midSize?: number) => ({
    message_id: "1",
    from_user_id: "u",
    item_list: [
      imageItem("MID", KEY_HEX, midSize),
      { type: MessageItemType.TEXT, text_item: { text: "hi" } },
    ],
  });
  const deps = { http: f.http, cdnBaseUrl: CDN };
  // 中图可得
  const a = await enrichImages(mk(), deps);
  assert.equal(a["0"], `data:image/png;base64,${big.toString("base64")}`);
  assert.equal(Object.keys(a).length, 1);
  // 声明的中图密文尺寸明显超限 → 不下载中图，直接取缩略图（独立录制器，只看本用例的请求）
  const fb = cdnKit((p) => (p === "MID" ? big : p === "THUMB" ? small : null));
  const b = await enrichImages(
    {
      message_id: "1",
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: { media: { encrypt_query_param: "MID" }, aeskey: KEY_HEX, mid_size: 99_999_999, thumb_media: { encrypt_query_param: "THUMB" } },
        },
      ],
    },
    { ...deps, http: fb.http },
  );
  assert.equal(b["0"], `data:image/png;base64,${small.toString("base64")}`);
  assert.equal(
    fb.kit.requests.some((r) => r.url.includes("encrypted_query_param=MID")),
    false,
  );
  assert.equal(fb.kit.requests.length, 1);
  // 中图取不到 → 缩略图
  const f2 = cdnKit((p) => (p === "THUMB" ? small : null));
  const c = await enrichImages(
    {
      message_id: "1",
      from_user_id: "u",
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: { encrypt_query_param: "MID", aes_key: "whatever" },
            thumb_media: { encrypt_query_param: "THUMB", aes_key: KEY.toString("base64") },
          },
        },
      ],
    },
    { http: f2.http, cdnBaseUrl: CDN, onError: () => undefined },
  );
  assert.equal(c["0"], `data:image/png;base64,${small.toString("base64")}`);
  // 内联上限：解密后字节超限 → 不内联（缩略图也超限则无键）
  const d = await enrichImages(mk(), { ...deps, maxBytes: 1000 });
  assert.equal(d["0"], undefined);
  // 无 key：不内联，也不发请求
  const f3 = cdnKit(() => small);
  const e = await enrichImages(
    {
      message_id: "1",
      from_user_id: "u",
      item_list: [{ type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: "MID" } } }],
    },
    { http: f3.http, cdnBaseUrl: CDN },
  );
  assert.deepEqual(e, {});
  assert.equal(f3.kit.requests.length, 0);
  assert.equal(sniffImageMime(jpegBytes()), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("xxxx")), null);
});

test("enrichImages：被引图归 \"quote\" 键；单条消息内联图片数有上限", async () => {
  const small = pngBytes(64, 3);
  const f = cdnKit((p) => (p.startsWith("I") ? small : null));
  const imgs = Array.from({ length: 6 }, (_, i) => imageItem(`I${i}`));
  const blobs = await enrichImages(
    {
      message_id: "1",
      from_user_id: "u",
      item_list: [
        ...imgs,
        {
          type: MessageItemType.TEXT,
          text_item: { text: "这是什么" },
          ref_msg: { svr_id: "9", message_item: imageItem("IQ") },
        },
      ],
    },
    { http: f.http, cdnBaseUrl: CDN },
  );
  assert.equal(Object.keys(blobs).length, 4); // 上限 4：正文前 4 张占满配额
  assert.equal(blobs["quote"], undefined);
  const onlyQuote = await enrichImages(
    {
      message_id: "2",
      from_user_id: "u",
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: "这是什么" }, ref_msg: { svr_id: "9", message_item: imageItem("IQ") } },
      ],
    },
    { http: f.http, cdnBaseUrl: CDN },
  );
  assert.equal(onlyQuote["quote"], `data:image/png;base64,${small.toString("base64")}`);
  assert.equal(onlyQuote["0"], undefined);
});

// —— 引用摘要 ——

test("digestOf / mediaLabelOf：文本取原文，媒体取占位，多 item 以 | 连接并限长", () => {
  assert.equal(mediaLabelOf(MessageItemType.IMAGE), "[图片]");
  assert.equal(mediaLabelOf(MessageItemType.VIDEO), "[视频]");
  assert.equal(mediaLabelOf(MessageItemType.FILE), "[文件]");
  assert.equal(mediaLabelOf(MessageItemType.VOICE), "[语音]");
  assert.equal(mediaLabelOf(11), "");
  assert.equal(
    digestOf({
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: " 第一句 " } },
        { type: MessageItemType.IMAGE },
      ],
    }),
    "第一句 | [图片]",
  );
  assert.equal(
    digestOf({ item_list: [{ type: MessageItemType.VOICE, voice_item: { text: "转写" } }] }),
    "转写",
  );
  assert.equal(digestOf({ item_list: [{ type: MessageItemType.VOICE }] }), "[语音]");
  assert.equal(digestOf({}), "");
  assert.equal([...digestOf({ item_list: [{ type: 1, text_item: { text: "字".repeat(1000) } }] })].length, 400);
});

test("resolvePartialQuote：无 md5 取首个候选；有 md5 在两种 endindex 解释间消歧", () => {
  const r1 = resolvePartialQuote("今天天气怎么样？明天呢？今天下雨了。", {
    start: "今天",
    end: "下雨",
    startindex: 0,
    endindex: 0,
  });
  assert.deepEqual(r1, { resolved: "今天天气怎么样？明天呢？今天下雨", fallback: false });
  // 锚不在：回落
  assert.deepEqual(resolvePartialQuote("abc", { start: "zz", end: "b" }), {
    resolved: null,
    fallback: true,
  });
  // global 与 relative 解释不同：md5 选出 relative
  const md5 = createHash("md5").update("ba", "utf8").digest("hex");
  const r2 = resolvePartialQuote("ababab", {
    start: "b",
    end: "a",
    startindex: 1,
    endindex: 0,
    quotemd5: md5,
  });
  assert.deepEqual(r2, { resolved: "ba", fallback: false });
  // md5 不匹配任何候选：回落
  const r3 = resolvePartialQuote("ababab", {
    start: "b",
    end: "a",
    startindex: 1,
    endindex: 0,
    quotemd5: "deadbeef",
  });
  assert.equal(r3.fallback, true);
});
