// 轻量 API 客户端：token 存 localStorage，Authorization 头携带（非 cookie，无 CSRF 面）。
// 401 → 清 token 并广播事件，App 回落登录页。

const KEY = "qqgateway.token";

export const getToken = (): string | null => localStorage.getItem(KEY);
export const setToken = (t: string): void => localStorage.setItem(KEY, t);
export const clearToken = (): void => localStorage.removeItem(KEY);

export const UNAUTHORIZED_EVENT = "qqui-unauthorized";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/ui/api${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(401, "登录已失效，请重新输入 token。");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body !== null && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);
export const post = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T>(path: string): Promise<T> =>
  api<T>(path, { method: "DELETE" });

// —— 本地偏好（群备注名 / 记住的 bot） ——

export const getAlias = (groupOpenid: string): string =>
  localStorage.getItem(`qqgateway.alias.${groupOpenid}`) ?? "";
export const setAlias = (groupOpenid: string, alias: string): void => {
  if (alias.trim() === "")
    localStorage.removeItem(`qqgateway.alias.${groupOpenid}`);
  else localStorage.setItem(`qqgateway.alias.${groupOpenid}`, alias.trim());
};
export const getLastBot = (): string | null =>
  localStorage.getItem("qqgateway.bot");
export const setLastBot = (appid: string): void =>
  localStorage.setItem("qqgateway.bot", appid);
