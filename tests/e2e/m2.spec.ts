import { test, expect, type Page, type BrowserContext } from '@playwright/test';

async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
  return (await page.getByTestId('room-code').textContent())!.trim();
}
async function joinRoom(page: Page, roomCode: string, nickname: string): Promise<void> {
  await page.goto(`/r/${roomCode}`);
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('join-room').click();
}
async function ready(first: Page, second: Page): Promise<void> {
  await expect(second.getByTestId('ready-button')).toBeVisible();
  await expect(second.getByTestId('ready-button')).toBeEnabled();
  await expect(first.getByTestId('ready-button')).toBeEnabled();
  await first.getByTestId('ready-button').click();
  await second.getByTestId('ready-button').click();
  await expect(first.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
  await expect(second.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
}
async function move(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.getByTestId('board-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not visible');
  const geometry = await canvas.evaluate((element) => ({ padding: Number((element as HTMLCanvasElement).dataset.padding), step: Number((element as HTMLCanvasElement).dataset.step) }));
  await page.mouse.click(box.x + geometry.padding + x * geometry.step, box.y + geometry.padding + y * geometry.step);
}
async function moves(pages: Page[], moveNo: number): Promise<void> {
  for (const page of pages) await expect(page.getByTestId('board-canvas')).toHaveAttribute('data-move-no', String(moveNo));
}
async function storedPlayerId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stored = localStorage.getItem('gomoku.identity.v1');
    return stored ? JSON.parse(stored).playerId : null;
  });
}
async function close(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(contexts.map((context) => context.close()));
}

test('refresh restores the same identity, room, board and turn from a complete snapshot', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage();
  const b = await contexts[1].newPage();
  try {
    const roomCode = await createRoom(a, '刷新玩家');
    await joinRoom(b, roomCode, '对手');
    await ready(a, b);
    await move(a, 7, 7); await moves([a, b], 1);
    await move(b, 8, 7); await moves([a, b], 2);
    const playerId = await storedPlayerId(a);
    const roundId = await a.getByTestId('board-canvas').getAttribute('data-round-id');
    await a.reload();
    await expect(a.getByTestId('room-code')).toHaveText(roomCode);
    await moves([a, b], 2);
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-round-id', roundId!);
    expect(await storedPlayerId(a)).toBe(playerId);
    await expect(a.getByTestId('status-message')).toContainText('轮到你');
    await move(a, 7, 8); await moves([a, b], 3);
  } finally { await close(contexts); }
});

test('DevTools slow network and offline preserve the board and reserved seat, then reconnect automatically', async ({ browser }) => {
  test.setTimeout(60_000);
  const contexts = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage();
  const b = await contexts[1].newPage();
  const third = await contexts[2].newPage();
  try {
    const roomCode = await createRoom(a, '在线玩家');
    await joinRoom(b, roomCode, '弱网玩家');
    await ready(a, b);
    await move(a, 7, 7); await moves([a, b], 1);
    await move(b, 8, 7); await moves([a, b], 2);
    const cdp = await contexts[1].newCDPSession(b);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 250, downloadThroughput: 64_000, uploadThroughput: 32_000 });
    await contexts[1].setOffline(true);
    await expect(a.getByTestId('status-message')).toContainText('掉线', { timeout: 20_000 });
    await expect(a.getByTestId('reconnect-countdown')).toBeVisible();
    await move(a, 4, 4); await moves([a], 2);
    await joinRoom(third, roomCode, '第三人');
    await expect(third.getByTestId('status-message')).toContainText('房间已满');
    await expect(third.getByTestId('board-canvas')).toBeHidden();
    await contexts[1].setOffline(false);
    await expect(b.getByTestId('room-code')).toHaveText(roomCode, { timeout: 20_000 });
    await expect(a.getByTestId('status-message')).toContainText('轮到你', { timeout: 20_000 });
    await moves([a, b], 2);
    await move(a, 7, 8); await moves([a, b], 3);
    await move(b, 8, 8); await moves([a, b], 4);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  } finally { await close(contexts); }
});

test('a second tab takes over one identity and the old tab cannot force a resignation', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage();
  const b = await contexts[1].newPage();
  try {
    const roomCode = await createRoom(a, '同浏览器玩家');
    await joinRoom(b, roomCode, '另一个玩家');
    await ready(a, b);
    await move(a, 7, 7); await moves([a, b], 1);
    await move(b, 8, 7); await moves([a, b], 2);
    const playerId = await storedPlayerId(a);
    const takeover = await contexts[0].newPage();
    await takeover.goto(`/r/${roomCode}`);
    await expect(takeover.getByTestId('room-code')).toHaveText(roomCode);
    await expect(a.getByTestId('status-message')).toContainText(/接管|其他窗口|其他标签/);
    await expect(a.getByTestId('leave-button')).toBeDisabled();
    expect(await storedPlayerId(takeover)).toBe(playerId);
    await a.close();
    await move(takeover, 7, 8); await moves([takeover, b], 3);
    await expect(b.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
  } finally { await close(contexts); }
});

test('same players start another round only after both agree and exchange black and white', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage();
  const b = await contexts[1].newPage();
  try {
    const roomCode = await createRoom(a, '原黑棋');
    await joinRoom(b, roomCode, '原白棋');
    await ready(a, b);
    const previousRoundId = await a.getByTestId('board-canvas').getAttribute('data-round-id');
    for (let x = 0; x < 5; x++) {
      await move(a, x, 0); await moves([a, b], x * 2 + 1);
      if (x < 4) { await move(b, x, 2); await moves([a, b], x * 2 + 2); }
    }
    await expect(a.getByTestId('result-message')).toContainText(/赢|胜/);
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'drawing');
    await a.getByTestId('drawing-skip').click();
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    await a.getByTestId('ready-button').click();
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    await b.getByTestId('ready-button').click();
    await moves([a, b], 0);
    await expect(a.getByTestId('board-canvas')).not.toHaveAttribute('data-round-id', previousRoundId!);
    await expect(a.locator('[data-seat="A"] .seat-color')).toHaveText('白棋');
    await expect(b.locator('[data-seat="B"] .seat-color')).toHaveText('黑棋');
    await expect(b.getByTestId('status-message')).toContainText('轮到你');
    await move(b, 7, 7); await moves([a, b], 1);
  } finally { await close(contexts); }
});

test('actively leaving resigns, frees the seat and lets a new player start a fresh-color game', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage();
  const b = await contexts[1].newPage();
  const replacement = await contexts[2].newPage();
  try {
    const roomCode = await createRoom(a, '离开的黑棋');
    await joinRoom(b, roomCode, '留下的白棋');
    await ready(a, b);
    await move(a, 7, 7); await moves([a, b], 1);
    a.once('dialog', (dialog) => dialog.accept());
    await a.getByTestId('leave-button').click();
    await expect(a.getByTestId('board-canvas')).toBeHidden();
    await expect(b.getByTestId('result-message')).toContainText(/赢|胜/);
    expect(await a.evaluate(() => localStorage.getItem('gomoku.room.v1'))).toBeNull();
    await joinRoom(replacement, roomCode, '新玩家');
    await expect(replacement.getByTestId('result-message')).not.toContainText(/你输了|本局失利|负：/);
    await expect(b.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'drawing');
    await b.getByTestId('drawing-skip').click();
    await ready(b, replacement);
    await expect(replacement.locator('[data-seat="A"] .seat-color')).toHaveText('黑棋');
    await expect(b.locator('[data-seat="B"] .seat-color')).toHaveText('白棋');
    await move(replacement, 7, 7); await moves([replacement, b], 1);
  } finally { await close(contexts); }
});

test('real 60-second grace permits waiting or claiming victory, but never automatically frees the seat', async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage();
  const b = await contexts[1].newPage();
  const third = await contexts[2].newPage();
  try {
    const roomCode = await createRoom(a, '等待的玩家');
    await joinRoom(b, roomCode, '掉线的玩家');
    await ready(a, b);
    await move(a, 7, 7); await moves([a, b], 1);
    await contexts[1].setOffline(true);
    await expect(a.getByTestId('status-message')).toContainText('掉线', { timeout: 20_000 });
    await expect(a.getByTestId('claim-win-button')).toBeHidden();
    await expect(a.getByTestId('claim-win-button')).toBeVisible({ timeout: 70_000 });
    await joinRoom(third, roomCode, '待加入玩家');
    await expect(third.getByTestId('status-message')).toContainText('房间已满');
    await a.getByTestId('keep-waiting-button').click();
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
    await a.getByTestId('claim-win-button').click();
    await expect(a.getByTestId('result-message')).toContainText(/赢|胜/);
    await third.goto(`/r/${roomCode}`);
    await expect(third.getByTestId('join-room')).toBeEnabled();
    await third.getByTestId('join-room').click();
    await expect(third.getByTestId('room-code')).toHaveText(roomCode);
    await expect(third.getByTestId('result-message')).not.toContainText(/你输了|本局失利|负：/);
    await contexts[1].setOffline(false);
    await expect(b.getByTestId('board-canvas')).toBeHidden({ timeout: 20_000 });
  } finally { await close(contexts); }
});
