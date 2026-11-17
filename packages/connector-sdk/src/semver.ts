// semver-lite：零依赖版本范围匹配，仅供 sdkRange 校验。
// 支持：精确 "1.2.3"、"^1.2.3"（主版本锁定）、"~1.2.3"（次版本锁定）、
// ">=1.0.0"、"*"、空格分隔 AND。不支持 OR（||）——分仓三方锁版用 AND 足够。

const V_RE = /^\d+\.\d+\.\d+$/;

/** 解析 "1.2.3"；非法返回 null */
export function parseVersion(v: string): [number, number, number] | null {
  if (!V_RE.test(v)) return null;
  const [maj, min, pat] = v.split(".").map((s) => Number.parseInt(s, 10));
  return [maj, min, pat];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** 单个子范围匹配 */
function matchPart(
  version: [number, number, number],
  part: string,
): boolean {
  const p = part.trim();
  if (p === "*" || p === "") return true;
  if (p.startsWith("^")) {
    const base = parseVersion(p.slice(1));
    if (base === null) return false;
    return (
      cmp(version, base) >= 0 &&
      version[0] === base[0]
    );
  }
  if (p.startsWith("~")) {
    const base = parseVersion(p.slice(1));
    if (base === null) return false;
    return (
      cmp(version, base) >= 0 &&
      version[0] === base[0] &&
      version[1] === base[1]
    );
  }
  if (p.startsWith(">=")) {
    const base = parseVersion(p.slice(2));
    if (base === null) return false;
    return cmp(version, base) >= 0;
  }
  if (p.startsWith("<=")) {
    const base = parseVersion(p.slice(2));
    if (base === null) return false;
    return cmp(version, base) <= 0;
  }
  if (p.startsWith(">")) {
    const base = parseVersion(p.slice(1));
    if (base === null) return false;
    return cmp(version, base) > 0;
  }
  if (p.startsWith("<")) {
    const base = parseVersion(p.slice(1));
    if (base === null) return false;
    return cmp(version, base) < 0;
  }
  if (p.startsWith("=")) {
    const base = parseVersion(p.slice(1));
    if (base === null) return false;
    return cmp(version, base) === 0;
  }
  const base = parseVersion(p);
  if (base === null) return false;
  return cmp(version, base) === 0;
}

/**
 * 判断 version 是否满足 range。range 非法（含无法解析的子范围）返回 false——
 * 加载侧对非法 range 报可操作错误时配合 parseVersion 自行定位。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  const parts = range.trim().split(/\s+/).filter((s) => s !== "");
  if (parts.length === 0) return false;
  return parts.every((part) => matchPart(v, part));
}
