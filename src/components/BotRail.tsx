import { useState } from "react";
import { Avatar, Badge, Tooltip } from "antd";
import { RobotOutlined, PlusOutlined, SettingOutlined } from "@ant-design/icons";
import type { BotInfo } from "../types";
import AddBotModal from "./AddBotModal";

interface Props {
  bots: BotInfo[];
  current: string | null;
  onSelect: (appid: string) => void;
  onRefresh: () => void;
  /** 打开设置页（/ui/settings） */
  onOpenSettings: () => void;
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

/** 最左栏：机器人头像列（点选切换）+ 添加入口；移除机器人已收编进设置页 */
export default function BotRail({
  bots,
  current,
  onSelect,
  onRefresh,
  onOpenSettings,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="bot-rail">
      {bots.map((b, i) => (
        <div
          key={b.appid}
          className={`bot-item${b.appid === current ? " selected" : ""}`}
          onClick={() => onSelect(b.appid)}
        >
          <Tooltip
            title={
              <span>
                {b.name}（{b.appid}）· {gatewayText(b.gateway)}
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
      {/* 底部：设置入口（收编移除机器人等管理操作） */}
      <Tooltip
        title="设置（发送开关 / 白名单 / token 轮换 / 数据管理）"
        placement="right"
      >
        <Avatar
          shape="square"
          size={40}
          style={{
            background: "#d5d9e0",
            color: "#4e5969",
            borderRadius: 10,
            cursor: "pointer",
            marginTop: "auto",
          }}
          icon={<SettingOutlined />}
          onClick={onOpenSettings}
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
