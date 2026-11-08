import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Spin,
  Typography,
} from "antd";
import { post } from "../api";
import type {
  AddBotResult,
  AuthLevel,
  QrBindCreate,
  QrBindPoll,
} from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: (appid: string) => void;
}

type QrPhase = "idle" | "starting" | "waiting" | "expired" | "error";

interface QrState {
  phase: QrPhase;
  taskId?: string;
  connectUrl?: string;
  intervalMs: number;
  err?: string;
}

const QR_IDLE: QrState = { phase: "idle", intervalMs: 2000 };

/** 添加机器人（QQ 登录窗式双栏）：左=手动 appid+AppSecret，右=手机 QQ 扫码绑定。
 *  扫码走 /ui/api/qr-bind/*：bind_key 只在服务端，完成时 AppSecret 在服务端解密并
 *  直接注册（含官方两级凭据校验），前端只拿到一次性 agent_token。
 *  两条路径殊途同归：created 成功态强制展示 agent_token，确认保存后才能关闭。 */
export default function AddBotModal({ open, onClose, onAdded }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [created, setCreated] = useState<AddBotResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<QrState>(QR_IDLE);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback((): void => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startQr = useCallback(async (): Promise<void> => {
    stopPoll();
    setQr({ phase: "starting", intervalMs: 2000 });
    try {
      const r = await post<QrBindCreate>("/qr-bind/create", {});
      const intervalMs = Math.max((r.interval_s || 2) * 1000, 1000);
      setQr({
        phase: "waiting",
        taskId: r.task_id,
        connectUrl: r.connect_url,
        intervalMs,
      });
      timerRef.current = setInterval(() => {
        void (async (): Promise<void> => {
          if (timerRef.current === null) return;
          try {
            const p = await post<QrBindPoll>("/qr-bind/poll", {
              task_id: r.task_id,
            });
            if (p.status === "pending") return;
            stopPoll();
            if (p.status === "expired") {
              setQr((s) => ({ ...s, phase: "expired" }));
              return;
            }
            // created：AppSecret 已在服务端解密并注册完毕，展示一次性 token
            setQr(QR_IDLE);
            setCreated({
              ok: true,
              bot: p.bot,
              agent_token: p.agent_token,
              note: p.note,
            });
          } catch (e) {
            stopPoll();
            setQr((s) => ({
              ...s,
              phase: "error",
              err: e instanceof Error ? e.message : String(e),
            }));
          }
        })();
      }, intervalMs);
    } catch (e) {
      setQr({
        phase: "error",
        intervalMs: 2000,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }, [stopPoll]);

  // 弹窗打开即开始扫码任务；关闭即停轮询并复位
  useEffect(() => {
    if (open && created === null && qr.phase === "idle") {
      void startQr();
    }
    if (!open) {
      stopPoll();
      setQr(QR_IDLE);
    }
    return stopPoll;
  }, [open, created, qr.phase, startQr, stopPoll]);

  const finish = (): void => {
    const appid = created?.bot.appid;
    setCreated(null);
    form.resetFields();
    setQr(QR_IDLE);
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
      stopPoll();
      setCreated(await post<AddBotResult>("/bots", v));
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusText =
    qr.phase === "starting"
      ? "正在获取二维码…"
      : qr.phase === "waiting"
        ? "等待扫码…（手机 QQ 确认后自动完成添加）"
        : qr.phase === "expired"
          ? "二维码已过期"
          : qr.phase === "error"
            ? (qr.err ?? "出错了")
            : "";

  return (
    <Modal
      title={
        created === null
          ? "添加机器人"
          : `已添加：${created.bot.name}（${created.bot.appid}）`
      }
      open={open}
      width={created === null ? 860 : 560}
      maskClosable={false}
      destroyOnClose
      onCancel={() => (created === null ? onClose() : finish())}
      footer={
        created === null
          ? null
          : [
              <Button key="saved" type="primary" onClick={finish}>
                我已保存
              </Button>,
            ]
      }
    >
      {created === null ? (
        <div className="addbot">
          <div className="addbot-left">
            <div className="addbot-col-title">手动添加</div>
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
                  {
                    required: true,
                    message: "q.qq.com → 开发设置 里的 AppSecret",
                  },
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
                    {
                      value: "certified",
                      label: "已认证（主动消息 60 条/分钟）",
                    },
                  ]}
                />
              </Form.Item>
              <Button
                type="primary"
                block
                loading={busy}
                onClick={() => void submit()}
              >
                添加
              </Button>
            </Form>
          </div>
          <div className="addbot-divider" />
          <div className="addbot-right">
            <div className="addbot-col-title">扫码添加</div>
            <div className="qr-stage">
              <div className="qr-penguin">🐧</div>
              <div
                className={`qr-shell${
                  qr.phase === "expired" || qr.phase === "error"
                    ? " refreshable"
                    : ""
                }`}
                onClick={() => {
                  if (qr.phase === "expired" || qr.phase === "error")
                    void startQr();
                }}
              >
                {qr.connectUrl !== undefined ? (
                  <QRCodeSVG value={qr.connectUrl} size={150} marginSize={1} />
                ) : (
                  <div className="qr-loading">
                    <Spin />
                  </div>
                )}
                {qr.phase === "expired" && (
                  <div className="qr-mask">
                    二维码已过期
                    <br />
                    点击重新获取
                  </div>
                )}
                {qr.phase === "error" && (
                  <div className="qr-mask">
                    获取失败
                    <br />
                    点击重试
                  </div>
                )}
              </div>
              <div className="qr-hint">
                打开手机QQ，点击
                <br />
                右上角「+」→「扫一扫」
              </div>
              <div className="qr-status">{statusText}</div>
            </div>
          </div>
        </div>
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
