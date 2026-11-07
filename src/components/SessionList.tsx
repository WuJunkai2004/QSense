import { useMemo, useState } from "react";
import { Avatar, Input, Tag } from "antd";
import { GroupOutlined, UserOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { GroupItem } from "../types";
import { getAlias } from "../api";

interface Props {
  groups: GroupItem[];
  current: string | null;
  onSelect: (groupOpenid: string) => void;
  allowGroups: string[];
}

function timeText(iso: string | null): string {
  if (iso === null) return "";
  const d = dayjs(iso);
  if (d.isSame(dayjs(), "day")) return d.format("HH:mm");
  if (d.isSame(dayjs().subtract(1, "day"), "day")) return "昨天";
  return d.format("MM/DD");
}

/** 会话列表（左二栏）：群+单聊按最后消息排序 + 摘要 + 搜索过滤 */
export default function SessionList({
  groups,
  current,
  onSelect,
  allowGroups,
}: Props) {
  const [kw, setKw] = useState("");
  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase();
    if (k === "") return groups;
    return groups.filter(
      (g) =>
        g.group_openid.toLowerCase().includes(k) ||
        getAlias(g.group_openid).toLowerCase().includes(k) ||
        (g.last?.snippet ?? "").toLowerCase().includes(k),
    );
  }, [groups, kw]);

  return (
    <div className="session-pane">
      <div className="search">
        <Input
          placeholder="搜索会话 / 备注 / 消息"
          allowClear
          size="small"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
      </div>
      <div className="session-list">
        {filtered.length === 0 && (
          <div className="empty-hint" style={{ height: 80, fontSize: 12 }}>
            {groups.length === 0
              ? "暂无会话缓存（等消息到达自动建立）"
              : "无匹配"}
          </div>
        )}
        {filtered.map((g) => {
          const isChat = g.type === "chat";
          const alias = getAlias(g.group_openid);
          // 单聊展示名：备注 > 名册映射名（last.author）> openid 前缀
          const name =
            alias !== ""
              ? alias
              : isChat && g.last?.author
                ? g.last.author
                : isChat
                  ? `用户 ${g.group_openid.slice(0, 10)}…`
                  : `群 ${g.group_openid.slice(0, 10)}…`;
          const allowed = isChat || allowGroups.includes(g.group_openid);
          return (
            <div
              key={g.group_openid}
              className={`session-item${g.group_openid === current ? " active" : ""}`}
              onClick={() => onSelect(g.group_openid)}
            >
              <Avatar
                shape="square"
                size={38}
                style={{
                  borderRadius: 8,
                  background: isChat ? "#f0d9e8" : "#c9d4e0",
                }}
                icon={isChat ? <UserOutlined /> : <GroupOutlined />}
              />
              <div className="s-main">
                <div className="s-title">
                  <span className="s-name">{name}</span>
                  <span className="s-time">
                    {timeText(g.last?.ts ?? g.updated_at)}
                  </span>
                </div>
                <div className="s-snippet">
                  {isChat ? (
                    <Tag
                      style={{
                        fontSize: 10,
                        lineHeight: "14px",
                        padding: "0 3px",
                      }}
                    >
                      单聊
                    </Tag>
                  ) : null}
                  {g.full_msg_enabled === false ? (
                    <Tag
                      style={{
                        fontSize: 10,
                        lineHeight: "14px",
                        padding: "0 3px",
                      }}
                    >
                      受限
                    </Tag>
                  ) : null}
                  {allowed ? null : (
                    <Tag
                      style={{
                        fontSize: 10,
                        lineHeight: "14px",
                        padding: "0 3px",
                      }}
                    >
                      未白名单
                    </Tag>
                  )}
                  {g.last !== null
                    ? `${g.last.author ?? ""}：${g.last.snippet || "（非文本消息）"}`
                    : `${g.member_count} 位成员`}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
