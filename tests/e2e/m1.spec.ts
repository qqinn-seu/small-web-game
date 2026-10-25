import { test, expect, type Page } from '@playwright/test';

async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('create-room').click();
  const code = page.getByTestId('room-code');
  await expect(code).toHaveText(/^[A-Z0-9]{6}$/);
  return (await code.textContent())!.trim();
}

async function joinRoom(page: Page, code: string, nickname: string) {
  await page.goto(`/r/${code}`);
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('join-room').click();
}

async function startRound(first: Page, second: Page) {
  await expect(first.getByTestId('player-name')).toHaveCount(2);
  await expect(second.getByTestId('player-name')).toHaveCount(2);
  await first.getByTestId('ready-button').click();
  await second.getByTestId('ready-button').click();
  await expect(first.getByTestId('status-message')).toContainText(/轮到/);
  await expect(second.getByTestId('status-message')).toContainText(/轮到|等待/);
}

async function playAt(page: Page, x: number, y: number, touch = false) {
  const canvas = page.getByTestId('board-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board is not visible');
  const geometry = await canvas.evaluate((node) => {
    const el = node as HTMLCanvasElement;
    return { padding: Number(el.dataset.padding), step: Number(el.dataset.step) };
  });
  if (!(geometry.step > 0)) throw new Error('Missing board geometry');
  const target = {
    x: box.x + geometry.padding + x * geometry.step,
    y: box.y + geometry.padding + y * geometry.step,
  };
  if (touch) await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.click(target.x, target.y);
}

async function expectMoveNo(pages: Page[], moveNo: number) {
  for (const page of pages) {
    await expect(page.getByTestId('board-canvas')).toHaveAttribute('data-move-no', String(moveNo));
  }
}

test('two isolated browser players finish a real game; third player sees room full', async ({ browser }, testInfo) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [first, second, third] = await Promise.all(contexts.map((context) => context.newPage()));
  const errors: string[] = [];
  for (const page of [first, second, third]) page.on('pageerror', (error) => errors.push(error.message));
  const thirdFrames: string[] = [];
  third.on('websocket', (socket) => socket.on('framereceived', (event) => thirdFrames.push(String(event.payload))));
  try {
    const roomCode = await createRoom(first, '黑棋玩家');
    await joinRoom(second, roomCode, '白棋玩家');
    await expect(first.getByTestId('player-name')).toHaveCount(2);
    await joinRoom(third, roomCode, '第三玩家');
    await expect(third.getByTestId('status-message')).toContainText('房间已满');
    await expect(third.getByRole('button', { name: '创建新房间', exact: true })).toBeVisible();
    await expect(third.getByTestId('board-canvas')).toBeHidden();
    await startRound(first, second);
    for (let x = 0; x < 5; x++) {
      await playAt(first, x, 0);
      await expectMoveNo([first, second], x * 2 + 1);
      if (x < 4) {
        await playAt(second, x, 2);
        await expectMoveNo([first, second], x * 2 + 2);
      }
    }
    await expect(first.getByTestId('result-message')).toContainText(/胜|赢/);
    await expect(second.getByTestId('result-message')).toContainText(/输|负|败|胜/);
    await playAt(first, 8, 8);
    await expectMoveNo([first, second], 9);
    expect(thirdFrames.some((frame) => /room:snapshot|room:patch/.test(frame))).toBe(false);
    expect(errors).toEqual([]);
    await first.screenshot({ path: testInfo.outputPath('desktop-winner.png'), fullPage: true });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('mobile touch player can join and make a server-confirmed move', async ({ browser }, testInfo) => {
  const desktop = await browser.newContext();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const first = await desktop.newPage();
  const second = await mobile.newPage();
  try {
    const roomCode = await createRoom(first, '桌面玩家');
    await joinRoom(second, roomCode, '手机玩家');
    await startRound(first, second);
    await playAt(first, 7, 7);
    await expectMoveNo([first, second], 1);
    await playAt(second, 8, 7, true);
    await expectMoveNo([first, second], 2);
    const fits = await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(fits).toBe(true);
    await second.screenshot({ path: testInfo.outputPath('mobile-board.png'), fullPage: true });
  } finally {
    await desktop.close();
    await mobile.close();
  }
});
