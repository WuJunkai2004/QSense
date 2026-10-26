import { useCallback, useEffect, useReducer, useState } from "react";
import {
  Badge,
  Button,
  Drawer,
  Spin,
  Tag,
  App as AntApp,
} from "antd";
import { SettingOutlined } from "@ant-design/icons";
import {
  clearToken,
  del,
  getLastBot,
  getToken,
  setLastBot,
  get,
  post,
  UNAUTHORIZED_EVENT,
} from "./api";
import type {
  Bootstrap,
  GroupItem,
  MemberItem,
  MsgItem,
  QuotaInfo,
  SendItem,
  SendResult,
} from "./types";
import Login from "./components/Login";
import BotRail from "./components/BotRail";
import SessionList from "./components/SessionList";
import ChatView from "./components/ChatView";
import RightPanel from "./components/RightPanel";
import MessageDetailDrawer from "./components/MessageDetailDrawer";
import SettingsView from "./components/SettingsView";

const en = encodeURIComponent;

export default function App() {
  const { message } = AntApp.useApp();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [checking, setChecking] = useState(getToken() !== null);
  const [currentBot, setCurrentBot] = useState<string | null>(getLastBot());
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [currentGroup, setCurrentGroup] = useState<string | null>(null);
  const [messages, setMessages] = useState<MsgItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busyOlder, setBusyOlder] = useState(false);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [sends, setSends] = useState<SendItem[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [detail, setDetail] = useState<MsgItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  // 401（token 失效）广播 → 回登录页
  useEffect(() => {
    const h = (): void => {
      setBoot(null);
      setChecking(false);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, h);
    const h2 = (): void => forceRender();
    window.addEventListener("qqui-alias-changed", h2);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, h);
      window.removeEventListener("qqui-alias-changed", h2);
    };
  }, []);

  // 启动：有 token 则验证并拉 bootstrap
  useEffect(() => {
    if (getToken() === null) {
      setChecking(false);
      return;
    }
    get<Bootstrap>("/bootstrap")
      .then(setBoot)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  const refreshBoot = useCallback((): void => {
    get<Bootstrap>("/bootstrap")
      .then(setBoot)
      .catch(() => undefined);
  }, []);

  // currentBot 失效（被移除/不存在）→ 落到第一个
  useEffect(() => {
    if (boot === null) return;
    if (currentBot !== null && boot.bots.some((b) => b.appid === currentBot))
      return;
    const first = boot.bots[0]?.appid ?? null;
    setCurrentBot(first);
    if (first !== null) setLastBot(first);
  }, [boot, currentBot]);

  // 会话列表：拉取 + 10s 轮询
  const loadGroups = useCallback((): void => {
    if (boot === null || currentBot === null) return;
    get<{ groups: GroupItem[] }>(`/groups?bot=${en(currentBot)}`)
      .then((r) => setGroups(r.groups))
      .catch(() => undefined);
  }, [boot, currentBot]);
  useEffect(() => {
    loadGroups();
    const t = setInterval(loadGroups, 10_000);
    return () => clearInterval(t);
  }, [loadGroups]);

  // 当前群失效 → 自动落到第一个
  useEffect(() => {
    if (groups.length === 0) {
      if (currentGroup !== null) setCurrentGroup(null);
      return;
    }
    if (
      currentGroup === null ||
      !groups.some((g) => g.group_openid === currentGroup)
    ) {
      setCurrentGroup(groups[0].group_openid);
    }
  }, [groups, currentGroup]);

  const currentGroupItem =
    groups.find((g) => g.group_openid === currentGroup) ?? null;

  // 消息：切群拉最新页
  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    if (boot === null || currentBot === null || currentGroup === null) return;
    get<{ messages: MsgItem[]; has_more: boolean }>(
      `/messages?bot=${en(currentBot)}&group=${en(currentGroup)}&limit=30`,
    )
      .then((r) => {
        setMessages(r.messages);
        setHasMore(r.has_more);
      })
      .catch(() => undefined);
  }, [boot, currentBot, currentGroup]);

  // 消息：4s 增量轮询（after 最后一条真实 rid；乐观消息 rid 为负不参与）
  useEffect(() => {
    if (boot === null || currentBot === null || currentGroup === null) return;
    const t = setInterval(() => {
      setMessages((cur) => {
        const lastRid = cur.reduce(
          (a, m) => (m.rid > a && m.pending !== true ? m.rid : a),
          0,
        );
        if (lastRid > 0) {
          get<{ messages: MsgItem[] }>(
            `/messages?bot=${en(currentBot)}&group=${en(currentGroup)}&after=${lastRid}&limit=100`,
          )
            .then((r) => {
              if (r.messages.length === 0) return;
              setMessages((prev) => [
                ...prev,
                // rid 去重（服务端重复推送）+ msg_id 去重（本机外发的乐观行已带官方 msg_id）
                ...r.messages.filter(
                  (n) =>
                    !prev.some(
                      (p) =>
                        p.rid === n.rid ||
                        (n.msg_id !== "" && p.msg_id === n.msg_id),
                    ),
                ),
              ]);
            })
            .catch(() => undefined);
        }
        return cur;
      });
    }, 4_000);
    return () => clearInterval(t);
  }, [boot, currentBot, currentGroup]);

  const loadOlder = async (): Promise<void> => {
    if (
      boot === null ||
      currentBot === null ||
      currentGroup === null ||
      messages.length === 0
    )
      return;
    setBusyOlder(true);
    try {
      const before = messages[0].rid;
      const r = await get<{ messages: MsgItem[]; has_more: boolean }>(
        `/messages?bot=${en(currentBot)}&group=${en(currentGroup)}&before=${before}&limit=30`,
      );
      setMessages((prev) => [...r.messages, ...prev]);
      setHasMore(r.has_more);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyOlder(false);
    }
  };

  // 右栏：成员名册 + 发送账本（切群 + 10s 轮询）
  const loadSide = useCallback((): void => {
    if (boot === null || currentBot === null || currentGroup === null) {
      setMembers([]);
      setSends([]);
      return;
    }
    const qs = `bot=${en(currentBot)}&group=${en(currentGroup)}`;
    get<{ members: MemberItem[] }>(`/members?${qs}`)
      .then((r) => setMembers(r.members))
      .catch(() => undefined);
    get<{ sends: SendItem[] }>(`/sends?${qs}`)
      .then((r) => setSends(r.sends))
      .catch(() => undefined);
  }, [boot, currentBot, currentGroup]);
  useEffect(() => {
    loadSide();
    const t = setInterval(loadSide, 10_000);
    return () => clearInterval(t);
  }, [loadSide]);

  // 额度水位：30s
  const loadQuota = useCallback((): void => {
    if (boot === null || currentBot === null || currentGroup === null) {
      setQuota(null);
      return;
    }
    get<QuotaInfo>(`/quota?bot=${en(currentBot)}`)
      .then(setQuota)
      .catch(() => undefined);
  }, [boot, currentBot, currentGroup]);
  useEffect(() => {
    loadQuota();
    const t = setInterval(loadQuota, 30_000);
    return () => clearInterval(t);
  }, [loadQuota]);

  // 整群缓存删除（原 MCP forget 迁入）：确认弹窗在 RightPanel，成功后清当前选中并刷新列表
  const handlePurgeGroup = async (): Promise<void> => {
    if (boot === null || currentBot === null || currentGroup === null) return;
    await del(
      `/groups/${en(currentGroup)}?bot=${en(currentBot)}`,
    );
    setCurrentGroup(null);
    loadGroups();
    void message.success("该群缓存已删除");
  };

  // 发送：乐观追加（成功保留标记本机、失败移除），账本/额度即时刷新
  const handleSend = async (
    text: string,
    replyMsgId: string | null,
    quote: boolean = false,
  ): Promise<void> => {
    if (boot === null || currentBot === null || currentGroup === null) return;
    const botName =
      boot.bots.find((b) => b.appid === currentBot)?.name ?? currentBot;
    const pending: MsgItem = {
      rid: -Date.now(),
      msg_id: "",
      ts: new Date().toISOString(),
      author: { openid: null, name: botName, role: null },
      content: text,
      has_attachments: false,
      attachments: null,
      has_ark: false,
      has_elements: false,
      pending: true,
    };
    setMessages((prev) => [...prev, pending]);
    try {
      const r = await post<{ result: SendResult }>("/send", {
        bot: currentBot,
        group: currentGroup,
        text,
        ...(replyMsgId !== null ? { reply_msg_id: replyMsgId, quote } : {}),
      });
      void message.success(
        r.result.status === "pending_audit"
          ? "已提交，进入官方人工审核（请勿重发）"
          : replyMsgId !== null
            ? "回复已送达"
            : "主动消息已送达",
      );
      // 把官方返回的消息 ID 写回乐观行：之后 4s 轮询按 msg_id 去重，不会出现双气泡
      const msgId = r.result.provider_msg_id;
      if (msgId !== undefined && msgId !== "") {
        setMessages((prev) =>
          prev.map((m) =>
            m.rid === pending.rid
              ? { ...m, msg_id: msgId, out: true, pending: false }
              : m,
          ),
        );
      }
      loadSide();
      loadQuota();
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.rid !== pending.rid));
      throw e;
    }
  };

  const logout = (): void => {
    clearToken();
    setBoot(null);
    setGroups([]);
    setCurrentGroup(null);
    setMessages([]);
  };

  if (checking) {
    return (
      <div
        className="empty-hint"
        style={{ height: "100%", flexDirection: "column", gap: 12 }}
      >
        <Spin />
        <span>连接网关…</span>
      </div>
    );
  }
  if (boot === null) {
    return <Login version={null} onReady={(b) => setBoot(b)} />;
  }

  const bot = boot.bots.find((b) => b.appid === currentBot) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          🤖 QQ Bot 网关 <Tag style={{ marginRight: 0 }}>v{boot.version}</Tag>
        </div>
        {bot !== null && (
          <Badge
            status={
              bot.gateway === "ready" || bot.gateway === "resumed"
                ? "success"
                : bot.gateway === "disconnected"
                  ? "warning"
                  : bot.gateway === "fatal"
                    ? "error"
                    : "default"
            }
            text={`${bot.name} · ${bot.gateway}`}
          />
        )}
        <Tag color={boot.send_enabled === true ? "green" : "red"}>
          发送{boot.send_enabled === true ? "开" : "关"}
        </Tag>
        <Tag color="blue">
          {bot?.auth_level === "certified" ? "已认证" : "未认证"}
        </Tag>
        <span className="spacer" />
        <span style={{ color: "#9aa0a8", fontSize: 12 }}>
          运行 {Math.floor(boot.uptime_s / 60)} 分钟 · 当前 bot 白名单{" "}
          {bot?.allow_groups.length ?? 0} 群
        </span>
        <Button
          size="small"
          icon={<SettingOutlined />}
          title="设置（发送开关 / 白名单 / token 轮换）"
          onClick={() => setSettingsOpen(true)}
        />
        <Button size="small" onClick={logout}>
          退出
        </Button>
      </header>
      <div className="main">
        <BotRail
          bots={boot.bots}
          current={currentBot}
          onSelect={(appid) => {
            setCurrentBot(appid);
            setLastBot(appid);
          }}
          onRefresh={refreshBoot}
        />
        <SessionList
          groups={groups}
          current={currentGroup}
          onSelect={setCurrentGroup}
          allowGroups={bot?.allow_groups ?? []}
        />
        <ChatView
          boot={boot}
          botName={bot?.name ?? currentBot ?? ""}
          botAppid={currentBot ?? ""}
          group={currentGroupItem}
          messages={messages}
          hasMore={hasMore}
          busyOlder={busyOlder}
          onLoadOlder={() => void loadOlder()}
          onSend={handleSend}
          onShowDetail={setDetail}
        />
        <RightPanel
          group={currentGroupItem}
          botAppid={currentBot ?? ""}
          members={members}
          sends={sends}
          quota={quota}
          onRefresh={loadSide}
          onPurge={handlePurgeGroup}
        />
      </div>
      <MessageDetailDrawer
        bot={currentBot ?? ""}
        group={currentGroup ?? ""}
        msg={detail}
        onClose={() => setDetail(null)}
      />
      <Drawer
        title="设置"
        placement="right"
        width={560}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        destroyOnClose
      >
        <SettingsView
          open={settingsOpen}
          onChanged={refreshBoot}
        />
      </Drawer>
    </div>
  );
}
