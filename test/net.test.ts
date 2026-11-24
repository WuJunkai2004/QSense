// NetKit / FakeNetKit / longPoll 驱动验收（B⁺ T3，2026-11-24）：
// - httpClient：NetError 分档（timeout/network/aborted/http）+ schema 参数化 json
// - backoff / sniffMime：机械正确性
// - longPoll 驱动不变量：批全摄完才推进游标 / fatal 上抛 / abort 即时 /
//   连败清游标 / 空批 clamp 空转
// - FakeNetKit：路由 + 请求记录 + 时钟 + materialize 脚本（测试驱动权落点）

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  FakeNetKit,
  NetError,
  backoff,
  httpClient,
  isNetError,
  longPoll,
  sniffMime,
  type LongPollBatch,
  type LongPollSpec,
} from "@qsense/connector-sdk";

// ---------------------------------------------------------------------------
// NetError 分档与鸭子判定
// ---------------------------------------------------------------------------

test("NetError：分档字段 + isNetError 鸭子判定（跨打包副本语义）", () => {
  const e = new NetError("http", "HTTP 404", 404);
  assert.equal(e.kind, "http");
  assert.equal(e.status, 404);
  assert.equal(isNetError(e), true);
  assert.equal(isNetError(new Error("普通错误")), false);
  assert.equal(isNetError("str"), false);
  // 跨副本：非 NetError 类实例但形状吻合也可判定（鸭子）
  const clone = Object.assign(new Error("x"), { kind: "timeout" });
  assert.equal(isNetError(clone), true);
});

// ---------------------------------------------------------------------------
// httpClient（swap globalThis.fetch）
// ---------------------------------------------------------------------------

const EchoSchema = z.object({ ok: z.boolean() });

test("httpClient.json（真 fetch swap）：2xx 过 schema 返回类型化数据", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  try {
    const data = await httpClient().json("https://x/api", EchoSchema);
    assert.equal(data.ok, true);
  } finally {
    globalThis.fetch = orig;
  }
});

test("httpClient.json：HTTP 404 → http 档带 status（FakeNetKit queue）", async () => {
  const fake = new FakeNetKit();
  fake.queue("https://x/", [{ status: 404, body: "no" }]);
  const client = fake.http();
  await assert.rejects(client.json("https://x/api", EchoSchema), (e: unknown) => {
    assert.ok(isNetError(e));
    assert.equal((e as NetError).kind, "http");
    assert.equal((e as NetError).status, 404);
    return true;
  });
});

test("httpClient.json：schema 违规 → http 档 + 字段路径（不含数据值）", async () => {
  const fake = new FakeNetKit();
  fake.on("https://x/", () => ({ status: 200, body: { ok: "yes" } }));
  const client = fake.http();
  await assert.rejects(client.json("https://x/api", EchoSchema), (e: unknown) => {
    assert.ok(isNetError(e));
    assert.equal((e as NetError).kind, "http");
    assert.ok((e as Error).message.includes("ok"), "message 含字段路径");
    assert.ok(!(e as Error).message.includes("yes"), "message 不含数据值");
    return true;
  });
});

test("httpClient：外部中止 → aborted 档", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    })) as typeof fetch;
  try {
    const ac = new AbortController();
    const p = httpClient().request("https://x", { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e: unknown) => {
      assert.ok(isNetError(e));
      assert.equal((e as NetError).kind, "aborted");
      return true;
    });
  } finally {
    globalThis.fetch = orig;
  }
});

test("httpClient：超时 → timeout 档（unref 定时器，20ms 短超时）", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  try {
    await assert.rejects(
      httpClient({ timeoutMs: 20 }).request("https://x"),
      (e: unknown) => {
        assert.ok(isNetError(e));
        assert.equal((e as NetError).kind, "timeout");
        return true;
      },
    );
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------------------------------------------------------------------------
// backoff / sniffMime
// ---------------------------------------------------------------------------

test("backoff：指数增长 + 封顶 + reset", () => {
  const b = backoff({ retryMs: 100, backoffMs: 2, maxDelayMs: 1000 });
  assert.equal(b.fail(), 100);
  assert.equal(b.fail(), 200);
  assert.equal(b.fail(), 400);
  assert.equal(b.fail(), 800);
  assert.equal(b.fail(), 1000); // 封顶
  assert.equal(b.fail(), 1000); // 封顶持续
  assert.equal(b.failures, 6);
  b.reset();
  assert.equal(b.failures, 0);
  assert.equal(b.fail(), 100);
});

test("sniffMime：魔数词表（png/jpeg/gif/webp/bmp/mp3/wav/silk/ogg/mp4）+ fallback", () => {
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("GIF89a", "latin1")), "image/gif");
  const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1")]);
  assert.equal(sniffMime(webp), "image/webp");
  assert.equal(sniffMime(Buffer.from("BMxx", "latin1")), "image/bmp");
  assert.equal(sniffMime(Buffer.from("ID3x", "latin1")), "audio/mpeg");
  const wav = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1")]);
  assert.equal(sniffMime(wav), "audio/wav");
  assert.equal(sniffMime(Buffer.from("\x02#!SILK_V3", "latin1")), "audio/silk");
  assert.equal(sniffMime(Buffer.from("OggSxx", "latin1")), "audio/ogg");
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp", "latin1"), Buffer.from("isom", "latin1")]);
  assert.equal(sniffMime(mp4), "video/mp4");
  assert.equal(sniffMime(Buffer.from("???"), "application/x-fallback"), "application/x-fallback");
});

// ---------------------------------------------------------------------------
// longPoll 驱动不变量（spec 全脚本化；policy 短时值避免真睡）
// ---------------------------------------------------------------------------

interface Rig {
  spec: LongPollSpec<string>;
  saved: string[];
  resets: number;
  states: string[];
  ingested: string[];
  abort: () => void;
  signal: AbortSignal;
  /** 预编排 fetch 脚本（队列，逐次弹出；Error 直接抛） */
  script: (steps: Array<LongPollBatch<string> | Error>) => void;
  done: Promise<void>;
}

function makeRig(): Rig {
  const ac = new AbortController();
  const saved: string[] = [];
  const states: string[] = [];
  const ingested: string[] = [];
  let resets = 0;
  let cursor: string | null = null;
  let steps: Array<LongPollBatch<string> | Error> = [];
  const spec: LongPollSpec<string> = {
    loadCursor: async () => cursor,
    saveCursor: async (c) => {
      saved.push(c);
      cursor = c;
    },
    resetCursor: async () => {
      resets++;
      cursor = null;
    },
    fetch: async () => {
      const next = steps.shift();
      if (next === undefined) {
        ac.abort(); // 脚本耗尽 → 停驱动
        throw new Error("script exhausted");
      }
      if (next instanceof Error) throw next;
      return next;
    },
    onItem: async (item) => {
      ingested.push(String(item));
    },
    isFatal: (e) => e instanceof Error && e.message === "FATAL",
    onState: (s) => states.push(s),
    policy: { retryMs: 1, backoffMs: 2, minPollMs: 1, maxPollMs: 5, maxFailures: 2 },
  };
  const done = longPoll(spec, ac.signal).then(() => undefined);
  return {
    spec,
    saved,
    get resets(): number {
      return resets;
    },
    states,
    ingested,
    abort: () => ac.abort(),
    signal: ac.signal,
    script: (s) => {
      steps = s;
    },
    done,
  };
}

test("longPoll：批全摄完才推进游标；onItem 抛错=批失败游标不动、重拉同批", async () => {
  const rig = makeRig();
  let failFirst = true;
  // 首批 items 含一个毒丸（首次摄取抛错）→ 驱动退避重拉同批（游标未推进）；
  // 重拉成功后游标才推进（首批失败的证据：毒丸摄取抛错时 saved 尚为空、同批重投）
  rig.spec.onItem = async (item) => {
    if (item === "poison" && failFirst) {
      failFirst = false;
      throw new Error("摄取失败");
    }
    rig.ingested.push(String(item));
  };
  rig.script([
    { items: ["a", "poison", "b"], next: "c1" },
    { items: ["a", "poison", "b"], next: "c1" }, // 同批重投（至少一次）
  ]);
  await rig.done; // 脚本耗尽自动停
  // 精确序列：首批 a 摄取后毒丸抛错（b 未到）→ 重拉同批 → a/poison/b 全过 → 推进游标。
  // 「至少一次」语义可见：a 被摄取两次、b 恰好一次、游标只推进一次。
  assert.deepEqual(rig.ingested, ["a", "a", "poison", "b"]);
  assert.deepEqual(rig.saved, ["c1"], "游标只在批次全摄完成后推进（重投成功那次）");
});

test("longPoll：成功批推进游标 + ready 上报", async () => {
  const rig = makeRig();
  rig.script([
    { items: ["a", "b"], next: "c1" },
    { items: [], next: "c2" },
  ]);
  await rig.done;
  assert.deepEqual(rig.saved, ["c1", "c2"]);
  assert.deepEqual(rig.ingested, ["a", "b"]);
  assert.equal(rig.states[0], "starting");
  assert.equal(rig.states.includes("ready"), true);
});

test("longPoll：fatal 上抛；非 fatal 指数退避后继续", async () => {
  const rig = makeRig();
  rig.script([new Error("FATAL")]);
  await assert.rejects(rig.done, /FATAL/);
  assert.equal(rig.states.includes("degraded"), true);
});

test("longPoll：连败 maxFailures → resetCursor + 游标重读（wx 语义）", async () => {
  const rig = makeRig();
  rig.script([
    new Error("e1"),
    new Error("e2"), // 连败 2 → resetCursor（resets=1）→ loadCursor 重读（cursor=null）
    { items: ["fresh"], next: "c-new" },
  ]);
  await rig.done;
  assert.equal(rig.resets, 1);
  assert.deepEqual(rig.ingested, ["fresh"]);
  assert.deepEqual(rig.saved, ["c-new"]);
});

test("longPoll：abort 即时生效（fetch 挂起中停服，驱动静默返回）", async () => {
  const ac = new AbortController();
  const spec: LongPollSpec<string> = {
    loadCursor: async () => null,
    saveCursor: async () => undefined,
    fetch: (_cursor, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("a", "AbortError")));
      }),
    onItem: async () => undefined,
    isFatal: () => false,
  };
  const p = longPoll(spec, ac.signal);
  setTimeout(() => ac.abort(), 10);
  await assert.doesNotReject(p);
});

// ---------------------------------------------------------------------------
// FakeNetKit：路由 / 请求记录 / 时钟 / materialize 脚本
// ---------------------------------------------------------------------------

test("FakeNetKit：路由应答 + 请求记录 + json schema 过滤 + 时钟", async () => {
  const fake = new FakeNetKit();
  fake.on("https://api.example/", (req) => {
    assert.equal(req.headers["authorization"], "Bearer t");
    return { status: 200, body: { ok: true } };
  });
  const client = fake.http();
  const data = await client.json("https://api.example/x", EchoSchema, {
    headers: { Authorization: "Bearer t" },
  });
  assert.equal(data.ok, true);
  assert.equal(fake.count("https://api.example/"), 1);
  assert.equal(fake.requests[0]!.method, "GET");
  assert.equal(fake.now(), 0);
  await fake.sleep(500);
  assert.equal(fake.now(), 500, "fake sleep 推进时钟");
});

test("FakeNetKit：无路由抛错；queue 队列耗尽抛错；Error 应答直接抛", async () => {
  const fake = new FakeNetKit();
  const client = fake.http();
  await assert.rejects(client.request("https://none/"), /no route/);
  fake.queue("https://q/", [{ body: { ok: true } }, new NetError("timeout", "超时模拟")]);
  await assert.doesNotReject(client.json("https://q/1", EchoSchema));
  await assert.rejects(client.json("https://q/2", EchoSchema), (e: unknown) => {
    assert.ok(isNetError(e));
    assert.equal((e as NetError).kind, "timeout");
    return true;
  });
});

test("FakeNetKit：materialize 脚本（url→字节；未注册抛错；b64 真解码）", async () => {
  const fake = new FakeNetKit();
  fake.file("https://cdn/x.png", Buffer.from([0x89, 0x50]));
  const m1 = await fake.materialize({ kind: "url", url: "https://cdn/x.png" });
  assert.equal(m1.buf.length, 2);
  assert.equal(m1.name, "x.png");
  const m2 = await fake.materialize({ kind: "b64", data: Buffer.from("hi").toString("base64") });
  assert.equal(m2.buf.toString(), "hi");
  await assert.rejects(fake.materialize({ kind: "url", url: "https://cdn/none" }), /no materialize script/);
});
