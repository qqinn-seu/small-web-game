import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FACE_PIXEL, FACE_PIXEL_COUNT } from '../../shared/constants.js';
import type { AckResult, StrokeBeginRequest, StrokeEndRequest, StrokePointsRequest } from '../../shared/protocol.js';
import type { RoomState } from '../../shared/models.js';
import { composeFacePixels, faceCellAt, getFaceGeometry } from '../../client/src/canvas/face-renderer.js';
import { DrawingController, type DrawingNetworkSender } from '../../client/src/input/drawing-controller.js';
import { reducePatch, reduceSnapshot } from '../../client/src/state/room-reducer.js';

class FakeCanvas {
  public clientWidth = 320;
  public clientHeight = 320;
  public clientLeft = 0;
  public clientTop = 0;
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = listener as (event: PointerEvent) => void;
    const group = this.listeners.get(type) ?? new Set<(event: PointerEvent) => void>();
    group.add(callback);
    this.listeners.set(type, group);
  }

  public removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener as (event: PointerEvent) => void);
  }

  public getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0 } as DOMRect;
  }

  public setPointerCapture(): void {}
  public releasePointerCapture(): void {}

  public dispatch(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', point: { x: number; y: number }, pointerId = 1): void {
    const event = {
      pointerType: 'mouse',
      button: 0,
      clientX: point.x,
      clientY: point.y,
      pointerId,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function ok(actionId: string): AckResult {
  return { actionId, ok: true };
}

function drawingRoom(overrides: Partial<RoomState['drawing']> = {}): RoomState {
  return {
    roomCode: 'ABC234',
    roomInstanceId: 'room-m3-test',
    version: 7,
    phase: 'drawing',
    seats: [
      { seatId: 'A', playerId: 'winner', nickname: '赢家', connected: true, ready: false, disconnectedAt: null, reconnectDeadline: null, disconnectDecisionAvailable: false },
      { seatId: 'B', playerId: 'target', nickname: '输家', connected: true, ready: false, disconnectedAt: null, reconnectDeadline: null, disconnectDecisionAvailable: false },
    ],
    round: {
      roundId: 'round-m3-test', participantIds: ['winner', 'target'], blackPlayerId: 'winner', whitePlayerId: 'target',
      board: Array(225).fill(0), moveNo: 12, turnPlayerId: null, lastMove: null, paused: false,
      result: { winnerPlayerId: 'winner', loserPlayerId: 'target', reason: 'five', winningLine: [], endedAt: 1 },
    },
    faces: {
      target: { ownerPlayerId: 'target', revision: 3, pixels: Array(FACE_PIXEL_COUNT).fill(EMPTY_FACE_PIXEL), strokes: [] },
      winner: { ownerPlayerId: 'winner', revision: 0, pixels: Array(FACE_PIXEL_COUNT).fill(EMPTY_FACE_PIXEL), strokes: [] },
    },
    drawing: {
      drawingId: 'drawing-m3-test', roundId: 'round-m3-test', winnerPlayerId: 'winner', targetPlayerId: 'target',
      winnerNickname: '赢家', targetNickname: '输家', deadlineAt: 50_000, strokeUsed: false, draft: null,
      ...overrides,
    },
    washProposal: null,
    noConnectedPlayersSince: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function controllerHarness(sender: DrawingNetworkSender, room = drawingRoom()) {
  const canvas = new FakeCanvas();
  const previews: number[] = [];
  const sync = vi.fn();
  const notify = vi.fn();
  let operational = true;
  let clock = 1_000;
  const controller = new DrawingController({
    canvas: canvas as unknown as HTMLCanvasElement,
    getRoom: () => room,
    getIdentity: () => ({ playerId: 'winner', nickname: '赢家' }),
    isOperational: () => operational,
    getColorIndex: () => 2,
    sender,
    requestSync: sync,
    notify,
    onLocalPreview: (preview) => previews.push(preview?.points.length ?? 0),
    now: () => clock,
    makeId: (() => { let serial = 0; return () => `action-${++serial}`; })(),
  });
  controller.setRoom(room);
  return {
    canvas,
    controller,
    previews,
    sync,
    notify,
    setOperational: (next: boolean) => { operational = next; controller.setOperational(); },
    advance: (milliseconds: number) => { clock += milliseconds; controller.setOperational(); },
    get room() { return room; },
    setRoom: (next: RoomState) => { room = next; controller.setRoom(next); },
  };
}

afterEach(() => vi.useRealTimers());

describe('M3 face renderer projection', () => {
  it('maps CSS content coordinates only into the 0..31 grid and paints draft/local paths without replaying history', () => {
    const geometry = getFaceGeometry(320, 320);
    expect(faceCellAt(geometry, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(faceCellAt(geometry, 319.99, 319.99)).toEqual({ x: 31, y: 31 });
    expect(faceCellAt(geometry, 320, 10)).toBeNull();

    const pixels = composeFacePixels({
      face: {
        ownerPlayerId: 'target', revision: 1,
        pixels: Array(FACE_PIXEL_COUNT).fill(EMPTY_FACE_PIXEL),
        // Deliberately conflicting history: flattened pixels are the only
        // committed source and this record must not be replayed.
        strokes: [{ strokeId: 'old', colorIndex: 5, points: [{ x: 7, y: 7 }] }],
      },
      draft: { strokeId: 'draft', colorIndex: 1, points: [{ x: 1, y: 1 }, { x: 3, y: 1 }] },
      localPreview: { strokeId: 'local', colorIndex: 2, points: [{ x: 4, y: 1 }] },
    });
    expect(pixels[7 * 32 + 7]).toBe(EMPTY_FACE_PIXEL);
    expect(pixels[1 * 32 + 1]).toBe(1);
    expect(pixels[1 * 32 + 2]).toBe(1);
    expect(pixels[1 * 32 + 4]).toBe(2);
  });
});

describe('M3 drawing controller', () => {
  it('sends one ordered stroke in <=32-point batches and only ends after every batch acknowledgement', async () => {
    let resolveFirstBatch: ((result: AckResult) => void) | null = null;
    const begins: StrokeBeginRequest[] = [];
    const batches: StrokePointsRequest[] = [];
    const ends: StrokeEndRequest[] = [];
    const harness = controllerHarness({
      strokeBegin: async (request) => { begins.push(request); return ok(request.actionId); },
      strokePoints: (request) => {
        batches.push(request);
        if (batches.length === 1) return new Promise<AckResult>((resolve) => { resolveFirstBatch = resolve; });
        return Promise.resolve(ok(request.actionId));
      },
      strokeEnd: async (request) => { ends.push(request); return ok(request.actionId); },
      drawingSkip: async (request) => ok(request.actionId),
    });

    harness.canvas.dispatch('pointerdown', { x: 1, y: 1 });
    await flushMicrotasks();
    for (let index = 0; index < 70; index += 1) {
      harness.canvas.dispatch('pointermove', { x: index % 2 ? 19 : 29, y: 19 });
    }
    harness.canvas.dispatch('pointerup', { x: 19, y: 19 });
    await flushMicrotasks();

    expect(begins).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.seq).toBe(1);
    expect(batches[0]?.points).toHaveLength(32);
    expect(ends).toHaveLength(0);

    const resolveBatch = resolveFirstBatch as unknown as (result: AckResult) => void;
    resolveBatch(ok(batches[0]!.actionId));
    await flushMicrotasks();
    expect(batches).toHaveLength(1);
    harness.advance(50);
    await flushMicrotasks();
    expect(batches).toHaveLength(2);
    harness.advance(50);
    await flushMicrotasks();
    expect(batches.map((batch) => batch.points.length)).toEqual([32, 32, 6]);
    expect(batches.map((batch) => batch.seq)).toEqual([1, 2, 3]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ lastSeq: 3, pointCount: 71 });
    harness.controller.destroy();
  });

  it('reuses an in-flight actionId after recovery and can unlock a lost ACK from authoritative draft state', async () => {
    const begins: StrokeBeginRequest[] = [];
    const batches: StrokePointsRequest[] = [];
    const ends: StrokeEndRequest[] = [];
    let failBatch = true;
    const harness = controllerHarness({
      strokeBegin: async (request) => { begins.push(request); return ok(request.actionId); },
      strokePoints: async (request) => {
        batches.push(request);
        if (failBatch) { failBatch = false; throw new Error('ack lost'); }
        return ok(request.actionId);
      },
      strokeEnd: async (request) => { ends.push(request); return ok(request.actionId); },
      drawingSkip: async (request) => ok(request.actionId),
    });

    harness.canvas.dispatch('pointerdown', { x: 1, y: 1 });
    await flushMicrotasks();
    harness.canvas.dispatch('pointermove', { x: 21, y: 21 });
    harness.canvas.dispatch('pointerup', { x: 21, y: 21 });
    await flushMicrotasks();
    expect(batches).toHaveLength(1);
    expect(harness.sync).toHaveBeenCalledTimes(1);

    const first = batches[0]!;
    harness.setRoom(drawingRoom({
      strokeUsed: true,
      draft: { strokeId: begins[0]!.strokeId, colorIndex: 2, points: [{ x: 0, y: 0 }, ...first.points], lastSeq: 1 },
    }));
    await flushMicrotasks();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ lastSeq: 1, pointCount: 2 });
    harness.controller.destroy();
  });

  it('replays a timed-out begin with the original actionId only after the operation gate reopens', async () => {
    const begins: StrokeBeginRequest[] = [];
    let firstAttempt = true;
    const harness = controllerHarness({
      strokeBegin: async (request) => {
        begins.push(request);
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error('transport interrupted');
        }
        return ok(request.actionId);
      },
      strokePoints: async (request) => ok(request.actionId),
      strokeEnd: async (request) => ok(request.actionId),
      drawingSkip: async (request) => ok(request.actionId),
    });

    harness.canvas.dispatch('pointerdown', { x: 5, y: 5 });
    await flushMicrotasks();
    expect(harness.sync).toHaveBeenCalledTimes(1);
    harness.setOperational(false);
    harness.setRoom({ ...drawingRoom(), version: 19 });
    harness.setOperational(true);
    await flushMicrotasks();

    expect(begins).toHaveLength(2);
    expect(begins[1]).toEqual(begins[0]);
    harness.controller.destroy();
  });

  it('freezes a timed-out point batch payload even when the recovery snapshot advances room version', async () => {
    const begins: StrokeBeginRequest[] = [];
    const batches: StrokePointsRequest[] = [];
    let firstAttempt = true;
    const harness = controllerHarness({
      strokeBegin: async (request) => { begins.push(request); return ok(request.actionId); },
      strokePoints: async (request) => {
        batches.push(request);
        if (firstAttempt) { firstAttempt = false; throw new Error('lost transport'); }
        return ok(request.actionId);
      },
      strokeEnd: async (request) => ok(request.actionId),
      drawingSkip: async (request) => ok(request.actionId),
    });
    harness.canvas.dispatch('pointerdown', { x: 1, y: 1 });
    await flushMicrotasks();
    harness.canvas.dispatch('pointermove', { x: 21, y: 21 });
    harness.canvas.dispatch('pointerup', { x: 21, y: 21 });
    await flushMicrotasks();
    harness.setOperational(false);
    harness.setRoom({ ...drawingRoom({ strokeUsed: true, draft: { strokeId: begins[0]!.strokeId, colorIndex: 2, points: [{ x: 0, y: 0 }], lastSeq: 0 } }), version: 21 });
    harness.setOperational(true);
    await flushMicrotasks();
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(batches[0]);
    harness.controller.destroy();
  });

  it('ignores a second pointerup while the first real release awaits confirmation', async () => {
    const ends: StrokeEndRequest[] = [];
    const harness = controllerHarness({
      strokeBegin: async (request) => ok(request.actionId),
      strokePoints: async (request) => ok(request.actionId),
      strokeEnd: (request) => { ends.push(request); return new Promise(() => {}); },
      drawingSkip: async (request) => ok(request.actionId),
    });
    harness.canvas.dispatch('pointerdown', { x: 1, y: 1 });
    await flushMicrotasks();
    harness.canvas.dispatch('pointerup', { x: 1, y: 1 });
    await flushMicrotasks();
    harness.canvas.dispatch('pointerup', { x: 250, y: 250 });
    expect(ends).toHaveLength(1);
    expect(ends[0]?.pointCount).toBe(1);
    expect(harness.previews.at(-1)).toBe(1);
    harness.controller.destroy();
  });

  it('does not fabricate stroke:end after pointercancel and blocks a second stroke for the used drawing', async () => {
    const begins: StrokeBeginRequest[] = [];
    const ends: StrokeEndRequest[] = [];
    const harness = controllerHarness({
      strokeBegin: async (request) => { begins.push(request); return ok(request.actionId); },
      strokePoints: async (request) => ok(request.actionId),
      strokeEnd: async (request) => { ends.push(request); return ok(request.actionId); },
      drawingSkip: async (request) => ok(request.actionId),
    });

    harness.canvas.dispatch('pointerdown', { x: 1, y: 1 });
    await flushMicrotasks();
    harness.canvas.dispatch('pointermove', { x: 20, y: 20 });
    harness.canvas.dispatch('pointercancel', { x: 20, y: 20 });
    harness.canvas.dispatch('pointerdown', { x: 30, y: 30 });
    await flushMicrotasks();

    expect(begins).toHaveLength(1);
    expect(ends).toHaveLength(0);
    expect(harness.previews.at(-1)).toBe(0);
    harness.controller.destroy();
  });

  it('refuses another pointerdown when an authoritative restored draft already consumed the one stroke', async () => {
    const begin = vi.fn(async (request: StrokeBeginRequest) => ok(request.actionId));
    const harness = controllerHarness({
      strokeBegin: begin,
      strokePoints: async (request) => ok(request.actionId),
      strokeEnd: async (request) => ok(request.actionId),
      drawingSkip: async (request) => ok(request.actionId),
    }, drawingRoom({
      strokeUsed: true,
      draft: { strokeId: 'server-old-stroke', colorIndex: 1, points: [{ x: 1, y: 1 }], lastSeq: 0 },
    }));

    harness.canvas.dispatch('pointerdown', { x: 4, y: 4 });
    await flushMicrotasks();
    expect(begin).not.toHaveBeenCalled();
    expect(harness.controller.canStart()).toBe(false);
    harness.controller.destroy();
  });
});

describe('M3 room cloning', () => {
  it('deep-copies face pixels, draft points, and wash proposal tuples for both snapshots and patches', () => {
    const source = drawingRoom({
      draft: { strokeId: 'draft', colorIndex: 1, points: [{ x: 2, y: 2 }], lastSeq: 0 },
    });
    source.washProposal = {
      proposalId: 'wash', proposerPlayerId: 'winner', participantIds: ['winner', 'target'], faceRevisions: [3, 0], deadlineAt: 9_000,
    };
    const snapshot = { roomInstanceId: source.roomInstanceId, version: source.version, serverTime: 0, state: source };
    const cloned = reduceSnapshot(null, snapshot).state!;
    source.faces.target!.pixels[0] = 5;
    source.drawing!.draft!.points[0]!.x = 9;
    source.washProposal!.participantIds[0] = 'mutated';
    expect(cloned.faces.target!.pixels[0]).toBe(EMPTY_FACE_PIXEL);
    expect(cloned.drawing!.draft!.points[0]).toEqual({ x: 2, y: 2 });
    expect(cloned.washProposal!.participantIds[0]).toBe('winner');

    const patchFaces = { ...source.faces, target: { ...source.faces.target!, pixels: [...source.faces.target!.pixels] } };
    const patch = {
      roomInstanceId: cloned.roomInstanceId, prevVersion: cloned.version, version: cloned.version + 1, serverTime: 0,
      changes: { faces: patchFaces },
    };
    const patched = reducePatch(cloned, patch).state!;
    patchFaces.target!.pixels[1] = 4;
    expect(patched.faces.target!.pixels[1]).toBe(EMPTY_FACE_PIXEL);
  });
});
