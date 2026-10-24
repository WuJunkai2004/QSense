// Mock QQ 网关：本机 ws 服务，按官方 op 语义模拟 HELLO/IDENTIFY/READY/心跳/DISPATCH/RESUME/op9/关闭码。
// 用途：M1 验收——不依赖真实QQ消息即可端到端验证接入器（含断线补发不丢消息）。

import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export interface IdentifyRecord {
  token: string;
  intents: number;
}

export interface ResumeRecord {
  token: string;
  session_id: string;
  seq: number | null;
}

export interface MockGatewayOptions {
  /** Hello 下发的心跳间隔（测试用短间隔） */
  heartbeatIntervalMs?: number;
  /** 第一次 IDENTIFY 回 op9（d=false），逼客户端清会话后重新 IDENTIFY */
  invalidSessionOnFirstIdentify?: boolean;
  /** 会话 id 前缀（多 mock 实例区分用） */
  sessionPrefix?: string;
}

export class MockGateway {
  readonly identifies: IdentifyRecord[] = [];
  readonly resumes: ResumeRecord[] = [];
  readonly heartbeats: Array<number | null> = [];

  private s = 0;
  private sessionId = '';
  private identifyCount = 0;
  private ws: WebSocket | null = null;
  /** 断线期间排队的事件（Resume 后按序补发——官方语义） */
  private readonly pending: Array<{ t: string; d: unknown }> = [];
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private portValue = 0;

  constructor(private readonly opts: MockGatewayOptions = {}) {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.portValue = typeof addr === 'object' && addr !== null ? addr.port : 0;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.portValue}`;
  }

  /** 当前会话 id（READY 后有效） */
  get currentSessionId(): string {
    return this.sessionId;
  }

  /** 下发 dispatch 事件；无活跃连接时排队，等待 Resume 后补发 */
  sendDispatch(t: string, d: unknown): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.send(this.ws, { op: OP.DISPATCH, t, s: ++this.s, d });
    } else {
      this.pending.push({ t, d });
    }
  }

  /** 模拟服务端异常断开（无关闭帧 → 客户端按 1006 处理），会话保留 */
  killSocket(): void {
    this.ws?.terminate();
  }

  /** 模拟官方指定关闭码（如 4004 token 失效） */
  closeWithCode(code: number): void {
    this.ws?.close(code, 'mock close');
  }

  async close(): Promise<void> {
    this.wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(ws: WebSocket): void {
    this.ws = ws;
    this.send(ws, {
      op: OP.HELLO,
      d: { heartbeat_interval: this.opts.heartbeatIntervalMs ?? 100 },
    });
    ws.on('message', (raw) => {
      try {
        this.onMessage(ws, JSON.parse(String(raw)) as Payload);
      } catch {
        // 非 JSON 帧直接忽略（测试不依赖）
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
    });
    ws.on('error', () => {});
  }

  private onMessage(ws: WebSocket, payload: Payload): void {
    switch (payload.op) {
      case OP.IDENTIFY: {
        this.identifyCount += 1;
        const d = payload.d as { token?: string; intents?: number } | undefined;
        this.identifies.push({ token: d?.token ?? '', intents: d?.intents ?? 0 });
        if (this.opts.invalidSessionOnFirstIdentify && this.identifyCount === 1) {
          this.send(ws, { op: OP.INVALID_SESSION, d: false });
          ws.close(4000, 'invalid session');
          return;
        }
        this.sessionId = `${this.opts.sessionPrefix ?? 'sess'}-${this.identifyCount}`;
        this.s = 0;
        this.send(ws, {
          op: OP.DISPATCH,
          t: 'READY',
          s: ++this.s,
          d: { session_id: this.sessionId, user: { id: 'mock-bot' } },
        });
        break;
      }
      case OP.RESUME: {
        const d = payload.d as { token?: string; session_id?: string; seq?: number | null } | undefined;
        this.resumes.push({
          token: d?.token ?? '',
          session_id: d?.session_id ?? '',
          seq: d?.seq ?? null,
        });
        this.s = d?.seq ?? 0;
        // 官方语义：按 seq 补发遗漏事件，最后下发 RESUMED
        for (const ev of this.pending.splice(0)) this.sendDispatch(ev.t, ev.d);
        this.send(ws, {
          op: OP.DISPATCH,
          t: 'RESUMED',
          s: ++this.s,
          d: { session_id: this.sessionId },
        });
        break;
      }
      case OP.HEARTBEAT: {
        this.heartbeats.push(typeof payload.d === 'number' ? payload.d : null);
        this.send(ws, { op: OP.HEARTBEAT_ACK });
        break;
      }
    }
  }

  private send(ws: WebSocket, payload: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
}

interface Payload {
  op: number;
  d?: unknown;
  t?: string;
  s?: number;
}
