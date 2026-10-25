import type {
  FaceCanvas,
  PatchMessage,
  PublicDrawing,
  PublicRound,
  RoomChanges,
  RoomState,
  SnapshotMessage,
  StoredStroke,
  WashProposal,
} from '../../../shared/models.js';

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

function cloneStroke(stroke: StoredStroke): StoredStroke {
  return { ...stroke, points: stroke.points.map((point) => ({ ...point })) };
}

function cloneFace(face: FaceCanvas): FaceCanvas {
  return {
    ...face,
    pixels: [...face.pixels],
    strokes: face.strokes.map(cloneStroke),
  };
}

function cloneFaces(faces: Record<string, FaceCanvas>): Record<string, FaceCanvas> {
  return Object.fromEntries(Object.entries(faces).map(([playerId, face]) => [playerId, cloneFace(face)]));
}

function cloneRound(round: PublicRound | null): PublicRound | null {
  if (!round) return null;
  return {
    ...round,
    participantIds: [...round.participantIds] as PublicRound['participantIds'],
    board: [...round.board],
    lastMove: round.lastMove ? { ...round.lastMove } : null,
    result: round.result
      ? {
          ...round.result,
          winningLine: round.result.winningLine.map((point) => ({ ...point })),
        }
      : null,
  };
}

function cloneDrawing(drawing: PublicDrawing | null): PublicDrawing | null {
  if (!drawing) return null;
  return {
    ...drawing,
    draft: drawing.draft
      ? { ...cloneStroke(drawing.draft), lastSeq: drawing.draft.lastSeq }
      : null,
  };
}

function cloneWashProposal(proposal: WashProposal | null): WashProposal | null {
  if (!proposal) return null;
  return {
    ...proposal,
    participantIds: [...proposal.participantIds] as WashProposal['participantIds'],
    faceRevisions: [...proposal.faceRevisions] as WashProposal['faceRevisions'],
  };
}

/** Copy optional full patch children before they enter the browser state mirror. */
function cloneChanges(changes: RoomChanges): RoomChanges {
  const result: RoomChanges = { ...changes };
  if (changes.seats) result.seats = changes.seats.map((seat) => (seat ? { ...seat } : null)) as RoomState['seats'];
  if (changes.round !== undefined) result.round = cloneRound(changes.round);
  if (changes.faces !== undefined) result.faces = cloneFaces(changes.faces);
  if (changes.drawing !== undefined) result.drawing = cloneDrawing(changes.drawing);
  if (changes.washProposal !== undefined) result.washProposal = cloneWashProposal(changes.washProposal);
  return result;
}

function cloneSnapshotState(message: SnapshotMessage): RoomState {
  const state = message.state;
  return {
    ...state,
    roomInstanceId: message.roomInstanceId,
    version: message.version,
    seats: state.seats.map((seat) => (seat ? { ...seat } : null)) as RoomState['seats'],
    round: cloneRound(state.round),
    faces: cloneFaces(state.faces),
    drawing: cloneDrawing(state.drawing),
    washProposal: cloneWashProposal(state.washProposal),
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
 * public child object supplied by the server, so replacement remains
 * authoritative while copying protects the mirror from future message mutation.
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
    ...cloneChanges(message.changes),
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
