import { useState } from "react";
import { Avatar, Badge, Dropdown, Tooltip, App as AntApp } from "antd";
import { RobotOutlined, PlusOutlined } from "@ant-design/icons";
import type { BotInfo } from "../types";
import { del } from "../api";
import AddBotModal from "./AddBotModal";

interface Props {
  bots: BotInfo[];
  current: string | null;
  onSelect: (appid: string) => void;
  onRefresh: () => void;
}

const STATE_COLOR: Record<string, string> = {
  ready: "#52c41a",
  resumed: "#52c41a",
  disconnected: "#faad14",
  fatal: "#ff4d4f",
  unknown: "#bfbfbf",
};

const AVATAR_BG = [
  "#0099ff",
  "#722ed1",
  "#13c2c2",
  "#eb2f96",
  "#fa8c16",
  "#52c41a",
];

function gatewayText(state: string): string {
  switch (state) {
    case "ready":
      return "在线";
    case "resumed":
      return "在线（续传）";
    case "disconnected":
      return "重连中";
    case "fatal":
      return "致命断开";
    default:
      return "状态未知";
  }
}

/** 最左栏：机器人头像列（点选切换，右键管理）+ 添加入口 */
export default function BotRail({ bots, current, onSelect, onRefresh }: Props) {
  const { message, modal } = AntApp.useApp();
  const [addOpen, setAddOpen] = useState(false);

  const removeBot = (b: BotInfo): void => {
    modal.confirm({
      title: `移除机器人 ${b.name}？`,
      content: "断开其网关连接并清除登录态；缓存数据保留，可随时重新添加。",
      okText: "移除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await del(`/bots/${b.appid}`);
          void message.success(`已移除 ${b.name}`);
          onRefresh();
        } catch (e) {
          void message.error(e instanceof Error ? e.message : String(e));
        }
      },
    });
  };

  return (
    <div className="bot-rail">
      {bots.map((b, i) => (
        <Dropdown
          key={b.appid}
          trigger={["contextMenu"]}
          menu={{
            items: [{ key: "remove", label: "移除该机器人", danger: true }],
            onClick: (info) => {
              if (info.key === "remove") removeBot(b);
            },
          }}
        >
          <div
            className={`bot-item${b.appid === current ? " selected" : ""}`}
            onClick={() => onSelect(b.appid)}
          >
            <Tooltip
              title={
                <span>
                  {b.name}（{b.appid}）· {gatewayText(b.gateway)} · 右键可移除
                </span>
              }
              placement="right"
            >
              <Badge
                dot
                color={STATE_COLOR[b.gateway] ?? "#bfbfbf"}
                offset={[-4, 30]}
              >
                <Avatar
                  shape="square"
                  size={40}
                  style={{
                    background:
                      b.appid === current
                        ? AVATAR_BG[i % AVATAR_BG.length]
                        : "#c6cad2",
                    borderRadius: 10,
                  }}
                  icon={<RobotOutlined />}
                />
              </Badge>
            </Tooltip>
          </div>
        </Dropdown>
      ))}
      <Tooltip title="添加机器人（官方凭据校验后免重启接入）" placement="right">
        <Avatar
          shape="square"
          size={40}
          style={{
            background: "#d5d9e0",
            color: "#4e5969",
            borderRadius: 10,
            cursor: "pointer",
          }}
          icon={<PlusOutlined />}
          onClick={() => setAddOpen(true)}
        />
      </Tooltip>
      <AddBotModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(appid) => {
          onRefresh();
          onSelect(appid);
        }}
      />
    </div>
  );
}
