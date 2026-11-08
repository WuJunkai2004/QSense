// 气泡内容渲染（2026-11-08 v8 重构）：content 是服务端渲染好的 markdown 文本，
// 前端职责 = 把占位符/结构标记升级为可交互元素，不再自己解析原始载荷。
// 占位符契约（与后端 normalize 管线一一对应）：
//   `![附件n]`            图片/视频/未知媒体（n = attachments 下标 + 1）
//   `![附件n]（转写：…）`  语音（ASR 转写文本紧随占位符，保持纯文本可选中）
//   `[附件n 文件名 (大小)]` 文件（整块渲染为可下载 chip）
//   `[标题·N条]`           聊天记录（整行渲染为 QQ 风格转发卡片，点击展开）
// 引用不在 content 里（v8 出列结构化），由 quote_msg 字段单独渲染 QuoteBlock。

import type { ReactNode } from "react";
import dayjs from "dayjs";
import type { MsgAttachment, MsgItem, QuoteMsg, RecordItem } from "../types";

/** 媒体占位符 `![附件n]` 与文件占位符 `[附件n 名字]` 的合并词法器 */
const TOKEN = /!\[附件(\d+)\]|\[附件(\d+) ([^\]\n]+)\]/g;

/** 聊天记录标记行 `[标题·N条]`（整行匹配才认定，普通文本里的方括号不误伤） */
const RECORD_LINE = /^\[([^·\[\]]+?)·(\d+)条\]$/;

/** 结构化引用块：QQ 风格灰底引用卡；被引可定位时点击跳详情 */
export function QuoteBlock({
  quote,
  nameOf,
  onOpen,
}: {
  quote: QuoteMsg;
  nameOf: (openid: string | null) => string | null;
  onOpen: () => void;
}) {
  const name =
    quote.id !== null ? (nameOf(quote.id) ?? "引用消息") : "引用消息";
  const clickable = quote.msg_id !== null;
  return (
    <div
      className={`quote-block${clickable ? " clickable" : ""}`}
      title={clickable ? "点击查看被引用的消息" : undefined}
      onClick={
        clickable
          ? (e) => {
              e.stopPropagation();
              onOpen();
            }
          : undefined
      }
    >
      <div className="quote-name">{name}</div>
      <div className="quote-text">
        {quote.content !== "" ? quote.content : "（无文字内容）"}
      </div>
    </div>
  );
}

/** 聊天记录转发卡片（QQ 风格）：标题 + 条数，点击进详情展开子消息 */
export function RecordsCard({
  title,
  count,
  onClick,
}: {
  title: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <div
      className="records-card"
      title="点击展开聊天记录"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <div className="records-title">📎 {title}</div>
      <div className="records-meta">{count} 条消息 · 点击查看</div>
    </div>
  );
}

/** 单个占位符 → 附件元素（按 kind 分型渲染） */
function attachmentNode(
  n: number,
  key: string,
  atts: MsgAttachment[] | null,
): ReactNode {
  const a = atts !== null ? atts[n - 1] : undefined;
  if (a === undefined) return <span key={key}>{`[附件${n}]`}</span>;
  if (a.kind === "image") {
    return (
      <img
        key={key}
        src={a.url}
        alt={a.filename ?? `附件${n}`}
        loading="lazy"
        style={{
          display: "block",
          maxWidth: 180,
          maxHeight: 180,
          borderRadius: 6,
          margin: "4px 0",
        }}
      />
    );
  }
  if (a.kind === "video") {
    return (
      <video
        key={key}
        src={a.url}
        controls
        preload="metadata"
        style={{
          display: "block",
          maxWidth: 220,
          maxHeight: 180,
          borderRadius: 6,
          margin: "4px 0",
        }}
      />
    );
  }
  if (a.kind === "voice") {
    return (
      <a
        key={key}
        className="voice-chip"
        href={a.voice_wav_url ?? a.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="点击打开音频（官方链接，有时效）"
      >
        🎤 语音{a.duration !== undefined ? ` ${a.duration}″` : ""}
      </a>
    );
  }
  // kind=file 且带文件名：正文里是 `[附件n 名字 (大小)]` 文本形式，不会走到这里；
  // 无文件名的 file（旧数据/未知类型）回落中性占位
  return <span key={key}>{`[附件${n}]`}</span>;
}

/**
 * 气泡正文：逐行扫描——聊天记录标记行渲染为转发卡片；其余行做占位符词法替换
 *（图片/视频/语音 chip/文件 chip），纯文本保持 pre-wrap 原样。
 */
export function BubbleContent({
  m,
  onOpenRecords,
}: {
  m: MsgItem;
  onOpenRecords: () => void;
}) {
  const text = m.content ?? "";
  if (text === "") return <span className="bubble-empty">（无文本内容）</span>;
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  lines.forEach((line, li) => {
    const rec = line.match(RECORD_LINE);
    if (rec !== null) {
      nodes.push(
        <RecordsCard
          key={`r${li}`}
          title={rec[1] ?? "聊天记录"}
          count={Number(rec[2] ?? 0)}
          onClick={onOpenRecords}
        />,
      );
      return;
    }
    if (line === "") {
      nodes.push(<br key={`b${li}`} />);
      return;
    }
    TOKEN.lastIndex = 0;
    if (!TOKEN.test(line)) {
      nodes.push(<span key={`t${li}`}>{line}</span>);
      if (li < lines.length - 1) nodes.push(<br key={`n${li}`} />);
      return;
    }
    // 占位符混排行：按词法切分
    TOKEN.lastIndex = 0;
    let last = 0;
    let hit: RegExpExecArray | null;
    while ((hit = TOKEN.exec(line)) !== null) {
      if (hit.index > last) {
        nodes.push(
          <span key={`t${li}-${hit.index}`}>
            {line.slice(last, hit.index)}
          </span>,
        );
      }
      if (hit[1] !== undefined) {
        // `![附件n]`
        nodes.push(
          attachmentNode(Number(hit[1]), `a${li}-${hit.index}`, m.attachments),
        );
      } else {
        // `[附件n 名字 (大小)]` 文件 chip
        const n = Number(hit[2]);
        const label = hit[3] ?? "";
        const a = m.attachments !== null ? m.attachments[n - 1] : undefined;
        const url = a?.url;
        nodes.push(
          url !== undefined ? (
            <a
              key={`f${li}-${hit.index}`}
              className="file-chip"
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="点击下载（官方链接，有时效）"
            >
              📗 <span className="file-name">{label}</span>
            </a>
          ) : (
            <span key={`f${li}-${hit.index}`} className="file-chip static">
              📗 <span className="file-name">{label}</span>
            </span>
          ),
        );
      }
      last = hit.index + hit[0].length;
    }
    if (last < line.length) {
      nodes.push(<span key={`t${li}-end`}>{line.slice(last)}</span>);
    }
    if (li < lines.length - 1) nodes.push(<br key={`n${li}`} />);
  });
  return <>{nodes}</>;
}

/** 聊天记录子消息列表（详情抽屉用）：depth 缩进表达嵌套层级 */
export function RecordsList({ records }: { records: RecordItem[] }) {
  return (
    <div className="records-list">
      {records.map((r) => (
        <div
          key={r.ord}
          className="record-item"
          style={r.depth > 0 ? { marginLeft: 16 + r.depth * 14 } : undefined}
        >
          <div className="record-head">
            <span className="record-name">{r.name ?? r.openid ?? "?"}</span>
            <span className="record-ts">
              {r.ts !== null ? dayjs(r.ts).format("MM-DD HH:mm") : ""}
            </span>
          </div>
          <div className="record-text">{r.text}</div>
        </div>
      ))}
    </div>
  );
}
