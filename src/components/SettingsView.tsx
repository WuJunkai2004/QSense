import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from "antd";
import { get, post, put } from "../api";
import type { AgentTokenResult, SettingsInfo } from "../types";

interface Props {
  open: boolean;
  /** 任一设置落库后回调（App 借此刷新顶栏 bootstrap 口径） */
  onChanged: () => void;
}

const GATEWAY_COLOR: Record<string, string> = {
  ready: "green",
  resumed: "green",
  disconnected: "orange",
  fatal: "red",
  unknown: "default",
};

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** M8 设置页：发送总开关 + 每 bot 群白名单 + agent token 轮换（全部落 SQLite，即时生效） */
export default function SettingsView({ open, onChanged }: Props) {
  const { message, modal } = AntApp.useApp();
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  // 白名单本地草稿（按 appid），点「保存」才 PUT
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // 轮换结果：新 token 仅本次返回，弹窗强制确认后才消失
  const [fresh, setFresh] = useState<AgentTokenResult | null>(null);

  const load = useCallback((): void => {
    get<SettingsInfo>("/settings")
      .then((r) => {
        setInfo(r);
        setDrafts(
          Object.fromEntries(r.bots.map((b) => [b.appid, b.allow_groups])),
        );
      })
      .catch((e) => void message.error(errMsg(e)));
  }, [message]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const toggleSend = async (enabled: boolean): Promise<void> => {
    try {
      const r = await put<SettingsInfo>("/settings", { send_enabled: enabled });
      setInfo(r);
      setDrafts(
        Object.fromEntries(r.bots.map((b) => [b.appid, b.allow_groups])),
      );
      void message.success(enabled ? "发送已开启" : "发送已关闭（写操作硬拒绝）");
      onChanged();
    } catch (e) {
      void message.error(errMsg(e));
    }
  };

  const saveGroups = async (appid: string): Promise<void> => {
    setSavingKey(appid);
    try {
      const r = await put<SettingsInfo>("/settings", {
        allow_groups: [{ appid, groups: drafts[appid] ?? [] }],
      });
      setInfo(r);
      setDrafts(
        Object.fromEntries(r.bots.map((b) => [b.appid, b.allow_groups])),
      );
      void message.success("白名单已保存，发送门禁即时生效");
      onChanged();
    } catch (e) {
      void message.error(errMsg(e));
    } finally {
      setSavingKey(null);
    }
  };

  const rotate = (appid: string, name: string): void => {
    modal.confirm({
      title: `轮换 ${name} 的 agent token？`,
      content:
        "旧 token 立即失效：所有使用旧 token 的 MCP 客户端（如 OpenCode）将被断开，需用新 token 重新配置。",
      okText: "轮换",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          setFresh(
            await post<AgentTokenResult>(`/bots/${appid}/agent-token`, {}),
          );
        } catch (e) {
          void message.error(errMsg(e));
        }
      },
    });
  };

  return (
    <div style={{ minWidth: 460 }}>
      {info === null ? (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin />
        </div>
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Card size="small" title="发送总开关（全局）">
            <Space>
              <Switch
                checked={info.send_enabled}
                onChange={(v) => void toggleSend(v)}
              />
              <span>
                {info.send_enabled
                  ? "已开启：仅白名单内的群可发送/撤回"
                  : "已关闭：所有写操作硬拒绝"}
              </span>
            </Space>
          </Card>
          {info.bots.map((b) => {
            const draft = drafts[b.appid] ?? [];
            const dirty =
              JSON.stringify(draft) !== JSON.stringify(b.allow_groups);
            return (
              <Card
                size="small"
                key={b.appid}
                title={
                  <Space size={8} wrap>
                    <span>{b.name}</span>
                    <Typography.Text code type="secondary">
                      {b.appid}
                    </Typography.Text>
                    <Tag color={GATEWAY_COLOR[b.gateway] ?? "default"}>
                      {b.gateway}
                    </Tag>
                  </Space>
                }
                extra={
                  <Button
                    size="small"
                    danger
                    onClick={() => rotate(b.appid, b.name)}
                  >
                    轮换 token
                  </Button>
                }
              >
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text type="secondary">
                    群白名单（该 bot 的发送门禁）
                  </Typography.Text>
                </div>
                <Space.Compact style={{ width: "100%" }}>
                  <Select
                    mode="tags"
                    tokenSeparators={[",", " ", "\t"]}
                    style={{ minWidth: 0, flex: 1 }}
                    value={draft}
                    placeholder="粘贴群 openid 后回车；留空 = 该 bot 无可发送群"
                    onChange={(v) =>
                      setDrafts((d) => ({ ...d, [b.appid]: v }))
                    }
                  />
                  <Button
                    type="primary"
                    disabled={!dirty}
                    loading={savingKey === b.appid}
                    onClick={() => void saveGroups(b.appid)}
                  >
                    保存
                  </Button>
                </Space.Compact>
              </Card>
            );
          })}
        </Space>
      )}

      <Modal
        title={`已换发新 agent token（${fresh?.bot ?? ""}）`}
        open={fresh !== null}
        onCancel={() => setFresh(null)}
        maskClosable={false}
        footer={
          <Button type="primary" onClick={() => setFresh(null)}>
            我已保存
          </Button>
        }
      >
        <Alert
          type="warning"
          showIcon
          message="仅此一次展示，关闭后无法再次查看"
          description="旧 token 已立即失效，请立即更新到 MCP 客户端配置（如 opencode.jsonc 的 Authorization 头）。"
          style={{ marginBottom: 16 }}
        />
        <Typography.Paragraph
          copyable
          code
          style={{ wordBreak: "break-all", marginBottom: 8 }}
        >
          {fresh?.agent_token ?? ""}
        </Typography.Paragraph>
        <Typography.Text type="secondary">{fresh?.note}</Typography.Text>
      </Modal>
    </div>
  );
}
