import { describe, expect, it } from 'vitest';
import type { RoomState } from '../../shared/models.js';
import { archiveStroke, canRetainFace, createDrawing, ensureFace, MAX_FACE_CANVASES_PER_ROOM } from '../../server/src/domain/drawing.js';

function room(): RoomState {
  return { roomCode: 'ABC234', roomInstanceId: 'face-retention-room', version: 1, phase: 'waiting', seats: [null, null], round: null, faces: {}, drawing: null, washProposal: null, noConnectedPlayersSince: null, createdAt: 0, updatedAt: 0 };
}

describe('room-local face retention', () => {
  it('never evicts an earlier face when at capacity and permits the existing owner to return', () => {
    const state = room();
    const original = ensureFace(state, 'original');
    original.pixels[0] = 2;
    for (let index = 1; index < MAX_FACE_CANVASES_PER_ROOM; index++) ensureFace(state, `owner-${index}`);
    expect(canRetainFace(state, 'new-owner')).toBe(false);
    expect(() => ensureFace(state, 'new-owner')).toThrow('capacity');
    expect(canRetainFace(state, 'original')).toBe(true);
    expect(ensureFace(state, 'original')).toBe(original);
    expect(original.pixels[0]).toBe(2);
    expect(Object.keys(state.faces)).toHaveLength(MAX_FACE_CANVASES_PER_ROOM);
  });

  it('keeps all accumulated pixels even when old raw strokes are flattened', () => {
    const state = room();
    for (let index = 0; index < 10; index++) {
      const drawing = createDrawing({ drawingId: `drawing-${index}`, roundId: `round-${index}`, winnerPlayerId: 'winner', targetPlayerId: 'target', winnerNickname: 'W', targetNickname: 'T', deadlineAt: 1000 });
      drawing.draft = { strokeId: `stroke-${index}`, colorIndex: index % 6, points: [{ x: index, y: 1 }], lastSeq: 0 };
      archiveStroke(state, drawing);
    }
    expect(state.faces.target!.strokes).toHaveLength(4);
    expect(state.faces.target!.revision).toBe(10);
    for (let index = 0; index < 10; index++) expect(state.faces.target!.pixels[32 + index]).toBe(index % 6);
  });
});
