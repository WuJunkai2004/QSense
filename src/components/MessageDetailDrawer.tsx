import { useEffect, useState } from "react";
import { Drawer, Skeleton, App as AntApp } from "antd";
import { get } from "../api";
import type { MessageDetail, MsgItem } from "../types";

interface Props {
  bot: string;
  group: string;
  msg: MsgItem | null;
  onClose: () => void;
}

/** 消息详情抽屉：展开文本/提及/附件/卡片/官方原始载荷——智能体（MCP 工具）所见即所得 */
export default function MessageDetailDrawer({
  bot,
  group,
  msg,
  onClose,
}: Props) {
  const { message: tip } = AntApp.useApp();
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDetail(null);
    if (msg === null || msg.pending === true) return;
    setLoading(true);
    get<MessageDetail>(
      `/message?bot=${encodeURIComponent(bot)}&group=${encodeURIComponent(group)}&msg_id=${encodeURIComponent(msg.msg_id)}`,
    )
      .then(setDetail)
      .catch(
        (e: unknown) =>
          void tip.error(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, [bot, group, msg, tip]);

  return (
    <Drawer
      title={
        msg !== null
          ? `消息详情 · ${msg.author.name ?? msg.author.openid ?? "?"}`
          : ""
      }
      open={msg !== null}
      onClose={onClose}
      width={520}
    >
      {loading && <Skeleton active />}
      {!loading && detail !== null && (
        <pre className="json-pre">{JSON.stringify(detail, null, 2)}</pre>
      )}
      {!loading && detail === null && msg !== null && (
        <pre className="json-pre">{JSON.stringify(msg, null, 2)}</pre>
      )}
    </Drawer>
  );
}
