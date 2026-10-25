import { BOARD_CELLS, BOARD_SIZE } from '../../../shared/constants.js';
import type { Cell, Point } from '../../../shared/models.js';

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export function boardIndex(x: number, y: number): number {
  return y * BOARD_SIZE + x;
}

export function isInBounds(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

/**
 * Returns the complete contiguous line containing the most recently placed
 * stone, rather than trimming an overline down to five cells.
 */
export function winningLineForMove(
  board: readonly Cell[],
  x: number,
  y: number,
  color: 1 | 2,
): Point[] | null {
  for (const [dx, dy] of DIRECTIONS) {
    const before: Point[] = [];
    let cursorX = x - dx;
    let cursorY = y - dy;

    while (isInBounds(cursorX, cursorY) && board[boardIndex(cursorX, cursorY)] === color) {
      before.unshift({ x: cursorX, y: cursorY });
      cursorX -= dx;
      cursorY -= dy;
    }

    const after: Point[] = [];
    cursorX = x + dx;
    cursorY = y + dy;
    while (isInBounds(cursorX, cursorY) && board[boardIndex(cursorX, cursorY)] === color) {
      after.push({ x: cursorX, y: cursorY });
      cursorX += dx;
      cursorY += dy;
    }

    const line = [...before, { x, y }, ...after];
    if (line.length >= 5) {
      return line;
    }
  }

  return null;
}

export function isBoardFull(board: readonly Cell[]): boolean {
  return board.length === BOARD_CELLS && board.every((cell) => cell !== 0);
}
