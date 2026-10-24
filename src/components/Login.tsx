import { Button, Card, Form, Input, App as AntApp } from "antd";
import { clearToken, setToken } from "../api";
import type { Bootstrap } from "../types";

interface Props {
  version: string | null;
  onReady: (b: Bootstrap) => void;
}

/** 登录页：粘贴 MCP_TOKEN（与 /mcp 同一 token），验证通过进入主界面 */
export default function Login({ version, onReady }: Props) {
  const { message } = AntApp.useApp();
  return (
    <div className="login-wrap">
      <Card style={{ width: 360 }} title={<span>🤖 QQ Bot 网关{version ? ` v${version}` : ""}</span>}>
        <Form
          layout="vertical"
          onFinish={async (v: { token?: string }) => {
            const token = (v.token ?? "").trim();
            if (token === "") {
              void message.warning("请输入 token");
              return;
            }
            setToken(token);
            try {
              const res = await fetch("/ui/api/bootstrap", {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (res.status === 401) {
                clearToken();
                void message.error("token 校验失败（401）。请核对 MCP_TOKEN。");
                return;
              }
              if (!res.ok) {
                clearToken();
                void message.error(`服务异常：HTTP ${res.status}`);
                return;
              }
              onReady((await res.json()) as Bootstrap);
            } catch (e) {
              clearToken();
              void message.error(`无法连接服务：${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        >
          <Form.Item
            name="token"
            label="MCP_TOKEN"
            rules={[{ required: true, message: "粘贴 .env 里的 MCP_TOKEN" }]}
          >
            <Input.Password placeholder="MCP_TOKEN（与服务端 .env 一致）" autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
