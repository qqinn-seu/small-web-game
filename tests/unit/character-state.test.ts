import { describe, expect, it } from 'vitest';

import type { PublicSeat, RoomState } from '../../shared/models.js';
import {
  CHARACTER_STATE_LABELS,
  characterStateFor,
  facePixelHash,
  livePatchEffects,
} from '../../client/src/presentation/character-state.js';

const seatA: PublicSeat = {
  seatId: 'A', playerId: 'a', nickname: '甲', connected: true, ready: false,
  disconnectedAt: null, reconnectDeadline: null, disconnectDecisionAvailable: false,
};
const seatB: PublicSeat = {
  seatId: 'B', playerId: 'b', nickname: '乙', connected: true, ready: false,
  disconnectedAt: null, reconnectDeadline: null, disconnectDecisionAvailable: false,
};

function room(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomCode: 'M4TEST', roomInstanceId: 'm4-room', version: 1, phase: 'playing',
    seats: [seatA, seatB],
    round: {
      roundId: 'round-1', participantIds: ['a', 'b'], blackPlayerId: 'a', whitePlayerId: 'b',
      board: Array.from({ length: 225 }, () => 0), moveNo: 0, turnPlayerId: 'a', lastMove: null,
      paused: false, result: null,
    },
    faces: {}, drawing: null, washProposal: null, noConnectedPlayersSince: null, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

describe('character authority state priority', () => {
  it('exposes exactly the six Chinese-readable pose labels', () => {
    expect(Object.keys(CHARACTER_STATE_LABELS).sort()).toEqual([
      'being-drawn', 'cheering', 'defiant', 'idle', 'thinking', 'watching',
    ]);
    expect(CHARACTER_STATE_LABELS['being-drawn']).toBe('被画中');
  });

  it('uses turn, confirmed-watch timer, and idle in normal play', () => {
    const state = room();
    expect(characterStateFor(state, seatA)).toBe('thinking');
    expect(characterStateFor(state, seatB, { now: 100, watchingUntil: 200 })).toBe('watching');
    expect(characterStateFor(state, seatB, { now: 200, watchingUntil: 200 })).toBe('idle');
  });

  it('makes result poses identity-specific and lets being-drawn override defiance', () => {
    const finished = room({
      phase: 'finished',
      round: { ...room().round!, result: { winnerPlayerId: 'a', loserPlayerId: 'b', reason: 'five', winningLine: [], endedAt: 1 } },
    });
    expect(characterStateFor(finished, seatA)).toBe('cheering');
    expect(characterStateFor(finished, seatB)).toBe('defiant');

    const drawing = room({
      phase: 'drawing',
      round: finished.round,
      drawing: {
        drawingId: 'drawing-1', roundId: 'round-1', winnerPlayerId: 'a', targetPlayerId: 'b', deadlineAt: 20_000,
        strokeUsed: false, draft: null,
      },
    });
    expect(characterStateFor(drawing, seatB)).toBe('being-drawn');
  });

  it('keeps a newcomer idle when the frozen loser has left their seat', () => {
    const newcomer: PublicSeat = { ...seatB, playerId: 'new-b', nickname: '新人' };
    const replaced = room({
      phase: 'drawing', seats: [seatA, newcomer],
      round: { ...room().round!, result: { winnerPlayerId: 'a', loserPlayerId: 'b', reason: 'resign', winningLine: [], endedAt: 1 } },
      drawing: {
        drawingId: 'drawing-2', roundId: 'round-1', winnerPlayerId: 'a', targetPlayerId: 'b', deadlineAt: 20_000,
        strokeUsed: false, draft: null,
      },
    });
    expect(characterStateFor(replaced, newcomer)).toBe('idle');
    expect(characterStateFor(replaced, null)).toBe('idle');
  });
});

describe('character live-patch effects', () => {
  it('creates a watching effect only for the other participant after one confirmed move', () => {
    const before = room();
    const next = room({
      version: 2,
      round: {
        ...before.round!, moveNo: 1, turnPlayerId: 'b',
        lastMove: { x: 7, y: 7, playerId: 'a', color: 1, moveNo: 1 },
      },
    });
    expect(livePatchEffects(before, next)).toEqual({ watchingPlayerIds: ['b'], resultPlayerIds: [] });
  });

  it('emits result particles only on the null-to-result live transition, never a stable snapshot baseline', () => {
    const before = room();
    const resolved = room({
      version: 2, phase: 'finished',
      round: {
        ...before.round!, result: { winnerPlayerId: 'a', loserPlayerId: 'b', reason: 'five', winningLine: [], endedAt: 1 },
      },
    });
    expect(livePatchEffects(before, resolved).resultPlayerIds).toEqual(['a', 'b']);
    expect(livePatchEffects(resolved, { ...resolved, version: 3 }).resultPlayerIds).toEqual([]);
  });
});

describe('character face inspection hash', () => {
  it('is deterministic for accumulated pixels and changes without exposing private data', () => {
    const transparent = Array.from({ length: 1024 }, () => -1);
    const face = { ownerPlayerId: 'a', revision: 1, pixels: transparent, strokes: [] };
    const first = facePixelHash(face);
    expect(facePixelHash({ ...face, pixels: [...transparent] })).toBe(first);
    transparent[33] = 4;
    expect(facePixelHash(face)).not.toBe(first);
    expect(facePixelHash(null)).toBe('0');
  });
});
