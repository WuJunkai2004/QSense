import { useCallback, useEffect, useState } from "react";
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
import { get, post } from "../api";
import type {
  AddBotResult,
  AuthLevel,
  ConnectorCredSchema,
  ConnectorDecl,
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
  connectUrl?: string;
  err?: string;
}

const QR_IDLE: QrState = { phase: "idle" };

/** /connectors 不可用时的回落（QQ 基座形）：手动添加路径永远可用 */
const FALLBACK_DECL: ConnectorDecl = {
  id: "qq",
  title: "QQ 官方机器人",
  caps: {
    scopes: [],
    media: {},
    recall: false,
    passiveWindow: true,
    quota: true,
  },
  credential_schema: {
    type: "object",
    required: ["appid", "secret"],
    properties: {
      appid: {
        type: "string",
        description: "q.qq.com → 开发设置 里的 AppID",
      },
      secret: {
        type: "string",
        description: "q.qq.com → 开发设置 里的 AppSecret",
      },
    },
  },
  credential_secrets: ["secret"],
  login: { kind: "secret" },
  webui: [],
};

/** 凭据键 → 展示名（命名约定通用映射，非平台硬编码） */
const KEY_LABELS: Record<string, string> = {
  appid: "AppID",
  app_id: "AppID",
  secret: "AppSecret",
  token: "Token",
};

interface CredField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  desc: string;
}

/** credentialSchema → 表单字段清单（required 优先，其余按声明序） */
function credFieldsOf(schema: ConnectorCredSchema): CredField[] {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const keys = [
    ...required.filter((k) => k in props),
    ...Object.keys(props).filter((k) => !required.includes(k)),
  ];
  return keys.map((key) => ({
    key,
    label: KEY_LABELS[key] ?? key,
    required: required.includes(key),
    secret: key.includes("secret") || key.includes("token"),
    desc: props[key]?.description ?? (KEY_LABELS[key] ?? key),
  }));
}

/** 添加机器人（登录窗式双栏）：左=凭据表单（credentialSchema 驱动渲染），
 *  右=扫码绑定（login=qr-pair 声明驱动，经 /platforms/:id/* 插件路由；
 *  完成时宿主注册，前端只拿到一次性 agent_token）。
 *  P2 声明制（2026-11-15）：平台/字段/登录流全部来自 GET /ui/api/connectors；
 *  声明不可用时回落 QQ 基座静态形，手动添加永不失效。 */
export default function AddBotModal({ open, onClose, onAdded }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [created, setCreated] = useState<AddBotResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<QrState>(QR_IDLE);
  // 平台声明：null=未取到（表单回落 QQ 基座静态形）
  const [decl, setDecl] = useState<ConnectorDecl | null>(null);
  // 无 qr-pair 平台声明 → 隐藏扫码栏（纯凭据表单）
  const [noQr, setNoQr] = useState(false);
  // 重开任务计数：过期/失败的遮罩点击 +1，驱动下方 effect 重新建任务
  const [qrNonce, setQrNonce] = useState(0);

  /** 弹窗打开且未成功 → 拉声明 + 建任务 + 定时轮询。create/interval/清理全部收在同一个
   *  effect 闭包里（清理只随 [open, created, qrNonce] 变化触发）——历史上曾把
   *  定时器句柄放 useRef、cleanup 挂在含 qr.phase 的依赖上，phase 一变清理就
   *  把刚建的定时器杀掉，轮询从未真正跑起来（2026-11-08 真机踩坑）。 */
  useEffect(() => {
    if (!open || created !== null) {
      setQr(QR_IDLE);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const clear = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    void (async (): Promise<void> => {
      setQr({ phase: "starting" });
      // 声明面：表单字段源 + 扫码登录流路径；失败回落静态 QQ 形（隐藏扫码栏）
      let qrDecl: ConnectorDecl | undefined;
      try {
        const decls = await get<{ connectors: ConnectorDecl[] }>("/connectors");
        if (!alive) return;
        setDecl(decls.connectors[0] ?? null);
        qrDecl = decls.connectors.find((c) => c.login.kind === "qr-pair");
      } catch {
        if (!alive) return;
        setDecl(null);
      }
      if (
        qrDecl === undefined ||
        qrDecl.login.create === undefined ||
        qrDecl.login.poll === undefined
      ) {
        setNoQr(true);
        setQr(QR_IDLE);
        return;
      }
      // const 抓取登录流路径（闭包内 let 窄化不保持）
      const { create: createPath, poll: pollPath } = qrDecl.login;
      const base = `/platforms/${qrDecl.id}`;
      try {
        const r = await post<QrBindCreate>(`${base}${createPath}`, {});
        if (!alive) return;
        const intervalMs = Math.max((r.interval_s || 2) * 1000, 1000);
        setQr({ phase: "waiting", connectUrl: r.connect_url });
        timer = setInterval(() => {
          void (async (): Promise<void> => {
            try {
              const p = await post<QrBindPoll>(`${base}${pollPath}`, {
                task_id: r.task_id,
              });
              if (!alive) return;
              if (p.status === "pending") return;
              clear();
              if (p.status === "expired") {
                setQr({ phase: "expired" });
                return;
              }
              // created：宿主已完成注册（凭据校验+落库+拉起网关），展示一次性 token
              setCreated({
                ok: true,
                bot: p.bot,
                agent_token: p.agent_token,
                note: p.note,
              });
            } catch (e) {
              clear();
              setQr({
                phase: "error",
                err: e instanceof Error ? e.message : String(e),
              });
            }
          })();
        }, intervalMs);
      } catch (e) {
        if (!alive) return;
        setQr({
          phase: "error",
          err: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      alive = false;
      clear();
    };
  }, [open, created, qrNonce]);

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
      setCreated(await post<AddBotResult>("/bots", v));
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshQr = useCallback((): void => {
    setQrNonce((n) => n + 1);
  }, []);

  // 表单字段按声明渲染（声明未取到 → QQ 基座静态形回落）
  const effective = decl ?? FALLBACK_DECL;
  const fields = credFieldsOf(effective.credential_schema);
  const secrets = new Set(effective.credential_secrets);
  const showAuthLevel = effective.caps.quota; // 认证等级=额度语义平台（caps 驱动）

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
      width={created === null ? (noQr ? 560 : 860) : 560}
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
            <div className="addbot-col-title">
              手动添加{decl !== null ? ` · ${decl.title}` : ""}
            </div>
            <Form form={form} layout="vertical">
              {fields.map((f) => (
                <Form.Item
                  key={f.key}
                  name={f.key}
                  label={f.label}
                  rules={
                    f.required
                      ? [{ required: true, message: f.desc }]
                      : undefined
                  }
                >
                  {secrets.has(f.key) ? (
                    <Input.Password placeholder={f.desc} />
                  ) : (
                    <Input placeholder={f.desc} />
                  )}
                </Form.Item>
              ))}
              <Form.Item name="name" label="备注名（可选）">
                <Input placeholder="缺省使用首个凭据值" />
              </Form.Item>
              {showAuthLevel && (
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
              )}
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
          {!noQr && (
            <>
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
                        refreshQr();
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
            </>
          )}
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
