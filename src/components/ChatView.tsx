import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Avatar,
  Button,
  Input,
  Modal,
  Spin,
  Tag,
  Tooltip,
  App as AntApp,
} from "antd";
import {
  EditOutlined,
  RollbackOutlined,
  SendOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { Bootstrap, GroupItem, MsgItem } from "../types";
import { getAlias, setAlias } from "../api";
import { qqAvatar } from "../avatar";

interface Props {
  boot: Bootstrap;
  botName: string;
  botAppid: string;
  group: GroupItem | null;
  messages: MsgItem[];
  hasMore: boolean;
  busyOlder: boolean;
  onLoadOlder: () => void;
  onSend: (
    text: string,
    replyMsgId: string | null,
    quote: boolean,
  ) => Promise<void>;
  onShowDetail: (m: MsgItem) => void;
}

function RoleTag({ role }: { role: string | null }) {
  if (role === "owner")
    return <span className="role-tag role-owner">群主</span>;
  if (role === "admin")
    return <span className="role-tag role-admin">管理员</span>;
  return null;
}

/** 被动回复窗口（官方限制）：群聊消息 5 分钟内、每条上限 5 次；单聊 60 分钟、每条上限 4 次 */
const REPLY_WINDOW = {
  group: { ms: 5 * 60_000, max: 5 },
  chat: { ms: 60 * 60_000, max: 4 },
};

/** 引用回复目标是否已出窗（缺 msg_id / 缺时间戳 / 超窗均视为不可回复） */
function replyExpired(m: MsgItem, windowMs: number): boolean {
  if (m.msg_id === "" || m.ts === null) return true;
  return Date.now() - new Date(m.ts).getTime() > windowMs;
}

/** 本机行（乐观上屏/外发补记）不能作为被动回复目标 */
function isSelfRow(m: MsgItem): boolean {
  return m.pending === true || m.out === true;
}

// `![附件n]` 占位符（n 与 attachments 下标对应：n = 下标 + 1）；只做存在性判断，不带 g 标志
const ATT_MARK = /!\[附件(\d+)\]/;

/** 气泡正文渲染：占位符内联为图片（按编号取附件），其余文本原样（pre-wrap 由 .bubble 负责） */
function renderContent(m: MsgItem): ReactNode {
  const text = m.content ?? "";
  if (!ATT_MARK.test(text)) return text !== "" ? text : "（无文本内容）";
  const nodes: ReactNode[] = [];
  text.split(/!\[附件(\d+)\]/g).forEach((part, i) => {
    if (i % 2 === 0) {
      if (part !== "") nodes.push(<span key={`t${i}`}>{part}</span>);
      return;
    }
    const a = m.attachments?.[Number(part) - 1];
    nodes.push(
      a !== undefined && (a.content_type ?? "").startsWith("image/") ? (
        <img
          key={`a${i}`}
          src={a.url}
          alt={a.filename ?? `附件${part}`}
          loading="lazy"
          style={{
            display: "block",
            maxWidth: 180,
            maxHeight: 180,
            borderRadius: 6,
            margin: "4px 0",
          }}
        />
      ) : (
        <span key={`a${i}`}>{`[附件${part}]`}</span>
      ),
    );
  });
  return nodes;
}

/** 聊天主区：群头 + 消息流（QQ 风格气泡）+ 发送框（被动回复 / 主动消息） */
export default function ChatView(props: Props) {
  const {
    boot,
    botName,
    botAppid,
    group,
    messages,
    hasMore,
    busyOlder,
    onLoadOlder,
    onSend,
    onShowDetail,
  } = props;
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
    prevFirstRef.current =
      first !== undefined ? { rid: first.rid, height: el.scrollHeight } : null;
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
  const isChat = group?.type === "chat";
  const win = isChat ? REPLY_WINDOW.chat : REPLY_WINDOW.group;
  const alias = groupOpenid !== null ? getAlias(groupOpenid) : "";
  const title =
    groupOpenid === null
      ? ""
      : alias !== ""
        ? alias
        : isChat
          ? (group?.last?.author ?? `用户 ${groupOpenid.slice(0, 12)}…`)
          : `群 ${groupOpenid.slice(0, 12)}…`;
  const botGroups =
    boot.bots.find((b) => b.appid === botAppid)?.allow_groups ?? [];
  // 单聊无群白名单门禁（服务端按 opt-in 开关把关，错误文案可操作）
  const sendAllowed =
    boot.send_enabled === true &&
    groupOpenid !== null &&
    (isChat || botGroups.includes(groupOpenid));

  // 智能默认：无显式引用目标时，自动引用回复窗口内最新一条入站消息（被动，不耗主动额度）。
  // 官方每条消息被动回复次数有限（群 5 次/单聊 4 次）：本地计数防止把同一目标槽位耗尽，
  // 超额自动降级主动发送。
  const replyCountRef = useRef(new Map<string, number>());
  const autoTarget = ((): MsgItem | null => {
    const latest = [...messages].reverse().find((m) => !isSelfRow(m));
    if (
      latest === undefined ||
      replyExpired(latest, win.ms) ||
      (replyCountRef.current.get(latest.msg_id) ?? 0) >= win.max
    ) {
      return null;
    }
    return latest;
  })();

  const doSend = async (): Promise<void> => {
    const t = text.trim();
    if (t === "" || groupOpenid === null || sending) return;
    // 兜底校验：显式引用目标出窗时不打服务端（渲染间隙内过期的行按钮仍是可点状态）
    if (replyTo !== null && replyExpired(replyTo, win.ms)) {
      void msg.warning(
        `引用的消息已超过 ${isChat ? "60 分钟（单聊）" : "5 分钟"}被动回复窗口（官方限制），无法被动回复；可取消引用后直接作为主动消息发送。`,
      );
      return;
    }
    const target = replyTo ?? autoTarget;
    setSending(true);
    try {
      // 显式「引用」→ 被动回复附带官方引用块；智能默认 → 纯回复（仅窗口绑定，不带引用块）
      await onSend(t, target?.msg_id ?? null, replyTo !== null);
      if (target !== null) {
        replyCountRef.current.set(
          target.msg_id,
          (replyCountRef.current.get(target.msg_id) ?? 0) + 1,
        );
      }
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
        {group !== null && isChat && <Tag color="purple">单聊</Tag>}
        {group !== null && !isChat && (
          <span style={{ color: "#9aa0a8", fontSize: 12 }}>
            {group.member_count} 位成员
          </span>
        )}
        {group !== null && !isChat && group.full_msg_enabled === false && (
          <Tag color="orange">全量消息受限</Tag>
        )}
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
          pinBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {groupOpenid === null ? (
          <div className="empty-hint">← 从会话列表选择一个会话</div>
        ) : (
          <>
            {hasMore && (
              <div className="load-older" ref={sentinelRef}>
                {busyOlder ? (
                  <Spin size="small" />
                ) : (
                  <span style={{ color: "#9aa0a8", fontSize: 12 }}>
                    上滑加载更早…
                  </span>
                )}
              </div>
            )}
            {!hasMore && messages.length > 0 && (
              <div className="load-older">
                <span style={{ color: "#c3c8cf", fontSize: 12 }}>
                  没有更早的消息了
                </span>
              </div>
            )}
            {messages.map((m) => {
              const self = m.pending === true || m.out === true;
              const expired = self ? false : replyExpired(m, win.ms);
              return (
                <div
                  key={m.msg_id !== "" ? m.msg_id : `pending-${m.rid}`}
                  className={`msg-row${self ? " self" : ""}`}
                >
                  <Avatar
                    className="avatar"
                    shape="square"
                    size={34}
                    style={{
                      borderRadius: 8,
                      background: self ? "#0099ff" : "#c9d4e0",
                    }}
                    src={
                      !self && m.author.openid
                        ? qqAvatar(botAppid, m.author.openid)
                        : undefined
                    }
                  >
                    {(self ? botName : (m.author.name ?? "?")).slice(0, 1)}
                  </Avatar>
                  <div className="bubble-wrap">
                    <div className="bubble-meta">
                      {self ? (
                        <span>{botName}</span>
                      ) : (
                        <>
                          <span>
                            {m.author.name ?? m.author.openid ?? "未知"}
                          </span>
                          <RoleTag role={m.author.role} />
                        </>
                      )}
                      <span>
                        {m.ts !== null ? dayjs(m.ts).format("MM-DD HH:mm") : ""}
                      </span>
                    </div>
                    <div className="bubble" onClick={() => onShowDetail(m)}>
                      {renderContent(m)}
                      {m.has_attachments &&
                        !/!\[附件\d+\]/.test(m.content ?? "") && (
                          <span className="attach-tag">[图片/文件]</span>
                        )}
                      {m.has_ark && <span className="attach-tag">[卡片]</span>}
                    </div>
                    {!self && (
                      <div style={{ marginTop: 2 }}>
                        <Tooltip
                          title={
                            expired
                              ? `该消息已超过 ${isChat ? "60 分钟（单聊）" : "5 分钟"}被动回复窗口（官方限制），不能引用回复`
                              : `以此消息为被动回复目标（${isChat ? "60 分钟" : "5 分钟"}窗口）`
                          }
                        >
                          {/* disabled Button 吞掉 hover，包一层 span 让 Tooltip 仍可提示 */}
                          <span>
                            <Button
                              size="small"
                              type="text"
                              icon={<RollbackOutlined />}
                              disabled={expired}
                              style={{ color: "#9aa0a8", fontSize: 12 }}
                              onClick={() => setReplyTo(m)}
                            >
                              引用
                            </Button>
                          </span>
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
        {replyTo !== null ? (
          <div className="reply-banner">
            <RollbackOutlined />
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              引用 {replyTo.author.name ?? "?"}：
              {(replyTo.content ?? "").slice(0, 40)}
            </span>
            <a onClick={() => setReplyTo(null)}>取消</a>
          </div>
        ) : (
          autoTarget !== null && (
            <div className="reply-banner auto">
              <RollbackOutlined />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                发送将自动回复 {autoTarget.author.name ?? "?"}{" "}
                的最新消息（被动回复，不消耗主动额度）
              </span>
            </div>
          )
        )}
        {groupOpenid !== null && !sendAllowed && (
          <Alert
            style={{ marginBottom: 6 }}
            type="warning"
            showIcon
            message={
              boot.send_enabled
                ? isChat
                  ? "该用户未同意接收消息（官方 opt-in 门槛），主动发送被硬拒绝；被动窗口内回复不受限"
                  : "该群不在白名单，发送被硬拒绝（设置页可改，即时生效）"
                : "发送开关未开启，仅浏览（设置页可开启）"
            }
          />
        )}
        <div className="input-row">
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              replyTo !== null
                ? `引用回复（被动，不消耗主动额度，${isChat ? "60 分钟" : "5 分钟"}窗口）…`
                : autoTarget !== null
                  ? `发送 = 自动回复 ${autoTarget.author.name ?? "?"} 的最新消息（被动，不消耗主动额度）…`
                  : "主动消息（消耗额度：bot 级 30/60 每分钟、单群 20 每分钟、1000/天）…"
            }
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
        <Input
          value={aliasDraft}
          onChange={(e) => setAliasDraft(e.target.value)}
          placeholder={`原始：${groupOpenid ?? ""}`}
        />
      </Modal>
    </div>
  );
}
