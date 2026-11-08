import { useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Typography,
} from "antd";
import { post } from "../api";
import type { AddBotResult, AuthLevel } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: (appid: string) => void;
}

/** 添加机器人：appid + AppSecret（服务端先过官方凭据校验）。
 *  M8：成功后 agent_token 仅本次返回——成功态强制展示、确认保存后才能关闭。
 *  M9：可填认证等级（主动消息频控预算），此后可在设置页修改。 */
export default function AddBotModal({ open, onClose, onAdded }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [created, setCreated] = useState<AddBotResult | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = (): void => {
    const appid = created?.bot.appid;
    setCreated(null);
    form.resetFields();
    onClose();
    if (appid !== undefined) onAdded(appid);
  };

  const submit = async (): Promise<void> => {
    if (created !== null) return;
    const v = (await form.validateFields()) as {
      appid: string;
      secret: string;
      name?: string;
      auth_level?: AuthLevel;
    };
    setBusy(true);
    try {
      setCreated(await post<AddBotResult>("/bots", v));
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={
        created === null
          ? "添加机器人"
          : `已添加：${created.bot.name}（${created.bot.appid}）`
      }
      open={open}
      maskClosable={false}
      destroyOnClose
      onCancel={() => (created === null ? onClose() : finish())}
      onOk={() => void submit()}
      okText={created === null ? "添加" : ""}
      okButtonProps={
        created === null ? { loading: busy } : { style: { display: "none" } }
      }
      cancelButtonProps={
        created === null ? undefined : { style: { display: "none" } }
      }
      footer={
        created === null
          ? undefined
          : [
              <Button key="saved" type="primary" onClick={finish}>
                我已保存
              </Button>,
            ]
      }
    >
      {created === null ? (
        <Form form={form} layout="vertical">
          <Form.Item
            name="appid"
            label="AppID"
            rules={[
              { required: true, message: "q.qq.com → 开发设置 里的 AppID" },
            ]}
          >
            <Input placeholder="开放平台 AppID（数字）" />
          </Form.Item>
          <Form.Item
            name="secret"
            label="AppSecret"
            rules={[
              { required: true, message: "q.qq.com → 开发设置 里的 AppSecret" },
            ]}
          >
            <Input.Password placeholder="AppSecret（仅用于官方凭据校验，不落日志）" />
          </Form.Item>
          <Form.Item name="name" label="备注名（可选）">
            <Input placeholder="缺省使用 AppID" />
          </Form.Item>
          <Form.Item
            name="auth_level"
            label="认证等级"
            initialValue="uncertified"
          >
            <Select
              options={[
                {
                  value: "uncertified",
                  label: "未认证（主动消息 30 条/分钟）",
                },
                { value: "certified", label: "已认证（主动消息 60 条/分钟）" },
              ]}
            />
          </Form.Item>
        </Form>
      ) : (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="agent token 仅此一次展示，关闭后无法再查看"
            description="它是该机器人接入 MCP（/mcp）的唯一凭证：请立即复制保存到客户端配置；遗失只能走设置页轮换。"
          />
          <Typography.Paragraph
            copyable
            code
            style={{ wordBreak: "break-all", marginBottom: 8 }}
          >
            {created.agent_token}
          </Typography.Paragraph>
          <Typography.Text type="secondary">{created.note}</Typography.Text>
        </>
      )}
    </Modal>
  );
}
