import { test, expect, type Page, type BrowserContext } from '@playwright/test';

async function create(page: Page, nickname: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
  return (await page.getByTestId('room-code').textContent())!;
}
async function join(page: Page, roomCode: string, nickname?: string): Promise<void> {
  await page.goto(`/r/${roomCode}`);
  if (nickname) await page.getByTestId('nickname-input').fill(nickname);
  await expect(page.getByTestId('join-room')).toBeEnabled();
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(roomCode);
}
async function ready(first: Page, second: Page): Promise<void> {
  await expect(second.getByTestId('ready-button')).toBeVisible();
  await expect(second.getByTestId('ready-button')).toBeEnabled();
  await first.getByTestId('ready-button').click();
  await second.getByTestId('ready-button').click();
  await expect(first.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
  await expect(second.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
}
async function move(page: Page, x: number, y: number, pages: Page[], moveNo: number): Promise<void> {
  const canvas = page.getByTestId('board-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const geometry = await canvas.evaluate((element) => ({ padding: Number((element as HTMLCanvasElement).dataset.padding), step: Number((element as HTMLCanvasElement).dataset.step) }));
  await page.mouse.click(box.x + geometry.padding + x * geometry.step, box.y + geometry.padding + y * geometry.step);
  for (const other of pages) await expect(other.getByTestId('board-canvas')).toHaveAttribute('data-move-no', String(moveNo));
}
async function winBlack(black: Page, white: Page): Promise<void> {
  for (let x = 0; x < 5; x++) {
    await move(black, x, 0, [black, white], x * 2 + 1);
    if (x < 4) await move(white, x, 2, [black, white], x * 2 + 2);
  }
  await expect(black.getByTestId('drawing-canvas')).toBeVisible();
  await expect(white.getByTestId('drawing-canvas')).toBeVisible();
}
async function identity(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('gomoku.identity.v1')!).playerId as string);
}
async function atFace(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('drawing-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  return { x: box.x + ((x + 0.5) / 32) * box.width, y: box.y + ((y + 0.5) / 32) * box.height };
}
async function beginLine(page: Page, y = 10): Promise<void> {
  const start = await atFace(page, 4, y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const x of [7, 11, 16]) {
    const point = await atFace(page, x, y);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(80);
  }
}
async function draftCount(page: Page): Promise<number> {
  return Number(await page.getByTestId('drawing-canvas').getAttribute('data-draft-point-count'));
}
function face(page: Page, playerId: string) {
  return page.locator(`[data-testid="face-canvas"][data-player-id="${playerId}"]`);
}
async function pixelCount(page: Page, playerId: string): Promise<number> {
  return Number(await face(page, playerId).getAttribute('data-confirmed-pixel-count'));
}
async function close(contexts: BrowserContext[]) {
  await Promise.all(contexts.map((context) => context.close()));
}

test('real-time stroke is confirmed on release, accumulates across swapped-color rounds and washes only with two votes', async ({ browser }, testInfo) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const room = await create(a, '画笔赢家'); await join(b, room, '像素输家'); await ready(a, b);
    const aId = await identity(a); const bId = await identity(b);
    await winBlack(a, b);
    await expect(a.getByTestId('drawing-canvas')).toHaveAttribute('data-owner-player-id', bId);
    await expect(b.getByTestId('drawing-canvas')).toHaveAttribute('data-can-draw', 'false');
    await a.getByTestId('brush-color-1').click();
    await beginLine(a);
    await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    expect(await pixelCount(b, bId)).toBe(0);
    await a.mouse.up();
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    await expect.poll(() => pixelCount(b, bId)).toBeGreaterThan(0);
    const firstPixels = await pixelCount(b, bId);
    expect(await pixelCount(a, bId)).toBe(firstPixels);
    await ready(a, b);
    for (let x = 0; x < 5; x++) {
      await move(b, x * 2, 3, [a, b], x * 2 + 1);
      await move(a, x, 1, [a, b], x * 2 + 2);
    }
    await expect(a.getByTestId('drawing-canvas')).toHaveAttribute('data-owner-player-id', bId);
    await a.getByTestId('brush-color-2').click(); await beginLine(a, 18); await a.mouse.up();
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    await expect.poll(() => pixelCount(b, bId)).toBeGreaterThan(firstPixels);
    const accumulated = await pixelCount(b, bId);
    await a.getByTestId('wash-button').click();
    await expect(b.getByTestId('wash-accept')).toBeVisible();
    expect(await pixelCount(b, bId)).toBe(accumulated);
    await b.getByTestId('wash-accept').click();
    await expect.poll(() => pixelCount(b, bId)).toBe(0);
    await expect.poll(() => pixelCount(a, aId)).toBe(0);
    await a.screenshot({ path: testInfo.outputPath('m3-washed-desktop.png'), fullPage: true });
  } finally { await close(contexts); }
});

test('mobile touch draws one snapped stroke and the other player sees the confirmed face', async ({ browser }, testInfo) => {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const desktop = await browser.newContext();
  const a = await mobile.newPage(); const b = await desktop.newPage();
  try {
    const room = await create(a, '触摸赢家'); await join(b, room, '桌面对手'); await ready(a, b); await winBlack(a, b);
    const targetId = await identity(b);
    const cdp = await mobile.newCDPSession(a);
    const start = await atFace(a, 4, 12);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (const x of [8, 12, 17]) {
      const point = await atFace(a, x, 12);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
      await a.waitForTimeout(80);
    }
    await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => pixelCount(b, targetId)).toBeGreaterThan(0);
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await a.screenshot({ path: testInfo.outputPath('m3-touch-confirmed.png'), fullPage: true });
  } finally { await close([mobile, desktop]); }
});

test('loser refresh during drawing restores the draft but does not archive it until the winner releases', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const room = await create(a, '绘画赢家'); await join(b, room, '刷新输家'); await ready(a, b); await winBlack(a, b);
    const targetId = await identity(b);
    await beginLine(a); await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    await b.reload();
    await expect(b.getByTestId('drawing-canvas')).toBeVisible();
    await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    expect(await pixelCount(b, targetId)).toBe(0);
    await a.mouse.up(); await expect.poll(() => pixelCount(b, targetId)).toBeGreaterThan(0);
  } finally { await close(contexts); }
});

test('winner refresh cannot start a second stroke or invent release, and skip discards the restored draft', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const room = await create(a, '刷新赢家'); await join(b, room, '等待输家'); await ready(a, b); await winBlack(a, b);
    const targetId = await identity(b);
    await beginLine(a); await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    await a.reload(); await a.mouse.up();
    await expect(a.getByTestId('drawing-canvas')).toHaveAttribute('data-can-draw', 'false');
    await expect.poll(() => draftCount(a)).toBeGreaterThan(1);
    const before = await draftCount(a);
    const point = await atFace(a, 25, 22);
    await a.mouse.click(point.x, point.y);
    expect(await draftCount(a)).toBe(before);
    expect(await pixelCount(b, targetId)).toBe(0);
    await a.getByTestId('drawing-skip').click();
    await expect(b.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    expect(await pixelCount(b, targetId)).toBe(0);
  } finally { await close(contexts); }
});

test('a newcomer does not inherit the resigned loser target and the original identity can later recover its doodled face', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage(); const c = await contexts[2].newPage();
  try {
    const room = await create(a, '留下的赢家'); await join(b, room, '原输家'); await ready(a, b);
    const bId = await identity(b);
    await move(a, 7, 7, [a, b], 1);
    b.once('dialog', (dialog) => dialog.accept()); await b.getByTestId('leave-button').click();
    await expect(b.getByTestId('board-canvas')).toBeHidden();
    await join(c, room, '新玩家');
    const cId = await identity(c);
    await expect(c.getByTestId('drawing-canvas')).toHaveAttribute('data-owner-player-id', bId);
    await expect(c.getByTestId('drawing-canvas')).toHaveAttribute('data-can-draw', 'false');
    await expect(c.getByTestId('ready-button')).toBeHidden();
    expect(await pixelCount(c, cId)).toBe(0);
    await beginLine(a); await a.mouse.up();
    await expect(c.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    expect(await pixelCount(c, cId)).toBe(0);
    await c.getByTestId('leave-button').click();
    await expect(c.getByTestId('board-canvas')).toBeHidden();
    await join(b, room);
    expect(await identity(b)).toBe(bId);
    await expect.poll(() => pixelCount(b, bId)).toBeGreaterThan(0);
  } finally { await close(contexts); }
});

test('winner leaving while the pointer is held abandons the draft without changing the existing result', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const room = await create(a, '离开赢家'); await join(b, room, '留守输家'); await ready(a, b); await winBlack(a, b);
    const targetId = await identity(b);
    await beginLine(a); await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    await a.getByTestId('leave-button').focus(); await a.keyboard.press('Enter');
    await expect(a.getByTestId('board-canvas')).toBeHidden();
    await expect(b.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    await expect(b.getByTestId('result-message')).toContainText(/失利|输|负/);
    expect(await pixelCount(b, targetId)).toBe(0);
    await a.mouse.up();
  } finally { await close(contexts); }
});

test('same-page real release while offline submits the preserved final points after authenticated recovery', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const room = await create(a, '补交赢家'); await join(b, room, '在线对手'); await ready(a, b); await winBlack(a, b);
    const targetId = await identity(b);
    await beginLine(a); await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    await contexts[0].setOffline(true);
    const finalPoint = await atFace(a, 25, 18);
    await a.mouse.move(finalPoint.x, finalPoint.y);
    await a.mouse.up();
    expect(await pixelCount(b, targetId)).toBe(0);
    await contexts[0].setOffline(false);
    await expect(b.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished', { timeout: 15_000 });
    await expect.poll(() => pixelCount(b, targetId)).toBeGreaterThan(0);
    expect(await pixelCount(a, targetId)).toBe(await pixelCount(b, targetId));
  } finally { await close(contexts); }
});

test('real 20-second drawing deadline continues while the winner is offline and discards an unconfirmed stroke', async ({ browser }) => {
  test.setTimeout(45_000);
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const room = await create(a, '离线赢家'); await join(b, room, '在线输家'); await ready(a, b); await winBlack(a, b);
    const targetId = await identity(b);
    await beginLine(a); await expect.poll(() => draftCount(b)).toBeGreaterThan(1);
    await contexts[0].setOffline(true);
    await expect(b.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished', { timeout: 25_000 });
    expect(await pixelCount(b, targetId)).toBe(0);
    await contexts[0].setOffline(false);
    await expect(a.getByTestId('ready-button')).toBeVisible({ timeout: 15_000 });
    await a.mouse.up();
    expect(await pixelCount(a, targetId)).toBe(0);
  } finally { await close(contexts); }
});
