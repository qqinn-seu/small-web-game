import './styles/main.css';
import { BOARD_SIZE } from '../../shared/constants.js';
import type { AckResult } from '../../shared/protocol.js';
import { GomokuSocketClient, NetworkRequestError, type ClientIdentity } from './network/socket-client.js';
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

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('找不到应用根节点。');

const store = new RoomStore();
let ui!: GameUI;
let network!: GomokuSocketClient;
let pendingMove: PendingMove | null = null;
let manualSyncInFlight = false;
let queuedEntry: QueuedEntry | null = null;

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
    if (!response.ok) ui.notify(messageForError(response.errorCode, response.message));
  } catch (error) {
    if (network.isReady()) ui.notify(networkErrorText(error));
  } finally {
    manualSyncInFlight = false;
    ui.setSynchronizing(store.isSynchronizing());
  }
}

function networkErrorText(error: unknown): string {
  if (error instanceof NetworkRequestError) return error.message;
  return '网络操作未完成，请检查连接后重试。';
}

function handleAckFailure(response: Exclude<AckResult, { ok: true }>): void {
  ui.notify(messageForError(response.errorCode, response.message));
  if (response.needsSnapshot) void syncCurrentRoom('服务器要求同步最新房间状态…');
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
  if (!network.isReady()) {
    ui.notify('服务器尚未完成身份验证，请稍候。');
    return;
  }
  ui.setRoomFull(false);
  ui.setRoomEntryBusy(true);
  store.beginRoomEntry();
  try {
    const response = await network.createRoom();
    if (!response.ok || !response.data) {
      store.cancelRoomEntry();
      if (!response.ok) handleAckFailure(response);
      else ui.notify('创建房间未返回完整信息，请重试。');
      return;
    }
    // The server may already have emitted snapshot before this ACK. This only
    // correlates it; it does not fabricate a room version or local board.
    store.finishRoomEntry(response.data);
    ui.setInvitation(response.data);
    ui.notify('房间已创建，等待对方通过邀请链接加入。');
  } catch (error) {
    store.cancelRoomEntry();
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
  if (!network.isReady()) {
    ui.notify('服务器尚未完成身份验证，请稍候。');
    return;
  }
  ui.setRoomFull(false);
  ui.setRoomEntryBusy(true);
  store.beginRoomEntry();
  try {
    const response = await network.joinRoom(roomCode);
    if (!response.ok || !response.data) {
      store.cancelRoomEntry();
      if (!response.ok) {
        ui.setRoomFull(response.errorCode === 'ROOM_FULL');
        handleAckFailure(response);
      } else {
        ui.notify('加入房间未返回完整信息，请重试。');
      }
      return;
    }
    store.finishRoomEntry(response.data);
    ui.setInvitation(response.data);
    ui.notify('已加入房间，请等待双方准备。');
  } catch (error) {
    store.cancelRoomEntry();
    ui.notify(networkErrorText(error));
  } finally {
    ui.setRoomEntryBusy(false);
  }
}

async function setReady(): Promise<void> {
  const room = store.getState();
  const identity = network.getIdentity();
  const ownSeat = room?.seats.find((seat) => seat?.playerId === identity?.playerId) ?? null;
  if (!room || !ownSeat || room.phase !== 'waiting') return;

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
    || !network.isReady()
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

    // ACK confirms receipt only. Keep the UI locked and board unchanged until
    // a snapshot/patch reflects the server-authoritative move.
    window.setTimeout(() => {
      if (pendingMove === intent) void syncCurrentRoom('尚未收到落子状态，正在同步…');
    }, 1_800);
  } catch (error) {
    pendingMove = null;
    ui.setMovePending(false);
    ui.notify(networkErrorText(error));
  }
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
}, invitationCodeFromPath(window.location.pathname));

network = new GomokuSocketClient({
  onConnection: (notice) => {
    if (notice.kind === 'connecting') {
      ui.setNetworkReady(false);
      ui.setConnection('正在连接服务器。');
    } else if (notice.kind === 'connected') {
      ui.setNetworkReady(false);
      ui.setConnection('已连接服务器，请建立昵称身份。');
    } else if (notice.kind === 'disconnected') {
      ui.setNetworkReady(false);
      ui.setConnection('连接已断开，正在重连。M1 不提供刷新后房间恢复。');
    } else if (notice.kind === 'connect_error') {
      ui.setNetworkReady(false);
      ui.setConnection(`连接失败，正在重试：${notice.message}`);
    } else if (notice.kind === 'replaced') {
      ui.setNetworkReady(false);
      ui.setConnection('当前页面已停止操作。');
      ui.notify('此页面已被另一个标签页接管。');
    } else if (notice.kind === 'restarting') {
      ui.setNetworkReady(false);
      ui.setConnection('服务器正在重启，原房间可能无法恢复。');
      ui.notify('服务器正在重启；M1 房间仅保存在内存中。');
    }
  },
  onHello: (hello) => {
    ui.setServerStatus(`服务器在线 · 协议 v${hello.protocolVersion}`);
    if (hello.protocolVersion !== 1) ui.notify('客户端协议版本不兼容，请刷新页面。');
  },
  onSession: (identity: ClientIdentity) => {
    ui.setIdentity(identity, network.isReady());
    ui.setRoomFull(false);
    ui.setConnection('身份已建立，可以创建或加入房间。');
    const queued = queuedEntry;
    queuedEntry = null;
    if (queued?.kind === 'create') void createRoom();
    if (queued?.kind === 'join') void joinRoom(queued.roomCode);
  },
  onSessionInvalid: (message) => {
    queuedEntry = null;
    ui.setIdentity(null, false);
    ui.setConnection('身份验证失败。');
    ui.notify(message || '身份已失效，请重新建立昵称身份。');
  },
  onSnapshot: (message) => store.receiveSnapshot(message),
  onPatch: (message) => store.receivePatch(message),
  onRoomExpired: (message) => {
    store.cancelRoomEntry();
    ui.setRoomFull(false);
    ui.notify(message || '房间已失效，请创建新房间。');
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
        ui.notify(messageForError(response.errorCode, response.message));
      }
    } catch (error) {
      store.markSyncFailed();
      if (network.isReady()) ui.notify(networkErrorText(error));
    }
  })();
});

store.subscribe((room) => {
  ui.setRoom(room);
  ui.setSynchronizing(store.isSynchronizing() || manualSyncInFlight);
  if (pendingMove && moveIsReflected(pendingMove, room)) {
    pendingMove = null;
    ui.setMovePending(false);
  }
});

window.addEventListener('pagehide', () => {
  // Not a business "leave": M1 deliberately has no leave/resume UX.
  network.destroy();
  ui.destroy();
}, { once: true });
