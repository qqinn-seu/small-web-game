import './styles/main.css';
import { BOARD_SIZE, PROTOCOL_VERSION } from '../../shared/constants.js';
import type { AckResult, ErrorCode, RoomEntryData, SessionData } from '../../shared/protocol.js';
import { GomokuSocketClient, NetworkRequestError, type ClientIdentity } from './network/socket-client.js';
import { IdentityRoomStorage, type StoredRoomEntry } from './state/identity-storage.js';
import { RoomStore } from './state/room-store.js';
import { GameUI } from './ui/app.js';
import { messageForError } from './ui/error-messages.js';

interface PendingMove {
  roundId: string;
  moveNo: number;
  x: number;
  y: number;
}

type QueuedEntry = { kind: 'create' } | { kind: 'join'; roomCode: string };

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function invitationCodeFromPath(pathname: string): string | undefined {
  const match = /^\/r\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]).trim().toUpperCase() || undefined;
  } catch {
    return undefined;
  }
}

function moveIsReflected(pending: PendingMove, room: ReturnType<RoomStore['getState']>): boolean {
  const round = room?.round;
  if (!round || round.roundId !== pending.roundId) return true;
  return round.moveNo > pending.moveNo || round.board[pending.y * BOARD_SIZE + pending.x] !== 0;
}

function isRoomInvalidation(code: ErrorCode): boolean {
  return code === 'ROOM_EXPIRED' || code === 'SEAT_RELEASED';
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('找不到应用根节点。');

const persistence = new IdentityRoomStorage();
const storedIdentity = persistence.loadIdentity();
const initialRoomCode = invitationCodeFromPath(window.location.pathname);
const store = new RoomStore();
let ui!: GameUI;
let network!: GomokuSocketClient;
let pendingMove: PendingMove | null = null;
let manualSyncInFlight = false;
let queuedEntry: QueuedEntry | null = null;
let operationsReady = false;
let recoveryEntry: StoredRoomEntry | null = null;
let recoveryGeneration = 0;
let recoverySnapshotTimer: number | null = null;

function isOperational(): boolean {
  return operationsReady && network.isReady() && !store.isRecovering() && !store.isSynchronizing();
}

function clearRecoveryTimer(): void {
  if (recoverySnapshotTimer !== null) {
    window.clearTimeout(recoverySnapshotTimer);
    recoverySnapshotTimer = null;
  }
}

function notifyStorageFallbackIfNeeded(): void {
  const warning = persistence.takeDowngradeWarning();
  if (warning) ui.notify(warning);
}

function roomEntryFromState(
  room: NonNullable<ReturnType<RoomStore['getState']>>,
  preferred?: Pick<RoomEntryData, 'invitationPath'>,
): StoredRoomEntry {
  const known = persistence.loadRoom();
  return {
    roomCode: room.roomCode,
    roomInstanceId: room.roomInstanceId,
    invitationPath: preferred?.invitationPath
      ?? (known?.roomInstanceId === room.roomInstanceId ? known.invitationPath : `/r/${encodeURIComponent(room.roomCode)}`),
    lastVersion: room.version,
  };
}

function persistRoomState(room: NonNullable<ReturnType<RoomStore['getState']>>, preferred?: RoomEntryData): StoredRoomEntry {
  const entry = roomEntryFromState(room, preferred);
  persistence.saveRoom(entry);
  notifyStorageFallbackIfNeeded();
  return entry;
}

function clearRoomMirror(message?: string, clearPersistentEntry = false): void {
  clearRecoveryTimer();
  recoveryEntry = null;
  recoveryGeneration += 1;
  pendingMove = null;
  ui.setMovePending(false);
  store.clearRoom();
  ui.setInvitation(null);
  ui.setRestoringRoom(false);
  if (clearPersistentEntry) persistence.clearRoom();
  operationsReady = network.isReady();
  ui.setNetworkReady(isOperational());
  if (message) ui.notify(message);
}

function clearInvalidIdentity(message: string): void {
  queuedEntry = null;
  clearRecoveryTimer();
  persistence.clearIdentity();
  persistence.clearRoom();
  recoveryEntry = null;
  recoveryGeneration += 1;
  pendingMove = null;
  operationsReady = false;
  store.clearRoom();
  ui.setMovePending(false);
  ui.setInvitation(null);
  ui.setRestoringRoom(false);
  ui.setIdentity(null, false);
  ui.setNetworkReady(false);
  ui.setConnection('身份验证失败。');
  ui.notify(message);
}

function handleAckFailure(response: Exclude<AckResult, { ok: true }>, allowSync = true): void {
  if (response.errorCode === 'AUTH_INVALID' || response.errorCode === 'IDENTITY_EXPIRED') {
    clearInvalidIdentity(messageForError(response.errorCode, response.message));
    return;
  }
  if (isRoomInvalidation(response.errorCode)) {
    clearRoomMirror(messageForError(response.errorCode, response.message), true);
    return;
  }
  ui.notify(messageForError(response.errorCode, response.message));
  if (allowSync && response.needsSnapshot) void syncCurrentRoom('服务器要求同步最新房间状态…');
}

async function syncCurrentRoom(reason?: string): Promise<void> {
  const room = store.getState();
  if (!room || !network.isReady() || manualSyncInFlight) return;
  manualSyncInFlight = true;
  ui.setSynchronizing(true);
  if (reason) ui.notify(reason);
  try {
    const response = await network.sync({
      roomInstanceId: room.roomInstanceId,
      lastVersion: room.version,
      syncRequestId: makeId(),
    });
    if (!response.ok) handleAckFailure(response, false);
  } catch (error) {
    if (network.isReady()) {
      store.markSyncFailed();
      ui.notify(networkErrorText(error));
      network.reconnectForRecovery();
    }
  } finally {
    manualSyncInFlight = false;
    ui.setSynchronizing(store.isSynchronizing() || store.isRecovering());
  }
}

async function requestRecoverySnapshot(entry: StoredRoomEntry, generation: number): Promise<void> {
  if (generation !== recoveryGeneration || !network.isReady() || !store.isRecovering()) return;
  try {
    const state = store.getState();
    const response = await network.sync({
      roomInstanceId: entry.roomInstanceId,
      lastVersion: state?.roomInstanceId === entry.roomInstanceId ? state.version : entry.lastVersion,
      syncRequestId: makeId(),
    });
    if (!response.ok && generation === recoveryGeneration) {
      // A clear server refusal ends the in-memory recovery view. Only the
      // explicit expiration/release codes may delete the durable entry.
      clearRecoveryTimer();
      recoveryEntry = null;
      store.clearRoom();
      ui.setRestoringRoom(false);
      operationsReady = network.isReady();
      ui.setNetworkReady(isOperational());
      if (isRoomInvalidation(response.errorCode)) persistence.clearRoom();
      ui.notify(messageForError(response.errorCode, response.message));
    }
  } catch {
    // A temporary disconnect leaves both local entry records intact. The next
    // connection will authenticate and issue another complete resume request.
    if (generation === recoveryGeneration && network.isReady() && store.isRecovering()) network.reconnectForRecovery();
  }
}

function scheduleRecoverySnapshot(entry: StoredRoomEntry, generation: number): void {
  clearRecoveryTimer();
  recoverySnapshotTimer = window.setTimeout(() => {
    recoverySnapshotTimer = null;
    void requestRecoverySnapshot(entry, generation);
  }, 1_800);
}

function completeRecoveryFromSnapshot(room: NonNullable<ReturnType<RoomStore['getState']>>): void {
  if (recoveryEntry && recoveryEntry.roomInstanceId !== room.roomInstanceId) return;
  clearRecoveryTimer();
  recoveryEntry = null;
  operationsReady = network.isReady();
  ui.setRestoringRoom(false);
  ui.setNetworkReady(isOperational());
}

async function resumeRoom(entry: StoredRoomEntry): Promise<void> {
  if (!network.isReady()) return;
  const generation = ++recoveryGeneration;
  clearRecoveryTimer();
  recoveryEntry = entry;
  operationsReady = false;
  pendingMove = null;
  ui.setMovePending(false);
  ui.setNetworkReady(false);
  ui.setRestoringRoom(true);
  ui.setInvitation(entry);
  ui.setConnection('正在恢复原房间座位…');
  store.beginRoomRecovery(entry);

  try {
    const response = await network.resume({
      roomCode: entry.roomCode,
      roomInstanceId: entry.roomInstanceId,
      lastVersion: entry.lastVersion,
      syncRequestId: makeId(),
    });
    if (generation !== recoveryGeneration) return;
    if (!response.ok) {
      // An ACK is an explicit recovery result, so the client mirror must not
      // masquerade as a current room. Preserve durable data for non-expiry
      // failures in accordance with the no-network-loss deletion policy.
      clearRecoveryTimer();
      recoveryEntry = null;
      store.clearRoom();
      ui.setRestoringRoom(false);
      operationsReady = network.isReady();
      ui.setNetworkReady(isOperational());
      if (isRoomInvalidation(response.errorCode)) persistence.clearRoom();
      ui.notify(messageForError(response.errorCode, response.message));
      return;
    }

    if (response.data) {
      const state = store.getState();
      const updated: StoredRoomEntry = {
        ...response.data,
        lastVersion: state?.roomInstanceId === response.data.roomInstanceId ? state.version : entry.lastVersion,
      };
      recoveryEntry = updated;
      persistence.saveRoom(updated);
      notifyStorageFallbackIfNeeded();
      ui.setInvitation(updated);
    }

    // The server can emit a snapshot before its ACK. If it has already been
    // accepted, the complete state gate is open; otherwise request a backup
    // full sync rather than treating ACK/appliedVersion as authoritative state.
    const room = store.getState();
    if (!store.isRecovering() && room?.roomInstanceId === entry.roomInstanceId) {
      completeRecoveryFromSnapshot(room);
    } else if (recoveryEntry) {
      scheduleRecoverySnapshot(recoveryEntry, generation);
    }
  } catch (error) {
    if (generation !== recoveryGeneration) return;
    // Do not remove credentials or room entry for timeouts/network errors.
    if (network.isReady()) ui.notify(networkErrorText(error));
    if (store.isRecovering() && network.isReady()) scheduleRecoverySnapshot(entry, generation);
  }
}

function networkErrorText(error: unknown): string {
  if (error instanceof NetworkRequestError) return error.message;
  return '网络操作未完成，请检查连接后重试。';
}

function hasKnownRoom(): boolean {
  return Boolean(store.getState() || recoveryEntry || persistence.loadRoom());
}

async function createRoom(): Promise<void> {
  if (!network.getIdentity()) {
    const nickname = ui.getNickname();
    if (!nickname) {
      ui.notify('请先填写昵称。');
      return;
    }
    queuedEntry = { kind: 'create' };
    network.establishIdentity(nickname);
    return;
  }
  if (hasKnownRoom()) {
    ui.notify('你已在一个房间中；请先离开当前房间再创建新房间。');
    return;
  }
  if (!isOperational()) {
    ui.notify('服务器尚未完成身份验证和房间同步，请稍候。');
    return;
  }
  ui.setRoomFull(false);
  ui.setRoomEntryBusy(true);
  store.beginRoomEntry();
  try {
    const response = await network.createRoom();
    if (!response.ok || !response.data) {
      // A matching snapshot may have arrived even if an ACK was lost. Never
      // discard that server-authoritative seat and fabricate a lobby.
      if (!store.getState()) store.cancelRoomEntry();
      if (!response.ok) handleAckFailure(response);
      else ui.notify('创建房间未返回完整信息，请等待状态同步。');
      return;
    }
    store.finishRoomEntry(response.data);
    persistence.saveRoom({ ...response.data, lastVersion: store.getState()?.version ?? 0 });
    notifyStorageFallbackIfNeeded();
    ui.setInvitation(response.data);
    ui.notify('房间已创建，等待对方通过邀请链接加入。');
  } catch (error) {
    if (!store.getState()) store.cancelRoomEntry();
    ui.notify(networkErrorText(error));
  } finally {
    ui.setRoomEntryBusy(false);
  }
}

async function joinRoom(roomCode: string): Promise<void> {
  if (!roomCode) {
    ui.notify('请输入房间码。');
    return;
  }
  if (!network.getIdentity()) {
    const nickname = ui.getNickname();
    if (!nickname) {
      ui.notify('请先填写昵称。');
      return;
    }
    queuedEntry = { kind: 'join', roomCode };
    network.establishIdentity(nickname);
    return;
  }
  if (hasKnownRoom()) {
    ui.notify('你已在一个房间中；请先离开当前房间再加入其他邀请。');
    return;
  }
  if (!isOperational()) {
    ui.notify('服务器尚未完成身份验证和房间同步，请稍候。');
    return;
  }
  ui.setRoomFull(false);
  ui.setRoomEntryBusy(true);
  store.beginRoomEntry();
  try {
    const response = await network.joinRoom(roomCode);
    if (!response.ok || !response.data) {
      if (!store.getState()) store.cancelRoomEntry();
      if (!response.ok) {
        ui.setRoomFull(response.errorCode === 'ROOM_FULL');
        handleAckFailure(response);
      } else ui.notify('加入房间未返回完整信息，请等待状态同步。');
      return;
    }
    store.finishRoomEntry(response.data);
    persistence.saveRoom({ ...response.data, lastVersion: store.getState()?.version ?? 0 });
    notifyStorageFallbackIfNeeded();
    ui.setInvitation(response.data);
    ui.notify('已加入房间，请等待双方准备。');
  } catch (error) {
    if (!store.getState()) store.cancelRoomEntry();
    ui.notify(networkErrorText(error));
  } finally {
    ui.setRoomEntryBusy(false);
  }
}

async function setReady(): Promise<void> {
  const room = store.getState();
  const identity = network.getIdentity();
  const ownSeat = room?.seats.find((seat) => seat?.playerId === identity?.playerId) ?? null;
  if (!room || !ownSeat || (room.phase !== 'waiting' && room.phase !== 'finished') || !isOperational()) return;

  ui.setReadyBusy(true);
  try {
    const response = await network.setReady({
      roomInstanceId: room.roomInstanceId,
      baseVersion: room.version,
      roundId: room.round?.roundId ?? null,
      ready: !ownSeat.ready,
    });
    if (!response.ok) handleAckFailure(response);
  } catch (error) {
    ui.notify(networkErrorText(error));
  } finally {
    ui.setReadyBusy(false);
  }
}

async function placeMove(x: number, y: number): Promise<void> {
  const room = store.getState();
  const identity = network.getIdentity();
  const round = room?.round;
  if (
    !room
    || !round
    || room.phase !== 'playing'
    || round.paused
    || round.result
    || round.turnPlayerId !== identity?.playerId
    || pendingMove
    || !isOperational()
  ) return;

  const intent: PendingMove = { roundId: round.roundId, moveNo: round.moveNo, x, y };
  pendingMove = intent;
  ui.setMovePending(true);
  try {
    const response = await network.move({
      roomInstanceId: room.roomInstanceId,
      baseVersion: room.version,
      roundId: round.roundId,
      x,
      y,
      expectedMoveNo: round.moveNo,
    });
    if (!response.ok) {
      pendingMove = null;
      ui.setMovePending(false);
      handleAckFailure(response);
      return;
    }

    // ACK confirms receipt only. Keep the board unchanged until a complete
    // snapshot/patch reflects the authoritative move. It is never replayed
    // into a reconnected or newly created round.
    window.setTimeout(() => {
      if (pendingMove === intent) void syncCurrentRoom('尚未收到落子状态，正在同步…');
    }, 1_800);
  } catch (error) {
    pendingMove = null;
    ui.setMovePending(false);
    ui.notify(networkErrorText(error));
  }
}

async function leaveRoom(): Promise<void> {
  const room = store.getState();
  const identity = network.getIdentity();
  const ownSeat = room?.seats.find((seat) => seat?.playerId === identity?.playerId) ?? null;
  if (!room || !ownSeat || !isOperational()) return;
  if (room.phase === 'playing' && !window.confirm('离开视为认输，确定离开吗？')) return;

  try {
    const response = await network.leave({
      roomInstanceId: room.roomInstanceId,
      baseVersion: room.version,
      roundId: room.round?.roundId ?? null,
    });
    if (!response.ok) {
      handleAckFailure(response);
      // An unsuccessful leave (including ACK timeout after retries) must not
      // discard a possibly valid seat. Reconcile with the server instead.
      if (network.isReady()) await resumeRoom(roomEntryFromState(room));
      return;
    }
    clearRoomMirror(undefined, true);
    history.replaceState(null, '', '/');
    ui.notify('已离开房间。');
  } catch (error) {
    ui.notify(networkErrorText(error));
    // A committed leave removes broadcast membership, so room:sync can only
    // return NOT_IN_ROOM. Strict resume positively distinguishes a released
    // seat from a still-valid one, even when all leave ACKs were lost.
    if (network.isReady()) await resumeRoom(roomEntryFromState(room));
  }
}

async function resolveDisconnect(targetPlayerId: string, decision: 'claim_win' | 'keep_waiting'): Promise<void> {
  const room = store.getState();
  const identity = network.getIdentity();
  const round = room?.round;
  if (
    !room
    || !round
    || room.phase !== 'playing'
    || !round.paused
    || !round.participantIds.includes(identity?.playerId ?? '')
    || !isOperational()
  ) return;
  const opponent = room.seats.find((seat) => seat?.playerId === targetPlayerId) ?? null;
  if (!opponent || opponent.connected || !opponent.disconnectDecisionAvailable) return;

  try {
    const response = await network.resolveDisconnect({
      roomInstanceId: room.roomInstanceId,
      baseVersion: room.version,
      roundId: round.roundId,
      targetPlayerId,
      decision,
    });
    if (!response.ok) handleAckFailure(response);
  } catch (error) {
    ui.notify(networkErrorText(error));
  }
}

function beginQueuedEntry(): void {
  const queued = queuedEntry;
  queuedEntry = null;
  if (queued?.kind === 'create') void createRoom();
  if (queued?.kind === 'join') void joinRoom(queued.roomCode);
}

function handleSession(session: SessionData): void {
  const identity: ClientIdentity | null = network.getIdentity();
  const credentials = network.getCredentialsForStorage();
  if (!identity || !credentials) return;

  persistence.saveIdentity({ ...credentials, serverEpoch: session.serverEpoch });
  notifyStorageFallbackIfNeeded();
  ui.setClockOffset(session.serverTime);
  ui.setIdentity(identity, false);
  ui.setRoomFull(false);

  // `null` is a positive server statement that this identity owns no room. An
  // omitted field is tolerated for mixed-version development servers and uses
  // the browser entry hint instead.
  if (session.room === null) {
    if (hasKnownRoom()) clearRoomMirror('原房间或座位已失效，请重新加入或创建新房间。', true);
    operationsReady = network.isReady();
    ui.setNetworkReady(isOperational());
    ui.setConnection('身份已建立，可以创建或加入房间。');
    beginQueuedEntry();
    return;
  }

  const savedRoom = persistence.loadRoom();
  const roomHint = session.room
    ? {
        ...session.room,
        lastVersion: savedRoom?.roomInstanceId === session.room.roomInstanceId ? savedRoom.lastVersion : 0,
      }
    : savedRoom;

  if (roomHint) {
    if (initialRoomCode && initialRoomCode !== roomHint.roomCode) {
      ui.notify('你已在现有房间中；请先离开当前房间再加入这个邀请。');
    }
    void resumeRoom(roomHint);
    return;
  }

  operationsReady = network.isReady();
  ui.setNetworkReady(isOperational());
  ui.setConnection('身份已建立，可以创建或加入房间。');
  beginQueuedEntry();
}

ui = new GameUI(root, {
  establishIdentity: (nickname) => {
    ui.clearNotice();
    network.establishIdentity(nickname);
  },
  createRoom: () => void createRoom(),
  joinRoom: (roomCode) => void joinRoom(roomCode),
  setReady: () => void setReady(),
  placeMove: (x, y) => void placeMove(x, y),
  leaveRoom: () => void leaveRoom(),
  resolveDisconnect: (targetPlayerId, decision) => void resolveDisconnect(targetPlayerId, decision),
}, initialRoomCode);

network = new GomokuSocketClient({
  onConnection: (notice) => {
    if (notice.kind === 'connecting') {
      operationsReady = false;
      ui.setNetworkReady(false);
      ui.setConnection('正在连接服务器。');
    } else if (notice.kind === 'connected') {
      operationsReady = false;
      ui.setNetworkReady(false);
      ui.setConnection(storedIdentity ? '已连接服务器，正在验证已保存身份。' : '已连接服务器，请建立昵称身份。');
    } else if (notice.kind === 'disconnected') {
      operationsReady = false;
      ui.setNetworkReady(false);
      ui.setConnection('连接已断开，正在重连。恢复后会重新验证身份和房间状态。');
    } else if (notice.kind === 'offline') {
      operationsReady = false;
      ui.setNetworkReady(false);
      ui.setConnection('浏览器离线，已暂停连接；恢复网络后会自动重连。');
    } else if (notice.kind === 'connect_error') {
      operationsReady = false;
      ui.setNetworkReady(false);
      ui.setConnection(`连接失败，正在重试：${notice.message}`);
    } else if (notice.kind === 'replaced') {
      operationsReady = false;
      clearRecoveryTimer();
      ui.setNetworkReady(false);
      ui.setConnection('当前页面已停止操作。');
      // Do not clear browser storage: the newer same-origin tab owns it.
      ui.notify('此页面已被另一个标签页接管。');
    } else if (notice.kind === 'restarting') {
      operationsReady = false;
      ui.setNetworkReady(false);
      ui.setConnection('服务器正在重启，原房间可能无法恢复。');
      ui.notify('服务器正在重启；只有收到明确失效信息后才会清除恢复记录。');
    }
  },
  onHello: (hello) => {
    ui.setClockOffset(hello.serverTime);
    ui.setServerStatus(`服务器在线 · 协议 v${hello.protocolVersion}`);
    if (hello.protocolVersion !== PROTOCOL_VERSION) ui.notify('客户端协议版本不兼容，请刷新页面。');
  },
  onSession: (session) => handleSession(session),
  onSessionInvalid: (message) => {
    clearInvalidIdentity(message || '身份已失效，请重新建立昵称身份。');
  },
  onSnapshot: (message) => {
    ui.setClockOffset(message.serverTime);
    const applied = store.receiveSnapshot(message);
    const room = store.getState();
    if (!applied || !room) return;
    const entry = persistRoomState(room, recoveryEntry?.roomInstanceId === room.roomInstanceId ? recoveryEntry : undefined);
    ui.setInvitation(entry);
    if (!store.isRecovering()) completeRecoveryFromSnapshot(room);
  },
  onPatch: (message) => {
    ui.setClockOffset(message.serverTime);
    store.receivePatch(message);
  },
  onRoomExpired: (message) => {
    clearRoomMirror(message || '房间已失效，请创建新房间。', true);
    ui.setRoomFull(false);
  },
  onProtocolError: (message) => ui.notify(message || '协议操作失败，请重试。'),
});

store.onSyncNeeded(({ roomInstanceId, lastVersion }) => {
  void (async () => {
    if (!network.isReady()) return;
    try {
      const response = await network.sync({ roomInstanceId, lastVersion, syncRequestId: makeId() });
      if (!response.ok) {
        store.markSyncFailed();
        handleAckFailure(response, false);
        if (store.getState() && network.isReady()) network.reconnectForRecovery();
      }
    } catch (error) {
      store.markSyncFailed();
      if (network.isReady()) ui.notify(networkErrorText(error));
      if (network.isReady()) network.reconnectForRecovery();
    }
  })();
});

store.subscribe((room) => {
  ui.setRoom(room);
  ui.setSynchronizing(store.isSynchronizing() || store.isRecovering() || manualSyncInFlight);
  if (room) {
    persistence.updateRoomVersion(room.roomInstanceId, room.version);
    notifyStorageFallbackIfNeeded();
  }
  if (pendingMove && moveIsReflected(pendingMove, room)) {
    pendingMove = null;
    ui.setMovePending(false);
  }
});

if (storedIdentity) {
  ui.setRestoringIdentity(storedIdentity.nickname);
  network.restoreIdentity(storedIdentity);
} else {
  notifyStorageFallbackIfNeeded();
}

window.addEventListener('offline', () => network.goOffline());
window.addEventListener('online', () => network.goOnline());
window.addEventListener('pagehide', () => {
  // Closing/refreshing is transport disconnect only, never a business leave.
  network.destroy();
  ui.destroy();
}, { once: true });
