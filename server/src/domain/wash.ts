import { emptyFacePixels } from '../../../shared/face-raster.js';
import type { RoomState, WashProposal } from '../../../shared/models.js';
import { ensureFace, faceRevision } from './drawing.js';

export function createWashProposal(input: {
  proposalId: string;
  proposerPlayerId: string;
  participantIds: [string, string];
  state: RoomState;
  deadlineAt: number;
}): WashProposal {
  return {
    proposalId: input.proposalId,
    proposerPlayerId: input.proposerPlayerId,
    participantIds: input.participantIds,
    faceRevisions: [
      faceRevision(input.state, input.participantIds[0]),
      faceRevision(input.state, input.participantIds[1]),
    ],
    deadlineAt: input.deadlineAt,
  };
}

export function washProposalStillMatches(state: RoomState, proposal: WashProposal, timestamp: number): boolean {
  if (timestamp >= proposal.deadlineAt) return false;
  if (state.phase !== 'waiting' && state.phase !== 'finished') return false;
  const [seatA, seatB] = state.seats;
  if (seatA === null || seatB === null || !seatA.connected || !seatB.connected) return false;
  if (seatA.playerId !== proposal.participantIds[0] || seatB.playerId !== proposal.participantIds[1]) return false;
  return faceRevision(state, proposal.participantIds[0]) === proposal.faceRevisions[0]
    && faceRevision(state, proposal.participantIds[1]) === proposal.faceRevisions[1];
}

/** Clears both currently proposed canvases and increments each revision atomically. */
export function clearProposedFaces(state: RoomState, proposal: WashProposal): void {
  for (const playerId of proposal.participantIds) {
    const face = ensureFace(state, playerId);
    face.pixels = emptyFacePixels();
    face.strokes = [];
    face.revision += 1;
  }
}
