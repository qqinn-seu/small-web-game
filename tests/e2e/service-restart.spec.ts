import { test, expect } from '@playwright/test';
import { createGameServer, type GameServer } from '../../server/src/app.js';

async function listen(game: GameServer, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    game.httpServer.once('error', reject);
    game.httpServer.listen(port, '127.0.0.1', resolve);
  });
  const address = game.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return address.port;
}

test('an in-memory service restart expires the old identity and room instead of pretending to recover', async ({ browser }) => {
  test.setTimeout(45_000);
  let game = createGameServer({ serveStatic: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const port = await listen(game, 0);
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByTestId('nickname-input').fill('重启测试玩家');
    await page.getByTestId('create-room').click();
    await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
    const oldCode = await page.getByTestId('room-code').textContent();
    const oldIdentityId = await page.evaluate(() => JSON.parse(localStorage.getItem('gomoku.identity.v1')!).playerId as string);
    await game.close();
    game = createGameServer({ serveStatic: true });
    await listen(game, port);
    await expect(page.getByTestId('status-message')).toContainText(/失效|重启/, { timeout: 20_000 });
    await expect(page.getByTestId('board-canvas')).toBeHidden();
    await expect(page.getByTestId('nickname-input')).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('gomoku.room.v1'))).toBeNull();
    await page.getByTestId('nickname-input').fill('重新开始玩家');
    await page.getByTestId('create-room').click();
    await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
    expect(await page.getByTestId('room-code').textContent()).not.toBe(oldCode);
    const newIdentityId = await page.evaluate(() => JSON.parse(localStorage.getItem('gomoku.identity.v1')!).playerId as string);
    expect(newIdentityId).not.toBe(oldIdentityId);
  } finally {
    await context.close();
    await game.close();
  }
});
