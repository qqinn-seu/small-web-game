import {
  FACE_RECENT_STROKES,
  FACE_PIXEL_COUNT,
  STROKE_BATCHES_PER_SECOND,
  STROKE_BURST_ALLOWANCE,
} from '../../../shared/constants.js';
import { emptyFacePixels, paintPolyline } from '../../../shared/face-raster.js';
import type { FaceCanvas, PublicDrawing, RoomState, StoredStroke } from '../../../shared/models.js';

/** Prevents a long-lived in-memory room from retaining an unbounded number of departed players' faces. */
export const MAX_FACE_CANVASES_PER_ROOM = 64;

export interface DrawingRuntime {
  drawingId: string;
  strokeId: string;
  /** Canonical request hashes by accepted seq; at most 32 for one 1,024-point stroke. */
  batchHashes: Map<number, string>;
  /** Accepted non-duplicate batches in the current rolling one-second window. */
  batchTimestamps: number[];
}

/**
 * Server-only data deliberately kept out of snapshots. It is bounded by a
 * single active drawing and survives a transport reconnect while this process
 * remains alive.
 */
export class DrawingRuntimeStore {
  private readonly active = new WeakMap<object, DrawingRuntime>();
  private readonly expired = new WeakMap<object, Set<string>>();

  public start(room: object, drawingId: string, strokeId: string): DrawingRuntime {
    const runtime: DrawingRuntime = { drawingId, strokeId, batchHashes: new Map(), batchTimestamps: [] };
    this.active.set(room, runtime);
    return runtime;
  }

  public get(room: object): DrawingRuntime | undefined {
    return this.active.get(room);
  }

  public clear(room: object): void {
    this.active.delete(room);
  }

  public expire(room: object, drawingId: string): void {
    this.clear(room);
    const expired = this.expired.get(room) ?? new Set<string>();
    expired.add(drawingId);
    // There can only be one active drawing; retaining a few recent IDs is
    // enough to return DRAWING_EXPIRED for delayed final batches without
    // turning stale requests into unbounded server state.
    while (expired.size > 8) expired.delete(expired.values().next().value as string);
    this.expired.set(room, expired);
  }

  public isExpired(room: object, drawingId: string): boolean {
    return this.expired.get(room)?.has(drawingId) ?? false;
  }
}

export function canRetainFace(state: RoomState, ownerPlayerId: string): boolean {
  return state.faces[ownerPlayerId] !== undefined
    || Object.keys(state.faces).length < MAX_FACE_CANVASES_PER_ROOM;
}

function newFace(ownerPlayerId: string): FaceCanvas {
  return { ownerPlayerId, revision: 0, pixels: emptyFacePixels(), strokes: [] };
}

/** Gets a player's persistent room-local face, creating a bounded empty canvas when required. */
export function ensureFace(state: RoomState, ownerPlayerId: string): FaceCanvas {
  const existing = state.faces[ownerPlayerId];
  if (existing !== undefined) return existing;

  // Refuse admission before reaching here; never silently erase an old face.
  if (!canRetainFace(state, ownerPlayerId)) throw new Error('Room face capacity reached');
  const face = newFace(ownerPlayerId);
  state.faces[ownerPlayerId] = face;
  return face;
}

export function faceRevision(state: RoomState, playerId: string): number {
  return state.faces[playerId]?.revision ?? 0;
}

export function createDrawing(input: {
  drawingId: string;
  roundId: string;
  winnerPlayerId: string;
  targetPlayerId: string;
  winnerNickname: string | undefined;
  targetNickname: string | undefined;
  deadlineAt: number;
}): PublicDrawing {
  return {
    drawingId: input.drawingId,
    roundId: input.roundId,
    winnerPlayerId: input.winnerPlayerId,
    targetPlayerId: input.targetPlayerId,
    ...(input.winnerNickname === undefined ? {} : { winnerNickname: input.winnerNickname }),
    ...(input.targetNickname === undefined ? {} : { targetNickname: input.targetNickname }),
    deadlineAt: input.deadlineAt,
    strokeUsed: false,
    draft: null,
  };
}

/** Archives a fully confirmed stroke into the target's fixed-size face canvas. */
export function archiveStroke(state: RoomState, drawing: PublicDrawing): FaceCanvas {
  if (drawing.draft === null) throw new Error('Cannot archive a missing stroke draft');
  const face = ensureFace(state, drawing.targetPlayerId);
  const stored: StoredStroke = {
    strokeId: drawing.draft.strokeId,
    colorIndex: drawing.draft.colorIndex,
    points: drawing.draft.points.map((point) => ({ ...point })),
  };
  face.pixels = paintPolyline(face.pixels, stored.points, stored.colorIndex);
  face.strokes = [...face.strokes, stored].slice(-FACE_RECENT_STROKES);
  face.revision += 1;
  return face;
}

export function acceptedBatchIsRateLimited(runtime: DrawingRuntime, timestamp: number): boolean {
  runtime.batchTimestamps = runtime.batchTimestamps.filter((seenAt) => timestamp - seenAt < 1_000);
  if (runtime.batchTimestamps.length >= STROKE_BATCHES_PER_SECOND + STROKE_BURST_ALLOWANCE) return true;
  runtime.batchTimestamps.push(timestamp);
  return false;
}

/** Makes malformed state fail safe before it is ever exposed to a new client. */
export function hasValidFacePixels(face: FaceCanvas): boolean {
  return face.pixels.length === FACE_PIXEL_COUNT;
}
