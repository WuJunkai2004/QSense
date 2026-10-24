import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Avatar, Button, Input, Modal, Spin, Tag, Tooltip, App as AntApp } from "antd";
import { EditOutlined, RollbackOutlined, SendOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Bootstrap, GroupItem, MsgItem } from "../types";
import { getAlias, setAlias } from "../api";

interface Props {
  boot: Bootstrap;
  botName: string;
  group: GroupItem | null;
  messages: MsgItem[];
  hasMore: boolean;
  busyOlder: boolean;
  onLoadOlder: () => void;
  onSend: (text: string, replyMsgId: string | null) => Promise<void>;
  onShowDetail: (m: MsgItem) => void;
}

function RoleTag({ role }: { role: string | null }) {
  if (role === "owner") return <span className="role-tag role-owner">群主</span>;
  if (role === "admin") return <span className="role-tag role-admin">管理员</span>;
  return null;
}

/** 聊天主区：群头 + 消息流（QQ 风格气泡）+ 发送框（被动回复 / 主动消息） */
export default function ChatView(props: Props) {
  const { boot, botName, group, messages, hasMore, busyOlder, onLoadOlder, onSend, onShowDetail } = props;
  const { message: msg } = AntApp.useApp();
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<MsgItem | null>(null);
  const [sending, setSending] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinBottom = useRef(true);

  useEffect(() => {
    setReplyTo(null);
    pinBottom.current = true;
  }, [group?.group_openid]);

  // 滚动策略：贴底跟随新消息；上翻加载更早时按高度差补偿，不跳屏
  const prevFirstRef = useRef<{ rid: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    const first = messages[0];
    const prev = prevFirstRef.current;
    prevFirstRef.current = first !== undefined ? { rid: first.rid, height: el.scrollHeight } : null;
    if (pinBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (prev !== null && first !== undefined && first.rid !== prev.rid) {
      el.scrollTop += el.scrollHeight - prev.height;
    }
  }, [messages]);

  // 增量加载：顶部哨兵进入视口（含 160px 预载边距）自动翻更早一页，避免一次加载过多
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  const busyRef = useRef(busyOlder);
  busyRef.current = busyOlder;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const list = listRef.current;
    if (sentinel === null || list === null || !hasMore) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !busyRef.current) {
          loadOlderRef.current();
        }
      },
      { root: list, rootMargin: "160px 0px 0px 0px" },
    );
    ob.observe(sentinel);
    return () => ob.disconnect();
  }, [hasMore, messages.length]);

  const groupOpenid = group?.group_openid ?? null;
  const alias = groupOpenid !== null ? getAlias(groupOpenid) : "";
  const title =
    groupOpenid === null ? "" : alias !== "" ? alias : `群 ${groupOpenid.slice(0, 12)}…`;
  const sendAllowed =
    boot.send_enabled === true &&
    groupOpenid !== null &&
    boot.allow_groups.includes(groupOpenid);

  const doSend = async (): Promise<void> => {
    const t = text.trim();
    if (t === "" || groupOpenid === null || sending) return;
    setSending(true);
    try {
      await onSend(t, replyTo?.msg_id ?? null);
      setText("");
      setReplyTo(null);
      pinBottom.current = true;
    } catch (e) {
      void msg.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <span className="g-name">{title}</span>
        {group !== null && <span style={{ color: "#9aa0a8", fontSize: 12 }}>{group.member_count} 位成员</span>}
        {group !== null && group.full_msg_enabled === false && <Tag color="orange">全量消息受限</Tag>}
        <span className="spacer" style={{ flex: 1 }} />
        {groupOpenid !== null && (
          <Tooltip title="设置备注名（仅本机浏览器）">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setAliasDraft(alias);
                setAliasOpen(true);
              }}
            />
          </Tooltip>
        )}
      </div>

      <div
        className="message-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {groupOpenid === null ? (
          <div className="empty-hint">← 从会话列表选择一个群</div>
        ) : (
          <>
            {hasMore && (
              <div className="load-older" ref={sentinelRef}>
                {busyOlder ? (
                  <Spin size="small" />
                ) : (
                  <span style={{ color: "#9aa0a8", fontSize: 12 }}>上滑加载更早…</span>
                )}
              </div>
            )}
            {!hasMore && messages.length > 0 && (
              <div className="load-older">
                <span style={{ color: "#c3c8cf", fontSize: 12 }}>没有更早的消息了</span>
              </div>
            )}
            {messages.map((m) => {
              const self = m.pending === true || m.out === true;
              return (
                <div key={m.msg_id !== "" ? m.msg_id : `pending-${m.rid}`} className={`msg-row${self ? " self" : ""}`}>
                  <Avatar
                    className="avatar"
                    shape="square"
                    size={34}
                    style={{ borderRadius: 8, background: self ? "#0099ff" : "#c9d4e0" }}
                  >
                    {(self ? botName : (m.author.name ?? "?")).slice(0, 1)}
                  </Avatar>
                  <div className="bubble-wrap">
                    <div className="bubble-meta">
                      {self ? (
                        <span>{botName}</span>
                      ) : (
                        <>
                          <span>{m.author.name ?? m.author.openid ?? "未知"}</span>
                          <RoleTag role={m.author.role} />
                        </>
                      )}
                      <span>{m.ts !== null ? dayjs(m.ts).format("MM-DD HH:mm") : ""}</span>
                    </div>
                    <div className="bubble" onClick={() => onShowDetail(m)}>
                      {m.content !== null && m.content !== "" ? m.content : "（无文本内容）"}
                      {m.has_attachments && <span className="attach-tag">[图片/文件]</span>}
                      {m.has_ark && <span className="attach-tag">[卡片]</span>}
                    </div>
                    {!self && (
                      <div style={{ marginTop: 2 }}>
                        <Tooltip title="以此消息为被动回复目标（5 分钟窗口）">
                          <Button
                            size="small"
                            type="text"
                            icon={<RollbackOutlined />}
                            style={{ color: "#9aa0a8", fontSize: 12 }}
                            onClick={() => setReplyTo(m)}
                          >
                            回复
                          </Button>
                        </Tooltip>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="send-box">
        {replyTo !== null && (
          <div className="reply-banner">
            <RollbackOutlined />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              回复 {replyTo.author.name ?? "?"}：{(replyTo.content ?? "").slice(0, 40)}
            </span>
            <a onClick={() => setReplyTo(null)}>取消</a>
          </div>
        )}
        {groupOpenid !== null && !sendAllowed && (
          <Alert
            style={{ marginBottom: 6 }}
            type="warning"
            showIcon
            message={
              boot.send_enabled
                ? "该群不在 ALLOW_GROUPS 白名单，发送被硬拒绝（改 .env 后重启生效）"
                : "发送开关未开启（SEND_ENABLE=false），仅浏览"
            }
          />
        )}
        <div className="input-row">
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={replyTo !== null ? "被动回复（不消耗主动额度，5 分钟窗口）…" : "主动消息（消耗额度：bot 级 30/60 每分钟、单群 20 每分钟、1000/天）…"}
            autoSize={{ minRows: 1, maxRows: 4 }}
            disabled={groupOpenid === null}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                void doSend();
              }
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={groupOpenid === null || !sendAllowed}
            loading={sending}
            onClick={() => void doSend()}
          >
            发送
          </Button>
        </div>
      </div>

      <Modal
        title="设置备注名"
        open={aliasOpen}
        onCancel={() => setAliasOpen(false)}
        onOk={() => {
          if (groupOpenid !== null) setAlias(groupOpenid, aliasDraft);
          setAliasOpen(false);
          // 触发一次重渲染（alias 读取自 localStorage）
          setText((t) => t);
          window.dispatchEvent(new Event("qqui-alias-changed"));
        }}
        okText="保存"
        cancelText="取消"
      >
        <Input value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value)} placeholder={`原始：${groupOpenid ?? ""}`} />
      </Modal>
    </div>
  );
}
