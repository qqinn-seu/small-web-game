export type Cell = 0 | 1 | 2;
export type RoomPhase = 'waiting' | 'playing' | 'drawing' | 'finished';
export type SeatId = 'A' | 'B';
export interface Point { x: number; y: number }
export interface Move extends Point { playerId: string; color: 1 | 2; moveNo: number }
export interface PublicSeat {
  seatId: SeatId;
  playerId: string;
  nickname: string;
  connected: boolean;
  ready: boolean;
  disconnectedAt: number | null;
  reconnectDeadline: number | null;
  disconnectDecisionAvailable: boolean;
}
export interface RoundResult {
  winnerPlayerId: string | null;
  loserPlayerId: string | null;
  reason: 'five' | 'draw' | 'resign' | 'disconnect';
  winningLine: Point[];
  endedAt: number;
}
export interface PublicRound {
  roundId: string;
  participantIds: [string, string];
  blackPlayerId: string;
  whitePlayerId: string;
  board: Cell[];
  moveNo: number;
  turnPlayerId: string | null;
  lastMove: Move | null;
  paused: boolean;
  result: RoundResult | null;
}
export interface StoredStroke {
  strokeId: string;
  colorIndex: number;
  points: Point[];
}
export interface FaceCanvas {
  ownerPlayerId: string;
  revision: number;
  pixels: number[];
  strokes: StoredStroke[];
}
export interface PublicDrawing {
  drawingId: string;
  roundId: string;
  winnerPlayerId: string;
  targetPlayerId: string;
  deadlineAt: number;
  strokeUsed: boolean;
  draft: (StoredStroke & { lastSeq: number }) | null;
}
export interface WashProposal {
  proposalId: string;
  proposerPlayerId: string;
  participantIds: [string, string];
  faceRevisions: [number, number];
  deadlineAt: number;
}
export interface RoomState {
  roomCode: string;
  roomInstanceId: string;
  version: number;
  phase: RoomPhase;
  seats: [PublicSeat | null, PublicSeat | null];
  round: PublicRound | null;
  faces: Record<string, FaceCanvas>;
  drawing: PublicDrawing | null;
  washProposal: WashProposal | null;
  noConnectedPlayersSince: number | null;
  createdAt: number;
  updatedAt: number;
}
export type RoomChanges = Partial<Omit<RoomState, 'roomCode' | 'roomInstanceId' | 'version' | 'createdAt'>>;
export interface SnapshotMessage {
  roomInstanceId: string;
  version: number;
  serverTime: number;
  syncRequestId?: string;
  state: RoomState;
}
export interface PatchMessage {
  roomInstanceId: string;
  prevVersion: number;
  version: number;
  serverTime: number;
  causedByActionId?: string;
  changes: RoomChanges;
}
