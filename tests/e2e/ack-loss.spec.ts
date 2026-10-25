import { test, expect, type Page } from '@playwright/test';
import { createGameServer, type GameServer } from '../../server/src/app.js';

async function listen(game: GameServer): Promise<string> {
  await new Promise<void>((resolve) => game.httpServer.listen(0, '127.0.0.1', resolve));
  const address = game.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}
async function create(page: Page, origin: string): Promise<string> {
  await page.goto(origin);
  await page.getByTestId('nickname-input').fill('确认丢失测试');
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
  return (await page.getByTestId('room-code').textContent())!;
}
async function playerId(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('gomoku.identity.v1')!).playerId as string);
}

test('all leave ACKs lost still reconcile a released seat and allow a new room', async ({ browser }) => {
  test.setTimeout(45_000);
  const game = createGameServer({ serveStatic: true });
  let drops = 3;
  game.io.on('connection', (socket) => {
    socket.use((packet, next) => {
      if (packet[0] === 'room:leave' && drops > 0) {
        drops--;
        packet[packet.length - 1] = () => {};
      }
      next();
    });
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const oldRoom = await create(page, await listen(game));
    const identity = await playerId(page);
    await page.getByTestId('leave-button').click();
    await expect(page.getByTestId('board-canvas')).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('create-room')).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('gomoku.room.v1'))).toBeNull();
    expect(await playerId(page)).toBe(identity);
    await page.getByTestId('create-room').click();
    await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
    expect(await page.getByTestId('room-code').textContent()).not.toBe(oldRoom);
    expect(drops).toBe(0);
  } finally { await context.close(); await game.close(); }
});

test('all resume ACKs and resume snapshots lost recover via a complete backup sync', async ({ browser }) => {
  test.setTimeout(45_000);
  const game = createGameServer({ serveStatic: true });
  let simulateLoss = false;
  let droppedAcks = 0;
  game.io.on('connection', (socket) => {
    let suppressResumeSnapshot = false;
    const emitter = socket as unknown as { emit: (event: string, ...args: any[]) => unknown };
    const originalEmit = emitter.emit.bind(socket);
    emitter.emit = (event, ...args) => {
      if (event === 'room:snapshot' && suppressResumeSnapshot) return false;
      return originalEmit(event, ...args);
    };
    socket.use((packet, next) => {
      if (simulateLoss && packet[0] === 'room:resume') {
        suppressResumeSnapshot = true;
        droppedAcks++;
        packet[packet.length - 1] = () => {};
      }
      if (packet[0] === 'room:sync') suppressResumeSnapshot = false;
      next();
    });
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const roomCode = await create(page, await listen(game));
    const identity = await playerId(page);
    simulateLoss = true;
    await page.reload();
    await expect(page.getByTestId('room-code')).toHaveText(roomCode, { timeout: 25_000 });
    await expect(page.getByTestId('ready-button')).toBeEnabled();
    expect(await playerId(page)).toBe(identity);
    expect(droppedAcks).toBe(3);
  } finally { await context.close(); await game.close(); }
});

test('all restored-auth ACKs lost retry a new connection with the same saved identity', async ({ browser }) => {
  test.setTimeout(45_000);
  const game = createGameServer({ serveStatic: true });
  let authDrops = 0;
  game.io.on('connection', (socket) => {
    socket.use((packet, next) => {
      if (packet[0] === 'session:open' && authDrops > 0) {
        authDrops--;
        packet[packet.length - 1] = () => {};
      }
      next();
    });
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const roomCode = await create(page, await listen(game));
    const identity = await playerId(page);
    authDrops = 3;
    await page.reload();
    await expect(page.getByTestId('room-code')).toHaveText(roomCode, { timeout: 25_000 });
    await expect(page.getByTestId('ready-button')).toBeEnabled();
    expect(await playerId(page)).toBe(identity);
    expect(authDrops).toBe(0);
  } finally { await context.close(); await game.close(); }
});
