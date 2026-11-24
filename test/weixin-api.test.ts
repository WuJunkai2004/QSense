// 微信 iLink API 客户端线格式测试：真本地 HTTP 台架（node:http）验证请求头 / 请求体 /
// uint64 无损解析 / 错误分档（biz / http / network / timeout / aborted）/
// 扫码两接口的路径与鉴权差异——零真实网络（只打 127.0.0.1）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { httpClient } from "@qsense/connector-sdk";
import {
  WeixinApiError,
  baseInfo,
  bizCodeOf,
  clientVersionOf,
  createWeixinApi,
  parseWeixinJson,
} from "@qsense/connector-weixin";

interface Seen {
  method: string;
  url: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Handler = (req: Seen, res: ServerResponse) => void;

interface Mock {
  baseUrl: string;
  seen: Seen[];
  routes: Map<string, Handler>;
  close(): Promise<void>;
}

function json(res: ServerResponse, obj: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Connection", "close");
  res.end(JSON.stringify(obj));
}

/** 原样回文本（uint64 字面量必须走这条：JS 数字先落地会丢精度） */
function raw(res: ServerResponse, text: string, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Connection", "close");
  res.end(text);
}

async function startMock(): Promise<Mock> {
  const seen: Seen[] = [];
  const routes = new Map<string, Handler>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const record: Seen = {
        method: req.method ?? "",
        url: req.url ?? "/",
        path: url.pathname,
        headers: req.headers,
        body,
      };
      seen.push(record);
      const handler = routes.get(record.path);
      if (handler === undefined) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      handler(record, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    routes,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** 已关闭端口（连接被拒 → network 分档） */
async function deadBaseUrl(): Promise<string> {
  const m = await startMock();
  const base = m.baseUrl;
  await m.close();
  return base;
}

const TOKEN = "tok-123";

test("getupdates：请求头 / 请求体 / uint64 无损解析 / 服务端建议超时", async () => {
  const mock = await startMock();
  try {
    mock.routes.set("/ilink/bot/getupdates", (_req, res) =>
      raw(
        res,
        '{"ret":0,"msgs":[{"message_id":76561199012345678901234,"from_user_id":"u1@im.wechat",' +
          '"item_list":[{"type":1,"msg_id":99999999999999999999,"text_item":{"text":"原文里的 \\"msg_id\\": 7 不是键"}}]}],' +
          '"get_updates_buf":"BUF1","longpolling_timeout_ms":20000}',
      ),
    );
    const api = createWeixinApi(httpClient(), TOKEN, mock.baseUrl);
    const resp = await api.getUpdates("CURSOR", { timeoutMs: 5000 });

    const req = mock.seen[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/ilink/bot/getupdates");
    assert.equal(req.headers["authorization"], `Bearer ${TOKEN}`);
    assert.equal(req.headers["authorizationtype"], "ilink_bot_token");
    assert.equal(req.headers["ilink-app-id"], "bot");
    // 头名大小写不敏感：Node 归一为小写（iLink-App-ClientVersion）
    assert.equal(req.headers["ilink-app-clientversion"], "132106"); // 2.4.10 → 0x0002040A
    assert.equal(req.headers["content-type"], "application/json");
    // X-WECHAT-UIN = base64(随机 uint32 的十进制文本)
    const uin = String(req.headers["x-wechat-uin"] ?? "");
    assert.match(Buffer.from(uin, "base64").toString("utf8"), /^\d+$/);
    assert.deepEqual(JSON.parse(req.body), {
      get_updates_buf: "CURSOR",
      base_info: { channel_version: "2.4.10", bot_agent: "QSense-weixin/0.1.0" },
    });

    // uint64 无损：线上数字 → 字符串；字符串内部内容不动
    assert.equal(resp.msgs?.[0]?.message_id, "76561199012345678901234");
    assert.equal(resp.msgs?.[0]?.item_list?.[0]?.msg_id, "99999999999999999999");
    assert.equal(
      resp.msgs?.[0]?.item_list?.[0]?.text_item?.text,
      '原文里的 "msg_id": 7 不是键',
    );
    assert.equal(resp.get_updates_buf, "BUF1");
    assert.equal(resp.longpolling_timeout_ms, 20000);
  } finally {
    await mock.close();
  }
});

test("sendmessage：message_id 无损回执；ret / errcode 非零 → biz 错（code 可取）", async () => {
  const mock = await startMock();
  try {
    const api = createWeixinApi(httpClient(), TOKEN, mock.baseUrl);
    mock.routes.set("/ilink/bot/sendmessage", (req, res) => {
      const body = JSON.parse(req.body) as { msg: { to_user_id: string } };
      assert.equal(body.msg.to_user_id, "u1@im.wechat");
      raw(res, '{"message_id":12345678901234567890,"ret":0}');
    });
    const ok = await api.sendMessage({
      to_user_id: "u1@im.wechat",
      from_user_id: "",
      client_id: "c1",
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: "hi" } }],
      context_token: "CTX",
    });
    assert.equal(ok.message_id, "12345678901234567890");
    // 应答体带 context_token？不——请求体才回带
    assert.equal((JSON.parse(mock.seen[0]!.body) as { msg: { context_token: string } }).msg.context_token, "CTX");

    mock.routes.set("/ilink/bot/sendmessage", (_req, res) =>
      raw(res, '{"ret":500001,"errmsg":"content too long"}'),
    );
    await assert.rejects(
      () => api.sendMessage({ to_user_id: "u", from_user_id: "", client_id: "c", message_type: 2, item_list: [] }),
      (e: unknown) => e instanceof WeixinApiError && e.kind === "biz" && e.code === 500001,
    );
    mock.routes.set("/ilink/bot/sendmessage", (_req, res) => raw(res, '{"errcode":-14,"errmsg":"stale"}'));
    await assert.rejects(
      () => api.sendMessage({ to_user_id: "u", from_user_id: "", client_id: "c", message_type: 2, item_list: [] }),
      (e: unknown) => e instanceof WeixinApiError && e.kind === "biz" && e.code === -14,
    );
  } finally {
    await mock.close();
  }
});

test("错误分档：HTTP 401 → http；连接被拒 → network；挂起不回 → timeout；外部 signal → aborted", async () => {
  const mock = await startMock();
  try {
    const api = createWeixinApi(httpClient(), TOKEN, mock.baseUrl);
    mock.routes.set("/ilink/bot/msg/notifystart", (_req, res) => json(res, { ret: 401 }, 401));
    await assert.rejects(
      () => api.notifyStart(),
      (e: unknown) => e instanceof WeixinApiError && e.kind === "http" && e.status === 401,
    );
    // 挂起不回：客户端超时
    mock.routes.set("/ilink/bot/msg/notifystart", () => undefined);
    await assert.rejects(
      () => api.notifyStart({ timeoutMs: 80 }),
      (e: unknown) => e instanceof WeixinApiError && e.kind === "timeout",
    );
    // 外部 signal 中止
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(
      () => api.notifyStart({ signal: ac.signal, timeoutMs: 5000 }),
      (e: unknown) => e instanceof WeixinApiError && e.kind === "aborted",
    );
  } finally {
    await mock.close();
  }
  const api = createWeixinApi(httpClient(), TOKEN, await deadBaseUrl());
  await assert.rejects(
    () => api.notifyStart({ timeoutMs: 5000 }),
    (e: unknown) => e instanceof WeixinApiError && e.kind === "network",
  );
});

test("notifystart / notifystop / getuploadurl：路径与请求体；业务码非零抛 biz", async () => {
  const mock = await startMock();
  try {
    const api = createWeixinApi(httpClient(), TOKEN, mock.baseUrl);
    mock.routes.set("/ilink/bot/msg/notifystart", (_req, res) => json(res, { ret: 0 }));
    mock.routes.set("/ilink/bot/msg/notifystop", (_req, res) => json(res, { ret: 0 }));
    mock.routes.set("/ilink/bot/getuploadurl", (_req, res) =>
      json(res, { upload_param: "UP", upload_full_url: "https://cdn.example/up" }),
    );
    await api.notifyStart();
    await api.notifyStop();
    const up = await api.getUploadUrl({
      filekey: "fk",
      media_type: 1,
      to_user_id: "u",
      rawsize: 10,
      rawfilemd5: "md5",
      filesize: 16,
      no_need_thumb: true,
      aeskey: "a".repeat(32),
    });
    assert.deepEqual(up, { upload_param: "UP", upload_full_url: "https://cdn.example/up" });
    assert.equal(mock.seen[0]!.path, "/ilink/bot/msg/notifystart");
    assert.equal(mock.seen[1]!.path, "/ilink/bot/msg/notifystop");
    assert.deepEqual(JSON.parse(mock.seen[2]!.body), {
      filekey: "fk",
      media_type: 1,
      to_user_id: "u",
      rawsize: 10,
      rawfilemd5: "md5",
      filesize: 16,
      no_need_thumb: true,
      aeskey: "a".repeat(32),
      base_info: baseInfo(),
    });
    // 业务码非零
    mock.routes.set("/ilink/bot/msg/notifystart", (_req, res) => json(res, { ret: -1, errmsg: "bad" }));
    await assert.rejects(
      () => api.notifyStart(),
      (e: unknown) => e instanceof WeixinApiError && e.kind === "biz" && e.code === -1,
    );
    // 应答体业务码缺省/为 0 视为成功；空应答体也容忍
    mock.routes.set("/ilink/bot/msg/notifystart", (_req, res) => raw(res, ""));
    await api.notifyStart();
  } finally {
    await mock.close();
  }
});

test("扫码两接口：get_bot_qrcode（POST，bot_type=3，body 仅 local_token_list）；get_qrcode_status（GET，无 Authorization，可切入口）", async () => {
  const mock = await startMock();
  const other = await startMock();
  try {
    const api = createWeixinApi(httpClient(), "", mock.baseUrl);
    mock.routes.set("/ilink/bot/get_bot_qrcode", (_req, res) =>
      raw(res, '{"qrcode":"QR-TOKEN","qrcode_img_content":"https://weixin.qq.com/x/abc"}'),
    );
    const qr = await api.getBotQrcode(["t1", "t2"]);
    assert.deepEqual(qr, {
      qrcode: "QR-TOKEN",
      qrcode_img_content: "https://weixin.qq.com/x/abc",
    });
    const create = mock.seen[0]!;
    assert.equal(create.method, "POST");
    assert.equal(create.path, "/ilink/bot/get_bot_qrcode");
    assert.equal(create.url, "/ilink/bot/get_bot_qrcode?bot_type=3");
    assert.deepEqual(JSON.parse(create.body), { local_token_list: ["t1", "t2"] });
    assert.equal(create.headers["authorization"], undefined); // 无 token 不带 Authorization
    assert.equal(create.headers["authorizationtype"], "ilink_bot_token");

    // 状态查询打到「另一个入口」（IDC 重定向语义）：GET + query，无请求体，不带 Authorization
    other.routes.set("/ilink/bot/get_qrcode_status", (_req, res) =>
      json(res, { status: "scaned" }),
    );
    const status = await api.getQrcodeStatus("QR TOKEN", {
      baseUrl: other.baseUrl,
      verifyCode: "12 34",
      timeoutMs: 5000,
    });
    assert.equal(status.status, "scaned");
    const poll = other.seen[0]!;
    assert.equal(poll.method, "GET");
    assert.equal(
      poll.url,
      "/ilink/bot/get_qrcode_status?qrcode=QR%20TOKEN&verify_code=12%2034",
    );
    assert.equal(poll.body, "");
    assert.equal(poll.headers["authorization"], undefined);
    assert.equal(poll.headers["ilink-app-id"], "bot");
  } finally {
    await mock.close();
    await other.close();
  }
});

test("parseWeixinJson 单元：只改写 id 键位置的数字；字符串内部 / 数组元素 / 其它键不动", () => {
  const src =
    '{"message_id":123,"svr_id": 456 ,"msg_id":\n789,"seq":999,' +
    '"x":{"message_id":18446744073709551615},"text":"a \\"message_id\\": 5 b","a":[1,2],"neg":-14}';
  assert.deepEqual(parseWeixinJson(src), {
    message_id: "123",
    svr_id: "456",
    msg_id: "789",
    seq: 999,
    x: { message_id: "18446744073709551615" },
    text: 'a "message_id": 5 b',
    a: [1, 2],
    neg: -14,
  });
  // 冒号后不是数字：原样
  assert.deepEqual(parseWeixinJson('{"message_id":"already","msg_id":null}'), {
    message_id: "already",
    msg_id: null,
  });
});

test("常量与纯函数：clientVersionOf / baseInfo / bizCodeOf", () => {
  assert.equal(clientVersionOf("2.4.10"), 132106);
  assert.equal(clientVersionOf("1.0.11"), 65547);
  assert.deepEqual(baseInfo(), {
    channel_version: "2.4.10",
    bot_agent: "QSense-weixin/0.1.0",
  });
  assert.equal(bizCodeOf({}), undefined);
  assert.equal(bizCodeOf({ ret: 0, errcode: 0 }), undefined);
  assert.equal(bizCodeOf({ ret: 500001 }), 500001);
  assert.equal(bizCodeOf({ ret: 1, errcode: -14 }), -14); // errcode 优先
});
