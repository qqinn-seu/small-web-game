import type { FaceCanvas, PublicSeat, RoomState } from '../../../shared/models.js';

/** The six visible, authority-derived character poses required by M4. */
export type CharacterState = 'idle' | 'thinking' | 'watching' | 'cheering' | 'defiant' | 'being-drawn';

export const CHARACTER_STATE_LABELS: Readonly<Record<CharacterState, string>> = {
  idle: '待机',
  thinking: '思考中',
  watching: '看棋盘',
  cheering: '欢呼',
  defiant: '不服',
  'being-drawn': '被画中',
};

export interface CharacterStateOptions {
  now?: number;
  watchingUntil?: number;
}

/**
 * Maps only public room facts to a pose. A seat replacement is deliberately
 * resolved by player id: a newcomer must never inherit a prior participant's
 * loss, drawing target, or accumulated face.
 */
export function characterStateFor(
  room: RoomState | null,
  seat: PublicSeat | null,
  options: CharacterStateOptions = {},
): CharacterState {
  if (!room || !seat) return 'idle';
  const playerId = seat.playerId;
  const round = room.round;
  const isParticipant = Boolean(round?.participantIds.includes(playerId));
  const drawing = room.phase === 'drawing' ? room.drawing : null;

  // Being drawn takes visual priority over the loss pose, but only for the
  // exact frozen target identity that is still sitting in this seat.
  if (drawing?.targetPlayerId === playerId) return 'being-drawn';

  const result = round?.result;
  if (isParticipant && result?.winnerPlayerId === playerId) return 'cheering';
  if (isParticipant && result?.loserPlayerId === playerId) return 'defiant';

  const now = options.now ?? Date.now();
  if (isParticipant && (options.watchingUntil ?? 0) > now) return 'watching';

  if (
    isParticipant
    && room.phase === 'playing'
    && !round?.paused
    && !round?.result
    && round?.turnPlayerId === playerId
  ) return 'thinking';

  return 'idle';
}

export interface LivePatchEffects {
  /** The non-moving participant briefly looks at a server-confirmed stone. */
  watchingPlayerIds: string[];
  /** Winner/loser particle effects; callers decide whether their seats still match. */
  resultPlayerIds: string[];
}

/**
 * Extracts one-shot visual effects from two already accepted, contiguous live
 * states. Snapshots intentionally have no equivalent entry point, so recovery
 * and historical state never replay a move or result effect.
 */
export function livePatchEffects(before: RoomState, next: RoomState): LivePatchEffects {
  const watchingPlayerIds: string[] = [];
  const resultPlayerIds: string[] = [];
  const beforeRound = before.round;
  const nextRound = next.round;

  if (
    beforeRound
    && nextRound
    && beforeRound.roundId === nextRound.roundId
    && nextRound.moveNo === beforeRound.moveNo + 1
    && nextRound.lastMove
    && nextRound.lastMove.moveNo === nextRound.moveNo
  ) {
    for (const playerId of nextRound.participantIds) {
      if (playerId !== nextRound.lastMove.playerId) watchingPlayerIds.push(playerId);
    }
  }

  if (!beforeRound?.result && nextRound?.result) {
    for (const playerId of [nextRound.result.winnerPlayerId, nextRound.result.loserPlayerId]) {
      if (playerId && nextRound.participantIds.includes(playerId) && !resultPlayerIds.includes(playerId)) {
        resultPlayerIds.push(playerId);
      }
    }
  }

  return { watchingPlayerIds, resultPlayerIds };
}

/** A compact deterministic hash for test inspection; it exposes no credentials. */
export function facePixelHash(face: FaceCanvas | null | undefined): string {
  if (!face) return '0';
  let hash = 2_166_136_261;
  for (const pixel of face.pixels) {
    hash ^= pixel + 2; // Keep transparent -1 distinct from every brush colour.
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
