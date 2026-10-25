import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';
import type { PatchMessage, RoomState, SnapshotMessage } from '../../shared/models.js';
import type { AckResult, RoomEntryData, SessionData } from '../../shared/protocol.js';
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
  entry: RoomEntryData;
}

let game: GameServer;
let baseUrl: string;
let sockets: AnySocket[];
let sequence = 0;
let clock = 1_000_000;

function actionId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence.toString().padStart(6, '0')}`;
}

function request(socket: AnySocket, event: string, payload: Record<string, unknown>): Promise<AckResult<any>> {
  return new Promise((resolve) => (socket as any).emit(event, payload, resolve));
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

function observe(socket: AnySocket): Observer {
  const observer: Observer = { snapshots: [], patches: [], state: null };
  socket.on('room:snapshot', (message: SnapshotMessage) => {
    observer.snapshots.push(message);
    observer.state = structuredClone(message.state);
  });
  socket.on('room:patch', (message: PatchMessage) => {
    observer.patches.push(message);
    if (observer.state !== null
      && observer.state.roomInstanceId === message.roomInstanceId
      && observer.state.version === message.prevVersion) {
      Object.assign(observer.state, structuredClone(message.changes));
      observer.state.version = message.version;
    }
  });
  return observer;
}

async function connect(): Promise<AnySocket> {
  const socket: AnySocket = connectSocket(baseUrl, {
    transports: ['websocket'], forceNew: true, reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 1_500);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error: Error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function open(socket: AnySocket, nickname: string): Promise<SessionData> {
  const response = await request(socket, 'session:open', {
    actionId: actionId('open'), protocolVersion: 1, tabId: actionId('tab'), nickname,
  });
  expect(response.ok).toBe(true);
  if (!response.ok || response.data === undefined) throw new Error('session open failed');
  return response.data as SessionData;
}

async function recover(socket: AnySocket, previous: SessionData): Promise<SessionData> {
  const response = await request(socket, 'session:open', {
    actionId: actionId('recover'), protocolVersion: 1, tabId: actionId('recovery-tab'),
    playerId: previous.playerId, secret: previous.secret,
  });
  expect(response.ok).toBe(true);
  if (!response.ok || response.data === undefined) throw new Error('session recovery failed');
  return response.data as SessionData;
}

async function setupTwoPlayers(): Promise<TwoPlayers> {
  const a = await connect();
  const aObserver = observe(a);
  const aSession = await open(a, 'Alice');
  const created = await request(a, 'room:create', { actionId: actionId('create') });
  expect(created.ok).toBe(true);
  if (!created.ok || created.data === undefined) throw new Error('room create failed');
  await eventually(() => aObserver.state !== null, 'creator snapshot missing');

  const b = await connect();
  const bObserver = observe(b);
  const bSession = await open(b, 'Bob');
  const joined = await request(b, 'room:join', { actionId: actionId('join'), roomCode: created.data.roomCode });
  expect(joined.ok).toBe(true);
  await eventually(() => bObserver.state !== null && aObserver.state?.seats[1]?.playerId === bSession.playerId, 'join state missing');
  return { a, b, aObserver, bObserver, aSession, bSession, entry: created.data as RoomEntryData };
}

async function startRound(context: TwoPlayers): Promise<NonNullable<RoomState['round']>> {
  const first = await request(context.a, 'round:ready', {
    actionId: actionId('ready-a'), roomInstanceId: context.entry.roomInstanceId,
    baseVersion: 0, roundId: context.aObserver.state?.round?.roundId ?? null, ready: true,
  });
  expect(first.ok).toBe(true);
  const second = await request(context.b, 'round:ready', {
    actionId: actionId('ready-b'), roomInstanceId: context.entry.roomInstanceId,
    baseVersion: 0, roundId: context.bObserver.state?.round?.roundId ?? null, ready: true,
  });
  expect(second.ok).toBe(true);
  await eventually(() => context.aObserver.state?.phase === 'playing' && context.aObserver.state.round !== null, 'round did not start');
  return context.aObserver.state!.round!;
}

async function move(
  socket: AnySocket,
  entry: RoomEntryData,
  roundId: string,
  expectedMoveNo: number,
  x: number,
  y: number,
): Promise<AckResult<any>> {
  return request(socket, 'game:move', {
    actionId: actionId('move'), roomInstanceId: entry.roomInstanceId, baseVersion: 0,
    roundId, expectedMoveNo, x, y,
  });
}

async function finishFive(context: TwoPlayers, roundId: string): Promise<void> {
  const turns: Array<[AnySocket, number, number, number]> = [
    [context.a, 0, 0, 0], [context.b, 1, 0, 1], [context.a, 2, 1, 0], [context.b, 3, 1, 1],
    [context.a, 4, 2, 0], [context.b, 5, 2, 1], [context.a, 6, 3, 0], [context.b, 7, 3, 1],
    [context.a, 8, 4, 0],
  ];
  for (const [socket, moveNo, x, y] of turns) expect((await move(socket, context.entry, roundId, moveNo, x, y)).ok).toBe(true);
  await eventually(() => context.aObserver.state?.phase === 'finished', 'five-in-a-row did not finish');
}

beforeEach(async () => {
  clock = 1_000_000;
  sequence = 0;
  sockets = [];
  game = createGameServer({ serveStatic: false, now: () => clock, maintenanceIntervalMs: 0 });
  await new Promise<void>((resolve) => game.httpServer.listen(0, '127.0.0.1', resolve));
  const address = game.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  await game.close();
});

describe('M2 identity and room lifecycle', () => {
  it('uses a new server epoch after an in-memory restart and explicitly expires old identities', async () => {
    const original = await connect();
    const originalSession = await open(original, 'Alice');
    await game.close();

    game = createGameServer({ serveStatic: false, now: () => clock, maintenanceIntervalMs: 0 });
    await new Promise<void>((resolve) => game.httpServer.listen(0, '127.0.0.1', resolve));
    const address = game.httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('replacement server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const recovered = await connect();
    const expired = await request(recovered, 'session:open', {
      actionId: actionId('restart-recover'), protocolVersion: 1, tabId: actionId('restart-tab'),
      playerId: originalSession.playerId, secret: originalSession.secret,
    });
    expect(expired).toMatchObject({ ok: false, errorCode: 'IDENTITY_EXPIRED' });
    const freshSession = await open(recovered, 'Fresh');
    expect(freshSession.serverEpoch).not.toBe(originalSession.serverEpoch);
  });

  it('returns the private owned room entry, distinguishes expired identity from a bad secret, and lets an owner resume a full room', async () => {
    const context = await setupTwoPlayers();
    const third = await connect();
    const thirdObserver = observe(third);
    await open(third, 'Carol');
    const full = await request(third, 'room:join', { actionId: actionId('full'), roomCode: context.entry.roomCode });
    expect(full).toMatchObject({ ok: false, errorCode: 'ROOM_FULL' });
    expect(thirdObserver.snapshots).toHaveLength(0);
    expect(thirdObserver.patches).toHaveLength(0);

    const badSecretSocket = await connect();
    const badSecret = await request(badSecretSocket, 'session:open', {
      actionId: actionId('bad-secret'), protocolVersion: 1, tabId: actionId('bad-tab'),
      playerId: context.aSession.playerId, secret: 'x'.repeat(32),
    });
    expect(badSecret).toMatchObject({ ok: false, errorCode: 'AUTH_INVALID' });
    const missingIdentitySocket = await connect();
    const missingIdentity = await request(missingIdentitySocket, 'session:open', {
      actionId: actionId('missing-identity'), protocolVersion: 1, tabId: actionId('missing-tab'),
      playerId: 'missing-player-identity-00001', secret: 'y'.repeat(32),
    });
    expect(missingIdentity).toMatchObject({ ok: false, errorCode: 'IDENTITY_EXPIRED' });

    context.a.disconnect();
    await eventually(() => context.bObserver.state?.seats[0]?.connected === false, 'disconnect patch missing');
    const recoveredSocket = await connect();
    const recoveredObserver = observe(recoveredSocket);
    const recovered = await recover(recoveredSocket, context.aSession);
    expect(recovered.room).toEqual(context.entry);
    expect(recoveredObserver.snapshots).toHaveLength(0);
    const resumed = await request(recoveredSocket, 'room:resume', {
      actionId: actionId('resume-owner'), roomCode: context.entry.roomCode, roomInstanceId: context.entry.roomInstanceId,
      lastVersion: 0, syncRequestId: 'owner-resume-snapshot-01',
    });
    expect(resumed).toMatchObject({ ok: true, data: context.entry });
    await eventually(
      () => recoveredObserver.snapshots.some((snapshot) => snapshot.syncRequestId === 'owner-resume-snapshot-01'),
      'owner resume snapshot missing',
    );
  });

  it('pauses on disconnect, rejects early claim, preserves a keep-waiting seat, and releases only on an eligible claim', async () => {
    const context = await setupTwoPlayers();
    const round = await startRound(context);
    context.b.disconnect();
    await eventually(() => context.aObserver.state?.round?.paused === true, 'playing round was not paused');
    expect(context.aObserver.state?.seats[1]).toMatchObject({
      connected: false,
      disconnectedAt: clock,
      reconnectDeadline: clock + 60_000,
      disconnectDecisionAvailable: false,
    });

    const tooEarly = await request(context.a, 'disconnect:resolve', {
      actionId: actionId('early-claim'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0,
      roundId: round.roundId, targetPlayerId: context.bSession.playerId, decision: 'claim_win',
    });
    expect(tooEarly).toMatchObject({ ok: false, errorCode: 'GAME_PAUSED' });
    clock += 60_000;
    game.runMaintenance();
    await eventually(() => context.aObserver.state?.seats[1]?.disconnectDecisionAvailable === true, 'deadline eligibility patch missing');
    const wait = await request(context.a, 'disconnect:resolve', {
      actionId: actionId('keep-waiting'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0,
      roundId: round.roundId, targetPlayerId: context.bSession.playerId, decision: 'keep_waiting',
    });
    expect(wait).toMatchObject({ ok: true });
    expect(game.store.players.get(context.bSession.playerId)?.roomInstanceId).toBe(context.entry.roomInstanceId);
    expect(context.aObserver.state?.seats[1]?.connected).toBe(false);

    const claimed = await request(context.a, 'disconnect:resolve', {
      actionId: actionId('claim'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0,
      roundId: round.roundId, targetPlayerId: context.bSession.playerId, decision: 'claim_win',
    });
    expect(claimed).toMatchObject({ ok: true });
    await eventually(() => context.aObserver.state?.phase === 'finished' && context.aObserver.state.seats[1] === null, 'claim result missing');
    expect(context.aObserver.state?.round?.result).toMatchObject({
      winnerPlayerId: context.aSession.playerId, loserPlayerId: context.bSession.playerId, reason: 'disconnect',
    });
    expect(game.store.players.get(context.bSession.playerId)?.roomInstanceId).toBeNull();
  });

  it('starts a changed combination with A black after a disconnect claim, while preserving the frozen prior loser', async () => {
    const context = await setupTwoPlayers();
    const oldRound = await startRound(context);
    context.b.disconnect();
    await eventually(() => context.aObserver.state?.round?.paused === true, 'round did not pause');
    clock += 60_000;
    expect((await request(context.a, 'disconnect:resolve', {
      actionId: actionId('claim'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0,
      roundId: oldRound.roundId, targetPlayerId: context.bSession.playerId, decision: 'claim_win',
    })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.seats[1] === null, 'old player was not released');

    const c = await connect();
    const cObserver = observe(c);
    const cSession = await open(c, 'Carol');
    expect((await request(c, 'room:join', { actionId: actionId('replacement-join'), roomCode: context.entry.roomCode })).ok).toBe(true);
    await eventually(() => cObserver.state?.seats[1]?.playerId === cSession.playerId, 'replacement snapshot missing');
    const frozenResult = cObserver.state?.round?.result;
    expect(frozenResult?.loserPlayerId).toBe(context.bSession.playerId);

    expect((await request(context.a, 'round:ready', {
      actionId: actionId('ready-a'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: oldRound.roundId, ready: true,
    })).ok).toBe(true);
    expect((await request(c, 'round:ready', {
      actionId: actionId('ready-c'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: oldRound.roundId, ready: true,
    })).ok).toBe(true);
    await eventually(() => cObserver.state?.phase === 'playing' && cObserver.state.round?.roundId !== oldRound.roundId, 'replacement game did not start');
    expect(cObserver.state?.round).toMatchObject({
      blackPlayerId: context.aSession.playerId,
      whitePlayerId: cSession.playerId,
      participantIds: [context.aSession.playerId, cSession.playerId],
    });
  });

  it('swaps black and white only when the same two participants rematch', async () => {
    const context = await setupTwoPlayers();
    const first = await startRound(context);
    await finishFive(context, first.roundId);
    expect((await request(context.a, 'round:ready', {
      actionId: actionId('rematch-a'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: first.roundId, ready: true,
    })).ok).toBe(true);
    expect((await request(context.b, 'round:ready', {
      actionId: actionId('rematch-b'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: first.roundId, ready: true,
    })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.phase === 'playing' && context.aObserver.state.round?.roundId !== first.roundId, 'rematch did not start');
    expect(context.aObserver.state?.round).toMatchObject({
      blackPlayerId: context.bSession.playerId,
      whitePlayerId: context.aSession.playerId,
    });
  });

  it('resigns only the current round, removes the leaver before broadcasting, and rejects a delayed old-round leave', async () => {
    const context = await setupTwoPlayers();
    const oldRound = await startRound(context);
    const patchesBeforeLeave = context.aObserver.patches.length;
    const resigned = await request(context.a, 'room:leave', {
      actionId: actionId('resign'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: oldRound.roundId,
    });
    expect(resigned).toMatchObject({ ok: true });
    await eventually(() => context.bObserver.state?.phase === 'finished' && context.bObserver.state.seats[0] === null, 'resignation patch missing');
    await pause(30);
    expect(context.aObserver.patches).toHaveLength(patchesBeforeLeave);
    expect(context.bObserver.state?.round?.result).toMatchObject({
      winnerPlayerId: context.bSession.playerId, loserPlayerId: context.aSession.playerId, reason: 'resign',
    });

    const c = await connect();
    const cObserver = observe(c);
    const cSession = await open(c, 'Carol');
    expect((await request(c, 'room:join', { actionId: actionId('join-c'), roomCode: context.entry.roomCode })).ok).toBe(true);
    await eventually(() => cObserver.state?.seats[0]?.playerId === cSession.playerId, 'new seat snapshot missing');
    expect((await request(context.b, 'round:ready', {
      actionId: actionId('ready-b'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: oldRound.roundId, ready: true,
    })).ok).toBe(true);
    expect((await request(c, 'round:ready', {
      actionId: actionId('ready-c'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: oldRound.roundId, ready: true,
    })).ok).toBe(true);
    await eventually(() => context.bObserver.state?.phase === 'playing' && context.bObserver.state.round?.roundId !== oldRound.roundId, 'new game did not start');
    const staleLeave = await request(context.b, 'room:leave', {
      actionId: actionId('stale-leave'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: oldRound.roundId,
    });
    expect(staleLeave).toMatchObject({ ok: false, errorCode: 'STALE_ROUND' });
  });

  it('makes a replacement controller explicitly resume before play and rejects all old-controller actions', async () => {
    const context = await setupTwoPlayers();
    const round = await startRound(context);
    let replaced = false;
    context.a.once('session:replaced', () => { replaced = true; });
    const replacement = await connect();
    const replacementObserver = observe(replacement);
    const session = await recover(replacement, context.aSession);
    expect(session.room).toEqual(context.entry);
    await eventually(() => replaced, 'old controller was not replaced');
    const oldMove = await move(context.a, context.entry, round.roundId, 0, 0, 0);
    expect(oldMove).toMatchObject({ ok: false, errorCode: 'SESSION_REPLACED' });
    const oldLeave = await request(context.a, 'room:leave', {
      actionId: actionId('old-leave'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: round.roundId,
    });
    expect(oldLeave).toMatchObject({ ok: false, errorCode: 'SESSION_REPLACED' });
    expect(replacementObserver.snapshots).toHaveLength(0);

    const firstResumePayload = {
      actionId: actionId('resume'), roomCode: context.entry.roomCode, roomInstanceId: context.entry.roomInstanceId,
      lastVersion: 0, syncRequestId: 'replacement-snapshot-001',
    };
    const resumed = await request(replacement, 'room:resume', firstResumePayload);
    expect(resumed).toMatchObject({ ok: true });
    await eventually(() => replacementObserver.snapshots.some((item) => item.syncRequestId === 'replacement-snapshot-001'), 'resume snapshot missing');
    const repeated = await request(replacement, 'room:resume', firstResumePayload);
    expect(repeated).toEqual(resumed);
    await eventually(
      () => replacementObserver.snapshots.filter((item) => item.syncRequestId === 'replacement-snapshot-001').length === 2,
      'idempotent resume did not repeat its snapshot',
    );
  });

  it('preserves board, turn and stage in a forced reconnect snapshot before unpausing', async () => {
    const context = await setupTwoPlayers();
    const round = await startRound(context);
    expect((await move(context.a, context.entry, round.roundId, 0, 7, 7)).ok).toBe(true);
    await eventually(() => context.bObserver.state?.round?.moveNo === 1, 'opening move missing');
    context.b.disconnect();
    await eventually(() => context.aObserver.state?.round?.paused === true, 'round did not pause after disconnect');

    const replacement = await connect();
    const replacementObserver = observe(replacement);
    const session = await recover(replacement, context.bSession);
    expect(session.room).toEqual(context.entry);
    expect((await request(replacement, 'room:resume', {
      actionId: actionId('resume-board'), roomCode: context.entry.roomCode, roomInstanceId: context.entry.roomInstanceId,
      lastVersion: 0, syncRequestId: 'board-reconnect-snapshot',
    })).ok).toBe(true);
    await eventually(() => replacementObserver.snapshots.some((snapshot) => snapshot.syncRequestId === 'board-reconnect-snapshot'), 'reconnect snapshot missing');
    const reconnectSnapshot = replacementObserver.snapshots.find((snapshot) => snapshot.syncRequestId === 'board-reconnect-snapshot');
    expect(reconnectSnapshot?.state).toMatchObject({ phase: 'playing', round: { roundId: round.roundId, moveNo: 1, turnPlayerId: context.bSession.playerId, paused: true } });
    expect(reconnectSnapshot?.state.round?.board[7 + 7 * 15]).toBe(1);
    await eventually(() => replacementObserver.state?.round?.paused === false, 'both-online reconnect did not unpause');
  });

  it('serializes reconnect versus timeout claim so only one authoritative outcome can win', async () => {
    for (const reconnectFirst of [false, true]) {
      const context = await setupTwoPlayers();
      const round = await startRound(context);
      context.b.disconnect();
      await eventually(() => context.aObserver.state?.round?.paused === true, 'race did not begin from a paused round');
      clock += 60_000;
      const replacement = await connect();
      await recover(replacement, context.bSession);
      const claimPayload = {
        actionId: actionId('race-claim'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0,
        roundId: round.roundId, targetPlayerId: context.bSession.playerId, decision: 'claim_win',
      };
      const resumePayload = {
        actionId: actionId('race-resume'), roomCode: context.entry.roomCode,
        roomInstanceId: context.entry.roomInstanceId, lastVersion: 0,
      };
      const operations = reconnectFirst
        ? [request(replacement, 'room:resume', resumePayload), request(context.a, 'disconnect:resolve', claimPayload)]
        : [request(context.a, 'disconnect:resolve', claimPayload), request(replacement, 'room:resume', resumePayload)];
      const responses = await Promise.all(operations);
      const claim = responses[reconnectFirst ? 1 : 0]!;
      const resumed = responses[reconnectFirst ? 0 : 1]!;
      const state = game.store.rooms.get(context.entry.roomCode)!.state;
      expect(Number(claim.ok) + Number(resumed.ok)).toBe(1);
      if (claim.ok) {
        expect(state.phase).toBe('finished');
        expect(state.seats[1]).toBeNull();
        expect(state.round?.result?.winnerPlayerId).toBe(context.aSession.playerId);
        expect(resumed).toMatchObject({ ok: false, errorCode: 'SEAT_RELEASED' });
      } else {
        expect(state.phase).toBe('playing');
        expect(state.seats[1]?.connected).toBe(true);
        expect(state.round?.paused).toBe(false);
        expect(state.round?.result).toBeNull();
      }
    }
  });

  it('expires only after both have stayed offline for ten minutes, does not let a full-room third party extend it, and cancels expiry on a valid resume', async () => {
    const context = await setupTwoPlayers();
    context.a.disconnect();
    context.b.disconnect();
    await eventually(() => game.store.rooms.get(context.entry.roomCode)?.state.noConnectedPlayersSince === clock, 'idle clock did not start');
    clock += 599_999;
    game.runMaintenance();
    expect(game.store.rooms.has(context.entry.roomCode)).toBe(true);
    const third = await connect();
    const thirdObserver = observe(third);
    await open(third, 'Carol');
    const full = await request(third, 'room:join', { actionId: actionId('third-full'), roomCode: context.entry.roomCode });
    expect(full).toMatchObject({ ok: false, errorCode: 'ROOM_FULL' });
    expect(thirdObserver.snapshots).toHaveLength(0);
    clock += 1;
    game.runMaintenance();
    expect(game.store.rooms.has(context.entry.roomCode)).toBe(false);
    expect(game.store.players.get(context.aSession.playerId)?.roomInstanceId).toBeNull();
    const expiredRecovery = await connect();
    const expiredSession = await recover(expiredRecovery, context.aSession);
    expect(expiredSession.room).toBeNull();
    const expiredResume = await request(expiredRecovery, 'room:resume', {
      actionId: actionId('expired-resume'), roomCode: context.entry.roomCode, roomInstanceId: context.entry.roomInstanceId, lastVersion: 0,
    });
    expect(expiredResume).toMatchObject({ ok: false, errorCode: 'ROOM_EXPIRED' });

    const second = await setupTwoPlayers();
    second.a.disconnect();
    second.b.disconnect();
    await eventually(() => game.store.rooms.get(second.entry.roomCode)?.state.noConnectedPlayersSince === clock, 'second idle clock missing');
    clock += 9 * 60_000;
    const resumeSocket = await connect();
    await recover(resumeSocket, second.aSession);
    expect((await request(resumeSocket, 'room:resume', {
      actionId: actionId('cancel-expiry'), roomCode: second.entry.roomCode, roomInstanceId: second.entry.roomInstanceId, lastVersion: 0,
    })).ok).toBe(true);
    await eventually(() => game.store.rooms.get(second.entry.roomCode)?.state.noConnectedPlayersSince === null, 'resume did not cancel idle expiry');
    clock += 10 * 60_000;
    game.runMaintenance();
    expect(game.store.rooms.has(second.entry.roomCode)).toBe(true);
  });
});
