// M4-17 验收：资产上传（控制平面/数据平面分离）——
// request_upload 票据签发（HMAC 按 bot agent_token 派生、15 分钟、单次使用）→
// PUT /assets/{botId}/{assetId} 直传落盘（魔数嗅探/超限/篡改/过期/重放）→
// send_media asset:<id> 引用闭环（服务端读文件走 uploadMedia localPath）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger";
import { AssetStore, sniffAudioMime, sniffPathMime, uploadSig } from "../src/assets";
import { Sender, beijingDate } from "../src/sender";
import { buildServer } from "../src/server/http";
import { BotRegistry } from "../src/bots";
import { openDatabase, runMigrations, type DB } from "../src/store/db";
import { migrations } from "../src/store/migrations";
import { Repo } from "../src/store/repo";

const GROUP = "G1";
const BOT = "10001";
const AGENT_TOKEN = "a".repeat(48);
const BASE = "http://127.0.0.1:8787";

// 8x8 PNG 最小仿制（真实魔数）
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d2f" +
    "2a0000001d4944415478da63fcffff3f032511524c48c0c0c0c0f01f0009d102" +
    "ff9ecbd8ae0000000049454e44ae426082",
  "hex",
);

interface Fixture {
  db: DB;
  repo: Repo;
  registry: BotRegistry;
  assets: AssetStore;
  app: ReturnType<typeof buildServer>;
  dir: string;
  cleanup: () => void;
}

function setupFx(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-assets-"));
  const db = openDatabase(dir);
  runMigrations(db, migrations);
  const repo = new Repo(db);
  // M9：无 env 播种——基座 bot 直接入 bots 表（白名单含 GROUP），发送开关置 true
  db.prepare(
    `INSERT INTO bots(appid, name, secret, agent_token, allow_groups, auth_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(BOT, "t", "s", AGENT_TOKEN, JSON.stringify([GROUP]), "uncertified", Date.now());
  repo.ensureRuntime();
  repo.setSendEnable(true);
  const registry = new BotRegistry({ db });
  const assets = new AssetStore(join(dir, "assets"));
  const app = buildServer({
    log: createLogger("error"),
    db,
    repo,
    version: "test",
    registry,
    assets,
  });
  return {
    db,
    repo,
    registry,
    assets,
    app,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort（Windows EPERM 可忽略） */
      }
    },
  };
}

function makeSender(
  fx: Fixture,
  uploadInfo: { fileInfo: string },
  expectMediaType: "image" | "voice" = "image",
): Sender {
  return new Sender({
    log: createLogger("error"),
    db: fx.db,
    repo: fx.repo,
    tokenManager: {} as never,
    bots: fx.registry,
    assets: fx.assets,
    apiFor: () => ({
      sendRaw: async () => ({ id: "PROVIDER_MEDIA" }),
      recallMessage: async () => {},
      uploadMedia: async (_scope, _target, _creds, src, mediaType) => {
        // 服务端资产应走 localPath（file 源）直通 SDK；类别按来源魔数判定
        assert.equal(src.kind, "file", "asset: 引用应解析为 file 源");
        assert.equal(
          mediaType,
          expectMediaType,
          `uploadMedia 类别应为 ${expectMediaType}`,
        );
        const onDisk = readFileSync(src.path);
        if (expectMediaType === "image") {
          assert.ok(onDisk.subarray(0, 4).equals(PNG_BYTES.subarray(0, 4)));
        }
        return uploadInfo.fileInfo;
      },
    }),
  });
}

test("M4-17 资产闭环：签票→PUT 落盘→send_media asset: 引用（file 源直通 SDK）", async () => {
  const fx = setupFx();
  try {
    const ticket = fx.assets.issueTicket(BOT, AGENT_TOKEN, BASE);
    assert.match(ticket.urlPath, new RegExp(`^/assets/${BOT}/[0-9a-f]{32}\\?`));
    assert.equal(ticket.expiresInSec, 900);

    // 执行环境直传（curl 同款）：字节落盘后才可引用
    const put = await fx.app.inject({
      method: "PUT",
      url: `${BASE}${ticket.urlPath}`.replace(BASE, ""),
      headers: { "content-type": "application/octet-stream" },
      payload: PNG_BYTES,
    });
    assert.equal(put.statusCode, 200);

    // 窗内有消息 → 被动图
    fx.repo.saveGroupMessage({
      botId: BOT,
      scope: "group",
      scopeId: GROUP,
      msgId: "M_A",
      authorOpenid: "U1",
      authorName: "小明",
      ts: Date.now() - 60_000,
      content: "发张图",
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    });
    const sender = makeSender(fx, { fileInfo: "FILEINFO_ASSET" });
    const r = await sender.sendMediaAuto(
      BOT,
      GROUP,
      `asset:${ticket.assetId}`,
      "资产引用",
    );
    assert.equal(r.channel, "passive");
    assert.equal(r.msg_seq, 1);
  } finally {
    fx.cleanup();
  }
});

test("M4-17 PUT 数据端点：成功落盘/魔数拒绝/签名篡改/过期/重放/bot 未知", async () => {
  const fx = setupFx();
  try {
    const ticket = fx.assets.issueTicket(BOT, AGENT_TOKEN, BASE);
    const m = /[?&]exp=(\d+)&sig=([0-9a-f]+)/.exec(ticket.urlPath)!;
    const exp = m[1]!;
    const sig = m[2]!;
    const assetId = ticket.assetId;
    const url = `/assets/${BOT}/${assetId}`;

    // ① 正常直传（octet-stream → catch-all parser）
    const ok = await fx.app.inject({
      method: "PUT",
      url: `${url}?exp=${exp}&sig=${sig}`,
      headers: { "content-type": "application/octet-stream" },
      payload: PNG_BYTES,
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().asset_id, assetId);
    assert.equal(ok.json().mime, "image/png");
    assert.match(ok.json().next, /send_media/);

    // ② 重放（票据单次使用）
    const replay = await fx.app.inject({
      method: "PUT",
      url: `${url}?exp=${exp}&sig=${sig}`,
      headers: { "content-type": "application/octet-stream" },
      payload: PNG_BYTES,
    });
    assert.equal(replay.statusCode, 409);

    // ③ 签名篡改
    const ticket2 = fx.assets.issueTicket(BOT, AGENT_TOKEN, BASE);
    const m2 = /[?&]exp=(\d+)&sig=([0-9a-f]+)/.exec(ticket2.urlPath)!;
    const bad = await fx.app.inject({
      method: "PUT",
      url: `/assets/${BOT}/${ticket2.assetId}?exp=${m2[1]}&sig=${"0".repeat(64)}`,
      headers: { "content-type": "application/octet-stream" },
      payload: PNG_BYTES,
    });
    assert.equal(bad.statusCode, 403);

    // ④ 过期（exp 已过 + 用该 exp 重算的有效签名）
    const staleExp = Date.now() - 1000;
    const staleSig = uploadSig(AGENT_TOKEN, BOT, ticket2.assetId, staleExp);
    const stale = await fx.app.inject({
      method: "PUT",
      url: `/assets/${BOT}/${ticket2.assetId}?exp=${staleExp}&sig=${staleSig}`,
      headers: { "content-type": "application/octet-stream" },
      payload: PNG_BYTES,
    });
    assert.equal(stale.statusCode, 410);

    // ⑤ bot 未知（token 查不到 → 票据不可验）
    const t3 = fx.assets.issueTicket("ghost", AGENT_TOKEN, BASE);
    const m3 = /[?&]exp=(\d+)&sig=([0-9a-f]+)/.exec(t3.urlPath)!;
    const ghost = await fx.app.inject({
      method: "PUT",
      url: `/assets/ghost/${t3.assetId}?exp=${m3[1]}&sig=${m3[2]}`,
      headers: { "content-type": "application/octet-stream" },
      payload: PNG_BYTES,
    });
    assert.equal(ghost.statusCode, 403);

    // ⑥ 非图片内容（魔数嗅探失败）
    const t4 = fx.assets.issueTicket(BOT, AGENT_TOKEN, BASE);
    const m4 = /[?&]exp=(\d+)&sig=([0-9a-f]+)/.exec(t4.urlPath)!;
    const txt = await fx.app.inject({
      method: "PUT",
      url: `/assets/${BOT}/${t4.assetId}?exp=${m4[1]}&sig=${m4[2]}`,
      headers: { "content-type": "application/octet-stream" },
      payload: "hello, not an image",
    });
    assert.equal(txt.statusCode, 415);

    // ⑦ asset: 引用不存在的资产 → 可操作报错
    const sender = makeSender(fx, { fileInfo: "X" });
    await assert.rejects(
      () => sender.sendMediaAuto(BOT, GROUP, `asset:${"f".repeat(32)}`),
      /资产不存在/,
    );

    // ⑧ 日额度未被被动图污染（走的是 passive，不计 proactive）
    assert.equal(fx.repo.proactiveCountFor(BOT, GROUP, beijingDate()), 0);
  } finally {
    fx.cleanup();
  }
});

// —— M10 语音扩展：音频魔数嗅探 + 语音资产闭环（asset: → file_type=3） ——

// 最小 mp3 仿制：ID3v2 头 + 裸 MPEG 帧同步字 + 数据体
const MP3_BYTES = Buffer.concat([
  Buffer.from("ID3", "latin1"),
  Buffer.alloc(7, 0),
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  Buffer.alloc(64, 1),
]);
// 最小 wav 仿制：RIFF 容器 + WAVE 标识
const WAV_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.alloc(4, 0),
  Buffer.from("WAVE", "latin1"),
  Buffer.alloc(16, 0),
]);
// SILK v3 头：QQ 语音原生格式（常带 1 字节 0x02 前缀）
const SILK_BYTES = Buffer.concat([
  Buffer.from([0x02]),
  Buffer.from("#!SILK_V3", "latin1"),
  Buffer.alloc(16, 0),
]);

test("M10 音频魔数嗅探：mp3(ID3/裸帧)/wav/silk 命中，杂讯拒收", () => {
  assert.equal(sniffAudioMime(MP3_BYTES), "audio/mpeg");
  assert.equal(sniffAudioMime(WAV_BYTES), "audio/wav");
  assert.equal(sniffAudioMime(SILK_BYTES), "audio/silk");
  assert.equal(
    sniffAudioMime(Buffer.from("#!SILK_V3", "latin1")),
    "audio/silk",
    "无 0x02 前缀的 silk 头同样识别",
  );
  assert.equal(sniffAudioMime(Buffer.from("hello, not an audio")), null);
  assert.equal(sniffAudioMime(PNG_BYTES), null, "图片不是音频");
});

test("M10 语音资产闭环：PUT 落盘 audio/mpeg → send_media asset: 引用走语音类别，补记 ![语音]", async () => {
  const fx = setupFx();
  try {
    const ticket = fx.assets.issueTicket(BOT, AGENT_TOKEN, BASE);
    const put = await fx.app.inject({
      method: "PUT",
      url: `${BASE}${ticket.urlPath}`.replace(BASE, ""),
      headers: { "content-type": "application/octet-stream" },
      payload: MP3_BYTES,
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().mime, "audio/mpeg", "魔数嗅探应判为音频");

    // 落盘文件头可嗅探（send_media 的 file 源分类依据）
    const onDisk = fx.assets.pathOf(ticket.assetId)!;
    assert.equal(sniffPathMime(onDisk), "audio/mpeg");

    // 窗内有消息 → 被动语音
    fx.repo.saveGroupMessage({
      botId: BOT,
      scope: "group",
      scopeId: GROUP,
      msgId: "M_VOICE",
      authorOpenid: "U1",
      authorName: "小明",
      ts: Date.now() - 60_000,
      content: "来段语音",
      mentions: [],
      elements: undefined,
      attachments: [],
      raw: {},
    });
    const sender = makeSender(fx, { fileInfo: "FILEINFO_VOICE" }, "voice");
    const r = await sender.sendMediaAuto(
      BOT,
      GROUP,
      `asset:${ticket.assetId}`,
      "听听这个",
    );
    assert.equal(r.channel, "passive");
    const latest = fx.repo.browseLatest(BOT, GROUP, 1)[0]!;
    assert.equal(latest.direction, 1);
    assert.equal(latest.content, "![语音] 听听这个");
  } finally {
    fx.cleanup();
  }
});
