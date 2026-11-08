import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  App as AntApp,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  AppstoreOutlined,
  AudioOutlined,
  CloseOutlined,
  DatabaseOutlined,
  EditOutlined,
  InfoCircleOutlined,
  RobotOutlined,
  SoundOutlined,
} from "@ant-design/icons";
import { apiBlob, del, get, getAlias, patch, post, put } from "../api";
import type {
  AgentTokenResult,
  AuthLevel,
  Bootstrap,
  GroupItem,
  SettingsInfo,
  TtsConfigGet,
  TtsConfigPut,
} from "../types";
import AddBotModal from "./AddBotModal";

interface Props {
  boot: Bootstrap;
  /** 返回主界面（history 回 /ui/） */
  onClose: () => void;
  /** 任一设置落库后回调（App 借此刷新顶栏 bootstrap 口径） */
  onChanged: () => void;
}

type Section = "general" | "tts" | "bots" | "data" | "about";

const NAV: Array<{ key: Section; label: string; icon: ReactNode }> = [
  { key: "general", label: "通用", icon: <AppstoreOutlined /> },
  { key: "tts", label: "TTS 语音", icon: <AudioOutlined /> },
  { key: "bots", label: "机器人", icon: <RobotOutlined /> },
  { key: "data", label: "数据管理", icon: <DatabaseOutlined /> },
  { key: "about", label: "关于", icon: <InfoCircleOutlined /> },
];

const GATEWAY_COLOR: Record<string, string> = {
  ready: "green",
  resumed: "green",
  disconnected: "orange",
  fatal: "red",
  unknown: "default",
};

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const en = encodeURIComponent;

/** 群白名单：勾选式——列出该 bot 已缓存的群聊（别名优先展示），勾选即入草稿。
 *  草稿中不在缓存列表的条目（历史残留/未缓存群）照常展示，防保存时静默丢失。 */
function GroupWhitelist(props: {
  appid: string;
  draft: string[];
  dirty: boolean;
  saving: boolean;
  onChange: (v: string[]) => void;
  onSave: () => void;
}) {
  const { appid, draft, dirty, saving, onChange, onSave } = props;
  const [groups, setGroups] = useState<GroupItem[]>([]);

  useEffect(() => {
    get<{ groups: GroupItem[] }>(`/groups?bot=${en(appid)}&type=all`)
      .then((r) => setGroups(r.groups.filter((g) => g.type === "group")))
      .catch(() => undefined);
  }, [appid]);

  const toggle = (openid: string): void => {
    onChange(
      draft.includes(openid)
        ? draft.filter((g) => g !== openid)
        : [...draft, openid],
    );
  };

  const groupName = (openid: string): string =>
    getAlias(openid) || `群 ${openid.slice(0, 10)}…`;

  const extras = draft.filter(
    (id) => !groups.some((g) => g.group_openid === id),
  );

  return (
    <div style={{ minWidth: 0, width: "100%" }}>
      <div className="label">群白名单</div>
      <div className="desc">该 bot 的发送门禁：勾选允许发送/撤回的群</div>
      <div className="wl-list">
        {groups.length === 0 && extras.length === 0 && (
          <Typography.Text type="secondary">
            该 bot 暂无已缓存群聊可勾选
          </Typography.Text>
        )}
        {groups.map((g) => (
          <div
            className="wl-item"
            key={g.group_openid}
            onClick={() => toggle(g.group_openid)}
          >
            <Checkbox checked={draft.includes(g.group_openid)} />
            <span className="wl-name">{groupName(g.group_openid)}</span>
            <span className="wl-meta">{g.member_count} 人</span>
          </div>
        ))}
        {extras.map((id) => (
          <div className="wl-item" key={id} onClick={() => toggle(id)}>
            <Checkbox checked />
            <span className="wl-name">{groupName(id)}（未缓存）</span>
          </div>
        ))}
      </div>
      <Button
        type="primary"
        disabled={!dirty}
        loading={saving}
        onClick={onSave}
        style={{ marginTop: 10 }}
      >
        保存白名单
      </Button>
    </div>
  );
}

/** TTS 语音栏：OpenAI 兼容 /audio/speech 全局配置（kv）+ 试听。
 *  api_key 永不回显原文（打码占位符）；留空保存 = 保持已存值。
 *  试听草稿优先——未保存的表单值直接合成 "hi" 播放，先验证再落库。 */
function TtsSection() {
  const { message } = AntApp.useApp();
  const [cfg, setCfg] = useState<TtsConfigGet | null>(null);
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    get<TtsConfigGet>("/tts/config")
      .then((r) => {
        setCfg(r);
        if (r.configured) {
          setBase(r.base_url);
          setModel(r.model);
          setVoice(r.voice);
        }
      })
      .catch((e) => void message.error(errMsg(e)));
  }, [message]);

  // 卸载时停播 + 释放 blob URL
  useEffect(
    () => () => {
      audioRef.current?.pause();
      const src = audioRef.current?.src;
      if (src !== undefined && src.startsWith("blob:")) URL.revokeObjectURL(src);
    },
    [],
  );

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const r = await put<TtsConfigPut>("/tts/config", {
        base_url: base,
        api_key: key,
        model,
        voice,
      });
      setCfg({
        configured: true,
        base_url: base.trim(),
        model: model.trim(),
        voice: voice.trim(),
        api_key_masked: r.api_key_masked,
      });
      setKey("");
      void message.success("TTS 配置已保存");
    } catch (e) {
      void message.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      const blob = await apiBlob("/tts/test", {
        method: "POST",
        body: JSON.stringify({ base_url: base, api_key: key, model, voice }),
      });
      audioRef.current?.pause();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      void message.success("合成成功，正在试听「hi」");
    } catch (e) {
      void message.error(errMsg(e));
    } finally {
      setTesting(false);
    }
  };

  const configured = cfg?.configured === true;

  return (
    <>
      <div className="settings-section-title">TTS 语音</div>
      <div className="settings-card">
        <div className="settings-row">
          <div style={{ minWidth: 0, width: "100%" }}>
            <div className="label">服务地址 base_url</div>
            <div className="desc">
              OpenAI 兼容接口根（到 /v1 这一级，不带 /v1 也可自动补）
            </div>
            <Input
              value={base}
              placeholder="如 https://api.openai.com/v1"
              onChange={(e) => setBase(e.target.value)}
              style={{ marginTop: 6 }}
            />
          </div>
        </div>
        <div className="settings-row">
          <div style={{ minWidth: 0, width: "100%" }}>
            <div className="label">API Key</div>
            <div className="desc">
              {configured
                ? `已配置（${cfg.api_key_masked}）：留空保持不变，输入新值即覆盖`
                : "服务无鉴权可留空；保存后仅打码显示"}
            </div>
            <Input.Password
              value={key}
              placeholder={configured ? "留空 = 保持已存值" : "sk-…"}
              onChange={(e) => setKey(e.target.value)}
              style={{ marginTop: 6 }}
            />
          </div>
        </div>
        <div className="settings-row">
          <div style={{ minWidth: 0, width: "100%" }}>
            <div className="label">模型 model</div>
            <div className="desc">如 tts-1 / fish-speech-1.5 / cosyvoice-…（视服务商）</div>
            <Input
              value={model}
              placeholder="tts-1"
              onChange={(e) => setModel(e.target.value)}
              style={{ marginTop: 6 }}
            />
          </div>
        </div>
        <div className="settings-row">
          <div style={{ minWidth: 0, width: "100%" }}>
            <div className="label">音色 voice</div>
            <div className="desc">如 alloy / wanwan（视服务商）</div>
            <Input
              value={voice}
              placeholder="alloy"
              onChange={(e) => setVoice(e.target.value)}
              style={{ marginTop: 6 }}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <Button
            type="primary"
            loading={saving}
            disabled={base.trim() === "" || model.trim() === "" || voice.trim() === ""}
            onClick={() => void save()}
          >
            保存配置
          </Button>
          <Button
            icon={<SoundOutlined />}
            loading={testing}
            disabled={base.trim() === "" || model.trim() === "" || voice.trim() === ""}
            onClick={() => void test()}
          >
            试听（合成 hi）
          </Button>
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="desc" style={{ maxWidth: 640, lineHeight: 1.8 }}>
            保存后，智能体在 send_media 的 media 参数填{" "}
            <Typography.Text code>&quot;tts:要说的文本&quot;</Typography.Text>{" "}
            即可发送语音条（≤1000 字符，服务端合成、mp3 直发官方）。
            每个 bot 还需在「机器人」栏单独打开其「语音发送」开关（缺省关）。
            试听不发消息、不落库草稿，用于先验证配置再保存。
          </div>
        </div>
      </div>
    </>
  );
}

/** 设置页（/ui/settings）：通用 / 机器人 / 数据管理 / 关于。
 *  收编原设置抽屉的全部功能，外加左栏右键「移除机器人」与右栏「删除本群缓存」，
 *  危险操作集中于此，聊天三栏只留只读 + 发送。 */
export default function SettingsPage({ boot, onClose, onChanged }: Props) {
  const { message, modal } = AntApp.useApp();
  const [section, setSection] = useState<Section>("general");

  // —— 通用：发送总开关（GET/PUT /settings）——
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  // 白名单本地草稿（按 appid），点「保存」才 PUT
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // 轮换结果：新 token 仅本次返回，弹窗强制确认后才消失
  const [fresh, setFresh] = useState<AgentTokenResult | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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
    load();
  }, [load]);

  const applyInfo = (r: SettingsInfo): void => {
    setInfo(r);
    setDrafts(
      Object.fromEntries(r.bots.map((b) => [b.appid, b.allow_groups])),
    );
  };

  const toggleSend = async (enabled: boolean): Promise<void> => {
    try {
      const r = await put<SettingsInfo>("/settings", { send_enabled: enabled });
      applyInfo(r);
      void message.success(
        enabled ? "发送已开启" : "发送已关闭（写操作硬拒绝）",
      );
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
      applyInfo(r);
      void message.success("白名单已保存，发送门禁即时生效");
      onChanged();
    } catch (e) {
      void message.error(errMsg(e));
    } finally {
      setSavingKey(null);
    }
  };

  // 认证等级按 bot 即时改（主动消息频控预算 30/60 qpm）
  const saveAuthLevel = async (
    appid: string,
    level: AuthLevel,
  ): Promise<void> => {
    try {
      const r = await put<SettingsInfo>("/settings", {
        auth_levels: [{ appid, auth_level: level }],
      });
      applyInfo(r);
      void message.success(
        level === "certified"
          ? "已标记为认证 bot：主动消息预算 60 条/分钟"
          : "已标记为未认证 bot：主动消息预算 30 条/分钟",
      );
      onChanged();
    } catch (e) {
      void message.error(errMsg(e));
    }
  };

  // 每 bot 语音发送开关（kv tts:<appid>）：send_media "tts:" 来源的闸门之一，即时生效
  const toggleTts = async (appid: string, enabled: boolean): Promise<void> => {
    try {
      const r = await put<SettingsInfo>("/settings", {
        tts_enabled: [{ appid, enabled }],
      });
      applyInfo(r);
      void message.success(
        enabled ? "语音发送已开启（该 bot）" : "语音发送已关闭（该 bot）",
      );
    } catch (e) {
      void message.error(errMsg(e));
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

  // 改备注名：仅本地展示与自发消息补记的作者名，不触官方
  const [renameTarget, setRenameTarget] = useState<{
    appid: string;
    name: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const submitRename = async (): Promise<void> => {
    if (renameTarget === null) return;
    try {
      await patch(`/bots/${renameTarget.appid}`, { name: renameValue });
      void message.success("备注名已更新");
      setRenameTarget(null);
      load();
      onChanged();
    } catch (e) {
      void message.error(errMsg(e));
    }
  };

  // 移除机器人（自左栏右键收编）：断开网关清登录态，缓存保留
  const removeBot = (b: { appid: string; name: string }): void => {
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
          if (purgeBot === b.appid) {
            setPurgeBot(
              boot.bots.find((x) => x.appid !== b.appid)?.appid ?? null,
            );
          }
          load();
          onChanged();
        } catch (e) {
          void message.error(errMsg(e));
        }
      },
    });
  };

  // —— 数据管理：整群缓存删除（自右栏收编，仅群聊适用）——
  const [purgeBot, setPurgeBot] = useState<string | null>(
    boot.bots[0]?.appid ?? null,
  );
  const [purgeList, setPurgeList] = useState<GroupItem[]>([]);

  const loadPurge = useCallback((): void => {
    if (purgeBot === null) return;
    get<{ groups: GroupItem[] }>(`/groups?bot=${en(purgeBot)}&type=all`)
      .then((r) => setPurgeList(r.groups.filter((g) => g.type === "group")))
      .catch(() => undefined);
  }, [purgeBot]);

  useEffect(() => {
    if (section === "data") loadPurge();
  }, [section, loadPurge]);

  const purgeGroup = (g: GroupItem): void => {
    if (purgeBot === null) return;
    modal.confirm({
      title: "删除本群全部缓存？",
      content:
        "将删除该群的消息（含检索索引）、成员名册、群注册表与已读水位，不可恢复；发送审计账本保留。机器人仍在群时消息会重新累积。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await del(`/groups/${en(g.group_openid)}?bot=${en(purgeBot)}`);
          void message.success("该群缓存已删除");
          loadPurge();
        } catch (e) {
          void message.error(errMsg(e));
        }
      },
    });
  };

  return (
    <div className="settings-page">
      <aside className="settings-side">
        <div className="title">设置</div>
        {NAV.map((n) => (
          <div
            key={n.key}
            className={`settings-nav-item${section === n.key ? " active" : ""}`}
            onClick={() => setSection(n.key)}
          >
            {n.icon}
            <span>{n.label}</span>
          </div>
        ))}
      </aside>
      <main className="settings-main">
        <Button
          className="close"
          type="text"
          icon={<CloseOutlined />}
          title="返回主界面"
          onClick={onClose}
        />

        {section === "general" && (
          <>
            <div className="settings-section-title">通用</div>
            <div className="settings-card">
              <div className="settings-row">
                <div>
                  <div className="label">发送总开关（全局）</div>
                  <div className="desc">
                    {info?.send_enabled
                      ? "已开启：仅白名单内的群可发送/撤回"
                      : "已关闭：所有写操作硬拒绝"}
                  </div>
                </div>
                <Switch
                  checked={info?.send_enabled ?? false}
                  onChange={(v) => void toggleSend(v)}
                />
              </div>
            </div>
            <div className="settings-card">
              <div className="settings-row">
                <div className="label">版本</div>
                <Tag style={{ marginRight: 0 }}>v{boot.version}</Tag>
              </div>
              <div className="settings-row">
                <div className="label">运行时长</div>
                <span>{Math.floor(boot.uptime_s / 60)} 分钟</span>
              </div>
              {boot.bots.map((b) => (
                <div className="settings-row" key={b.appid}>
                  <div className="label">
                    {b.name} 网关状态
                  </div>
                  <Tag color={GATEWAY_COLOR[b.gateway] ?? "default"}>
                    {b.gateway}
                  </Tag>
                </div>
              ))}
            </div>
          </>
        )}

        {section === "tts" && <TtsSection />}

        {section === "bots" && (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <div className="settings-section-title" style={{ margin: 0 }}>
                机器人
              </div>
              <Button onClick={() => setAddOpen(true)}>
                添加机器人（官方凭据校验）
              </Button>
            </div>
            {info === null ? (
              <Spin />
            ) : (
              info.bots.map((b) => {
                const draft = drafts[b.appid] ?? [];
                const dirty =
                  JSON.stringify(draft) !== JSON.stringify(b.allow_groups);
                return (
                  <div className="settings-card" key={b.appid}>
                    <div className="settings-row">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="label">{b.name}</span>
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => {
                            setRenameTarget(b);
                            setRenameValue(b.name);
                          }}
                          title="改备注名"
                        />
                        <Typography.Text code type="secondary">
                          {b.appid}
                        </Typography.Text>
                        <Tag color={GATEWAY_COLOR[b.gateway] ?? "default"}>
                          {b.gateway}
                        </Tag>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div>
                        <div className="label">语音发送（TTS）</div>
                        <div className="desc">
                          允许 send_media 的 &quot;tts:&quot; 合成语音；需先在「TTS
                          语音」栏完成全局配置
                        </div>
                      </div>
                      <Switch
                        checked={b.tts_enabled}
                        onChange={(v) => void toggleTts(b.appid, v)}
                      />
                    </div>
                    <div className="settings-row">
                      <div>
                        <div className="label">认证等级</div>
                        <div className="desc">主动消息频控预算</div>
                      </div>
                      <Select<AuthLevel>
                        value={b.auth_level}
                        style={{ width: 200 }}
                        onChange={(v) => void saveAuthLevel(b.appid, v)}
                        options={[
                          {
                            value: "uncertified",
                            label: "未认证（30 条/分钟）",
                          },
                          {
                            value: "certified",
                            label: "已认证（60 条/分钟）",
                          },
                        ]}
                      />
                    </div>
                    <div className="settings-row">
                      <GroupWhitelist
                        appid={b.appid}
                        draft={draft}
                        dirty={dirty}
                        saving={savingKey === b.appid}
                        onChange={(v) =>
                          setDrafts((d) => ({ ...d, [b.appid]: v }))
                        }
                        onSave={() => void saveGroups(b.appid)}
                      />
                    </div>
                    <div className="settings-row">
                      <div>
                        <div className="label">agent token</div>
                        <div className="desc">
                          MCP 客户端（如 OpenCode）的接入凭证
                        </div>
                      </div>
                      <Button danger onClick={() => rotate(b.appid, b.name)}>
                        轮换 token
                      </Button>
                    </div>
                    <div className="settings-row">
                      <div>
                        <div className="label">移除机器人</div>
                        <div className="desc">
                          断开网关并清除登录态；缓存数据保留
                        </div>
                      </div>
                      <Button danger onClick={() => removeBot(b)}>
                        移除
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}

        {section === "data" && (
          <>
            <div className="settings-section-title">数据管理</div>
            <div className="settings-card">
              <div className="settings-row">
                <div>
                  <div className="label">选择机器人</div>
                  <div className="desc">
                    列出其已缓存的群聊会话；单聊无注册表条目，不适用删除
                  </div>
                </div>
                <Select
                  style={{ width: 260 }}
                  value={purgeBot ?? undefined}
                  onChange={setPurgeBot}
                  options={boot.bots.map((b) => ({
                    value: b.appid,
                    label: `${b.name}（${b.appid}）`,
                  }))}
                />
              </div>
            </div>
            <div className="settings-card">
              {purgeList.length === 0 ? (
                <Typography.Text type="secondary">
                  该 bot 暂无已缓存群聊
                </Typography.Text>
              ) : (
                purgeList.map((g) => (
                  <div className="settings-row" key={g.group_openid}>
                    <div style={{ minWidth: 0 }}>
                      <div className="label" style={{ wordBreak: "break-all" }}>
                        {g.group_openid}
                      </div>
                      <div className="desc">
                        成员 {g.member_count} · 最后活动{" "}
                        {g.last?.ts ?? "—"}
                      </div>
                    </div>
                    <Button danger onClick={() => purgeGroup(g)}>
                      删除本群缓存
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {section === "about" && (
          <>
            <div className="settings-section-title">关于</div>
            <div className="settings-card">
              <div className="settings-row">
                <div className="label">QQ Bot 网关</div>
                <Tag style={{ marginRight: 0 }}>v{boot.version}</Tag>
              </div>
              <div className="settings-row">
                <div className="desc" style={{ maxWidth: 560, lineHeight: 1.8 }}>
                  QQ 官方机器人 → MCP 网关的智能体视角客户端。数据源头仅
                  QQ 官方机器人 API（WebSocket Gateway + OpenAPI），全链路合规；
                  消息缓存与全部运行状态落 SQLite；写操作默认关闭，经群白名单门禁。
                  MCP 工具面供本地 OpenCode 等智能体接入。
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      <Modal
        title={`改备注名（${renameTarget?.appid ?? ""}）`}
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        onOk={() => void submitRename()}
        okText="保存"
        cancelText="取消"
      >
        <Input
          value={renameValue}
          maxLength={32}
          placeholder="留空 = 显示 appid"
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={() => void submitRename()}
        />
        <Typography.Text
          type="secondary"
          style={{ marginTop: 8, display: "block" }}
        >
          仅本地展示与自发消息补记的作者名，不会改官方任何资料
        </Typography.Text>
      </Modal>

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
        <Typography.Paragraph
          copyable
          code
          style={{ wordBreak: "break-all", marginBottom: 8 }}
        >
          {fresh?.agent_token ?? ""}
        </Typography.Paragraph>
        <Typography.Text type="secondary">{fresh?.note}</Typography.Text>
      </Modal>

      <AddBotModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          load();
          onChanged();
        }}
      />
    </div>
  );
}
