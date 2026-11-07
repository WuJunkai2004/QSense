// 一次性回填：c2c_messages.author_name 为 NULL 的入站行，从本 bot 群聊名册（members）反查昵称。
// 单聊事件载荷无昵称（author.user_openid 之上没有展示名）；openid 按 bot 维度隔离——
// 同一人在不同 bot 处 openid 不同，映射查询必须绑定 bot_id。名册即映射表（群聊消息积累）。
// 用法：npx tsx scripts/backfill-c2c-names.mts   （就地回填 ./data/qqbot.db，幂等：只填 NULL 行）

import Database from "better-sqlite3";

const db = new Database(process.env.DATA_DB ?? "./data/qqbot.db");

// 待回填的（bot, 用户）对：入站行按会话去重
const pairs = db
  .prepare(
    "SELECT bot_id, user_openid FROM c2c_messages WHERE author_name IS NULL GROUP BY bot_id, user_openid",
  )
  .all() as Array<{ bot_id: string; user_openid: string }>;

const lookup = db.prepare(
  "SELECT username FROM members WHERE bot_id = ? AND member_openid = ? AND username IS NOT NULL ORDER BY last_seen DESC LIMIT 1",
);
const update = db.prepare(
  "UPDATE c2c_messages SET author_name = ? WHERE bot_id = ? AND user_openid = ? AND author_name IS NULL",
);

let mapped = 0;
const missing: string[] = [];
for (const p of pairs) {
  const hit = lookup.get(p.bot_id, p.user_openid) as
    | { username: string | null }
    | undefined;
  const name = hit?.username ?? null;
  if (name === null) {
    missing.push(`${p.bot_id}/${p.user_openid}`);
    continue;
  }
  update.run(name, p.bot_id, p.user_openid);
  mapped++;
}

console.log(
  `c2c 昵称回填完成：映射 ${mapped} 个会话，名册未命中 ${missing.length} 个` +
    (missing.length > 0 ? `（${missing.join(", ")}）` : ""),
);
