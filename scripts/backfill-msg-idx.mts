// 一次性回填：v7 迁移新增 messages/c2c_messages.msg_idx 列，历史行从 raw_json 补提。
// 官方在每条消息的 message_scene.ext 携带 msg_idx 令牌（"msg_idx=REFIDX_…"），
// 提取入库后 repo.resolveQuotes 才能把历史引用行 join 到缓存原文。
// 用法：npx tsx scripts/backfill-msg-idx.mts   （就地回填 ./data/qqbot.db，幂等：只填 NULL 行）

import Database from "better-sqlite3";

const db = new Database(process.env.DATA_DB ?? "./data/qqbot.db");

function extractMsgIdx(raw: string): string | null {
  try {
    const scene = (JSON.parse(raw) as Record<string, unknown>).message_scene as
      | { ext?: unknown }
      | undefined;
    const ext = scene?.ext;
    if (!Array.isArray(ext)) return null;
    for (const item of ext) {
      if (typeof item === "string" && item.startsWith("msg_idx=")) {
        const v = item.slice("msg_idx=".length);
        if (v !== "") return v;
      }
    }
  } catch {
    /* 畸形 raw 跳过 */
  }
  return null;
}

function backfill(table: string): number {
  const rows = db
    .prepare(
      `SELECT rowid AS rid, raw_json FROM ${table} WHERE msg_idx IS NULL AND raw_json IS NOT NULL`,
    )
    .all() as Array<{ rid: number; raw_json: string }>;
  const upd = db.prepare(`UPDATE ${table} SET msg_idx = ? WHERE rowid = ?`);
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const v = extractMsgIdx(r.raw_json);
      if (v !== null) {
        upd.run(v, r.rid);
        n += 1;
      }
    }
  })();
  return n;
}

const groupN = backfill("messages");
const c2cN = backfill("c2c_messages");
db.close();
console.log(`回填完成：messages ${groupN} 条，c2c_messages ${c2cN} 条`);
