// 网关会话持久化：session_id + lastSeq 存 kv 表（DESIGN.md §3.3）。
// 进程重启后凭它发起 RESUME，官方自动补发停机期间遗漏的事件——断电也不丢消息。

import type { PersistedSession, SessionPersistencePort } from "@tencent-connect/qqbot-nodejs/protocol";
import type { DB } from "../store/db";

const keyOf = (botId: string): string => `gw:session:${botId}`;

export function kvSessionPort(db: DB, botId: string): SessionPersistencePort {
  const key = keyOf(botId);
  const select = db.prepare("SELECT v FROM kv WHERE k = ?");
  const upsert = db.prepare(
    "INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  );
  const del = db.prepare("DELETE FROM kv WHERE k = ?");
  return {
    load: (): PersistedSession | null => {
      const row = select.get(key) as { v: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.v) as PersistedSession;
        if (typeof parsed.sessionId !== "string" || parsed.sessionId === "") return null;
        return parsed;
      } catch {
        return null; // 坏数据视为无会话，走全新 IDENTIFY
      }
    },
    save: (session: PersistedSession): void => {
      upsert.run(key, JSON.stringify(session));
    },
    clear: (): void => {
      del.run(key);
    },
  };
}
