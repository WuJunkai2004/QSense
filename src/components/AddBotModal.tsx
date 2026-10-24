import { Form, Input, Modal, App as AntApp } from "antd";
import { post } from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: (appid: string) => void;
}

/** 添加机器人：appid + AppSecret；服务端会先拉官方 access_token 校验凭据，失败即拒绝 */
export default function AddBotModal({ open, onClose, onAdded }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  return (
    <Modal
      title="添加机器人"
      open={open}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnClose
      onOk={async () => {
        const v = (await form.validateFields()) as {
          appid: string;
          secret: string;
          name?: string;
        };
        try {
          await post("/bots", v);
          void message.success(`已添加 ${v.appid}，网关接入中…`);
          form.resetFields();
          onAdded(v.appid);
          onClose();
        } catch (e) {
          void message.error(e instanceof Error ? e.message : String(e));
        }
      }}
      okText="添加"
      okButtonProps={{ danger: false }}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="appid"
          label="AppID"
          rules={[{ required: true, message: "q.qq.com → 开发设置 里的 AppID" }]}
        >
          <Input placeholder="开放平台 AppID（数字）" />
        </Form.Item>
        <Form.Item
          name="secret"
          label="AppSecret"
          rules={[{ required: true, message: "q.qq.com → 开发设置 里的 AppSecret" }]}
        >
          <Input.Password placeholder="AppSecret（保存于服务端 SQLite，详见安全说明）" />
        </Form.Item>
        <Form.Item name="name" label="备注名（可选）">
          <Input placeholder="缺省使用 AppID" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
