import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createGameServer, type GameServer } from '../../server/src/app.js';
import type { AckResult } from '../../shared/protocol.js';

let game: GameServer;
let socket: Socket;
function request(event: string, payload: object): Promise<AckResult<any>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
beforeEach(async () => {
  game = createGameServer({ serveStatic: false });
  await new Promise<void>((resolve) => game.httpServer.listen(0, '127.0.0.1', resolve));
  const address = game.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  socket = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const opened = await request('session:open', { actionId: 'open-id-001', protocolVersion: 1, tabId: 'test-tab-001', nickname: '测试玩家' });
  expect(opened.ok).toBe(true);
});
afterEach(async () => {
  socket.disconnect();
  await game.close();
});
describe('actionId protocol guarantees', () => {
  it('returns exactly the same success for concurrent identical creates without creating extra rooms', async () => {
    const payload = { actionId: 'concurrent-create-001' };
    const [first, second] = await Promise.all([request('room:create', payload), request('room:create', payload)]);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(game.store.rooms.size).toBe(1);
  });
  it('rejects reusing one actionId for a different message name', async () => {
    const created = await request('room:create', { actionId: 'cross-event-action-001' });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.data) throw new Error('Creation failed');
    const reused = await request('round:ready', {
      actionId: 'cross-event-action-001', roomInstanceId: created.data.roomInstanceId,
      baseVersion: 1, roundId: null, ready: true,
    });
    expect(reused).toMatchObject({ ok: false, errorCode: 'ACTION_ID_REUSED' });
  });
});
