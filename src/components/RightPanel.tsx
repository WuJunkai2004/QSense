import {
  Avatar,
  Button,
  Descriptions,
  Empty,
  List,
  Statistic,
  Tabs,
  Tag,
  Tooltip,
  App as AntApp,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { GroupItem, MemberItem, QuotaInfo, SendItem } from "../types";
import { getAlias } from "../api";
import { qqAvatar } from "../avatar";

interface Props {
  group: GroupItem | null;
  /** 当前 bot appid（成员头像 CDN 需要同 bot 维度的 openid 前缀） */
  botAppid: string;
  members: MemberItem[];
  sends: SendItem[];
  quota: QuotaInfo | null;
  onRefresh: () => void;
  /** 整群缓存删除（破坏性操作，服务端 /ui/api DELETE /groups/:openid；确认弹窗在此组件内） */
  onPurge: () => Promise<void>;
}

const SEND_STATUS: Record<string, { color: string; text: string }> = {
  sent: { color: "green", text: "已送达" },
  replayed: { color: "blue", text: "幂等重放" },
  downgraded: { color: "cyan", text: "已降级" },
  pending_audit: { color: "orange", text: "审核中" },
  audit_pass: { color: "green", text: "审核通过" },
  audit_reject: { color: "red", text: "审核拒绝" },
  failed: { color: "red", text: "失败" },
  reserved: { color: "default", text: "预留" },
};

/** 右栏（智能体视角）：群资料与成员名册 / 发送账本 / 额度水位 */
export default function RightPanel({
  group,
  botAppid,
  members,
  sends,
  quota,
  onRefresh,
  onPurge,
}: Props) {
  const { message: msg, modal } = AntApp.useApp();
  const isChat = group?.type === "chat";
  return (
    <div className="right-panel">
      <Tabs
        size="small"
        items={[
          {
            key: "info",
            label: isChat ? "会话资料" : "群资料",
            children:
              group === null ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="未选择会话"
                />
              ) : (
                <>
                  <Descriptions
                    column={1}
                    size="small"
                    items={[
                      {
                        key: "alias",
                        label: "备注名",
                        children: getAlias(group.group_openid) || "（未设置）",
                      },
                      {
                        key: "openid",
                        label: isChat ? "对方 openid" : "群 openid",
                        children: (
                          <Tooltip title="点击复制">
                            <a
                              onClick={() => {
                                void navigator.clipboard
                                  .writeText(group.group_openid)
                                  .then(() => void msg.success("已复制"));
                              }}
                              style={{ wordBreak: "break-all" }}
                            >
                              {group.group_openid}
                            </a>
                          </Tooltip>
                        ),
                      },
                      ...(isChat
                        ? [
                            {
                              key: "kind",
                              label: "类型",
                              children: (
                                <Tag color="purple">
                                  单聊（昵称来自群聊名册映射）
                                </Tag>
                              ),
                            },
                          ]
                        : [
                            {
                              key: "full",
                              label: "全量消息",
                              children:
                                group.full_msg_enabled === true ? (
                                  <Tag color="green">开启</Tag>
                                ) : (
                                  <Tag color="orange">受限</Tag>
                                ),
                            },
                            {
                              key: "count",
                              label: "成员数（自建名册）",
                              children: group.member_count,
                            },
                          ]),
                    ]}
                  />
                  {/* 危险区：整群缓存删除（原 MCP forget 迁入，仅人类操作；单聊无注册表条目，不适用） */}
                  {!isChat && (
                    <div
                      style={{
                        marginTop: 10,
                        paddingTop: 8,
                        borderTop: "1px dashed #e5e7eb",
                      }}
                    >
                      <Button
                        size="small"
                        danger
                        onClick={() => {
                          modal.confirm({
                            title: "删除本群全部缓存？",
                            content:
                              "将删除该群的消息（含检索索引）、成员名册、群注册表与已读水位，不可恢复；发送审计账本保留。机器人仍在群时消息会重新累积。",
                            okText: "删除",
                            okButtonProps: { danger: true },
                            cancelText: "取消",
                            onOk: () => onPurge(),
                          });
                        }}
                      >
                        删除本群缓存…
                      </Button>
                    </div>
                  )}
                  {!isChat && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        margin: "10px 0 4px",
                      }}
                    >
                      <b style={{ fontSize: 13 }}>成员名册</b>
                      <Button
                        size="small"
                        type="text"
                        icon={<ReloadOutlined />}
                        onClick={onRefresh}
                      />
                    </div>
                  )}
                  {!isChat && (
                    <List
                      size="small"
                      dataSource={members}
                      locale={{ emptyText: "暂无成员（消息到达后自动积累）" }}
                      renderItem={(m) => (
                        <List.Item style={{ padding: "4px 0" }}>
                          <div className="member-row" style={{ width: "100%" }}>
                            <Avatar
                              size={26}
                              style={{ background: "#c9d4e0" }}
                              src={qqAvatar(botAppid, m.member_openid)}
                            >
                              {(m.username ?? "?").slice(0, 1)}
                            </Avatar>
                            <span className="m-name">
                              {m.username ?? m.member_openid}
                            </span>
                            {m.member_role === "owner" && (
                              <span className="role-tag role-owner">群主</span>
                            )}
                            {m.member_role === "admin" && (
                              <span className="role-tag role-admin">
                                管理员
                              </span>
                            )}
                            <span className="m-count">{m.msg_count} 条</span>
                          </div>
                        </List.Item>
                      )}
                    />
                  )}
                </>
              ),
          },
          {
            key: "sends",
            label: "发送记录",
            children: (
              <>
                <div
                  style={{ fontSize: 12, color: "#9aa0a8", marginBottom: 6 }}
                >
                  发送账本（含审核回填状态；仅存 openid 与结果，不含内容）
                </div>
                {sends.length === 0 && (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无发送"
                  />
                )}
                {sends.map((s) => {
                  const st = SEND_STATUS[s.status] ?? {
                    color: "default",
                    text: s.status,
                  };
                  return (
                    <div key={s.id} className="send-row">
                      <div className="row1">
                        <Tag color={st.color} style={{ marginRight: 0 }}>
                          {st.text}
                        </Tag>
                        <span>
                          {s.kind === "reply" ? "被动回复" : "主动消息"}
                        </span>
                        <span className="muted">
                          {s.created_at !== null
                            ? dayjs(s.created_at).format("MM-DD HH:mm")
                            : ""}
                        </span>
                      </div>
                      <div className="muted">
                        {s.msg_seq !== null && <>msg_seq={s.msg_seq} · </>}
                        {s.provider_msg_id !== null && (
                          <>官方ID {s.provider_msg_id.slice(0, 18)}… · </>
                        )}
                        {s.error_code !== null && (
                          <span style={{ color: "#ff4d4f" }}>
                            错误码 {s.error_code}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            ),
          },
          {
            key: "quota",
            label: "额度",
            children:
              quota === null ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="未选择 bot/群"
                />
              ) : (
                <>
                  <Statistic
                    title="今日主动消息已发"
                    value={quota.proactive_sent_today}
                    suffix="/ 1000"
                  />
                  <div style={{ margin: "10px 0 6px" }}>
                    <Tag color={quota.send_enabled === true ? "green" : "red"}>
                      发送{quota.send_enabled === true ? "已开启" : "已关闭"}
                    </Tag>
                    <Tag color="blue">
                      {quota.auth_level === "certified"
                        ? "已认证 60/min"
                        : "未认证 30/min"}
                    </Tag>
                  </div>
                  {quota.buckets !== undefined && (
                    <>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#9aa0a8",
                          margin: "8px 0 4px",
                        }}
                      >
                        令牌桶快照（JSON）
                      </div>
                      <pre className="json-pre" style={{ maxHeight: 200 }}>
                        {JSON.stringify(quota.buckets, null, 2)}
                      </pre>
                    </>
                  )}
                </>
              ),
          },
        ]}
      />
    </div>
  );
}
