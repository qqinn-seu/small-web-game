import { io, type Socket } from 'socket.io-client';
import { PROTOCOL_VERSION } from '../../../shared/constants.js';
import type { PatchMessage, SnapshotMessage } from '../../../shared/models.js';
import type {
  Ack,
  AckResult,
  ActionRequest,
  ClientToServerEvents,
  MoveRequest,
  ReadyRequest,
  RoomEntryData,
  ServerHello,
  ServerToClientEvents,
  SessionData,
  SessionOpenRequest,
  SyncRequest,
} from '../../../shared/protocol.js';

const ACK_TIMEOUT_MS = 3_500;
const ACK_RETRY_COUNT = 2;

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ClientEventName = keyof ClientToServerEvents;

export interface ClientIdentity {
  playerId: string;
  nickname: string;
}

export type ConnectionNotice =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'connect_error'; message: string }
  | { kind: 'replaced'; message: string }
  | { kind: 'restarting'; message: string };

export interface SocketClientCallbacks {
  onConnection?: (notice: ConnectionNotice) => void;
  onHello?: (hello: ServerHello) => void;
  onSession?: (identity: ClientIdentity) => void;
  onSessionInvalid?: (message: string) => void;
  onSnapshot?: (message: SnapshotMessage) => void;
  onPatch?: (message: PatchMessage) => void;
  onRoomExpired?: (message: string) => void;
  onProtocolError?: (message: string) => void;
}

export class NetworkRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NetworkRequestError';
  }
}

interface MemoryCredentials {
  playerId: string;
  secret: string;
}

interface UntypedEmitter {
  emit<T>(event: string, request: ActionRequest, ack: Ack<T>): void;
}

function actionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tabId(): string {
  return actionId();
}

/**
 * A small typed Socket.IO boundary. Credentials live in this instance only;
 * deliberately no localStorage/sessionStorage read or write occurs here.
 */
export class GomokuSocketClient {
  private readonly socket: TypedSocket;
  private readonly currentTabId = tabId();
  private readonly activeRejectors = new Map<string, (error: Error) => void>();
  private credentials: MemoryCredentials | null = null;
  private identity: ClientIdentity | null = null;
  private requestedNickname: string | null = null;
  private authenticationInFlight = false;
  private authenticatedOnThisConnection = false;
  private stoppedByReplacement = false;

  public constructor(private readonly callbacks: SocketClientCallbacks = {}) {
    this.socket = io({
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 650,
      reconnectionDelayMax: 10_000,
      randomizationFactor: 0.35,
    }) as unknown as TypedSocket;
    this.bindSocketEvents();
  }

  public getIdentity(): ClientIdentity | null {
    return this.identity;
  }

  public isReady(): boolean {
    return this.socket.connected && this.authenticatedOnThisConnection && !this.stoppedByReplacement;
  }

  /** Begins an explicit first-session request using the supplied nickname. */
  public establishIdentity(nickname: string): void {
    const trimmed = nickname.trim();
    if (!trimmed) {
      this.callbacks.onProtocolError?.('请输入昵称后再继续。');
      return;
    }
    if (this.identity && this.isReady()) return;

    // This call is user initiated. A later reconnect may reuse only the
    // in-memory server credential, never silently make a new identity.
    this.requestedNickname = trimmed;
    this.stoppedByReplacement = false;
    this.socket.io.reconnection(true);
    if (!this.socket.connected) {
      this.callbacks.onConnection?.({ kind: 'connecting' });
      this.socket.connect();
      return;
    }
    void this.authenticate();
  }

  public async createRoom(): Promise<AckResult<RoomEntryData>> {
    return this.request('room:create', { actionId: actionId() });
  }

  public async joinRoom(roomCode: string): Promise<AckResult<RoomEntryData>> {
    const request = { actionId: actionId(), roomCode };
    return this.request('room:join', request);
  }

  public async setReady(input: Omit<ReadyRequest, 'actionId'>): Promise<AckResult> {
    const request: ReadyRequest = { ...input, actionId: actionId() };
    return this.request('round:ready', request);
  }

  public async move(input: Omit<MoveRequest, 'actionId'>): Promise<AckResult> {
    const request: MoveRequest = { ...input, actionId: actionId() };
    return this.request('game:move', request);
  }

  public async sync(input: Omit<SyncRequest, 'actionId'>): Promise<AckResult> {
    const request: SyncRequest = { ...input, actionId: actionId() };
    return this.request('room:sync', request);
  }

  public destroy(): void {
    this.rejectActiveRequests(new NetworkRequestError('页面已关闭连接。'));
    this.socket.disconnect();
  }

  private bindSocketEvents(): void {
    this.socket.on('connect', () => {
      this.authenticatedOnThisConnection = false;
      this.callbacks.onConnection?.({ kind: 'connected' });
      // Reconnect only authenticates the memory-held identity for the current
      // page. It intentionally does not call room:resume (an M2 capability).
      if (!this.stoppedByReplacement && (this.credentials || this.requestedNickname)) {
        void this.authenticate();
      }
    });

    this.socket.on('disconnect', (reason) => {
      this.authenticatedOnThisConnection = false;
      this.rejectActiveRequests(new NetworkRequestError('连接已断开，未发送的旧操作不会排队。'));
      if (!this.stoppedByReplacement) this.callbacks.onConnection?.({ kind: 'disconnected', reason });
    });

    this.socket.on('connect_error', (error) => {
      this.callbacks.onConnection?.({ kind: 'connect_error', message: error.message || '无法连接服务器' });
    });

    this.socket.on('server:hello', (hello) => this.callbacks.onHello?.(hello));
    this.socket.on('room:snapshot', (message) => this.callbacks.onSnapshot?.(message));
    this.socket.on('room:patch', (message) => this.callbacks.onPatch?.(message));

    this.socket.on('session:replaced', ({ message }) => {
      this.stoppedByReplacement = true;
      this.authenticatedOnThisConnection = false;
      this.rejectActiveRequests(new NetworkRequestError('此页面已被另一个标签接管。'));
      this.socket.io.reconnection(false);
      this.socket.disconnect();
      this.callbacks.onConnection?.({ kind: 'replaced', message });
    });

    this.socket.on('room:expired', ({ message }) => this.callbacks.onRoomExpired?.(message));
    this.socket.on('server:restarting', ({ message }) => {
      this.callbacks.onConnection?.({ kind: 'restarting', message });
    });
  }

  private async authenticate(): Promise<void> {
    if (this.authenticationInFlight || !this.socket.connected || this.stoppedByReplacement) return;
    const request = this.sessionRequest();
    if (!request) return;

    this.authenticationInFlight = true;
    try {
      const response = await this.request<SessionData>('session:open', request);
      if (!response.ok || !response.data) {
        if (!response.ok && (response.errorCode === 'AUTH_INVALID' || response.errorCode === 'IDENTITY_EXPIRED')) {
          // Do not use the typed nickname to create a replacement identity on
          // later reconnects; another explicit click is required.
          this.credentials = null;
          this.identity = null;
          this.requestedNickname = null;
          this.callbacks.onSessionInvalid?.(response.message);
        } else if (!response.ok) {
          this.callbacks.onProtocolError?.(response.message);
        }
        return;
      }

      const secret = response.data.secret ?? this.credentials?.secret;
      if (!secret) {
        this.callbacks.onSessionInvalid?.('服务器未返回身份密钥，请重新建立昵称身份。');
        return;
      }
      this.credentials = { playerId: response.data.playerId, secret };
      this.identity = { playerId: response.data.playerId, nickname: response.data.nickname };
      this.requestedNickname = response.data.nickname;
      this.authenticatedOnThisConnection = true;
      this.callbacks.onSession?.(this.identity);
    } catch (error) {
      // A disconnect already produces the explicit M1 reconnect notice. Avoid
      // treating a temporary network timeout as a reason to make a new player.
      if (this.socket.connected) {
        this.callbacks.onProtocolError?.(error instanceof Error ? error.message : '建立身份失败。');
      }
    } finally {
      this.authenticationInFlight = false;
    }
  }

  private sessionRequest(): SessionOpenRequest | null {
    const request: SessionOpenRequest = {
      actionId: actionId(),
      protocolVersion: PROTOCOL_VERSION,
      tabId: this.currentTabId,
    };
    if (this.credentials) {
      request.playerId = this.credentials.playerId;
      request.secret = this.credentials.secret;
      return request;
    }
    if (!this.requestedNickname) return null;
    request.nickname = this.requestedNickname;
    return request;
  }

  private async request<T = Record<string, never>>(
    event: ClientEventName,
    request: ActionRequest,
  ): Promise<AckResult<T>> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= ACK_RETRY_COUNT; attempt += 1) {
      if (!this.socket.connected || this.stoppedByReplacement) {
        throw new NetworkRequestError('连接已断开，本次操作未发送。');
      }
      try {
        return await this.emitOnce<T>(event, request);
      } catch (error) {
        lastError = error instanceof Error ? error : new NetworkRequestError('操作等待超时。');
        if (!this.socket.connected || attempt === ACK_RETRY_COUNT) break;
      }
    }
    throw lastError ?? new NetworkRequestError('操作未完成。');
  }

  private emitOnce<T>(event: ClientEventName, request: ActionRequest): Promise<AckResult<T>> {
    return new Promise<AckResult<T>>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeRejectors.delete(request.actionId);
        callback();
      };
      const timer = window.setTimeout(() => {
        finish(() => reject(new NetworkRequestError('服务器确认超时，正在有限重试。')));
      }, ACK_TIMEOUT_MS);

      this.activeRejectors.set(request.actionId, (error) => finish(() => reject(error)));
      const emitter = this.socket as unknown as UntypedEmitter;
      emitter.emit<T>(event, request, (response) => finish(() => resolve(response)));
    });
  }

  private rejectActiveRequests(error: Error): void {
    const rejectors = [...this.activeRejectors.values()];
    this.activeRejectors.clear();
    for (const reject of rejectors) reject(error);
  }
}
