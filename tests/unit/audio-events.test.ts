import { describe, expect, it, vi } from 'vitest';
import type { Cell, PublicDrawing, PublicRound, RoomState } from '../../shared/models.js';
import { LiveAudioRouter } from '../../client/src/audio/audio-events.js';

const A = 'player-a';
const B = 'player-b';
const C = 'new-player-c';

function round(overrides: Partial<PublicRound> = {}): PublicRound {
  return {
    roundId: 'round-1',
    participantIds: [A, B],
    blackPlayerId: A,
    whitePlayerId: B,
    board: Array<Cell>(225).fill(0),
    moveNo: 0,
    turnPlayerId: A,
    lastMove: null,
    paused: false,
    result: null,
    ...overrides,
  };
}

function drawing(overrides: Partial<PublicDrawing> = {}): PublicDrawing {
  return {
    drawingId: 'drawing-1',
    roundId: 'round-1',
    winnerPlayerId: A,
    targetPlayerId: B,
    deadlineAt: 99_999,
    strokeUsed: false,
    draft: null,
    ...overrides,
  };
}

function room(version: number, overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomCode: 'ABC234',
    roomInstanceId: 'room-instance-1',
    version,
    phase: 'playing',
    seats: [
      { seatId: 'A', playerId: A, nickname: 'A', connected: true, ready: false, disconnectedAt: null, reconnectDeadline: null, disconnectDecisionAvailable: false },
      { seatId: 'B', playerId: B, nickname: 'B', connected: true, ready: false, disconnectedAt: null, reconnectDeadline: null, disconnectDecisionAvailable: false },
    ],
    round: round(),
    faces: {},
    drawing: null,
    washProposal: null,
    noConnectedPlayersSince: null,
    createdAt: 0,
    updatedAt: version,
    ...overrides,
  };
}

function legalMove(previous: RoomState, version: number, playerId: string, color: 1 | 2, turnPlayerId: string | null, overrides: Partial<RoomState> = {}): RoomState {
  const before = previous.round!;
  const board = [...before.board];
  board[0] = color;
  return room(version, {
    ...overrides,
    phase: overrides.phase ?? 'playing',
    round: round({
      ...before,
      board,
      moveNo: before.moveNo + 1,
      turnPlayerId,
      lastMove: { x: 0, y: 0, playerId, color, moveNo: before.moveNo + 1 },
      result: overrides.round?.result ?? before.result,
    }),
  });
}

describe('LiveAudioRouter', () => {
  it('plays stone and win together for a final accepted move, without a turn cue', () => {
    const play = vi.fn();
    const router = new LiveAudioRouter(play);
    const previous = room(10, { round: round({ moveNo: 4, turnPlayerId: A }) });
    const next = legalMove(previous, 11, A, 1, null, {
      phase: 'drawing',
      round: round({
        ...previous.round!,
        board: (() => { const board = [...previous.round!.board]; board[0] = 1; return board; })(),
        moveNo: 5,
        turnPlayerId: null,
        lastMove: { x: 0, y: 0, playerId: A, color: 1, moveNo: 5 },
        result: { winnerPlayerId: A, loserPlayerId: B, reason: 'five', winningLine: [], endedAt: 1 },
      }),
      drawing: drawing(),
    });

    expect(router.acceptPatch(previous, next, A)).toEqual(['stone', 'win']);
    expect(play.mock.calls.map(([cue]) => cue)).toEqual(['stone', 'win']);
  });

  it('plays turn only when an opponent legal move hands a live, unpaused playing round to self', () => {
    const play = vi.fn();
    const router = new LiveAudioRouter(play);
    const previous = room(1, { round: round({ moveNo: 3, turnPlayerId: B }) });
    const next = legalMove(previous, 2, B, 2, A);

    expect(router.acceptPatch(previous, next, A)).toEqual(['stone', 'turn']);

    const unpause = room(3, { round: round({ ...next.round!, paused: true, turnPlayerId: A }) });
    const resumed = room(4, { round: round({ ...unpause.round!, paused: false, turnPlayerId: A }) });
    expect(router.acceptPatch(unpause, resumed, A)).toEqual([]);
  });

  it('plays a first-turn cue for a newly live round only, not a restored snapshot-like state', () => {
    const play = vi.fn();
    const router = new LiveAudioRouter(play);
    const waiting = room(4, { phase: 'waiting', round: null });
    const started = room(5, { phase: 'playing', round: round({ roundId: 'round-2', turnPlayerId: A }) });
    expect(router.acceptPatch(waiting, started, A)).toEqual(['turn']);
    expect(router.acceptPatch(waiting, started, A)).toEqual([]);
  });

  it('rejects foreign, duplicate, historical, jumping, and null-identity transitions', () => {
    const play = vi.fn();
    const router = new LiveAudioRouter(play);
    const first = room(1);
    const second = room(2);
    const jumped = room(4);
    const foreign = room(3, { roomInstanceId: 'other-room' });

    expect(router.acceptPatch(first, second, null)).toEqual([]);
    expect(router.acceptPatch(first, second, A)).toEqual([]);
    expect(router.acceptPatch(second, jumped, A)).toEqual([]);
    expect(router.acceptPatch(second, foreign, A)).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  });

  it('does not announce a draw or a prior result to a newly joined nonparticipant', () => {
    const drawPlay = vi.fn();
    const drawRouter = new LiveAudioRouter(drawPlay);
    const beforeDraw = room(1, { round: round({ moveNo: 10, turnPlayerId: A }) });
    const afterDraw = legalMove(beforeDraw, 2, A, 1, null, {
      phase: 'finished',
      round: round({
        ...beforeDraw.round!,
        board: (() => { const board = [...beforeDraw.round!.board]; board[0] = 1; return board; })(),
        moveNo: 11,
        turnPlayerId: null,
        lastMove: { x: 0, y: 0, playerId: A, color: 1, moveNo: 11 },
        result: { winnerPlayerId: null, loserPlayerId: null, reason: 'draw', winningLine: [], endedAt: 1 },
      }),
    });
    expect(drawRouter.acceptPatch(beforeDraw, afterDraw, A)).toEqual(['stone']);

    const resultPlay = vi.fn();
    const resultRouter = new LiveAudioRouter(resultPlay);
    const beforeResult = room(8, { round: round({ moveNo: 3, turnPlayerId: A }) });
    const afterResult = legalMove(beforeResult, 9, A, 1, null, {
      phase: 'drawing',
      round: round({
        ...beforeResult.round!,
        board: (() => { const board = [...beforeResult.round!.board]; board[0] = 1; return board; })(),
        moveNo: 4,
        turnPlayerId: null,
        lastMove: { x: 0, y: 0, playerId: A, color: 1, moveNo: 4 },
        result: { winnerPlayerId: A, loserPlayerId: B, reason: 'five', winningLine: [], endedAt: 1 },
      }),
    });
    expect(resultRouter.acceptPatch(beforeResult, afterResult, C)).toEqual(['stone']);
    expect(resultPlay).toHaveBeenCalledWith('stone');
  });

  it('plays brush only for a new live draft or accepted increasing sequence, never confirmation tail', () => {
    const play = vi.fn();
    const router = new LiveAudioRouter(play);
    const before = room(1, { phase: 'drawing', drawing: drawing(), round: round({ result: { winnerPlayerId: A, loserPlayerId: B, reason: 'five', winningLine: [], endedAt: 1 } }) });
    const begun = room(2, {
      phase: 'drawing',
      drawing: drawing({ draft: { strokeId: 'stroke-1', colorIndex: 1, points: [{ x: 1, y: 1 }], lastSeq: 0 } }),
      round: before.round,
    });
    const points = room(3, {
      phase: 'drawing',
      drawing: drawing({ draft: { strokeId: 'stroke-1', colorIndex: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }], lastSeq: 1 } }),
      round: before.round,
    });
    const confirmed = room(4, { phase: 'finished', drawing: null, faces: { [B]: { ownerPlayerId: B, revision: 1, pixels: [], strokes: [] } }, round: before.round });

    expect(router.acceptPatch(before, begun, A)).toEqual(['brush']);
    expect(router.acceptPatch(begun, points, A)).toEqual(['brush']);
    expect(router.acceptPatch(points, confirmed, A)).toEqual([]);
    expect(play.mock.calls.map(([cue]) => cue)).toEqual(['brush', 'brush']);
  });

  it('requires reset before a new room can emit and never retains a broad event history', () => {
    const play = vi.fn();
    const router = new LiveAudioRouter(play);
    const first = room(1, { phase: 'waiting', round: null });
    const started = room(2, { phase: 'playing', round: round({ roundId: 'one', turnPlayerId: A }) });
    expect(router.acceptPatch(first, started, A)).toEqual(['turn']);

    const nextRoomBefore = room(1, { roomInstanceId: 'room-instance-2', phase: 'waiting', round: null });
    const nextRoomAfter = room(2, { roomInstanceId: 'room-instance-2', phase: 'playing', round: round({ roundId: 'two', turnPlayerId: A }) });
    expect(router.acceptPatch(nextRoomBefore, nextRoomAfter, A)).toEqual([]);
    router.reset();
    expect(router.acceptPatch(nextRoomBefore, nextRoomAfter, A)).toEqual(['turn']);
  });
});
