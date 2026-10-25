import { BOARD_CELLS } from '../../../shared/constants.js';
import type { Cell, PublicRound, PublicSeat, RoomState, SeatId } from '../../../shared/models.js';
import type { PlayerRecord } from './store.js';

export function publicSeat(seatId: SeatId, player: PlayerRecord): PublicSeat {
  return {
    seatId,
    playerId: player.playerId,
    nickname: player.nickname,
    connected: true,
    ready: false,
    disconnectedAt: null,
    reconnectDeadline: null,
    disconnectDecisionAvailable: false,
  };
}

export function roomEntry(state: RoomState): { roomCode: string; roomInstanceId: string; invitationPath: string } {
  return {
    roomCode: state.roomCode,
    roomInstanceId: state.roomInstanceId,
    invitationPath: `/r/${state.roomCode}`,
  };
}

export function seatIndexForPlayer(state: RoomState, playerId: string): number {
  return state.seats.findIndex((seat) => seat?.playerId === playerId);
}

export function seatForPlayer(state: RoomState, playerId: string): PublicSeat | null {
  const index = seatIndexForPlayer(state, playerId);
  return index === -1 ? null : state.seats[index];
}

export function seatsAreOnline(state: RoomState): boolean {
  return state.seats[0] !== null && state.seats[1] !== null
    && state.seats[0].connected && state.seats[1].connected;
}

export function hasConnectedSeat(state: RoomState): boolean {
  return state.seats.some((seat) => seat?.connected === true);
}

export function clearReady(state: RoomState): void {
  for (const seat of state.seats) {
    if (seat !== null) seat.ready = false;
  }
}

/**
 * Applies the room's no-online-player invariant after a seat mutation. A null
 * seat is deliberately not considered online, so the last explicit leave also
 * starts the idle destruction clock.
 */
export function updateNoConnectedPlayersSince(state: RoomState, now: number): void {
  state.noConnectedPlayersSince = hasConnectedSeat(state) ? null : (state.noConnectedPlayersSince ?? now);
}

export function createRound(
  previousRound: PublicRound | null,
  seats: [PublicSeat, PublicSeat],
  roundId: string,
): PublicRound {
  const [seatA, seatB] = seats;
  const sameParticipants = previousRound !== null
    && previousRound.participantIds.every((playerId) => playerId === seatA.playerId || playerId === seatB.playerId)
    && (seatA.playerId === previousRound.participantIds[0] || seatA.playerId === previousRound.participantIds[1])
    && (seatB.playerId === previousRound.participantIds[0] || seatB.playerId === previousRound.participantIds[1]);

  // With exactly two unique seats the predicate above is an equality of the
  // two participant sets. A changed combination starts with physical A black.
  const blackPlayerId = sameParticipants
    ? previousRound!.whitePlayerId
    : seatA.playerId;
  const whitePlayerId = sameParticipants
    ? previousRound!.blackPlayerId
    : seatB.playerId;

  return {
    roundId,
    participantIds: [seatA.playerId, seatB.playerId],
    blackPlayerId,
    whitePlayerId,
    board: Array<Cell>(BOARD_CELLS).fill(0),
    moveNo: 0,
    turnPlayerId: blackPlayerId,
    lastMove: null,
    paused: false,
    result: null,
  };
}
