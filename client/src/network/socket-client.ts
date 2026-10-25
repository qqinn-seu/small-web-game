import { io, type Socket } from 'socket.io-client';
import { PROTOCOL_VERSION } from '../../../shared/constants.js';
import type { PatchMessage, SnapshotMessage } from '../../../shared/models.js';
import type {
  Ack,
  AckResult,
  ActionRequest,
  ClientToServerEvents,
  DisconnectResolveRequest,
  JoinRequest,
  LeaveRequest,
  MoveRequest,
  ReadyRequest,
  ResumeRequest,
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

export interface RestoredCredentials {
  playerId: string;
  secret: string;
  nickname: string;
}

export type ConnectionNotice =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'connect_error'; message: string }
  | { kind: 'offline' }
  | { kind: 'replaced'; message: string }
  | { kind: 'restarting'; message: string };

export interface SocketClientCallbacks {
  onConnection?: (notice: ConnectionNotice) => void;
  onHello?: (hello: ServerHello) => void;
  /** Private session data stays in the controller, never the DOM. */
  onSession?: (session: SessionData) => void;
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

function browserStartsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Typed Socket.IO boundary. The secret stays in this instance and can only be
 * copied by the app controller into its persistence boundary; it is never
 * written to the DOM, URL, notices, or logs.
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
  private browserOffline = browserStartsOffline();
  private destroyed = false;
  private authenticationRetryTimer: number | null = null;
  private firstSessionRequest: SessionOpenRequest | null = null;

  public constructor(private readonly callbacks: SocketClientCallbacks = {}) {
    this.socket = io({
      autoConnect: !this.browserOffline,
      reconnection: true,
      reconnectionDelay: 650,
      reconnectionDelayMax: 10_000,
      randomizationFactor: 0.35,
      timeout: 5_000,
    }) as unknown as TypedSocket;
    this.bindSocketEvents();
    if (this.browserOffline) this.callbacks.onConnection?.({ kind: 'offline' });
  }

  public getIdentity(): ClientIdentity | null {
    return this.identity;
  }

  /** Controller-only access for saving a server-issued private credential. */
  public getCredentialsForStorage(): RestoredCredentials | null {
    if (!this.credentials || !this.requestedNickname) return null;
    return {
      playerId: this.credentials.playerId,
      secret: this.credentials.secret,
      nickname: this.requestedNickname,
    };
  }

  public isReady(): boolean {
    return this.socket.connected
      && this.authenticatedOnThisConnection
      && !this.stoppedByReplacement
      && !this.browserOffline
      && !this.destroyed;
  }

  /** Restore an existing browser identity; this never creates a new identity. */
  public restoreIdentity(credentials: RestoredCredentials): void {
    if (this.destroyed || this.stoppedByReplacement) return;
    this.credentials = { playerId: credentials.playerId, secret: credentials.secret };
    this.requestedNickname = credentials.nickname;
    this.identity = { playerId: credentials.playerId, nickname: credentials.nickname };
    this.connectForAuthentication();
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
    // server-issued credential, never silently make a replacement identity.
    this.requestedNickname = trimmed;
    this.stoppedByReplacement = false;
    this.connectForAuthentication();
  }

  /** Browser offline is transport-only, never a business room leave. */
  public goOffline(): void {
    if (this.destroyed || this.browserOffline) return;
    this.browserOffline = true;
    this.authenticatedOnThisConnection = false;
    this.rejectActiveRequests(new NetworkRequestError('浏览器已离线，本次操作未发送。'));
    this.socket.io.reconnection(false);
    this.socket.disconnect();
    this.callbacks.onConnection?.({ kind: 'offline' });
  }

  public goOnline(): void {
    if (this.destroyed || this.stoppedByReplacement || !this.browserOffline) return;
    this.browserOffline = false;
    this.socket.io.reconnection(true);
    this.callbacks.onConnection?.({ kind: 'connecting' });
    this.socket.connect();
  }

  public async createRoom(): Promise<AckResult<RoomEntryData>> {
    return this.requestAuthenticated('room:create', { actionId: actionId() });
  }

  public async joinRoom(roomCode: string): Promise<AckResult<RoomEntryData>> {
    const request: JoinRequest = { actionId: actionId(), roomCode };
    return this.requestAuthenticated('room:join', request);
  }

  public async resume(input: Omit<ResumeRequest, 'actionId'>): Promise<AckResult<RoomEntryData>> {
    return this.requestAuthenticated('room:resume', { ...input, actionId: actionId() });
  }

  public async leave(input: Omit<LeaveRequest, 'actionId'>): Promise<AckResult> {
    return this.requestAuthenticated('room:leave', { ...input, actionId: actionId() });
  }

  public async resolveDisconnect(input: Omit<DisconnectResolveRequest, 'actionId'>): Promise<AckResult> {
    return this.requestAuthenticated('disconnect:resolve', { ...input, actionId: actionId() });
  }

  public async setReady(input: Omit<ReadyRequest, 'actionId'>): Promise<AckResult> {
    return this.requestAuthenticated('round:ready', { ...input, actionId: actionId() });
  }

  public async move(input: Omit<MoveRequest, 'actionId'>): Promise<AckResult> {
    return this.requestAuthenticated('game:move', { ...input, actionId: actionId() });
  }

  public async sync(input: Omit<SyncRequest, 'actionId'>): Promise<AckResult> {
    return this.requestAuthenticated('room:sync', { ...input, actionId: actionId() });
  }

  /** Reauthenticate an existing credential after an uncertain ACK; never create a replacement identity. */
  public reconnectForRecovery(): void {
    if (this.destroyed || this.stoppedByReplacement || this.browserOffline || !this.credentials) return;
    this.authenticatedOnThisConnection = false;
    this.socket.disconnect();
    this.socket.connect();
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.authenticationRetryTimer !== null) window.clearTimeout(this.authenticationRetryTimer);
    this.authenticatedOnThisConnection = false;
    this.rejectActiveRequests(new NetworkRequestError('页面已关闭连接。'));
    this.socket.io.reconnection(false);
    this.socket.disconnect();
  }

  private connectForAuthentication(): void {
    if (this.destroyed || this.stoppedByReplacement || this.browserOffline) return;
    this.socket.io.reconnection(true);
    if (!this.socket.connected) {
      this.callbacks.onConnection?.({ kind: 'connecting' });
      this.socket.connect();
      return;
    }
    void this.authenticate();
  }

  private bindSocketEvents(): void {
    this.socket.on('connect', () => {
      if (this.destroyed) return;
      this.authenticatedOnThisConnection = false;
      if (this.browserOffline) {
        this.socket.disconnect();
        return;
      }
      this.callbacks.onConnection?.({ kind: 'connected' });
      if (!this.stoppedByReplacement && (this.credentials || this.requestedNickname)) {
        void this.authenticate();
      }
    });

    this.socket.on('disconnect', (reason) => {
      this.authenticatedOnThisConnection = false;
      if (!this.credentials) {
        // An unconfirmed first identity must be retried by an explicit user
        // action, not silently recreated on every new transport connection.
        this.requestedNickname = null;
        this.firstSessionRequest = null;
      }
      this.rejectActiveRequests(new NetworkRequestError('连接已断开，未发送的旧操作不会排队。'));
      if (!this.destroyed && !this.stoppedByReplacement && !this.browserOffline) {
        this.callbacks.onConnection?.({ kind: 'disconnected', reason });
      }
    });

    this.socket.on('connect_error', (error) => {
      if (!this.destroyed && !this.browserOffline && !this.stoppedByReplacement) {
        this.callbacks.onConnection?.({ kind: 'connect_error', message: error.message || '无法连接服务器' });
      }
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
      // Crucially, do not clear storage: the replacing same-origin tab owns it.
      this.callbacks.onConnection?.({ kind: 'replaced', message });
    });

    this.socket.on('room:expired', ({ message }) => this.callbacks.onRoomExpired?.(message));
    this.socket.on('server:restarting', ({ message }) => {
      this.callbacks.onConnection?.({ kind: 'restarting', message });
    });
  }

  private async authenticate(): Promise<void> {
    if (
      this.authenticationInFlight
      || !this.socket.connected
      || this.stoppedByReplacement
      || this.browserOffline
      || this.destroyed
    ) return;
    const request = this.sessionRequest();
    if (!request) return;

    this.authenticationInFlight = true;
    const connectionId = this.socket.id;
    try {
      const response = await this.request<SessionData>('session:open', request);
      if (!this.socket.connected || this.socket.id !== connectionId || this.stoppedByReplacement || this.destroyed) return;
      if (!response.ok || !response.data) {
        if (!response.ok && (response.errorCode === 'AUTH_INVALID' || response.errorCode === 'IDENTITY_EXPIRED')) {
          // Never use a typed nickname to create a replacement identity after a
          // rejected credential; another explicit click is required.
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
      this.firstSessionRequest = null;
      this.callbacks.onSession?.(response.data);
    } catch (error) {
      // A disconnect already produces the reconnect notice. A temporary timeout
      // is never evidence that a player identity or room has expired.
      if (this.socket.connected && !this.browserOffline) {
        this.callbacks.onProtocolError?.(error instanceof Error ? error.message : '建立身份失败。');
      }
      if (this.credentials && this.socket.connected && !this.stoppedByReplacement && !this.destroyed
          && this.authenticationRetryTimer === null) {
        this.authenticationRetryTimer = window.setTimeout(() => {
          this.authenticationRetryTimer = null;
          this.reconnectForRecovery();
        }, 1_000);
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
    if (this.firstSessionRequest?.nickname === this.requestedNickname) return this.firstSessionRequest;
    request.nickname = this.requestedNickname;
    this.firstSessionRequest = request;
    return request;
  }

  private async requestAuthenticated<T = Record<string, never>>(
    event: ClientEventName,
    request: ActionRequest,
  ): Promise<AckResult<T>> {
    if (!this.isReady()) throw new NetworkRequestError('服务器尚未完成身份验证，请稍候。');
    return this.request<T>(event, request);
  }

  private async request<T = Record<string, never>>(
    event: ClientEventName,
    request: ActionRequest,
  ): Promise<AckResult<T>> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= ACK_RETRY_COUNT; attempt += 1) {
      if (!this.socket.connected || this.stoppedByReplacement || this.browserOffline || this.destroyed) {
        throw new NetworkRequestError('连接已断开，本次操作未发送。');
      }
      try {
        return await this.emitOnce<T>(event, request);
      } catch (error) {
        lastError = error instanceof Error ? error : new NetworkRequestError('操作等待超时。');
        if (!this.socket.connected || this.browserOffline || attempt === ACK_RETRY_COUNT) break;
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
