import type { PatchMessage, RoomState, SnapshotMessage } from '../../../shared/models.js';

/**
 * Pure room-state transitions. The client only adopts state sent by the server;
 * this module never creates a move, infers a winner, or merges nested changes.
 */
export type RoomReducerEvent =
  | { type: 'snapshot'; message: SnapshotMessage }
  | { type: 'patch'; message: PatchMessage };

export type RoomReducerStatus = 'applied' | 'stale' | 'gap' | 'foreign';

export interface RoomReducerResult {
  state: RoomState | null;
  status: RoomReducerStatus;
}

export interface SnapshotReduceOptions {
  /** A reconnect's complete snapshot is allowed to rebuild an equal version. */
  replaceAtSameVersion?: boolean;
}

function cloneSnapshotState(message: SnapshotMessage): RoomState {
  const state = message.state;
  return {
    ...state,
    roomInstanceId: message.roomInstanceId,
    version: message.version,
    seats: [...state.seats],
    round: state.round
      ? {
          ...state.round,
          board: [...state.round.board],
          lastMove: state.round.lastMove ? { ...state.round.lastMove } : null,
          result: state.round.result
            ? {
                ...state.round.result,
                winningLine: state.round.result.winningLine.map((point) => ({ ...point })),
              }
            : null,
        }
      : null,
    faces: { ...state.faces },
    drawing: state.drawing
      ? {
          ...state.drawing,
          draft: state.drawing.draft
            ? { ...state.drawing.draft, points: state.drawing.draft.points.map((point) => ({ ...point })) }
            : null,
        }
      : null,
    washProposal: state.washProposal ? { ...state.washProposal } : null,
  };
}

/** Replace the complete public state from a server snapshot. */
export function reduceSnapshot(
  current: RoomState | null,
  message: SnapshotMessage,
  options: SnapshotReduceOptions = {},
): RoomReducerResult {
  if (current && current.roomInstanceId !== message.roomInstanceId) {
    return { state: current, status: 'foreign' };
  }
  if (current && message.version < current.version) {
    return { state: current, status: 'stale' };
  }
  if (current && message.version === current.version && !options.replaceAtSameVersion) {
    return { state: current, status: 'stale' };
  }
  return { state: cloneSnapshotState(message), status: 'applied' };
}

/**
 * Atomically apply one protocol patch. Every member inside `changes` is a full
 * public child object supplied by the server, so shallow replacement is
 * deliberate: nested data must never be client-side merged.
 */
export function reducePatch(current: RoomState | null, message: PatchMessage): RoomReducerResult {
  if (!current || current.roomInstanceId !== message.roomInstanceId) {
    return { state: current, status: 'foreign' };
  }
  if (message.version <= current.version) {
    return { state: current, status: 'stale' };
  }
  if (message.prevVersion !== current.version) {
    return { state: current, status: 'gap' };
  }

  const next: RoomState = {
    ...current,
    ...message.changes,
    roomInstanceId: message.roomInstanceId,
    version: message.version,
  };
  return { state: next, status: 'applied' };
}

export function reduceRoomState(current: RoomState | null, event: RoomReducerEvent): RoomReducerResult {
  return event.type === 'snapshot'
    ? reduceSnapshot(current, event.message)
    : reducePatch(current, event.message);
}
