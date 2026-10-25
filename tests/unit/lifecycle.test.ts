import { describe, expect, it } from 'vitest';
import type { PublicRound, RoomState } from '../../shared/models.js';
import { createRound, updateNoConnectedPlayersSince } from '../../server/src/lifecycle/room-lifecycle.js';

function seat(seatId: 'A' | 'B', playerId: string) {
  return {
    seatId,
    playerId,
    nickname: playerId,
    connected: true,
    ready: false,
    disconnectedAt: null,
    reconnectDeadline: null,
    disconnectDecisionAvailable: false,
  };
}

function previousRound(): PublicRound {
  return {
    roundId: 'previous-round-0001', participantIds: ['alice-player-001', 'bob-player-00002'],
    blackPlayerId: 'alice-player-001', whitePlayerId: 'bob-player-00002',
    board: Array(225).fill(0), moveNo: 0, turnPlayerId: null, lastMove: null,
    paused: false, result: null,
  };
}

describe('room lifecycle helpers', () => {
  it('uses A-black for a changed combination and swaps colors for the same pair', () => {
    const samePair = createRound(previousRound(), [seat('A', 'alice-player-001'), seat('B', 'bob-player-00002')], 'next-round-000001');
    expect(samePair.blackPlayerId).toBe('bob-player-00002');
    expect(samePair.whitePlayerId).toBe('alice-player-001');

    const replacement = createRound(previousRound(), [seat('A', 'alice-player-001'), seat('B', 'carol-player-003')], 'replacement-round-01');
    expect(replacement.blackPlayerId).toBe('alice-player-001');
    expect(replacement.whitePlayerId).toBe('carol-player-003');
  });

  it('starts and clears the no-connected-player clock from actual online seats', () => {
    const state = {
      seats: [null, null],
      noConnectedPlayersSince: null,
    } as unknown as RoomState;
    updateNoConnectedPlayersSince(state, 123);
    expect(state.noConnectedPlayersSince).toBe(123);
    state.seats[0] = seat('A', 'alice-player-001');
    updateNoConnectedPlayersSince(state, 456);
    expect(state.noConnectedPlayersSince).toBeNull();
  });
});
