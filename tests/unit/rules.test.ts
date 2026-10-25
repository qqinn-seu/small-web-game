import { describe, expect, it } from 'vitest';

import { BOARD_CELLS, BOARD_SIZE } from '../../shared/constants.js';
import type { Cell } from '../../shared/models.js';
import { boardIndex, isBoardFull, winningLineForMove } from '../../server/src/domain/rules.js';

function emptyBoard(): Cell[] {
  return Array<Cell>(BOARD_CELLS).fill(0);
}

function place(board: Cell[], points: Array<[number, number]>, color: 1 | 2): void {
  for (const [x, y] of points) board[boardIndex(x, y)] = color;
}

describe('winningLineForMove', () => {
  it('recognizes a horizontal five', () => {
    const board = emptyBoard();
    place(board, [[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]], 1);
    expect(winningLineForMove(board, 7, 7, 1)).toEqual([
      { x: 3, y: 7 }, { x: 4, y: 7 }, { x: 5, y: 7 }, { x: 6, y: 7 }, { x: 7, y: 7 },
    ]);
  });

  it('recognizes a vertical five touching the board edge', () => {
    const board = emptyBoard();
    place(board, [[14, 10], [14, 11], [14, 12], [14, 13], [14, 14]], 2);
    expect(winningLineForMove(board, 14, 14, 2)).toEqual([
      { x: 14, y: 10 }, { x: 14, y: 11 }, { x: 14, y: 12 }, { x: 14, y: 13 }, { x: 14, y: 14 },
    ]);
  });

  it('recognizes both diagonal directions', () => {
    const descending = emptyBoard();
    place(descending, [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]], 1);
    expect(winningLineForMove(descending, 5, 5, 1)).toHaveLength(5);

    const ascending = emptyBoard();
    place(ascending, [[2, 12], [3, 11], [4, 10], [5, 9], [6, 8]], 2);
    expect(winningLineForMove(ascending, 6, 8, 2)).toEqual([
      { x: 2, y: 12 }, { x: 3, y: 11 }, { x: 4, y: 10 }, { x: 5, y: 9 }, { x: 6, y: 8 },
    ]);
  });

  it('accepts an overline and returns the full connected line', () => {
    const board = emptyBoard();
    place(board, [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4]], 1);
    expect(winningLineForMove(board, 3, 4, 1)).toHaveLength(6);
  });

  it('does not mistake interrupted stones for a win', () => {
    const board = emptyBoard();
    place(board, [[1, 6], [2, 6], [3, 6], [5, 6], [6, 6]], 1);
    expect(winningLineForMove(board, 6, 6, 1)).toBeNull();
  });
});

describe('isBoardFull', () => {
  it('recognizes a full 15×15 board with no five-in-a-row as a draw candidate', () => {
    // A pre-verified complete two-colour position: no horizontal, vertical or
    // diagonal contiguous line has length five. It prevents a draw test from
    // accidentally treating a checkerboard's long diagonal as harmless.
    const rows = [
      '121111221221111', '121111212211112', '212112112122212', '222112121212121', '212221121121122',
      '112112221122212', '111222111221111', '222111212122221', '211221112211112', '221112212212221',
      '121112121121211', '112221122211112', '211221212122212', '111211112211122', '122111122121121',
    ];
    const board = rows.flatMap((row) => [...row].map((cell) => Number(cell) as Cell));
    expect(board).toHaveLength(BOARD_CELLS);
    expect(isBoardFull(board)).toBe(true);
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        expect(winningLineForMove(board, x, y, board[boardIndex(x, y)] as 1 | 2)).toBeNull();
      }
    }
  });

  it('does not call a board with one empty cell full', () => {
    const board = Array<Cell>(BOARD_CELLS).fill(1);
    board[boardIndex(14, 14)] = 0;
    expect(isBoardFull(board)).toBe(false);
  });
});
