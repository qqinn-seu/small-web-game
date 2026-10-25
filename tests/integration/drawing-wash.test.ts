import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';

import { DRAWING_DURATION_MS, EMPTY_FACE_PIXEL, STROKE_MAX_INPUT_POINTS, WASH_DURATION_MS } from '../../shared/constants.js';
import type { PatchMessage, RoomState, SnapshotMessage } from '../../shared/models.js';
import type { AckResult, RoomEntryData, SessionData } from '../../shared/protocol.js';
import { createGameServer, type GameServer } from '../../server/src/app.js';
import { ensureFace, MAX_FACE_CANVASES_PER_ROOM } from '../../server/src/domain/drawing.js';

type AnySocket = Socket<any, any>;

interface Observer {
  state: RoomState | null;
  snapshots: SnapshotMessage[];
  patches: PatchMessage[];
}

interface Pair {
  a: AnySocket;
  b: AnySocket;
  aSession: SessionData;
  bSession: SessionData;
  aObserver: Observer;
  bObserver: Observer;
  entry: RoomEntryData;
}

let game: GameServer;
let baseUrl: string;
let sockets: AnySocket[];
let serial = 0;
let clock = 1_000_000;

const actionId = (prefix: string): string => `${prefix}-${(++serial).toString().padStart(5, '0')}`;
const pause = (milliseconds = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause();
  }
  throw new Error(message);
}

function request(socket: AnySocket, event: string, payload: Record<string, unknown>): Promise<AckResult<any>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function observe(socket: AnySocket): Observer {
  const observer: Observer = { state: null, snapshots: [], patches: [] };
  socket.on('room:snapshot', (snapshot: SnapshotMessage) => {
    observer.snapshots.push(snapshot);
    observer.state = structuredClone(snapshot.state);
  });
  socket.on('room:patch', (patch: PatchMessage) => {
    observer.patches.push(patch);
    if (observer.state !== null && observer.state.roomInstanceId === patch.roomInstanceId && observer.state.version === patch.prevVersion) {
      Object.assign(observer.state, structuredClone(patch.changes));
      observer.state.version = patch.version;
    }
  });
  return observer;
}

async function connect(): Promise<AnySocket> {
  const socket: AnySocket = connectSocket(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timeout')), 1_500);
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

async function recover(socket: AnySocket, session: SessionData): Promise<SessionData> {
  const response = await request(socket, 'session:open', {
    actionId: actionId('recover'), protocolVersion: 1, tabId: actionId('recover-tab'),
    playerId: session.playerId, secret: session.secret,
  });
  expect(response.ok).toBe(true);
  if (!response.ok || response.data === undefined) throw new Error('session recover failed');
  return response.data as SessionData;
}

async function pair(): Promise<Pair> {
  const a = await connect();
  const aObserver = observe(a);
  const aSession = await open(a, 'Alice');
  const created = await request(a, 'room:create', { actionId: actionId('create') });
  expect(created.ok).toBe(true);
  if (!created.ok || created.data === undefined) throw new Error('room create failed');
  await eventually(() => aObserver.state !== null, 'creator snapshot absent');

  const b = await connect();
  const bObserver = observe(b);
  const bSession = await open(b, 'Bob');
  expect((await request(b, 'room:join', { actionId: actionId('join'), roomCode: created.data.roomCode })).ok).toBe(true);
  await eventually(() => bObserver.state !== null && aObserver.state?.seats[1]?.playerId === bSession.playerId, 'join state absent');
  return { a, b, aSession, bSession, aObserver, bObserver, entry: created.data as RoomEntryData };
}

async function startRound(context: Pair): Promise<NonNullable<RoomState['round']>> {
  expect((await request(context.a, 'round:ready', {
    actionId: actionId('ready-a'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: null, ready: true,
  })).ok).toBe(true);
  expect((await request(context.b, 'round:ready', {
    actionId: actionId('ready-b'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: null, ready: true,
  })).ok).toBe(true);
  await eventually(() => context.aObserver.state?.phase === 'playing' && context.aObserver.state.round !== null, 'round did not start');
  return context.aObserver.state!.round!;
}

async function move(socket: AnySocket, context: Pair, roundId: string, expectedMoveNo: number, x: number, y: number): Promise<void> {
  const response = await request(socket, 'game:move', {
    actionId: actionId('move'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId, expectedMoveNo, x, y,
  });
  expect(response.ok).toBe(true);
}

async function winningDrawing(context: Pair): Promise<NonNullable<RoomState['drawing']>> {
  const round = await startRound(context);
  const turns: Array<[AnySocket, number, number, number]> = [
    [context.a, 0, 0, 0], [context.b, 1, 0, 1], [context.a, 2, 1, 0], [context.b, 3, 1, 1],
    [context.a, 4, 2, 0], [context.b, 5, 2, 1], [context.a, 6, 3, 0], [context.b, 7, 3, 1], [context.a, 8, 4, 0],
  ];
  for (const [socket, moveNo, x, y] of turns) await move(socket, context, round.roundId, moveNo, x, y);
  await eventually(() => context.aObserver.state?.phase === 'drawing' && context.aObserver.state.drawing !== null, 'drawing did not start');
  return context.aObserver.state!.drawing!;
}

function drawingBase(context: Pair, drawing: NonNullable<RoomState['drawing']>) {
  return { roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: drawing.roundId, drawingId: drawing.drawingId };
}

async function begin(context: Pair, drawing: NonNullable<RoomState['drawing']>, strokeId = 'stroke-000000000001', colorIndex = 2) {
  return request(context.a, 'stroke:begin', {
    actionId: actionId('begin'), ...drawingBase(context, drawing), strokeId, colorIndex, startPoint: { x: 1, y: 1 },
  });
}

async function skip(context: Pair, drawing: NonNullable<RoomState['drawing']>): Promise<void> {
  const response = await request(context.a, 'drawing:skip', { actionId: actionId('skip'), ...drawingBase(context, drawing) });
  expect(response.ok).toBe(true);
  await eventually(() => context.aObserver.state?.phase === 'finished', 'drawing did not finish');
}

beforeEach(async () => {
  serial = 0;
  clock = 1_000_000;
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

describe('M3 drawing and wash server', () => {
  it('accepts a single start point and batches, de-duplicates a new actionId, rejects sequence conflicts, then archives only on a complete end', async () => {
    const context = await pair();
    expect(context.aObserver.state!.faces).toEqual(context.bObserver.state!.faces);
    expect(Object.keys(context.aObserver.state!.faces)).toHaveLength(2);
    const drawing = await winningDrawing(context);
    const base = drawingBase(context, drawing);

    const nonWinner = await request(context.b, 'stroke:begin', {
      actionId: actionId('loser-begin'), ...base, strokeId: 'stroke-000000000099', colorIndex: 1, startPoint: { x: 0, y: 0 },
    });
    expect(nonWinner).toMatchObject({ ok: false, errorCode: 'NOT_YOUR_TURN' });
    expect(await begin(context, drawing)).toMatchObject({ ok: true });
    await eventually(() => context.bObserver.state?.drawing?.draft?.lastSeq === 0, 'start point draft missing');
    expect(context.bObserver.state?.drawing).toMatchObject({ strokeUsed: true, draft: { points: [{ x: 1, y: 1 }], lastSeq: 0 } });

    const secondBegin = await begin(context, drawing, 'stroke-000000000002');
    expect(secondBegin).toMatchObject({ ok: false, errorCode: 'INVALID_PHASE' });
    const batch = { ...base, strokeId: 'stroke-000000000001', seq: 1, points: [{ x: 2, y: 1 }, { x: 3, y: 1 }] };
    const first = await request(context.a, 'stroke:points', { actionId: actionId('points'), ...batch });
    expect(first.ok).toBe(true);
    const versionAfterFirst = context.aObserver.state!.version;
    const patchCount = context.aObserver.patches.length;
    const duplicate = await request(context.a, 'stroke:points', { actionId: actionId('duplicate-new-action'), ...batch });
    expect(duplicate).toMatchObject({ ok: true, appliedVersion: versionAfterFirst });
    expect(context.aObserver.patches).toHaveLength(patchCount);

    const conflict = await request(context.a, 'stroke:points', {
      actionId: actionId('conflict'), ...batch, points: [{ x: 7, y: 7 }],
    });
    expect(conflict).toMatchObject({ ok: false, errorCode: 'INVALID_STROKE_SEQ' });
    const gap = await request(context.a, 'stroke:points', {
      actionId: actionId('gap'), ...base, strokeId: batch.strokeId, seq: 3, points: [{ x: 4, y: 1 }],
    });
    expect(gap).toMatchObject({ ok: false, errorCode: 'INVALID_STROKE_SEQ' });
    const outOfRange = await request(context.a, 'stroke:points', {
      actionId: actionId('range'), ...base, strokeId: batch.strokeId, seq: 2, points: [{ x: 32, y: 0 }],
    });
    expect(outOfRange).toMatchObject({ ok: false, errorCode: 'INVALID_PAYLOAD' });
    const badEnd = await request(context.a, 'stroke:end', {
      actionId: actionId('bad-end'), ...base, strokeId: batch.strokeId, lastSeq: 1, pointCount: 2,
    });
    expect(badEnd).toMatchObject({ ok: false, errorCode: 'INVALID_STROKE_SEQ' });
    const end = await request(context.a, 'stroke:end', {
      actionId: actionId('end'), ...base, strokeId: batch.strokeId, lastSeq: 1, pointCount: 3,
    });
    expect(end.ok).toBe(true);
    await eventually(() => context.bObserver.state?.phase === 'finished', 'confirmed stroke did not finish');
    const face = context.bObserver.state!.faces[context.bSession.playerId]!;
    expect(face).toMatchObject({ revision: 1, strokes: [{ colorIndex: 2, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }] }] });
    expect(face.pixels[1 * 32 + 1]).toBe(2);
    expect(face.pixels[1 * 32 + 2]).toBe(2);
    expect(face.pixels[1 * 32 + 3]).toBe(2);
  });

  it('enforces the dedicated 25Hz plus burst limit and the 1,024-input-point cap without weakening other events', async () => {
    const context = await pair();
    const drawing = await winningDrawing(context);
    const base = drawingBase(context, drawing);
    expect((await begin(context, drawing)).ok).toBe(true);
    for (let seq = 1; seq <= 30; seq += 1) {
      expect((await request(context.a, 'stroke:points', {
        actionId: actionId('rate'), ...base, strokeId: 'stroke-000000000001', seq, points: [{ x: seq % 32, y: 2 }],
      })).ok).toBe(true);
    }
    const limited = await request(context.a, 'stroke:points', {
      actionId: actionId('rate-over'), ...base, strokeId: 'stroke-000000000001', seq: 31, points: [{ x: 0, y: 3 }],
    });
    expect(limited).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });

    const second = await pair();
    const secondDrawing = await winningDrawing(second);
    const secondBase = drawingBase(second, secondDrawing);
    expect((await begin(second, secondDrawing)).ok).toBe(true);
    const batch = Array.from({ length: 32 }, () => ({ x: 4, y: 4 }));
    for (let seq = 1; seq <= 30; seq += 1) {
      expect((await request(second.a, 'stroke:points', {
        actionId: actionId('cap'), ...secondBase, strokeId: 'stroke-000000000001', seq, points: batch,
      })).ok).toBe(true);
    }
    clock += 1_000;
    expect((await request(second.a, 'stroke:points', {
      actionId: actionId('cap-31'), ...secondBase, strokeId: 'stroke-000000000001', seq: 31, points: batch,
    })).ok).toBe(true);
    const tooMany = await request(second.a, 'stroke:points', {
      actionId: actionId('cap-32'), ...secondBase, strokeId: 'stroke-000000000001', seq: 32, points: batch,
    });
    expect(tooMany).toMatchObject({ ok: false, errorCode: 'INVALID_PAYLOAD' });
    expect(second.aObserver.state?.drawing?.draft?.points).toHaveLength(STROKE_MAX_INPUT_POINTS - 31);
  });

  it('keeps an accepted draft in a reconnect snapshot but never archives it on timeout or grants a second stroke', async () => {
    const context = await pair();
    const drawing = await winningDrawing(context);
    const base = drawingBase(context, drawing);
    expect((await begin(context, drawing)).ok).toBe(true);
    expect((await request(context.a, 'stroke:points', {
      actionId: actionId('points'), ...base, strokeId: 'stroke-000000000001', seq: 1, points: [{ x: 2, y: 2 }],
    })).ok).toBe(true);
    context.a.disconnect();
    await eventually(() => context.bObserver.state?.seats[0]?.connected === false, 'winner disconnect absent');
    const recovered = await connect();
    const recoveredObserver = observe(recovered);
    await recover(recovered, context.aSession);
    expect((await request(recovered, 'room:resume', {
      actionId: actionId('resume'), roomCode: context.entry.roomCode, roomInstanceId: context.entry.roomInstanceId, lastVersion: 0,
      syncRequestId: 'drawing-reconnect-snapshot',
    })).ok).toBe(true);
    await eventually(() => recoveredObserver.snapshots.some((snapshot) => snapshot.syncRequestId === 'drawing-reconnect-snapshot'), 'drawing snapshot absent');
    const snapshot = recoveredObserver.snapshots.find((item) => item.syncRequestId === 'drawing-reconnect-snapshot')!;
    expect(snapshot.state.drawing?.draft).toMatchObject({ strokeId: 'stroke-000000000001', lastSeq: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    const secondBegin = await request(recovered, 'stroke:begin', {
      actionId: actionId('second-begin'), ...base, strokeId: 'stroke-000000000002', colorIndex: 0, startPoint: { x: 0, y: 0 },
    });
    expect(secondBegin).toMatchObject({ ok: false, errorCode: 'INVALID_PHASE' });
    clock += DRAWING_DURATION_MS;
    game.runMaintenance();
    await eventually(() => recoveredObserver.state?.phase === 'finished' && recoveredObserver.state.drawing === null, 'drawing timeout absent');
    const expiredEnd = await request(recovered, 'stroke:end', {
      actionId: actionId('late-end'), ...base, strokeId: 'stroke-000000000001', lastSeq: 1, pointCount: 2,
    });
    expect(expiredEnd).toMatchObject({ ok: false, errorCode: 'DRAWING_EXPIRED' });
    const face = recoveredObserver.state!.faces[context.bSession.playerId]!;
    expect(face.revision).toBe(0);
    expect(face.pixels.every((pixel) => pixel === EMPTY_FACE_PIXEL)).toBe(true);
  });

  it('keeps the original loser target after they leave, denies a replacement drawing control, and restores that original player face on rejoin', async () => {
    const context = await pair();
    const drawing = await winningDrawing(context);
    const base = drawingBase(context, drawing);
    expect((await request(context.b, 'room:leave', {
      actionId: actionId('loser-leave'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: drawing.roundId,
    })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.seats[1] === null && context.aObserver.state?.phase === 'drawing', 'loser leave changed drawing');

    const c = await connect();
    const cObserver = observe(c);
    const cSession = await open(c, 'Carol');
    expect((await request(c, 'room:join', { actionId: actionId('join-c'), roomCode: context.entry.roomCode })).ok).toBe(true);
    await eventually(() => cObserver.state?.seats[1]?.playerId === cSession.playerId, 'replacement did not join');
    expect(cObserver.state?.drawing).toMatchObject({ targetPlayerId: context.bSession.playerId, targetNickname: 'Bob', winnerNickname: 'Alice' });
    const replacementBegin = await request(c, 'stroke:begin', {
      actionId: actionId('replacement-begin'), ...base, strokeId: 'stroke-000000000111', colorIndex: 0, startPoint: { x: 0, y: 0 },
    });
    expect(replacementBegin).toMatchObject({ ok: false, errorCode: 'NOT_YOUR_TURN' });

    expect((await begin(context, drawing)).ok).toBe(true);
    expect((await request(context.a, 'stroke:end', {
      actionId: actionId('end'), ...base, strokeId: 'stroke-000000000001', lastSeq: 0, pointCount: 1,
    })).ok).toBe(true);
    await eventually(() => cObserver.state?.phase === 'finished', 'stroke after target leave did not archive');
    expect(cObserver.state!.faces[context.bSession.playerId]!.revision).toBe(1);
    expect((await request(c, 'room:leave', {
      actionId: actionId('replacement-leave'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: drawing.roundId,
    })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.seats[1] === null, 'replacement seat did not open');
    expect((await request(context.b, 'room:join', { actionId: actionId('original-return'), roomCode: context.entry.roomCode })).ok).toBe(true);
    await eventually(() => context.bObserver.state?.seats[1]?.playerId === context.bSession.playerId, 'original player did not return');
    expect(context.bObserver.state!.faces[context.bSession.playerId]).toMatchObject({ revision: 1, pixels: expect.any(Array) });
  });

  it('drops a held winner draft immediately when the winner actively leaves', async () => {
    const context = await pair();
    const drawing = await winningDrawing(context);
    expect((await begin(context, drawing)).ok).toBe(true);
    expect((await request(context.a, 'room:leave', {
      actionId: actionId('winner-leave'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: drawing.roundId,
    })).ok).toBe(true);
    await eventually(() => context.bObserver.state?.phase === 'finished' && context.bObserver.state?.drawing === null, 'winner leave did not finish');
    const face = context.bObserver.state!.faces[context.bSession.playerId]!;
    expect(face.revision).toBe(0);
    expect(face.strokes).toEqual([]);
  });

  it('requires the other current member to accept wash, validates revisions and timeout, then atomically clears both faces', async () => {
    const context = await pair();
    const drawing = await winningDrawing(context);
    const base = drawingBase(context, drawing);
    expect((await begin(context, drawing)).ok).toBe(true);
    expect((await request(context.a, 'stroke:end', {
      actionId: actionId('end'), ...base, strokeId: 'stroke-000000000001', lastSeq: 0, pointCount: 1,
    })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.phase === 'finished', 'drawing did not archive before wash');
    const roundId = drawing.roundId;

    const propose = async () => request(context.a, 'wash:propose', {
      actionId: actionId('wash-propose'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId,
    });
    expect((await propose()).ok).toBe(true);
    await eventually(() => context.aObserver.state?.washProposal !== null, 'wash proposal absent');
    let proposal = context.aObserver.state!.washProposal!;
    const selfResponse = await request(context.a, 'wash:respond', {
      actionId: actionId('self-respond'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, proposalId: proposal.proposalId, accept: true,
    });
    expect(selfResponse).toMatchObject({ ok: false, errorCode: 'NOT_YOUR_TURN' });
    expect((await request(context.b, 'wash:respond', {
      actionId: actionId('reject'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, proposalId: proposal.proposalId, accept: false,
    })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.washProposal === null, 'wash rejection did not clear proposal');

    expect((await propose()).ok).toBe(true);
    proposal = context.aObserver.state!.washProposal!;
    clock += WASH_DURATION_MS;
    game.runMaintenance();
    await eventually(() => context.aObserver.state?.washProposal === null, 'wash timeout did not clear proposal');
    const timedOut = await request(context.b, 'wash:respond', {
      actionId: actionId('timeout-response'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, proposalId: proposal.proposalId, accept: true,
    });
    expect(timedOut).toMatchObject({ ok: false, errorCode: 'INVALID_PHASE' });

    expect((await propose()).ok).toBe(true);
    proposal = context.aObserver.state!.washProposal!;
    const target = game.store.rooms.get(context.entry.roomCode)!.state.faces[context.bSession.playerId]!;
    target.revision += 1;
    const revisionChanged = await request(context.b, 'wash:respond', {
      actionId: actionId('revision-response'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, proposalId: proposal.proposalId, accept: true,
    });
    expect(revisionChanged).toMatchObject({ ok: false, errorCode: 'INVALID_PHASE' });
    await eventually(() => context.aObserver.state?.washProposal === null, 'revision mismatch did not cancel proposal');

    expect((await propose()).ok).toBe(true);
    proposal = context.aObserver.state!.washProposal!;
    const previousTargetRevision = game.store.rooms.get(context.entry.roomCode)!.state.faces[context.bSession.playerId]!.revision;
    expect((await request(context.b, 'wash:respond', {
      actionId: actionId('accept'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, proposalId: proposal.proposalId, accept: true,
    })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.washProposal === null && context.aObserver.state?.faces[context.bSession.playerId]?.strokes.length === 0, 'wash accept did not clear faces');
    expect(context.aObserver.state!.faces[context.bSession.playerId]).toMatchObject({ revision: previousTargetRevision + 1, strokes: [] });
    expect(context.aObserver.state!.faces[context.aSession.playerId]).toMatchObject({ revision: 1, strokes: [] });
  });

  it('rejects a new identity at historical face capacity without leaking state or deleting the returning original face', async () => {
    const context = await pair();
    const state = game.store.rooms.get(context.entry.roomCode)!.state;
    state.faces[context.bSession.playerId]!.pixels[0] = 3;
    for (let index = 2; index < MAX_FACE_CANVASES_PER_ROOM; index++) ensureFace(state, `historical-${index}`);
    expect((await request(context.b, 'room:leave', { actionId: actionId('leave'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: null })).ok).toBe(true);
    const third = await connect();
    const thirdObserver = observe(third);
    await open(third, 'NewPerson');
    expect(await request(third, 'room:join', { actionId: actionId('capacity-join'), roomCode: context.entry.roomCode })).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    expect(thirdObserver.snapshots).toHaveLength(0);
    expect(thirdObserver.patches).toHaveLength(0);
    expect((await request(context.b, 'room:join', { actionId: actionId('old-owner-join'), roomCode: context.entry.roomCode })).ok).toBe(true);
    await eventually(() => context.bObserver.state?.seats[1]?.playerId === context.bSession.playerId, 'original owner did not return at capacity');
    expect(context.bObserver.state!.faces[context.bSession.playerId]!.pixels[0]).toBe(3);
    expect(Object.keys(state.faces)).toHaveLength(MAX_FACE_CANVASES_PER_ROOM);
  });

  it('does not accept wash in the asynchronous leave window and allows a fresh vote after failed leave rollback', async () => {
    const context = await pair();
    const drawing = await winningDrawing(context);
    expect((await begin(context, drawing)).ok).toBe(true);
    expect((await request(context.a, 'stroke:end', { actionId: actionId('end'), ...drawingBase(context, drawing), strokeId: 'stroke-000000000001', lastSeq: 0, pointCount: 1 })).ok).toBe(true);
    await eventually(() => context.aObserver.state?.phase === 'finished', 'drawing did not finish');
    expect((await request(context.a, 'wash:propose', { actionId: actionId('propose'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: drawing.roundId })).ok).toBe(true);
    const proposalId = context.aObserver.state!.washProposal!.proposalId;
    const serverSocket = game.io.sockets.sockets.get(context.a.id!)!;
    const originalLeave = serverSocket.leave.bind(serverSocket);
    let rejectLeave: (() => void) | null = null;
    serverSocket.leave = () => new Promise<void>((_resolve, reject) => { rejectLeave = () => reject(new Error('simulated adapter failure')); });
    const leaving = request(context.a, 'room:leave', { actionId: actionId('leave'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, roundId: drawing.roundId });
    try {
      await eventually(() => rejectLeave !== null, 'leave window absent');
      const vote = await request(context.b, 'wash:respond', { actionId: actionId('pending-vote'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, proposalId, accept: true });
      expect(vote).toMatchObject({ ok: false, errorCode: 'GAME_PAUSED' });
      expect(game.store.rooms.get(context.entry.roomCode)!.state.faces[context.bSession.playerId]!.revision).toBe(1);
      (rejectLeave as unknown as () => void)();
      expect(await leaving).toMatchObject({ ok: false, errorCode: 'INTERNAL_ERROR' });
      serverSocket.leave = originalLeave;
      expect((await request(context.b, 'wash:respond', { actionId: actionId('fresh-vote'), roomInstanceId: context.entry.roomInstanceId, baseVersion: 0, proposalId, accept: true })).ok).toBe(true);
      await eventually(() => context.bObserver.state?.faces[context.bSession.playerId]?.revision === 2, 'fresh wash vote did not clear');
    } finally {
      serverSocket.leave = originalLeave;
      if (rejectLeave) (rejectLeave as unknown as () => void)();
    }
  });
});
