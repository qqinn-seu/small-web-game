import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';

import type { PatchMessage, RoomState, SnapshotMessage } from '../../shared/models.js';
import type { AckResult, SessionData } from '../../shared/protocol.js';
import { createGameServer, type GameServer } from '../../server/src/app.js';

type AnySocket = Socket<any, any>;

interface Observer {
  snapshots: SnapshotMessage[];
  patches: PatchMessage[];
  state: RoomState | null;
}

interface TwoPlayers {
  a: AnySocket;
  b: AnySocket;
  aObserver: Observer;
  bObserver: Observer;
  aSession: SessionData;
  bSession: SessionData;
  roomCode: string;
  roomInstanceId: string;
}

let game: GameServer;
let baseUrl: string;
let sockets: AnySocket[];
let actionSequence = 0;

function actionId(prefix: string): string {
  actionSequence += 1;
  return `${prefix}-${actionSequence.toString().padStart(4, '0')}`;
}

function observe(socket: AnySocket): Observer {
  const observer: Observer = { snapshots: [], patches: [], state: null };
  socket.on('room:snapshot', (message: SnapshotMessage) => {
    observer.snapshots.push(message);
    observer.state = structuredClone(message.state);
  });
  socket.on('room:patch', (message: PatchMessage) => {
    observer.patches.push(message);
    if (observer.state !== null && observer.state.roomInstanceId === message.roomInstanceId && observer.state.version === message.prevVersion) {
      Object.assign(observer.state, structuredClone(message.changes));
      observer.state.version = message.version;
    }
  });
  return observer;
}

function request(socket: AnySocket, event: string, payload: Record<string, unknown>): Promise<AckResult<any>> {
  return new Promise((resolve) => {
    (socket as any).emit(event, payload, (response: AckResult<any>) => resolve(response));
  });
}

function pause(milliseconds = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause();
  }
  throw new Error(message);
}

async function connect(): Promise<AnySocket> {
  const socket: AnySocket = connectSocket(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 1_500);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

async function open(socket: AnySocket, nickname: string): Promise<SessionData> {
  const response = await request(socket, 'session:open', {
    actionId: actionId('session'),
    protocolVersion: 1,
    tabId: actionId('tab'),
    nickname,
  });
  expect(response.ok).toBe(true);
  if (!response.ok || response.data === undefined) throw new Error('session opening failed');
  return response.data as SessionData;
}

async function setupTwoPlayers(): Promise<TwoPlayers> {
  const a = await connect();
  const aObserver = observe(a);
  const aSession = await open(a, 'Alice');
  const created = await request(a, 'room:create', { actionId: actionId('create') });
  expect(created.ok).toBe(true);
  if (!created.ok || created.data === undefined) throw new Error('room creation failed');
  await eventually(() => aObserver.state !== null, 'creator did not receive a snapshot');

  const b = await connect();
  const bObserver = observe(b);
  const bSession = await open(b, 'Bob');
  const joined = await request(b, 'room:join', { actionId: actionId('join'), roomCode: created.data.roomCode });
  expect(joined.ok).toBe(true);
  await eventually(() => bObserver.state !== null && aObserver.state?.seats[1]?.playerId === bSession.playerId, 'join snapshots/patches missing');

  return {
    a,
    b,
    aObserver,
    bObserver,
    aSession,
    bSession,
    roomCode: created.data.roomCode,
    roomInstanceId: created.data.roomInstanceId,
  };
}

async function startRound(context: TwoPlayers): Promise<NonNullable<RoomState['round']>> {
  const requestBase = { roomInstanceId: context.roomInstanceId, baseVersion: context.aObserver.state?.version ?? 0, roundId: null };
  const aReady = await request(context.a, 'round:ready', { actionId: actionId('ready-a'), ...requestBase, ready: true });
  expect(aReady.ok).toBe(true);
  const bReady = await request(context.b, 'round:ready', {
    actionId: actionId('ready-b'),
    roomInstanceId: context.roomInstanceId,
    baseVersion: context.bObserver.state?.version ?? 0,
    roundId: null,
    ready: true,
  });
  expect(bReady.ok).toBe(true);
  await eventually(() => context.aObserver.state?.phase === 'playing' && context.aObserver.state.round !== null, 'round did not start');
  return context.aObserver.state!.round!;
}

async function move(
  socket: AnySocket,
  roomInstanceId: string,
  roundId: string,
  expectedMoveNo: number,
  x: number,
  y: number,
  action = actionId('move'),
): Promise<AckResult<any>> {
  return request(socket, 'game:move', {
    actionId: action,
    roomInstanceId,
    baseVersion: 0,
    roundId,
    expectedMoveNo,
    x,
    y,
  });
}

beforeEach(async () => {
  game = createGameServer({ serveStatic: false });
  sockets = [];
  actionSequence = 0;
  await new Promise<void>((resolve) => game.httpServer.listen(0, '127.0.0.1', resolve));
  const address = game.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  await game.close();
});

describe('M1 game server', () => {
  it('synchronizes two real clients, applies monotonic patches, supports sync, and ends a five-in-a-row', async () => {
    const context = await setupTwoPlayers();
    const round = await startRound(context);
    expect(round.blackPlayerId).toBe(context.aSession.playerId);
    expect(round.turnPlayerId).toBe(context.aSession.playerId);

    const duplicateAction = actionId('duplicate-move');
    const firstMove = await move(context.a, context.roomInstanceId, round.roundId, 0, 0, 0, duplicateAction);
    expect(firstMove.ok).toBe(true);
    await eventually(() => context.bObserver.state?.round?.moveNo === 1, 'opponent did not receive first move');
    const patchCountAfterMove = context.aObserver.patches.length;

    const duplicateMove = await move(context.a, context.roomInstanceId, round.roundId, 0, 0, 0, duplicateAction);
    expect(duplicateMove).toEqual(firstMove);
    await pause(30);
    expect(context.aObserver.state?.round?.moveNo).toBe(1);
    expect(context.aObserver.patches).toHaveLength(patchCountAfterMove);

    const alteredReuse = await move(context.a, context.roomInstanceId, round.roundId, 0, 2, 0, duplicateAction);
    expect(alteredReuse).toMatchObject({ ok: false, errorCode: 'ACTION_ID_REUSED' });

    expect((await move(context.b, context.roomInstanceId, round.roundId, 1, 0, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 2, 1, 0)).ok).toBe(true);
    expect((await move(context.b, context.roomInstanceId, round.roundId, 3, 1, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 4, 2, 0)).ok).toBe(true);
    expect((await move(context.b, context.roomInstanceId, round.roundId, 5, 2, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 6, 3, 0)).ok).toBe(true);
    expect((await move(context.b, context.roomInstanceId, round.roundId, 7, 3, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 8, 4, 0)).ok).toBe(true);

    await eventually(() => context.bObserver.state?.phase === 'finished', 'winning patch did not reach opponent');
    expect(context.bObserver.state?.round?.result).toMatchObject({
      winnerPlayerId: context.aSession.playerId,
      loserPlayerId: context.bSession.playerId,
      reason: 'five',
    });
    expect(context.bObserver.state?.round?.result?.winningLine).toHaveLength(5);

    const syncRequestId = 'sync-request-0001';
    const synced = await request(context.b, 'room:sync', {
      actionId: actionId('sync'),
      roomInstanceId: context.roomInstanceId,
      lastVersion: 0,
      syncRequestId,
    });
    expect(synced).toMatchObject({ ok: true, appliedVersion: context.bObserver.state?.version });
    await eventually(
      () => context.bObserver.snapshots.some((snapshot) => snapshot.syncRequestId === syncRequestId),
      'sync did not issue a complete snapshot',
    );

    for (const observer of [context.aObserver, context.bObserver]) {
      for (const patch of observer.patches) {
        expect(patch.version).toBe(patch.prevVersion + 1);
      }
      const versions = observer.patches.map((patch) => patch.version);
      expect(versions).toEqual([...versions].sort((left, right) => left - right));
    }
  });

  it('rejects spoofing, invalid moves, stale rounds, occupied cells, wrong turns, ready outside waiting, and moves after a win', async () => {
    const context = await setupTwoPlayers();
    const round = await startRound(context);
    const basePayload = {
      roomInstanceId: context.roomInstanceId,
      baseVersion: 0,
      roundId: round.roundId,
      expectedMoveNo: 0,
      x: 0,
      y: 0,
    };

    const spoofed = await request(context.a, 'game:move', { actionId: actionId('spoof'), ...basePayload, playerId: context.bSession.playerId });
    expect(spoofed).toMatchObject({ ok: false, errorCode: 'INVALID_PAYLOAD' });
    const wrongTurn = await move(context.b, context.roomInstanceId, round.roundId, 0, 0, 0);
    expect(wrongTurn).toMatchObject({ ok: false, errorCode: 'NOT_YOUR_TURN' });
    const outOfRange = await move(context.a, context.roomInstanceId, round.roundId, 0, 15, 0);
    expect(outOfRange).toMatchObject({ ok: false, errorCode: 'INVALID_PAYLOAD' });
    const staleRound = await move(context.a, context.roomInstanceId, 'old-round-000000', 0, 0, 0);
    expect(staleRound).toMatchObject({ ok: false, errorCode: 'STALE_ROUND' });
    const readyWhilePlaying = await request(context.a, 'round:ready', {
      actionId: actionId('ready-playing'), roomInstanceId: context.roomInstanceId, baseVersion: 0, roundId: null, ready: true,
    });
    expect(readyWhilePlaying).toMatchObject({ ok: false, errorCode: 'INVALID_PHASE' });

    expect((await move(context.a, context.roomInstanceId, round.roundId, 0, 0, 0)).ok).toBe(true);
    const occupied = await move(context.b, context.roomInstanceId, round.roundId, 1, 0, 0);
    expect(occupied).toMatchObject({ ok: false, errorCode: 'CELL_OCCUPIED' });
    expect((await move(context.b, context.roomInstanceId, round.roundId, 1, 0, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 2, 1, 0)).ok).toBe(true);
    expect((await move(context.b, context.roomInstanceId, round.roundId, 3, 1, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 4, 2, 0)).ok).toBe(true);
    expect((await move(context.b, context.roomInstanceId, round.roundId, 5, 2, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 6, 3, 0)).ok).toBe(true);
    expect((await move(context.b, context.roomInstanceId, round.roundId, 7, 3, 1)).ok).toBe(true);
    expect((await move(context.a, context.roomInstanceId, round.roundId, 8, 4, 0)).ok).toBe(true);
    await eventually(() => context.aObserver.state?.phase === 'finished', 'game did not finish');

    const afterWin = await move(context.b, context.roomInstanceId, round.roundId, 9, 4, 1);
    expect(afterWin).toMatchObject({ ok: false, errorCode: 'INVALID_PHASE' });
  });

  it('finishes a full 225-cell board with no five-in-a-row as a draw', async () => {
    const context = await setupTwoPlayers();
    const round = await startRound(context);
    // 113 black and 112 white cells; this full board contains no five or more
    // contiguous cells in any of the four directions.
    const rows = [
      '122111122112121', '211212212122121', '112212112222112', '122122211121211', '121112212221221',
      '122121121211121', '211121211212121', '221222211112122', '211211212221111', '121222122121212',
      '222211121222122', '121122221112211', '112221111221212', '121111212122212', '221121211121222',
    ];
    const cells = { 1: [] as Array<[number, number]>, 2: [] as Array<[number, number]> };
    rows.forEach((row, y) => [...row].forEach((value, x) => cells[Number(value) as 1 | 2].push([x, y])));
    expect(cells[1]).toHaveLength(113);
    expect(cells[2]).toHaveLength(112);

    for (let moveNo = 0; moveNo < 225; moveNo += 1) {
      const color = moveNo % 2 === 0 ? 1 : 2;
      const actor = color === 1 ? context.a : context.b;
      const [x, y] = cells[color][Math.floor(moveNo / 2)]!;
      const response = await move(actor, context.roomInstanceId, round.roundId, moveNo, x, y);
      expect(response.ok, `move ${moveNo} should be accepted`).toBe(true);
    }

    await eventually(() => context.aObserver.state?.phase === 'finished', 'full board did not finish');
    expect(context.aObserver.state?.round).toMatchObject({
      moveNo: 225,
      turnPlayerId: null,
      result: { winnerPlayerId: null, loserPlayerId: null, reason: 'draw', winningLine: [] },
    });
  });

  it('does not reveal snapshots or patches to a third identity when a room is full, including via room:sync', async () => {
    const context = await setupTwoPlayers();
    const third = await connect();
    const thirdObserver = observe(third);
    await open(third, 'Carol');

    const full = await request(third, 'room:join', { actionId: actionId('full-join'), roomCode: context.roomCode });
    expect(full).toMatchObject({ ok: false, errorCode: 'ROOM_FULL' });
    expect(full).not.toHaveProperty('data');
    expect(thirdObserver.snapshots).toHaveLength(0);
    expect(thirdObserver.patches).toHaveLength(0);

    const unauthorizedSync = await request(third, 'room:sync', {
      actionId: actionId('third-sync'),
      roomInstanceId: context.roomInstanceId,
      lastVersion: 0,
      syncRequestId: 'third-sync-0001',
    });
    expect(unauthorizedSync).toMatchObject({ ok: false, errorCode: 'NOT_IN_ROOM' });

    const ready = await request(context.a, 'round:ready', {
      actionId: actionId('first-ready'), roomInstanceId: context.roomInstanceId, baseVersion: 0, roundId: null, ready: true,
    });
    expect(ready.ok).toBe(true);
    await pause(40);
    expect(thirdObserver.snapshots).toHaveLength(0);
    expect(thirdObserver.patches).toHaveLength(0);
  });

  it('makes a newer credential-authenticated tab the sole controller and rejects old-socket actions', async () => {
    const context = await setupTwoPlayers();
    let wasReplaced = false;
    context.a.once('session:replaced', () => { wasReplaced = true; });
    const replacement = await connect();
    const replacementObserver = observe(replacement);
    const recovered = await request(replacement, 'session:open', {
      actionId: actionId('recover'),
      protocolVersion: 1,
      tabId: actionId('replacement-tab'),
      playerId: context.aSession.playerId,
      secret: context.aSession.secret,
    });
    expect(recovered).toMatchObject({ ok: true, data: { playerId: context.aSession.playerId } });
    await eventually(() => wasReplaced, 'old controller did not receive replacement signal');

    const oldRequest = await request(context.a, 'room:sync', {
      actionId: actionId('old-sync'),
      roomInstanceId: context.roomInstanceId,
      lastVersion: 0,
      syncRequestId: 'old-sync-request',
    });
    expect(oldRequest).toMatchObject({ ok: false, errorCode: 'SESSION_REPLACED' });
    expect(replacementObserver.snapshots).toHaveLength(0);
  });
});
