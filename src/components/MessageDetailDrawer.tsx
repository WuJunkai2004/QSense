// 消息详情抽屉（2026-11-08 v8 重构）：结构化呈现 + 官方原始载荷兜底。
// 智能体（MCP 工具）所见即所得：quote_msg / records / attachments / ark / raw
// 与服务端 /ui/api/message 输出字段一一对应。

import { useEffect, useState } from "react";
import { Collapse, Drawer, Skeleton, Tag, App as AntApp } from "antd";
import dayjs from "dayjs";
import { get } from "../api";
import type { MessageDetail, MsgAttachment, MsgItem, QuoteMsg } from "../types";
import { RecordsList } from "./bubble";

interface Props {
  bot: string;
  group: string;
  /** 会话类型：chat 时走合一表 chat scope 读取 */
  type: "group" | "chat";
  msg: MsgItem | null;
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  image: "图片",
  voice: "语音",
  video: "视频",
  file: "文件",
};

function humanSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">{title}</div>
      {children}
    </div>
  );
}

/** 引用块（详情侧）：直接展示服务端摘要 */
function DetailQuote({ q }: { q: QuoteMsg }) {
  return (
    <div className="quote-block static">
      <div className="quote-name">
        {q.id !== null ? `作者 ${q.id.slice(0, 12)}…` : "引用消息"}
        {q.msg_id === null && <Tag style={{ marginLeft: 6 }}>被引不在缓存</Tag>}
      </div>
      <div className="quote-text">
        {q.content !== "" ? q.content : "（无文字内容）"}
      </div>
    </div>
  );
}

/** 消息详情抽屉：展开结构化字段 + 官方原始载荷 */
export default function MessageDetailDrawer({
  bot,
  group,
  type,
  msg,
  onClose,
}: Props) {
  const { message: tip } = AntApp.useApp();
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDetail(null);
    if (msg === null || msg.pending === true || msg.msg_id === "") return;
    setLoading(true);
    get<MessageDetail>(
      `/message?bot=${encodeURIComponent(bot)}&group=${encodeURIComponent(group)}${type === "chat" ? "&type=chat" : ""}&msg_id=${encodeURIComponent(msg.msg_id)}`,
    )
      .then(setDetail)
      .catch(
        (e: unknown) =>
          void tip.error(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, [bot, group, type, msg, tip]);

  const view = detail ?? msg;
  const attachments: MsgAttachment[] | null =
    detail !== null ? (detail.attachments as MsgAttachment[] | null) : null;

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
      {loading && view === null && <Skeleton active />}
      {!loading && view !== null && (
        <div className="detail-body">
          <div className="detail-meta">
            <span>
              {view.author.name ?? view.author.openid ?? "未知"}(
              {view.author.role ?? "member"})
            </span>
            <span>{view.out === true ? "本机外发" : "入站"}</span>
            <span>
              {view.ts !== null
                ? dayjs(view.ts).format("YYYY-MM-DD HH:mm:ss")
                : "时间未知"}
            </span>
          </div>

          {view.quote_msg !== null && <DetailQuote q={view.quote_msg} />}

          <Section title="正文（content，渲染 markdown）">
            <pre className="detail-pre">{view.content ?? "（空）"}</pre>
          </Section>

          {detail !== null && detail.records !== null && (
            <Section
              title={`聊天记录子消息（${detail.records_count} 条，depth=嵌套层级）`}
            >
              <RecordsList records={detail.records} />
            </Section>
          )}
          {view.records_count > 0 &&
            detail !== null &&
            detail.records === null && (
              <Section title="聊天记录子消息">
                <span style={{ color: "#9aa0a8" }}>
                  （详情加载异常，无子消息）
                </span>
              </Section>
            )}

          {attachments !== null && attachments.length > 0 && (
            <Section title={`附件（${attachments.length}）`}>
              <div className="detail-atts">
                {attachments.map((a, i) => (
                  <div key={i} className="detail-att">
                    <Tag>{KIND_LABEL[a.kind] ?? a.kind}</Tag>
                    <span className="att-name">
                      {a.filename ?? `附件${i + 1}`}
                    </span>
                    {a.size !== undefined && (
                      <span className="att-size">{humanSize(a.size)}</span>
                    )}
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      打开
                    </a>
                  </div>
                ))}
              </div>
              <div style={{ color: "#9aa0a8", fontSize: 12, marginTop: 4 }}>
                官方链接带时效签名（rkey），过期后不可访问；文本与元数据长期可靠。
              </div>
            </Section>
          )}

          {detail !== null &&
            Array.isArray(detail.mentions) &&
            detail.mentions.length > 0 && (
              <Section title={`提及（${detail.mentions.length}）`}>
                <div className="detail-mentions">
                  {(
                    detail.mentions as Array<{ id: string; name?: string }>
                  ).map((mn, i) => (
                    <Tag key={i}>{mn.name ?? mn.id.slice(0, 12) + "…"}</Tag>
                  ))}
                </div>
              </Section>
            )}

          {detail !== null &&
            detail.ark !== null &&
            detail.ark !== undefined && (
              <Collapse
                ghost
                items={[
                  {
                    key: "ark",
                    label: "ARK 卡片 JSON",
                    children: (
                      <pre className="json-pre">
                        {JSON.stringify(detail.ark, null, 2)}
                      </pre>
                    ),
                  },
                ]}
              />
            )}
          {detail !== null && detail.raw !== null && (
            <Collapse
              ghost
              items={[
                {
                  key: "raw",
                  label: "官方原始载荷（raw）",
                  children: (
                    <pre className="json-pre">
                      {JSON.stringify(detail.raw, null, 2)}
                    </pre>
                  ),
                },
              ]}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}
