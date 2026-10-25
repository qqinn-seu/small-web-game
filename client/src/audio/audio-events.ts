import { BOARD_SIZE } from '../../../shared/constants.js';
import type { PublicDrawing, PublicRound, RoomState } from '../../../shared/models.js';
import type { AudioCue } from './types.js';

/**
 * Derives ephemeral cues from one already-accepted, consecutive live patch.
 * Snapshots, ACKs, local previews and replayed state never enter this class.
 */
export class LiveAudioRouter {
  private roomInstanceId: string | null = null;
  private lastVersion: number | null = null;

  public constructor(private readonly play: (cue: AudioCue) => void) {}

  public acceptPatch(previous: RoomState, next: RoomState, identityPlayerId: string | null): AudioCue[] {
    if (!this.acceptsConsecutiveTransition(previous, next)) return [];

    // Advance the bounded dedupe cursor even while no identity is present. A
    // later identity must not turn an old transition into a newly audible cue.
    this.roomInstanceId = previous.roomInstanceId;
    this.lastVersion = next.version;
    if (!identityPlayerId) return [];

    const stone = this.isAcceptedMove(previous, next);
    const cues: AudioCue[] = [];
    if (stone) cues.push('stone');

    const outcome = this.outcomeForParticipant(previous.round, next.round, identityPlayerId);
    if (outcome) cues.push(outcome);

    // A winning move can make both a stone and outcome cue, but never a turn
    // cue. Changes caused only by reconnect/presence/unpause have no stone.
    if (!outcome && this.shouldPlayTurn(previous, next, identityPlayerId, stone)) cues.push('turn');

    if (this.isAcceptedBrush(previous, next)) cues.push('brush');

    for (const cue of cues) {
      try {
        this.play(cue);
      } catch {
        // Presentation must not interfere with the authoritative state stream.
      }
    }
    return cues;
  }

  /** Call on room cleanup, reconnect restore, or any intentional state reset. */
  public reset(): void {
    this.roomInstanceId = null;
    this.lastVersion = null;
  }

  private acceptsConsecutiveTransition(previous: RoomState, next: RoomState): boolean {
    if (previous.roomInstanceId !== next.roomInstanceId) return false;
    if (next.version !== previous.version + 1) return false;

    if (this.roomInstanceId === null) return true;
    return this.roomInstanceId === previous.roomInstanceId && this.lastVersion === previous.version;
  }

  private isAcceptedMove(previous: RoomState, next: RoomState): boolean {
    const before = previous.round;
    const after = next.round;
    if (!before || !after || before.roundId !== after.roundId) return false;
    if (previous.phase !== 'playing' || !['playing', 'drawing', 'finished'].includes(next.phase)) return false;
    if (after.moveNo !== before.moveNo + 1) return false;

    const move = after.lastMove;
    if (!move || move.moveNo !== after.moveNo || move.playerId !== before.turnPlayerId) return false;
    if (!after.participantIds.includes(move.playerId)) return false;
    if (!Number.isInteger(move.x) || !Number.isInteger(move.y) || move.x < 0 || move.y < 0 || move.x >= BOARD_SIZE || move.y >= BOARD_SIZE) return false;
    return after.board[move.y * BOARD_SIZE + move.x] === move.color;
  }

  private outcomeForParticipant(before: PublicRound | null, after: PublicRound | null, identityPlayerId: string): AudioCue | null {
    if (!before || !after || before.roundId !== after.roundId) return null;
    if (before.result || !after.result || after.result.reason === 'draw') return null;
    if (!after.result.winnerPlayerId || !after.participantIds.includes(identityPlayerId)) return null;
    if (after.result.winnerPlayerId === identityPlayerId) return 'win';
    return after.result.loserPlayerId === identityPlayerId ? 'lose' : null;
  }

  private shouldPlayTurn(previous: RoomState, next: RoomState, identityPlayerId: string, acceptedMove: boolean): boolean {
    const after = next.round;
    if (!after || next.phase !== 'playing' || after.paused || after.result || after.turnPlayerId !== identityPlayerId) return false;

    const before = previous.round;
    const startsNewRound = (!before || before.roundId !== after.roundId)
      && after.moveNo === 0
      && after.lastMove === null;
    if (startsNewRound) return true;

    return acceptedMove && previous.phase === 'playing' && before?.turnPlayerId !== identityPlayerId;
  }

  private isAcceptedBrush(previous: RoomState, next: RoomState): boolean {
    if (next.phase !== 'drawing') return false;
    const before = previous.drawing;
    const after = next.drawing;
    if (!before || !after || before.drawingId !== after.drawingId || !after.draft) return false;

    const previousDraft = before.draft;
    if (!previousDraft) return true;
    return previousDraft.strokeId === after.draft.strokeId && after.draft.lastSeq > previousDraft.lastSeq;
  }
}
