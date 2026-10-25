import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createGameServer, type GameServer } from '../../server/src/app.js';
import type { AckResult, SessionData, RoomEntryData } from '../../shared/protocol.js';

let game: GameServer;
let baseUrl: string;
let clients: Socket[];
let serial = 0;
const id = () => `concurrency-action-${++serial}`;
const request = (socket: Socket, event: string, payload: object): Promise<AckResult<any>> =>
  new Promise((resolve) => socket.emit(event, payload, resolve));
async function connect(): Promise<Socket> {
  const socket = io(baseUrl, { forceNew: true, transports: ['websocket'], reconnection: false });
  clients.push(socket);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  return socket;
}
async function session(socket: Socket, nickname: string, original?: SessionData): Promise<SessionData> {
  const ack = await request(socket, 'session:open', {
    actionId: id(), protocolVersion: 1, tabId: id(),
    ...(original ? { playerId: original.playerId, secret: original.secret } : { nickname }),
  });
  if (!ack.ok || !ack.data) throw new Error('Unable to authenticate');
  return ack.data;
}
async function ready(socket: Socket, entry: RoomEntryData, roundId: string | null): Promise<AckResult<any>> {
  return request(socket, 'round:ready', { actionId: id(), roomInstanceId: entry.roomInstanceId, baseVersion: 0, roundId, ready: true });
}
async function setup() {
  const a = await connect();
  const aIdentity = await session(a, 'A');
  const created = await request(a, 'room:create', { actionId: id() });
  if (!created.ok || !created.data) throw new Error('Unable to create room');
  const entry = created.data as RoomEntryData;
  const b = await connect();
  const bIdentity = await session(b, 'B');
  return { a, b, aIdentity, bIdentity, entry };
}
async function joined() {
  const context = await setup();
  const joined = await request(context.b, 'room:join', { actionId: id(), roomCode: context.entry.roomCode });
  expect(joined.ok).toBe(true);
  return context;
}
function delayJoin(socket: Socket) {
  const server = game.io.sockets.sockets.get(socket.id!)!;
  const original = server.join.bind(server);
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  server.join = async (rooms) => { started(); await gate; await original(rooms); };
  return { begun, release, server };
}
function resume(socket: Socket, entry: RoomEntryData) {
  return request(socket, 'room:resume', { actionId: id(), roomCode: entry.roomCode, roomInstanceId: entry.roomInstanceId, lastVersion: 0 });
}
beforeEach(async () => {
  serial = 0;
  clients = [];
  game = createGameServer({ serveStatic: false, maintenanceIntervalMs: 0 });
  await new Promise<void>((resolve) => game.httpServer.listen(0, '127.0.0.1', resolve));
  const address = game.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  for (const client of clients) client.disconnect();
  await game.close();
});

describe('M2 member-operation concurrency', () => {
  it('does not start a new round while a finished-round leave is awaiting membership removal', async () => {
    const { a, b, entry } = await joined();
    await ready(a, entry, null); await ready(b, entry, null);
    const state = game.store.rooms.get(entry.roomCode)!.state;
    const roundId = state.round!.roundId;
    for (let x = 0; x < 5; x++) {
      expect((await request(a, 'game:move', { actionId: id(), roomInstanceId: entry.roomInstanceId, baseVersion: 0, roundId, x, y: 0, expectedMoveNo: x * 2 })).ok).toBe(true);
      if (x < 4) expect((await request(b, 'game:move', { actionId: id(), roomInstanceId: entry.roomInstanceId, baseVersion: 0, roundId, x, y: 2, expectedMoveNo: x * 2 + 1 })).ok).toBe(true);
    }
    await ready(a, entry, roundId);
    const serverA = game.io.sockets.sockets.get(a.id!)!;
    const original = serverA.leave.bind(serverA);
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    serverA.leave = async (room) => { await original(room); started(); await gate; };
    const leave = request(a, 'room:leave', { actionId: id(), roomInstanceId: entry.roomInstanceId, baseVersion: state.version, roundId });
    await begun;
    await ready(b, entry, roundId);
    const phaseDuringLeave = state.phase;
    const roundDuringLeave = state.round!.roundId;
    release();
    const result = await leave;
    expect(phaseDuringLeave).toBe('finished');
    expect(roundDuringLeave).toBe(roundId);
    expect(result.ok).toBe(true);
    expect(state.round!.result!.reason).toBe('five');
  });

  it('rejects readiness during a failing leave and can start normally after rollback', async () => {
    const { a, b, entry } = await joined();
    await ready(a, entry, null); await ready(b, entry, null);
    const state = game.store.rooms.get(entry.roomCode)!.state;
    const roundId = state.round!.roundId;
    for (let x = 0; x < 5; x++) {
      expect((await request(a, 'game:move', { actionId: id(), roomInstanceId: entry.roomInstanceId, baseVersion: 0, roundId, x, y: 0, expectedMoveNo: x * 2 })).ok).toBe(true);
      if (x < 4) expect((await request(b, 'game:move', { actionId: id(), roomInstanceId: entry.roomInstanceId, baseVersion: 0, roundId, x, y: 2, expectedMoveNo: x * 2 + 1 })).ok).toBe(true);
    }
    await ready(a, entry, roundId);
    const serverA = game.io.sockets.sockets.get(a.id!)!;
    const original = serverA.leave.bind(serverA);
    let rejectLeave!: (error: Error) => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((_resolve, reject) => { rejectLeave = reject; });
    serverA.leave = async () => { started(); await gate; };
    const leave = request(a, 'room:leave', { actionId: id(), roomInstanceId: entry.roomInstanceId, baseVersion: state.version, roundId });
    await begun;
    expect(await ready(b, entry, roundId)).toMatchObject({ ok: false, errorCode: 'GAME_PAUSED' });
    rejectLeave(new Error('Synthetic adapter failure'));
    expect(await leave).toMatchObject({ ok: false, errorCode: 'INTERNAL_ERROR' });
    expect(state.seats[1]?.ready).toBe(false);
    serverA.leave = original;
    expect((await ready(b, entry, roundId)).ok).toBe(true);
    expect(state.phase).toBe('playing');
    expect(state.round!.roundId).not.toBe(roundId);
  });

  it('rejects a superseded join after await and removes the old socket from broadcasts', async () => {
    const { a, b, bIdentity, entry } = await setup();
    const delay = delayJoin(b);
    let oldSnapshots = 0;
    b.on('room:snapshot', () => { oldSnapshots++; });
    const join = request(b, 'room:join', { actionId: id(), roomCode: entry.roomCode });
    await delay.begun;
    const replacement = await connect();
    await session(replacement, 'replacement', bIdentity);
    expect((await resume(replacement, entry)).ok).toBe(true);
    delay.release();
    expect(await join).toMatchObject({ ok: false, errorCode: 'SESSION_REPLACED' });
    expect(oldSnapshots).toBe(0);
    expect(delay.server.rooms.has(entry.roomInstanceId)).toBe(false);
    await ready(a, entry, null); await ready(replacement, entry, null);
    expect(game.store.rooms.get(entry.roomCode)!.state.phase).toBe('playing');
  });

  it('rejects a superseded resume after await without overwriting the new controller seat', async () => {
    const { b, bIdentity, entry } = await joined();
    b.disconnect();
    const old = await connect();
    await session(old, 'old', bIdentity);
    const delay = delayJoin(old);
    let oldSnapshots = 0;
    old.on('room:snapshot', () => { oldSnapshots++; });
    const pendingResume = resume(old, entry);
    await delay.begun;
    const replacement = await connect();
    await session(replacement, 'replacement', bIdentity);
    expect((await resume(replacement, entry)).ok).toBe(true);
    delay.release();
    expect(await pendingResume).toMatchObject({ ok: false, errorCode: 'SESSION_REPLACED' });
    expect(oldSnapshots).toBe(0);
    expect(delay.server.rooms.has(entry.roomInstanceId)).toBe(false);
    const state = game.store.rooms.get(entry.roomCode)!.state;
    expect(state.seats[1]).toMatchObject({ playerId: bIdentity.playerId, connected: true });
  });

  it('survives an old controller leave failure during session takeover', async () => {
    const { a, b, bIdentity, entry } = await joined();
    const oldServer = game.io.sockets.sockets.get(b.id!)!;
    oldServer.leave = async () => { throw new Error('Synthetic old membership failure'); };
    const replacement = await connect();
    const recovered = await session(replacement, 'replacement', bIdentity);
    expect(recovered.room).toEqual(entry);
    expect(oldServer.rooms.has(entry.roomInstanceId)).toBe(false);
    expect((await resume(replacement, entry)).ok).toBe(true);
    await ready(a, entry, null); await ready(replacement, entry, null);
    expect(game.store.rooms.get(entry.roomCode)!.state.phase).toBe('playing');
  });
});
