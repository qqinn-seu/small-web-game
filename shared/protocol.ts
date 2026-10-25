import type { PatchMessage, SnapshotMessage, Point } from './models.js';

export type ErrorCode =
  | 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'IDENTITY_EXPIRED' | 'SESSION_REPLACED'
  | 'INVALID_PAYLOAD' | 'PROTOCOL_MISMATCH' | 'ACTION_ID_REUSED'
  | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'ROOM_EXPIRED' | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM' | 'SEAT_RELEASED' | 'STALE_ROUND' | 'STALE_MOVE'
  | 'INVALID_PHASE' | 'GAME_PAUSED' | 'NOT_YOUR_TURN' | 'CELL_OCCUPIED'
  | 'DRAWING_EXPIRED' | 'INVALID_STROKE_SEQ' | 'RATE_LIMITED' | 'INTERNAL_ERROR';
export type AckResult<T = Record<string, never>> =
  | { actionId: string; ok: true; data?: T; appliedVersion?: number }
  | { actionId: string; ok: false; errorCode: ErrorCode; message: string; retryable: boolean; needsSnapshot?: boolean };
export type Ack<T = Record<string, never>> = (response: AckResult<T>) => void;
export interface ActionRequest { actionId: string }
export interface RoomRequest extends ActionRequest { roomInstanceId: string; baseVersion: number }
export interface RoundRequest extends RoomRequest { roundId: string }
export interface SessionOpenRequest extends ActionRequest {
  protocolVersion: number;
  tabId: string;
  nickname?: string;
  playerId?: string;
  secret?: string;
}
export interface SessionData { playerId: string; nickname: string; secret?: string; serverEpoch: string; serverTime: number; room?: RoomEntryData | null }
export interface RoomEntryData { roomCode: string; roomInstanceId: string; invitationPath: string }
export interface JoinRequest extends ActionRequest { roomCode: string }
export interface ReadyRequest extends RoomRequest { roundId: string | null; ready: boolean }
export interface MoveRequest extends RoundRequest { x: number; y: number; expectedMoveNo: number }
export interface SyncRequest extends ActionRequest { roomInstanceId: string; lastVersion: number; syncRequestId: string }
export interface ResumeRequest extends ActionRequest { roomCode: string; roomInstanceId: string; lastVersion: number; syncRequestId?: string }
export interface LeaveRequest extends RoomRequest { roundId: string | null }
export interface DisconnectResolveRequest extends RoundRequest { targetPlayerId: string; decision: 'claim_win' | 'keep_waiting' }
export interface DrawingRequest extends RoundRequest { drawingId: string }
export interface StrokeBeginRequest extends DrawingRequest { strokeId: string; colorIndex: number; startPoint: Point }
export interface StrokePointsRequest extends DrawingRequest { strokeId: string; seq: number; points: Point[] }
export interface StrokeEndRequest extends DrawingRequest { strokeId: string; lastSeq: number; pointCount: number }
export interface ServerHello { protocolVersion: number; serverEpoch: string; serverTime: number }
export interface ClientToServerEvents {
  'session:open': (request: SessionOpenRequest, ack: Ack<SessionData>) => void;
  'room:create': (request: ActionRequest, ack: Ack<RoomEntryData>) => void;
  'room:join': (request: JoinRequest, ack: Ack<RoomEntryData>) => void;
  'room:sync': (request: SyncRequest, ack: Ack) => void;
  'round:ready': (request: ReadyRequest, ack: Ack) => void;
  'game:move': (request: MoveRequest, ack: Ack) => void;
  'room:resume': (request: ResumeRequest, ack: Ack<RoomEntryData>) => void;
  'room:leave': (request: LeaveRequest, ack: Ack) => void;
  'disconnect:resolve': (request: DisconnectResolveRequest, ack: Ack) => void;
  'stroke:begin': (request: StrokeBeginRequest, ack: Ack) => void;
  'stroke:points': (request: StrokePointsRequest, ack: Ack) => void;
  'stroke:end': (request: StrokeEndRequest, ack: Ack) => void;
  'drawing:skip': (request: DrawingRequest, ack: Ack) => void;
  'wash:propose': (request: RoundRequest, ack: Ack) => void;
  'wash:respond': (request: RoomRequest & { proposalId: string; accept: boolean }, ack: Ack) => void;
}
export interface ServerToClientEvents {
  'server:hello': (message: ServerHello) => void;
  'room:snapshot': (message: SnapshotMessage) => void;
  'room:patch': (message: PatchMessage) => void;
  'session:replaced': (message: { message: string }) => void;
  'room:expired': (message: { message: string }) => void;
  'server:restarting': (message: { message: string }) => void;
}
export interface SocketData { playerId?: string; controlEpoch?: number }
