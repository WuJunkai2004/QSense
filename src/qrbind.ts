// QQ 开放平台扫码绑定（q.qq.com lite 接口）：手机 QQ 扫码授权后，
// 本服务凭创建任务时自持的 AES-256 密钥解密拿回 AppSecret——全程无明文过网。
//
// 自 core/qrbind.ts 原样迁入（P1 QQ 收口手术，2026-11-15）：协议操作归连接器，
// 经 login: qr-pair 声明以插件 WebUI 路由暴露给 WebUI。
//
// 流程（2026-11-08 活体验证，参照 AstrBot 同源实现）：
//   1) 本地生成 32 字节 bind_key（base64）→ POST /lite/create_bind_task → task_id
//   2) 连接页 https://q.qq.com/qqbot/openclaw/connect.html?task_id=… 本地画成二维码，
//      用户手机 QQ 扫码后在官方页登录并确认绑定（官方校验扫码人管理权限）
//   3) 每 ~2s POST /lite/poll_bind_result：status 1=待确认 / 2=完成 / 3=过期
//      完成时返回 bot_appid + bot_encrypt_secret（base64(nonce12‖密文‖tag16)，AES-256-GCM）
//
// 安全模型：lite 接口零鉴权，task_id 谁都可轮——但 AppSecret 用我方 bind_key 端到端加密，
// 只有持有密钥的一方（本服务）能解。bind_key 不出本进程，浏览器只见 task_id。
//
// 风险与回落：这是官方未文档化的 lite 接口，可能无预警变更——WebUI 手动
// appid+AppSecret 添加路径常驻不删，本模块故障不影响添加功能。

import { createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { HttpClient, HttpResponse } from "@qsense/connector-sdk";
import { parseJsonWith } from "@qsense/connector-sdk";

export const QQ_BIND_HOST = "q.qq.com";

export interface QrTask {
  taskId: string;
  /** AES-256 密钥（base64）：创建任务时上交官方，完成时用于解密 AppSecret */
  bindKey: string;
  /** 连接页 URL：WebUI 本地渲染成二维码 */
  connectUrl: string;
}

export type QrPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | {
      status: "completed";
      appid: string;
      secret: string;
      /** 扫码确认人（QQ 侧 openid，bot 维度）；仅留档展示用 */
      userOpenid: string;
    };

export class QrBindError extends Error {}

/**
 * 官方 lite 应答统一信封（retcode=0 才算成功）：形状按实际读取字段定义
 * （create→data.task_id；poll→data.status/bot_appid/bot_encrypt_secret/user_openid），
 * 其余官方字段经 looseObject 透传（宽容接收方原则）。
 */
const LiteRespSchema = z.object({
  retcode: z.number().optional(),
  msg: z.string().optional(),
  data: z
    .looseObject({
      task_id: z.string().optional(),
      status: z.number().optional(),
      bot_appid: z.string().optional(),
      bot_encrypt_secret: z.string().optional(),
      user_openid: z.string().optional(),
    })
    .nullable()
    .optional(),
});
type LiteResp = z.infer<typeof LiteRespSchema>;

/** 统一 POST JSON + retcode 检查（官方 lite 风格：retcode=0 才算成功） */
async function postLite(
  http: HttpClient,
  path: string,
  payload: Record<string, string>,
): Promise<LiteResp> {
  let res: HttpResponse;
  try {
    res = await http.request(`https://${QQ_BIND_HOST}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs: 15_000,
    });
  } catch (e) {
    throw new QrBindError(
      `扫码绑定服务不可达（${e instanceof Error ? e.message : String(e)}）。` +
        "可改用手动方式添加（appid + AppSecret）。",
    );
  }
  const okStatus = res.status >= 200 && res.status < 300;
  const body = okStatus
    ? parseJsonWith(LiteRespSchema, await res.text().catch(() => ""))
    : null;
  if (!okStatus || body === null) {
    throw new QrBindError(
      `扫码绑定接口异常（HTTP ${res.status}）。可改用手动方式添加。`,
    );
  }
  const retcode = body.retcode ?? 0;
  if (retcode !== 0) {
    throw new QrBindError(
      `扫码绑定接口失败（retcode=${retcode}）：${
        body.msg !== undefined && body.msg !== "" ? body.msg : "未知原因"
      }`,
    );
  }
  return body;
}

/** 创建绑定任务：本地出密钥，官方发 task_id */
export async function createQrBindTask(http: HttpClient): Promise<QrTask> {
  const bindKey = randomBytes(32).toString("base64");
  const body = await postLite(http, "/lite/create_bind_task", { key: bindKey });
  const taskId = (body.data?.task_id ?? "").trim();
  if (taskId === "") {
    throw new QrBindError(
      "扫码绑定任务创建失败：官方响应缺少 task_id。可改用手动方式添加。",
    );
  }
  return {
    taskId,
    bindKey,
    connectUrl: `https://${QQ_BIND_HOST}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`,
  };
}

/** 轮询一次绑定结果：pending（继续轮）/ expired（重开任务）/ completed（含解密后 AppSecret） */
export async function pollQrBind(
  task: Pick<QrTask, "taskId" | "bindKey">,
  http: HttpClient,
): Promise<QrPollResult> {
  const body = await postLite(http, "/lite/poll_bind_result", {
    task_id: task.taskId,
  });
  const data = body.data;
  const status = data?.status ?? 0;
  if (status === 2) {
    const appid = (data?.bot_appid ?? "").trim();
    const enc = (data?.bot_encrypt_secret ?? "").trim();
    if (appid === "" || enc === "") {
      throw new QrBindError(
        "扫码完成但官方未返回完整凭据（缺 appid 或密文），请重试或手动添加。",
      );
    }
    return {
      status: "completed",
      appid,
      secret: decryptBindSecret(enc, task.bindKey),
      userOpenid: data?.user_openid ?? "",
    };
  }
  if (status === 3) return { status: "expired" };
  return { status: "pending" };
}

/**
 * 解密官方回传的 AppSecret：base64( nonce[12] ‖ AES-256-GCM 密文 ‖ tag[16] )，
 * 密钥即创建任务时上交的 bind_key（base64 的 32 字节）。
 */
export function decryptBindSecret(enc: string, bindKey: string): string {
  let key: Buffer;
  let raw: Buffer;
  try {
    key = Buffer.from(bindKey, "base64");
    raw = Buffer.from(enc, "base64");
  } catch {
    throw new QrBindError("扫码凭据解码失败（非法 base64）。");
  }
  if (key.length !== 32 || raw.length <= 28) {
    throw new QrBindError("扫码凭据密文格式异常。");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]);
  } catch {
    throw new QrBindError("扫码凭据解密失败：密钥不匹配或密文被篡改。");
  }
  return plain.toString("utf8");
}
