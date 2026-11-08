// TTS 语音合成（OpenAI 兼容 /audio/speech）：send_media 的 "tts:<文本>" 来源在此合成，
// 产物（mp3 字节）直接进既有语音发送管道（file_type=3 官方吃 mp3/wav/silk，无需转码）。
//
// 配置：全局一份，kv tts:config:v1（base_url/api_key/model/voice）——WebUI 设置页维护；
// 使用闸门：每 bot 一把，kv tts:<appid>（enable/disable，缺省关）——见 repo。
//
// 安全与边界：
// - api_key 明文落库（与 agent_token 同一原则：单机管理面），源码/日志不打，UI 回显打码；
// - 合成产物即用即弃（内存 buffer，不落资产区——资产区是给 agent 上传的东西）；
// - 输入限长 1000 字符（防 agent 把整篇文章塞进来烧钱），超长可操作拒绝；
// - 上游不可达/非音频响应 → TtsError（可操作文案，agent 可转述给用户）。

export type TtsFormat = "mp3" | "wav";

export interface TtsConfig {
  /** OpenAI 兼容服务根（到 /v1 这一级，如 https://api.openai.com/v1；不带 /v1 也可，自动补） */
  base_url: string;
  /** Bearer 密钥；空串=不带 Authorization 头（自建无鉴权网关） */
  api_key: string;
  /** 模型名（tts-1 / fish-speech-1.5 / cosyvoice-… 视服务商） */
  model: string;
  /** 音色名（alloy / … 视服务商） */
  voice: string;
  /** 响应格式（response_format）：缺省 wav——兼容生态保底格式（真实服务实测存在仅支持 wav 的） */
  format?: TtsFormat;
}

export interface TtsDeps {
  /** 缺省 globalThis.fetch；测试注入假实现 */
  fetchImpl?: typeof fetch;
  /** 合成请求超时 ms（云端 1~5s 常态，缺省 30s 兜底） */
  timeoutMs?: number;
}

export class TtsError extends Error {}

/** tts: 前缀文本的输入上限（字符） */
export const TTS_MAX_INPUT = 1000;

/** URL 规范化拼接：去尾斜杠；路径不含 /v1 时自动补（兼容填根域与填到 /v1 两种习惯） */
export function ttsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const path = trimmed.replace(/^https?:\/\/[^/]+/, "");
  const withV1 = /\/v\d+$/.test(path) ? trimmed : `${trimmed}/v1`;
  return `${withV1}/audio/speech`;
}

/**
 * 合成语音：POST {base}/audio/speech（OpenAI 兼容），response_format 由配置选择
 * （wav 缺省——兼容生态保底格式；mp3 体积小）。两者官方语音接口 file_type=3 均直接
 * 受理（silk/mp3/wav），无需转码。返回音频字节（按所选格式魔数校验）。
 */
export async function synthesizeSpeech(
  cfg: TtsConfig,
  text: string,
  deps: TtsDeps = {},
): Promise<{ buf: Buffer; mime: "audio/wav" | "audio/mpeg" }> {
  const input = text.trim();
  if (input === "") {
    throw new TtsError("tts: 后没有内容——请提供要合成的话语。");
  }
  if (input.length > TTS_MAX_INPUT) {
    throw new TtsError(
      `tts: 文本过长（${input.length} > ${TTS_MAX_INPUT} 字符）。请精简或分段合成发送。`,
    );
  }
  const format: TtsFormat = cfg.format ?? "wav";
  const doFetch = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: format === "wav" ? "audio/wav" : "audio/mpeg",
  };
  if (cfg.api_key !== "") headers.Authorization = `Bearer ${cfg.api_key}`;
  let res: Response;
  try {
    res = await doFetch(ttsEndpoint(cfg.base_url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        input,
        voice: cfg.voice,
        response_format: format,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new TtsError(
      `TTS 服务不可达（${e instanceof Error ? e.message : String(e)}）。` +
        "请到 WebUI 设置页检查 TTS base_url，或改用文字发送。",
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new TtsError(
      `TTS 合成失败（HTTP ${res.status}）${detail !== "" ? `：${detail}` : "。"}。` +
        "请检查 WebUI 设置页的 TTS 配置（model/voice/格式 是否为该服务所支持）。",
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // 魔数校验（按所选格式）——防上游把 JSON/HTML 错误体当音频吐回来：
  // wav = RIFF…WAVE 头；mp3 = ID3v2 头或 MPEG 帧同步字
  const latin = (a: number, b: number): string =>
    buf.subarray(a, b).toString("latin1");
  const ok =
    format === "wav"
      ? buf.length >= 12 && latin(0, 4) === "RIFF" && latin(8, 12) === "WAVE"
      : buf.length >= 3 &&
        (latin(0, 3) === "ID3" ||
          (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0));
  if (!ok) {
    throw new TtsError(
      "TTS 服务返回的不是音频数据（魔数校验失败）。请检查 base_url 是否指向 OpenAI 兼容接口。",
    );
  }
  return { buf, mime: format === "wav" ? "audio/wav" : "audio/mpeg" };
}
