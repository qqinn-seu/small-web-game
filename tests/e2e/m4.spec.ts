import { test, expect, type Page, type BrowserContext } from '@playwright/test';

async function create(page: Page, name: string) {
  await page.goto('/'); await page.getByTestId('nickname-input').fill(name); await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
  return (await page.getByTestId('room-code').textContent())!;
}
async function join(page: Page, code: string, name: string) {
  await page.goto(`/r/${code}`); await page.getByTestId('nickname-input').fill(name); await page.getByTestId('join-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(code);
}
async function ready(a: Page, b: Page) {
  await expect(b.getByTestId('ready-button')).toBeEnabled();
  await a.getByTestId('ready-button').click(); await b.getByTestId('ready-button').click();
  await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
  await expect(b.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'playing');
}
async function move(page: Page, x: number, y: number, pages: Page[], count: number) {
  const canvas = page.getByTestId('board-canvas'); await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const geo = await canvas.evaluate((node) => ({ padding: Number((node as HTMLCanvasElement).dataset.padding), step: Number((node as HTMLCanvasElement).dataset.step) }));
  await page.mouse.click(box.x + geo.padding + x * geo.step, box.y + geo.padding + y * geo.step);
  for (const p of pages) await expect(p.getByTestId('board-canvas')).toHaveAttribute('data-move-no', String(count));
}
async function win(a: Page, b: Page) {
  for (let x = 0; x < 5; x++) {
    await move(a, x, 0, [a, b], x * 2 + 1);
    if (x < 4) await move(b, x, 2, [a, b], x * 2 + 2);
  }
  await expect(a.getByTestId('drawing-canvas')).toBeVisible();
}
async function id(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('gomoku.identity.v1')!).playerId as string);
}
function character(page: Page, playerId: string) {
  return page.locator(`[data-testid="character-canvas"][data-player-id="${playerId}"]`);
}
async function soundCount(page: Page, cue: string) {
  return Number(await page.getByTestId('mute-button').getAttribute(`data-played-${cue}`));
}
async function point(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('drawing-canvas'); await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  return { x: box.x + box.width * (x + 0.5) / 32, y: box.y + box.height * (y + 0.5) / 32 };
}
async function close(contexts: BrowserContext[]) { await Promise.all(contexts.map((context) => context.close())); }

test('desktop characters flank the board, show all gameplay states and keep doodles throughout animation', async ({ browser }, info) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const code = await create(a, '绿衣棋友'); await join(b, code, '白衣棋友');
    const aId = await id(a); const bId = await id(b);
    await expect(character(a, aId)).toHaveAttribute('data-state', 'idle');
    const left = (await character(a, aId).boundingBox())!; const right = (await character(a, bId).boundingBox())!;
    const board = (await a.getByTestId('board-canvas').boundingBox())!;
    expect(left.x + left.width).toBeLessThanOrEqual(board.x);
    expect(right.x).toBeGreaterThanOrEqual(board.x + board.width);
    await ready(a, b);
    await expect(character(a, aId)).toHaveAttribute('data-state', 'thinking');
    await move(a, 0, 0, [a, b], 1);
    await expect(character(a, bId)).toHaveAttribute('data-state', 'watching');
    await expect(character(a, bId)).toHaveAttribute('data-state', 'thinking', { timeout: 4_000 });
    await expect.poll(() => soundCount(a, 'stone')).toBe(1);
    await expect.poll(() => soundCount(b, 'stone')).toBe(1);
    await expect.poll(() => soundCount(b, 'turn')).toBeGreaterThan(0);
    await move(b, 0, 2, [a, b], 2);
    for (let x = 1; x < 5; x++) {
      await move(a, x, 0, [a, b], x * 2 + 1);
      if (x < 4) await move(b, x, 2, [a, b], x * 2 + 2);
    }
    await expect(character(a, aId)).toHaveAttribute('data-state', 'cheering');
    await expect.poll(() => soundCount(a, 'win')).toBe(1);
    await expect.poll(() => soundCount(b, 'lose')).toBe(1);
    const start = await point(a, 4, 10); await a.mouse.move(start.x, start.y); await a.mouse.down();
    for (const x of [8, 12, 16]) { const p = await point(a, x, 10); await a.mouse.move(p.x, p.y); await a.waitForTimeout(80); }
    await expect(character(b, bId)).toHaveAttribute('data-state', 'being-drawn');
    await expect.poll(() => soundCount(b, 'brush')).toBeGreaterThan(0);
    await a.mouse.up();
    await expect(character(b, bId)).toHaveAttribute('data-state', 'defiant');
    await expect.poll(async () => Number(await character(b, bId).getAttribute('data-confirmed-pixel-count'))).toBeGreaterThan(0);
    const hash = await character(b, bId).getAttribute('data-face-hash');
    await b.waitForTimeout(450);
    expect(await character(b, bId).getAttribute('data-face-hash')).toBe(hash);
    expect(await soundCount(a, 'win')).toBe(1); expect(await soundCount(b, 'lose')).toBe(1);
    await expect(a.getByTestId('status-message')).toContainText('本局已经结束');
    await a.screenshot({ path: info.outputPath('m4-desktop-characters.png'), fullPage: true });
  } finally { await close(contexts); }
});

test('mute persists across refresh, restored results are silent, and only future confirmed moves sound', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const code = await create(a, '静音玩家'); await join(b, code, '声音玩家'); await ready(a, b); await win(a, b);
    await a.getByTestId('drawing-skip').click();
    await a.getByTestId('mute-button').click();
    await expect(a.getByTestId('mute-button')).toHaveAttribute('data-muted', 'true');
    await a.reload();
    await expect(a.getByTestId('ready-button')).toBeEnabled();
    await expect(a.getByTestId('mute-button')).toHaveAttribute('data-muted', 'true');
    for (const cue of ['stone', 'turn', 'win', 'lose', 'brush']) expect(await soundCount(a, cue)).toBe(0);
    await a.getByTestId('mute-button').click();
    await expect(a.getByTestId('mute-button')).toHaveAttribute('data-muted', 'false');
    await expect(a.getByTestId('mute-button')).toHaveAttribute('data-audio-unlocked', 'true');
    expect(await soundCount(a, 'win')).toBe(0);
    await ready(a, b);
    await move(b, 7, 7, [a, b], 1);
    await expect.poll(() => soundCount(a, 'stone')).toBe(1);
    await expect.poll(() => soundCount(a, 'turn')).toBe(1);
    expect(await soundCount(a, 'win')).toBe(0);
  } finally { await close(contexts); }
});

test('mobile reduced-motion characters stay above the board and touch drawing remains usable', async ({ browser }, info) => {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const desktop = await browser.newContext(); const a = await mobile.newPage(); const b = await desktop.newPage();
  try {
    const code = await create(a, '手机棋友'); await join(b, code, '桌面棋友'); await ready(a, b);
    const board = (await a.getByTestId('board-canvas').boundingBox())!;
    for (const canvas of await a.getByTestId('character-canvas').all()) {
      await expect(canvas).toHaveAttribute('data-reduced-motion', 'true');
      expect((await canvas.boundingBox())!.y).toBeLessThan(board.y);
    }
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await win(a, b);
    const cdp = await mobile.newCDPSession(a); const start = await point(a, 4, 12);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (const x of [8, 12, 17]) { const p = await point(a, x, 12); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] }); await a.waitForTimeout(80); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(a.getByTestId('board-canvas')).toHaveAttribute('data-phase', 'finished');
    await expect.poll(async () => Number(await character(a, await id(b)).getAttribute('data-confirmed-pixel-count'))).toBeGreaterThan(0);
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: info.outputPath('m4-mobile-touch.png'), fullPage: true });
  } finally { await close([mobile, desktop]); }
});

test('a takeover snapshot makes no historical sounds and the old controller cannot play future events', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(); const b = await contexts[1].newPage();
  try {
    const code = await create(a, '被接管棋友'); await join(b, code, '另一棋友'); await ready(a, b);
    await move(a, 0, 0, [a, b], 1); await move(b, 0, 2, [a, b], 2);
    const oldCount = await soundCount(a, 'stone');
    const replacement = await contexts[0].newPage(); await replacement.goto(`/r/${code}`);
    await expect(replacement.getByTestId('board-canvas')).toHaveAttribute('data-move-no', '2');
    await expect(a.getByTestId('status-message')).toContainText('接管');
    for (const cue of ['stone', 'turn', 'win', 'lose', 'brush']) expect(await soundCount(replacement, cue)).toBe(0);
    await move(replacement, 1, 0, [replacement, b], 3);
    await expect.poll(() => soundCount(replacement, 'stone')).toBe(1);
    await a.bringToFront();
    await move(b, 1, 2, [replacement, b], 4);
    expect(await soundCount(a, 'stone')).toBe(oldCount);
  } finally { await close(contexts); }
});
