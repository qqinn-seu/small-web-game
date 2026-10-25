import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express, { type Express } from 'express';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';

import {
  BOARD_CELLS,
  BOARD_SIZE,
  NICKNAME_MAX_LENGTH,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  ROOM_IDLE_TTL_MS,
} from '../../shared/constants.js';
import type {
  Cell,
  PatchMessage,
  PublicRound,
  RoomChanges,
  RoomState,
  SeatId,
  SnapshotMessage,
} from '../../shared/models.js';
import type {
  AckResult,
  ClientToServerEvents,
  DisconnectResolveRequest,
  ErrorCode,
  JoinRequest,
  LeaveRequest,
  MoveRequest,
  ReadyRequest,
  ResumeRequest,
  RoomEntryData,
  ServerToClientEvents,
  SessionData,
  SessionOpenRequest,
  SocketData,
  SyncRequest,
} from '../../shared/protocol.js';
import { isBoardFull, boardIndex, winningLineForMove } from './domain/rules.js';
import {
  clearReady,
  createRound,
  publicSeat,
  roomEntry,
  seatForPlayer,
  seatIndexForPlayer,
  seatsAreOnline,
  updateNoConnectedPlayersSince,
} from './lifecycle/room-lifecycle.js';
import { GameStore, type GameStoreView, type PlayerRecord, type RoomRecord } from './lifecycle/store.js';
import { MemberOperations } from './lifecycle/member-operations.js';

const ROOM_CODE_LENGTH = 6;
const ROUND_ID_BYTES = 18;
const SERVER_EPOCH_BYTES = 12;
const MAX_ROOMS = 500;
const MAX_PLAYERS = 2_000;
const MAX_ACTIONS_PER_PLAYER = 200;
const ACTION_CACHE_TTL_MS = 10 * 60_000;
const RATE_WINDOW_MS = 10_000;
// A player can legally place up to 113 stones in one complete 15×15 game.
const RATE_MAX_REQUESTS = 240;

export const M1_SERVICE_LIMITS = Object.freeze({
  maxRooms: MAX_ROOMS,
  maxPlayers: MAX_PLAYERS,
  maxActionsPerPlayer: MAX_ACTIONS_PER_PLAYER,
  actionCacheTtlMs: ACTION_CACHE_TTL_MS,
  rateWindowMs: RATE_WINDOW_MS,
  rateMaxRequests: RATE_MAX_REQUESTS,
});

type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type AckCallback = (response: AckResult<unknown>) => void;

interface RateBucket { timestamps: number[] }
interface InFlightAction {
  fingerprint: string;
  response: Promise<AckResult<unknown>>;
}

export interface CreateGameServerOptions {
  /** Tests normally disable static files. Production index.ts enables them. */
  serveStatic?: boolean;
  /** Internal deterministic clock injection for server and integration tests. */
  now?: () => number;
  /** Defaults to one second in production; zero disables only the periodic scan. */
  maintenanceIntervalMs?: number;
}

export interface GameServer {
  app: Express;
  httpServer: HttpServer;
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  store: GameStoreView;
  /** Runs idle-room expiry against the internal clock; useful with an injected test clock. */
  runMaintenance: () => void;
  close: () => Promise<void>;
}

const actionIdSchema = z.string().min(1).max(128);
const roomCodeSchema = z.string().regex(/^[A-Z0-9]{6}$/);
const opaqueIdSchema = z.string().min(12).max(128);
const versionSchema = z.number().int().nonnegative();

const sessionOpenSchema = z.object({
  actionId: actionIdSchema,
  protocolVersion: z.number().int(),
  tabId: z.string().min(1).max(128),
  nickname: z.string().min(1).max(64).optional(),
  playerId: opaqueIdSchema.optional(),
  secret: z.string().min(32).max(256).optional(),
}).strict().superRefine((value, context) => {
  const hasCredentials = value.playerId !== undefined || value.secret !== undefined;
  if (hasCredentials && (value.playerId === undefined || value.secret === undefined)) {
    context.addIssue({ code: 'custom', message: 'playerId and secret must be supplied together' });
  }
  if (hasCredentials && value.nickname !== undefined) {
    context.addIssue({ code: 'custom', message: 'credential recovery cannot set nickname' });
  }
  if (!hasCredentials && value.nickname === undefined) {
    context.addIssue({ code: 'custom', message: 'new sessions require a nickname' });
  }
  if (value.nickname !== undefined) {
    const nicknameLength = [...value.nickname.trim()].length;
    if (nicknameLength === 0 || nicknameLength > NICKNAME_MAX_LENGTH) {
      context.addIssue({ code: 'custom', message: 'nickname must be 1–12 characters after trimming' });
    }
  }
});

const createSchema = z.object({ actionId: actionIdSchema }).strict();
const joinSchema = z.object({ actionId: actionIdSchema, roomCode: roomCodeSchema }).strict();
const syncSchema = z.object({
  actionId: actionIdSchema,
  roomInstanceId: opaqueIdSchema,
  lastVersion: versionSchema,
  syncRequestId: opaqueIdSchema,
}).strict();
const resumeSchema = z.object({
  actionId: actionIdSchema,
  roomCode: roomCodeSchema,
  roomInstanceId: opaqueIdSchema,
  lastVersion: versionSchema,
  syncRequestId: opaqueIdSchema.optional(),
}).strict();
const readySchema = z.object({
  actionId: actionIdSchema,
  roomInstanceId: opaqueIdSchema,
  baseVersion: versionSchema,
  roundId: z.string().min(12).max(128).nullable(),
  ready: z.boolean(),
}).strict();
const leaveSchema = z.object({
  actionId: actionIdSchema,
  roomInstanceId: opaqueIdSchema,
  baseVersion: versionSchema,
  roundId: z.string().min(12).max(128).nullable(),
}).strict();
const moveSchema = z.object({
  actionId: actionIdSchema,
  roomInstanceId: opaqueIdSchema,
  baseVersion: versionSchema,
  roundId: opaqueIdSchema,
  x: z.number().int().min(0).max(BOARD_SIZE - 1),
  y: z.number().int().min(0).max(BOARD_SIZE - 1),
  expectedMoveNo: z.number().int().min(0).max(BOARD_CELLS),
}).strict();
const disconnectResolveSchema = z.object({
  actionId: actionIdSchema,
  roomInstanceId: opaqueIdSchema,
  baseVersion: versionSchema,
  roundId: opaqueIdSchema,
  targetPlayerId: opaqueIdSchema,
  decision: z.enum(['claim_win', 'keep_waiting']),
}).strict();

function randomId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashSecret(secret: string, salt: string): string {
  return scryptSync(secret, salt, 64).toString('hex');
}

function secretMatches(secret: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function responseActionId(raw: unknown): string {
  return raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).actionId === 'string'
    ? (raw as Record<string, unknown>).actionId as string
    : '';
}

function failure(
  actionId: string,
  errorCode: ErrorCode,
  message: string,
  retryable = false,
  needsSnapshot?: boolean,
): AckResult<never> {
  return { actionId, ok: false, errorCode, message, retryable, ...(needsSnapshot === undefined ? {} : { needsSnapshot }) };
}

function success<T>(actionId: string, data?: T, appliedVersion?: number): AckResult<T> {
  return {
    actionId,
    ok: true,
    ...(data === undefined ? {} : { data }),
    ...(appliedVersion === undefined ? {} : { appliedVersion }),
  };
}

function socketAck(rawAck: unknown): AckCallback {
  return typeof rawAck === 'function' ? rawAck as AckCallback : () => undefined;
}

function isAllowedOrigin(request: import('node:http').IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173' || origin === 'http://[::1]:5173') return true;
  try {
    const parsed = new URL(origin);
    const forwardedProtocol = request.headers['x-forwarded-proto'];
    const protocol = typeof forwardedProtocol === 'string'
      ? `${forwardedProtocol.split(',')[0].trim()}:`
      : parsed.protocol;
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    return typeof host === 'string' && parsed.origin === `${protocol}//${host.split(',')[0].trim()}`;
  } catch {
    return false;
  }
}

export function createGameServer(options: CreateGameServerOptions = {}): GameServer {
  const now = options.now ?? Date.now;
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.status(200).type('text/plain').send('ok'));

  if (options.serveStatic ?? true) {
    const clientDirectory = path.resolve(process.cwd(), 'dist/client');
    app.use(express.static(clientDirectory));
    app.get('/r/{*roomPath}', (_request, response) => response.sendFile(path.join(clientDirectory, 'index.html')));
  }

  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    maxHttpBufferSize: 16 * 1024,
    cors: { origin: true, credentials: false },
    allowRequest: (request, callback) => callback(null, isAllowedOrigin(request)),
    // Heartbeats run every five seconds and time out after another five. Thus a
    // dead transport is normally detected within roughly 5–10 seconds; business
    // reconnect/forfeit windows are deliberately much longer and clock-driven.
    pingInterval: 5_000,
    pingTimeout: 5_000,
  });
  const store = new GameStore({
    now,
    randomId,
    makeRoomCode,
    hashSecret,
    maxRooms: MAX_ROOMS,
    maxPlayers: MAX_PLAYERS,
    maxActionsPerPlayer: MAX_ACTIONS_PER_PLAYER,
    actionCacheTtlMs: ACTION_CACHE_TTL_MS,
  });
  const serverEpoch = randomId(SERVER_EPOCH_BYTES);
  const rateBuckets = new WeakMap<GameSocket, RateBucket>();
  // This is actor-scoped—not socket-scoped—so concurrent retries after a tab
  // handoff still share one actionId reservation.
  const inFlightActions = new WeakMap<PlayerRecord, Map<string, InFlightAction>>();
  const memberOperations = new MemberOperations();

  const actionFingerprint = (event: string, hash: string): string => `${event}\u0000${hash}`;

  const rateLimited = (socket: GameSocket): boolean => {
    const timestamp = now();
    const bucket = rateBuckets.get(socket) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((seenAt) => timestamp - seenAt < RATE_WINDOW_MS);
    if (bucket.timestamps.length >= RATE_MAX_REQUESTS) {
      rateBuckets.set(socket, bucket);
      return true;
    }
    bucket.timestamps.push(timestamp);
    rateBuckets.set(socket, bucket);
    return false;
  };

  const getCached = (player: PlayerRecord, event: string, actionId: string, hash: string): AckResult<unknown> | 'reused' | null => {
    store.pruneCache(player);
    const entry = player.actionCache.get(actionId);
    if (entry === undefined) return null;
    return entry.payloadHash === actionFingerprint(event, hash) ? clone(entry.response as AckResult<unknown>) : 'reused';
  };

  const cacheResponse = (player: PlayerRecord, event: string, actionId: string, hash: string, response: AckResult<unknown>): void => {
    player.actionCache.set(actionId, {
      payloadHash: actionFingerprint(event, hash),
      response: clone(response),
      createdAt: now(),
    });
    store.pruneCache(player);
  };

  const commit = (room: RoomRecord, changes: RoomChanges, causedByActionId?: string): PatchMessage => {
    const previousVersion = room.state.version;
    const timestamp = now();
    room.state.version += 1;
    room.state.updatedAt = timestamp;
    const patchChanges: RoomChanges = { ...changes, updatedAt: timestamp };
    return {
      roomInstanceId: room.state.roomInstanceId,
      prevVersion: previousVersion,
      version: room.state.version,
      serverTime: timestamp,
      ...(causedByActionId === undefined ? {} : { causedByActionId }),
      changes: clone(patchChanges),
    };
  };

  const snapshot = (socket: GameSocket, room: RoomRecord, syncRequestId?: string): void => {
    const message: SnapshotMessage = {
      roomInstanceId: room.state.roomInstanceId,
      version: room.state.version,
      serverTime: now(),
      ...(syncRequestId === undefined ? {} : { syncRequestId }),
      state: clone(room.state),
    };
    socket.emit('room:snapshot', message);
  };

  const broadcastPatch = (room: RoomRecord, patch: PatchMessage, except?: GameSocket): void => {
    if (except === undefined) io.to(room.state.roomInstanceId).emit('room:patch', patch);
    else except.to(room.state.roomInstanceId).emit('room:patch', patch);
  };

  const roomChanges = (room: RoomRecord, includeRound = false): RoomChanges => ({
    seats: clone(room.state.seats),
    ...(includeRound && room.state.round !== null ? { round: clone(room.state.round) } : {}),
    washProposal: clone(room.state.washProposal),
    noConnectedPlayersSince: room.state.noConnectedPlayersSince,
  });

  const actorForSocket = (socket: GameSocket, actionId: string): PlayerRecord | AckResult<never> => {
    const playerId = socket.data.playerId;
    const controlEpoch = socket.data.controlEpoch;
    if (playerId === undefined || controlEpoch === undefined) return failure(actionId, 'AUTH_REQUIRED', '请先建立会话。');
    const player = store.players.get(playerId);
    if (player === undefined) return failure(actionId, 'IDENTITY_EXPIRED', '身份已失效，请重新建立会话。');
    if (player.activeSocketId !== socket.id || player.controlEpoch !== controlEpoch) {
      return failure(actionId, 'SESSION_REPLACED', '此标签页已被新的控制连接接管。');
    }
    player.lastSeenAt = now();
    return player;
  };

  const isFailure = (value: PlayerRecord | AckResult<never>): value is AckResult<never> => !('playerId' in value);

  const memberRoom = (socket: GameSocket, player: PlayerRecord, roomInstanceId: string, actionId: string): RoomRecord | AckResult<never> => {
    if (player.roomInstanceId !== roomInstanceId) return failure(actionId, 'NOT_IN_ROOM', '你不在该房间中。');
    const room = store.roomsByInstance.get(roomInstanceId);
    if (room === undefined) return failure(actionId, 'ROOM_EXPIRED', '房间已经过期。');
    if (room.pendingMemberPlayerIds.has(player.playerId) || !socket.rooms.has(roomInstanceId)) {
      return failure(actionId, 'NOT_IN_ROOM', '你不在该房间中。');
    }
    if (seatForPlayer(room.state, player.playerId) === null) return failure(actionId, 'SEAT_RELEASED', '你的座位已失效。');
    return room;
  };

  const isRoomFailure = (value: RoomRecord | AckResult<never>): value is AckResult<never> => !('state' in value);

  const continuationFailure = (socket: GameSocket, player: PlayerRecord, room: RoomRecord, lease: symbol, actionId: string): AckResult<never> | null => {
    const actor = actorForSocket(socket, actionId);
    if (isFailure(actor)) return actor;
    if (!socket.connected) return failure(actionId, 'AUTH_REQUIRED', '连接已断开。', true);
    if (store.roomsByInstance.get(room.state.roomInstanceId) !== room) return failure(actionId, 'ROOM_EXPIRED', '房间已经失效。');
    if (player.roomInstanceId !== room.state.roomInstanceId || seatForPlayer(room.state, player.playerId) === null) {
      return failure(actionId, 'SEAT_RELEASED', '原座位已失效。');
    }
    if (!memberOperations.owns(room, player.playerId, lease)) return failure(actionId, 'INVALID_PHASE', '成员操作已被新的恢复请求替换。', true);
    return null;
  };

  const removeObsoleteMembership = async (socket: GameSocket, room: RoomRecord): Promise<void> => {
    try {
      await socket.leave(room.state.roomInstanceId);
    } catch {
      // A superseded connection must never remain subscribed to state broadcasts.
      socket.disconnect(true);
    }
  };

  const markSeatOffline = (room: RoomRecord, player: PlayerRecord): PatchMessage | null => {
    const seat = seatForPlayer(room.state, player.playerId);
    if (seat === null || !seat.connected) return null;
    const timestamp = now();
    seat.connected = false;
    seat.disconnectedAt = timestamp;
    seat.reconnectDeadline = timestamp + RECONNECT_GRACE_MS;
    seat.disconnectDecisionAvailable = false;
    clearReady(room.state);
    room.state.washProposal = null;
    let includeRound = false;
    if (room.state.phase === 'playing' && room.state.round !== null) {
      room.state.round.paused = true;
      includeRound = true;
    }
    updateNoConnectedPlayersSince(room.state, timestamp);
    return commit(room, roomChanges(room, includeRound));
  };

  const ownedRoomEntry = (player: PlayerRecord): RoomEntryData | null => {
    if (player.roomInstanceId === null) return null;
    const room = store.roomsByInstance.get(player.roomInstanceId);
    if (room === undefined || seatForPlayer(room.state, player.playerId) === null) return null;
    return roomEntry(room.state);
  };

  const runMaintenance = (): void => {
    const timestamp = now();
    for (const room of [...store.rooms.values()]) {
      if (room.state.noConnectedPlayersSince !== null
          && timestamp - room.state.noConnectedPlayersSince >= ROOM_IDLE_TTL_MS) {
        io.to(room.state.roomInstanceId).emit('room:expired', { message: '房间因双方离线过久已失效。' });
        store.removeRoom(room);
        continue;
      }
      let eligibilityChanged = false;
      for (const seat of room.state.seats) {
        if (seat === null) continue;
        const available = room.state.phase === 'playing' && !seat.connected
          && seat.reconnectDeadline !== null && timestamp >= seat.reconnectDeadline;
        if (seat.disconnectDecisionAvailable !== available) {
          seat.disconnectDecisionAvailable = available;
          eligibilityChanged = true;
        }
      }
      if (eligibilityChanged) {
        const patch = commit(room, roomChanges(room));
        broadcastPatch(room, patch);
      }
    }
  };

  const runAuthenticated = async <T>(
    socket: GameSocket,
    event: string,
    rawRequest: unknown,
    rawAck: unknown,
    schema: z.ZodType<T>,
    handler: (player: PlayerRecord, request: T) => Promise<AckResult<unknown>> | AckResult<unknown>,
    onCached?: (player: PlayerRecord, request: T, response: AckResult<unknown>) => Promise<void> | void,
  ): Promise<void> => {
    runMaintenance();
    const ack = socketAck(rawAck);
    const actionId = responseActionId(rawRequest);
    const actor = actorForSocket(socket, actionId);
    if (isFailure(actor)) {
      ack(actor);
      return;
    }
    const parsed = schema.safeParse(rawRequest);
    if (!parsed.success) {
      ack(failure(actionId, 'INVALID_PAYLOAD', '请求格式无效。'));
      return;
    }
    const request = parsed.data;
    const requestId = (request as { actionId: string }).actionId;
    const hash = payloadHash(rawRequest);
    const cached = getCached(actor, event, requestId, hash);
    if (cached === 'reused') {
      ack(failure(requestId, 'ACTION_ID_REUSED', '同一 actionId 不能用于不同请求。'));
      return;
    }
    if (cached !== null) {
      await onCached?.(actor, request, cached);
      ack(cached);
      return;
    }

    const fingerprint = actionFingerprint(event, hash);
    const pendingActions = inFlightActions.get(actor) ?? new Map<string, InFlightAction>();
    const pending = pendingActions.get(requestId);
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) ack(failure(requestId, 'ACTION_ID_REUSED', '同一 actionId 不能用于不同请求。'));
      else ack(clone(await pending.response));
      return;
    }
    if (rateLimited(socket)) {
      const response = failure(requestId, 'RATE_LIMITED', '请求过于频繁，请稍后重试。', true);
      cacheResponse(actor, event, requestId, hash, response);
      ack(response);
      return;
    }

    let resolvePending!: (result: AckResult<unknown>) => void;
    const pendingResponse = new Promise<AckResult<unknown>>((resolve) => { resolvePending = resolve; });
    pendingActions.set(requestId, { fingerprint, response: pendingResponse });
    inFlightActions.set(actor, pendingActions);
    let response: AckResult<unknown>;
    try {
      response = await handler(actor, request);
    } catch {
      response = failure(requestId, 'INTERNAL_ERROR', '服务器暂时无法处理该请求。', true);
    }
    cacheResponse(actor, event, requestId, hash, response);
    resolvePending(clone(response));
    pendingActions.delete(requestId);
    ack(response);
  };

  const handleSessionOpen = async (socket: GameSocket, rawRequest: unknown, rawAck: unknown): Promise<void> => {
    runMaintenance();
    const ack = socketAck(rawAck);
    const actionId = responseActionId(rawRequest);
    const parsed = sessionOpenSchema.safeParse(rawRequest);
    if (!parsed.success) {
      ack(failure(actionId, 'INVALID_PAYLOAD', '请求格式无效。'));
      return;
    }
    const request: SessionOpenRequest = parsed.data;
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      ack(failure(request.actionId, 'PROTOCOL_MISMATCH', '客户端协议版本不兼容。'));
      return;
    }

    if (socket.data.playerId !== undefined) {
      const existing = actorForSocket(socket, request.actionId);
      if (isFailure(existing)) {
        ack(existing);
        return;
      }
      const hash = payloadHash(rawRequest);
      const cached = getCached(existing, 'session:open', request.actionId, hash);
      if (cached === 'reused') ack(failure(request.actionId, 'ACTION_ID_REUSED', '同一 actionId 不能用于不同请求。'));
      else if (cached !== null) ack(cached);
      else ack(failure(request.actionId, 'AUTH_INVALID', '已认证连接不能切换身份。'));
      return;
    }
    if (rateLimited(socket)) {
      ack(failure(request.actionId, 'RATE_LIMITED', '身份请求过于频繁，请稍后重试。', true));
      return;
    }

    let player: PlayerRecord;
    let issuedSecret: string | undefined;
    if (request.playerId !== undefined && request.secret !== undefined) {
      const recoveredPlayer = store.players.get(request.playerId);
      if (recoveredPlayer === undefined) {
        ack(failure(request.actionId, 'IDENTITY_EXPIRED', '身份已失效，请重新建立会话。'));
        return;
      }
      if (!secretMatches(request.secret, recoveredPlayer.secretSalt, recoveredPlayer.secretHash)) {
        ack(failure(request.actionId, 'AUTH_INVALID', '身份凭据无效。'));
        return;
      }
      player = recoveredPlayer;
    } else {
      const created = store.createPlayer(request.nickname ?? '');
      if (created === null) {
        ack(failure(request.actionId, 'RATE_LIMITED', '服务器暂时无法创建更多身份。', true));
        return;
      }
      player = created.player;
      issuedSecret = created.secret;
    }

    // Advance epoch before any await: the old controller can no longer leave or
    // move while its Socket.IO membership is being removed.
    const oldSocketId = player.activeSocketId;
    player.controlEpoch += 1;
    player.activeSocketId = socket.id;
    player.lastSeenAt = now();
    socket.data.playerId = player.playerId;
    socket.data.controlEpoch = player.controlEpoch;
    if (oldSocketId !== null && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId) as GameSocket | undefined;
      if (oldSocket !== undefined) {
        oldSocket.emit('session:replaced', { message: '此标签页已被新的控制连接接管。' });
        const previousRoom = player.roomInstanceId === null ? undefined : store.roomsByInstance.get(player.roomInstanceId);
        if (previousRoom !== undefined) await removeObsoleteMembership(oldSocket, previousRoom);
        else oldSocket.disconnect(true);
      }
      const currentActor = actorForSocket(socket, request.actionId);
      if (isFailure(currentActor)) {
        ack(currentActor);
        return;
      }
      // session:open deliberately does not auto-resume a room. The seat becomes
      // offline until room:resume has joined this current controller and sent a
      // full snapshot, preventing pre-snapshot play by a new tab.
      if (player.roomInstanceId !== null) {
        const room = store.roomsByInstance.get(player.roomInstanceId);
        if (room !== undefined) {
          const patch = markSeatOffline(room, player);
          if (patch !== null) broadcastPatch(room, patch);
        }
      }
    }

    const response = success<SessionData>(request.actionId, {
      playerId: player.playerId,
      nickname: player.nickname,
      ...(issuedSecret === undefined ? {} : { secret: issuedSecret }),
      serverEpoch,
      serverTime: now(),
      room: ownedRoomEntry(player),
    });
    cacheResponse(player, 'session:open', request.actionId, payloadHash(rawRequest), response);
    ack(response);
  };

  const createRoom = async (socket: GameSocket, player: PlayerRecord, request: { actionId: string }): Promise<AckResult<RoomEntryData>> => {
    if (player.roomInstanceId !== null) return failure(request.actionId, 'ALREADY_IN_ROOM', '你已经在一个房间中。');
    const identity = store.nextRoomIdentity();
    const timestamp = now();
    const state: RoomState = {
      roomCode: identity.roomCode,
      roomInstanceId: identity.roomInstanceId,
      version: 1,
      phase: 'waiting',
      seats: [publicSeat('A', player), null],
      round: null,
      faces: {},
      drawing: null,
      washProposal: null,
      noConnectedPlayersSince: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const room = store.createRoom(state, player);
    if (room === null) return failure(request.actionId, 'RATE_LIMITED', '服务器暂时无法创建更多房间。', true);
    const lease = memberOperations.begin(room, player.playerId, socket.id, player.controlEpoch)!;
    try {
      await socket.join(room.state.roomInstanceId);
    } catch {
      await removeObsoleteMembership(socket, room);
      const invalid = continuationFailure(socket, player, room, lease, request.actionId);
      memberOperations.finish(room, player.playerId, lease);
      if (invalid !== null) return invalid;
      io.to(room.state.roomInstanceId).emit('room:expired', { message: '房间创建失败，原房间已失效。' });
      store.removeRoom(room);
      return failure(request.actionId, 'INTERNAL_ERROR', '加入新房间失败。', true);
    }
    const invalid = continuationFailure(socket, player, room, lease, request.actionId);
    if (invalid !== null) {
      await removeObsoleteMembership(socket, room);
      memberOperations.finish(room, player.playerId, lease);
      return invalid;
    }
    snapshot(socket, room);
    memberOperations.finish(room, player.playerId, lease);
    return success(request.actionId, roomEntry(room.state), room.state.version);
  };

  const joinRoom = async (socket: GameSocket, player: PlayerRecord, request: JoinRequest): Promise<AckResult<RoomEntryData>> => {
    if (player.roomInstanceId !== null) return failure(request.actionId, 'ALREADY_IN_ROOM', '你已经在一个房间中。');
    const room = store.rooms.get(request.roomCode);
    if (room === undefined) return failure(request.actionId, 'ROOM_NOT_FOUND', '房间不存在。');
    const seatIndex = room.state.seats.findIndex((seat) => seat === null);
    if (seatIndex === -1) return failure(request.actionId, 'ROOM_FULL', '房间已满，请创建新房间。');

    const lease = memberOperations.begin(room, player.playerId, socket.id, player.controlEpoch);
    if (lease === null) return failure(request.actionId, 'INVALID_PHASE', '成员操作正在处理中，请稍候。', true);
    const previousNoConnectedPlayersSince = room.state.noConnectedPlayersSince;
    const seatId: SeatId = seatIndex === 0 ? 'A' : 'B';
    room.state.seats[seatIndex] = publicSeat(seatId, player);
    player.roomInstanceId = room.state.roomInstanceId;
    updateNoConnectedPlayersSince(room.state, now());
    const reservationPatch = commit(room, roomChanges(room), request.actionId);
    // Existing authorized members learn the reservation before join awaits. The
    // pending gate prevents the not-yet-joined socket from acting on it.
    broadcastPatch(room, reservationPatch);

    try {
      await socket.join(room.state.roomInstanceId);
    } catch {
      await removeObsoleteMembership(socket, room);
      const invalid = continuationFailure(socket, player, room, lease, request.actionId);
      if (invalid !== null) {
        memberOperations.finish(room, player.playerId, lease);
        return invalid;
      }
      room.state.seats[seatIndex] = null;
      player.roomInstanceId = null;
      room.state.noConnectedPlayersSince = previousNoConnectedPlayersSince;
      updateNoConnectedPlayersSince(room.state, now());
      const rollbackPatch = commit(room, roomChanges(room), request.actionId);
      broadcastPatch(room, rollbackPatch);
      memberOperations.finish(room, player.playerId, lease);
      return failure(request.actionId, 'INTERNAL_ERROR', '加入房间失败。', true);
    }
    const invalid = continuationFailure(socket, player, room, lease, request.actionId);
    if (invalid !== null) {
      await removeObsoleteMembership(socket, room);
      memberOperations.finish(room, player.playerId, lease);
      return invalid;
    }
    // A real new member, unlike a failed reservation above, invalidates both
    // readiness and any M3 wash proposal. Keep its gate closed until the
    // resulting state is on the socket's event queue.
    const hadReady = room.state.seats.some((candidate) => candidate?.ready === true);
    if (hadReady || room.state.washProposal !== null) {
      clearReady(room.state);
      room.state.washProposal = null;
      const memberPatch = commit(room, roomChanges(room), request.actionId);
      broadcastPatch(room, memberPatch);
    }
    snapshot(socket, room);
    memberOperations.finish(room, player.playerId, lease);
    return success(request.actionId, roomEntry(room.state), room.state.version);
  };

  const resumeRoom = async (socket: GameSocket, player: PlayerRecord, request: ResumeRequest): Promise<AckResult<RoomEntryData>> => {
    // Resolve by code first and require the exact, non-reusable instance before
    // inspecting any seat. A third identity receives no state on any failure.
    const room = store.rooms.get(request.roomCode);
    if (room === undefined || room.state.roomInstanceId !== request.roomInstanceId) {
      return failure(request.actionId, 'ROOM_EXPIRED', '房间已经失效，不能恢复到新实例。');
    }
    if (player.roomInstanceId !== request.roomInstanceId) return failure(request.actionId, 'SEAT_RELEASED', '原座位已失效。');
    const seat = seatForPlayer(room.state, player.playerId);
    if (seat === null) return failure(request.actionId, 'SEAT_RELEASED', '原座位已失效。');

    // A distinct resume action after transport uncertainty must always send a
    // snapshot, even if its current controller is already online.
    if (seat.connected && socket.rooms.has(room.state.roomInstanceId) && !room.pendingMemberPlayerIds.has(player.playerId)) {
      snapshot(socket, room, request.syncRequestId);
      return success(request.actionId, roomEntry(room.state), room.state.version);
    }

    const lease = memberOperations.begin(room, player.playerId, socket.id, player.controlEpoch);
    if (lease === null) return failure(request.actionId, 'INVALID_PHASE', '成员操作正在处理中，请稍候。', true);
    const priorSeat = clone(seat);
    const previousNoConnectedPlayersSince = room.state.noConnectedPlayersSince;
    seat.connected = true;
    seat.disconnectedAt = null;
    seat.reconnectDeadline = null;
    seat.disconnectDecisionAvailable = false;
    updateNoConnectedPlayersSince(room.state, now());
    // Keep a playing round paused through join and the mandatory snapshot. It
    // eliminates a pre-snapshot action window for the reconnecting controller.
    const onlinePatch = commit(room, roomChanges(room), request.actionId);
    broadcastPatch(room, onlinePatch);

    try {
      await socket.join(room.state.roomInstanceId);
    } catch {
      await removeObsoleteMembership(socket, room);
      const invalid = continuationFailure(socket, player, room, lease, request.actionId);
      if (invalid !== null) {
        memberOperations.finish(room, player.playerId, lease);
        return invalid;
      }
      Object.assign(seat, priorSeat);
      room.state.noConnectedPlayersSince = previousNoConnectedPlayersSince;
      updateNoConnectedPlayersSince(room.state, now());
      const rollbackPatch = commit(room, roomChanges(room), request.actionId);
      broadcastPatch(room, rollbackPatch);
      memberOperations.finish(room, player.playerId, lease);
      return failure(request.actionId, 'INTERNAL_ERROR', '恢复房间失败。', true);
    }
    const invalid = continuationFailure(socket, player, room, lease, request.actionId);
    if (invalid !== null) {
      await removeObsoleteMembership(socket, room);
      memberOperations.finish(room, player.playerId, lease);
      return invalid;
    }

    // While the snapshot is emitted, the pending gate remains active. It opens
    // only once that complete pre-unpause state is on this socket's event queue.
    snapshot(socket, room, request.syncRequestId);
    memberOperations.finish(room, player.playerId, lease);
    if (room.state.phase === 'playing' && room.state.round !== null && seatsAreOnline(room.state) && room.state.round.paused) {
      room.state.round.paused = false;
      const unpausePatch = commit(room, roomChanges(room, true), request.actionId);
      broadcastPatch(room, unpausePatch);
      return success(request.actionId, roomEntry(room.state), unpausePatch.version);
    }
    return success(request.actionId, roomEntry(room.state), room.state.version);
  };

  const replayCachedResume = (socket: GameSocket, player: PlayerRecord, request: ResumeRequest, response: AckResult<unknown>): void => {
    if (!response.ok || player.roomInstanceId !== request.roomInstanceId) return;
    const room = store.rooms.get(request.roomCode);
    if (room === undefined || room.state.roomInstanceId !== request.roomInstanceId) return;
    if (seatForPlayer(room.state, player.playerId) !== null && socket.rooms.has(room.state.roomInstanceId)) {
      snapshot(socket, room, request.syncRequestId);
    }
  };

  const setReady = (socket: GameSocket, player: PlayerRecord, request: ReadyRequest): AckResult => {
    const member = memberRoom(socket, player, request.roomInstanceId, request.actionId);
    if (isRoomFailure(member)) return member;
    const room = member;
    if (room.state.phase !== 'waiting' && room.state.phase !== 'finished') {
      return failure(request.actionId, 'INVALID_PHASE', '当前阶段不能准备。');
    }
    if (room.pendingMemberPlayerIds.size > 0) {
      return failure(request.actionId, 'GAME_PAUSED', '成员正在切换连接或离开，请稍后重新准备。', true);
    }
    const expectedRoundId = room.state.round?.roundId ?? null;
    if (request.roundId !== expectedRoundId) return failure(request.actionId, 'STALE_ROUND', '准备请求引用了过期对局。', false, true);
    const seat = seatForPlayer(room.state, player.playerId);
    if (seat === null) return failure(request.actionId, 'SEAT_RELEASED', '你的座位已失效。');
    if (seat.ready === request.ready) return success(request.actionId, undefined, room.state.version);

    seat.ready = request.ready;
    const [seatA, seatB] = room.state.seats;
    let changes: RoomChanges = roomChanges(room);
    if (seatA !== null && seatB !== null && seatsAreOnline(room.state) && seatA.ready && seatB.ready) {
      const round = createRound(room.state.round, [seatA, seatB], randomId(ROUND_ID_BYTES));
      room.state.phase = 'playing';
      room.state.round = round;
      clearReady(room.state);
      changes = { phase: room.state.phase, ...roomChanges(room, true) };
    }
    const patch = commit(room, changes, request.actionId);
    broadcastPatch(room, patch);
    return success(request.actionId, undefined, patch.version);
  };

  const move = (socket: GameSocket, player: PlayerRecord, request: MoveRequest): AckResult => {
    const member = memberRoom(socket, player, request.roomInstanceId, request.actionId);
    if (isRoomFailure(member)) return member;
    const room = member;
    const round = room.state.round;
    if (round === null || round.roundId !== request.roundId) return failure(request.actionId, 'STALE_ROUND', '该对局已经过期。', false, true);
    if (room.state.phase !== 'playing') return failure(request.actionId, 'INVALID_PHASE', '当前阶段不能落子。', false, true);
    if (round.paused) return failure(request.actionId, 'GAME_PAUSED', '对局已暂停。', true, true);
    if (!round.participantIds.includes(player.playerId)) return failure(request.actionId, 'SEAT_RELEASED', '你不是本局参与者。');
    if (round.turnPlayerId !== player.playerId) return failure(request.actionId, 'NOT_YOUR_TURN', '尚未轮到你落子。', false, true);
    if (request.expectedMoveNo !== round.moveNo) return failure(request.actionId, 'STALE_MOVE', '落子序号已过期。', false, true);
    const index = boardIndex(request.x, request.y);
    if (round.board[index] !== 0) return failure(request.actionId, 'CELL_OCCUPIED', '该位置已有棋子。', false, true);

    const color: 1 | 2 = round.blackPlayerId === player.playerId ? 1 : 2;
    round.board[index] = color;
    round.moveNo += 1;
    round.lastMove = { x: request.x, y: request.y, playerId: player.playerId, color, moveNo: round.moveNo };
    const winningLine = winningLineForMove(round.board, request.x, request.y, color);
    if (winningLine !== null) {
      round.turnPlayerId = null;
      round.result = {
        winnerPlayerId: player.playerId,
        loserPlayerId: round.participantIds.find((participantId) => participantId !== player.playerId) ?? null,
        reason: 'five',
        winningLine,
        endedAt: now(),
      };
      room.state.phase = 'finished';
    } else if (isBoardFull(round.board)) {
      round.turnPlayerId = null;
      round.result = { winnerPlayerId: null, loserPlayerId: null, reason: 'draw', winningLine: [], endedAt: now() };
      room.state.phase = 'finished';
    } else {
      round.turnPlayerId = round.participantIds.find((participantId) => participantId !== player.playerId) ?? null;
    }
    const patch = commit(room, { phase: room.state.phase, round: clone(round) }, request.actionId);
    broadcastPatch(room, patch);
    return success(request.actionId, undefined, patch.version);
  };

  const resolveDisconnect = (socket: GameSocket, player: PlayerRecord, request: DisconnectResolveRequest): AckResult => {
    const member = memberRoom(socket, player, request.roomInstanceId, request.actionId);
    if (isRoomFailure(member)) return member;
    const room = member;
    const round = room.state.round;
    if (room.state.phase !== 'playing' || round === null || round.roundId !== request.roundId) {
      return failure(request.actionId, 'STALE_ROUND', '该对局已经过期。', false, true);
    }
    const actorSeat = seatForPlayer(room.state, player.playerId);
    if (actorSeat === null || !actorSeat.connected || !round.participantIds.includes(player.playerId)) {
      return failure(request.actionId, 'SEAT_RELEASED', '你不是当前在线的本局对手。');
    }
    const opponentId = round.participantIds.find((participantId) => participantId !== player.playerId);
    if (opponentId === undefined || opponentId !== request.targetPlayerId) {
      return failure(request.actionId, 'SEAT_RELEASED', '只能对本局原对手进行裁决。');
    }
    const targetSeat = seatForPlayer(room.state, request.targetPlayerId);
    if (targetSeat === null || targetSeat.connected || targetSeat.disconnectedAt === null) {
      return failure(request.actionId, 'INVALID_PHASE', '对手当前不处于可裁决的离线状态。', false, true);
    }
    if (now() - targetSeat.disconnectedAt < RECONNECT_GRACE_MS) {
      return failure(request.actionId, 'GAME_PAUSED', '对手离线尚未满 60 秒。', true, true);
    }
    if (request.decision === 'keep_waiting') {
      // This decision intentionally stores no grace-period reset: a later claim
      // is still valid as soon as the same target remains offline.
      return success(request.actionId, undefined, room.state.version);
    }

    round.turnPlayerId = null;
    round.paused = false;
    round.result = {
      winnerPlayerId: player.playerId,
      loserPlayerId: request.targetPlayerId,
      reason: 'disconnect',
      winningLine: [],
      endedAt: now(),
    };
    room.state.phase = 'finished';
    const targetPlayer = store.players.get(request.targetPlayerId);
    const targetIndex = seatIndexForPlayer(room.state, request.targetPlayerId);
    if (targetIndex !== -1) room.state.seats[targetIndex] = null;
    if (targetPlayer?.roomInstanceId === room.state.roomInstanceId) targetPlayer.roomInstanceId = null;
    clearReady(room.state);
    updateNoConnectedPlayersSince(room.state, now());
    const patch = commit(room, { phase: room.state.phase, ...roomChanges(room, true) }, request.actionId);
    broadcastPatch(room, patch);
    return success(request.actionId, undefined, patch.version);
  };

  const leaveRoom = async (socket: GameSocket, player: PlayerRecord, request: LeaveRequest): Promise<AckResult> => {
    const member = memberRoom(socket, player, request.roomInstanceId, request.actionId);
    if (isRoomFailure(member)) return member;
    const room = member;
    const expectedRoundId = room.state.round?.roundId ?? null;
    if (request.roundId !== expectedRoundId) return failure(request.actionId, 'STALE_ROUND', '离开请求引用了过期对局。', false, true);
    const leavingIndex = seatIndexForPlayer(room.state, player.playerId);
    if (leavingIndex === -1) return failure(request.actionId, 'SEAT_RELEASED', '你的座位已失效。');

    const lease = memberOperations.begin(room, player.playerId, socket.id, player.controlEpoch);
    if (lease === null) return failure(request.actionId, 'INVALID_PHASE', '成员操作正在处理中，请稍候。', true);
    // First remove this socket from the room group. It can never observe the
    // patch that releases it nor any later state intended for a replacement.
    try {
      await socket.leave(room.state.roomInstanceId);
    } catch {
      const invalid = continuationFailure(socket, player, room, lease, request.actionId);
      if (invalid === null && !socket.rooms.has(room.state.roomInstanceId)) {
        const offlinePatch = markSeatOffline(room, player);
        if (offlinePatch !== null) broadcastPatch(room, offlinePatch);
      }
      memberOperations.finish(room, player.playerId, lease);
      if (invalid !== null) return invalid;
      return failure(request.actionId, 'INTERNAL_ERROR', '离开房间失败。', true);
    }
    const invalid = continuationFailure(socket, player, room, lease, request.actionId);
    if (invalid !== null) {
      memberOperations.finish(room, player.playerId, lease);
      return invalid;
    }
    if (request.roundId !== (room.state.round?.roundId ?? null)) {
      const offlinePatch = markSeatOffline(room, player);
      if (offlinePatch !== null) broadcastPatch(room, offlinePatch);
      memberOperations.finish(room, player.playerId, lease);
      return failure(request.actionId, 'STALE_ROUND', '离开请求引用了过期对局。', false, true);
    }

    const round = room.state.round;
    if (room.state.phase === 'playing' && round !== null) {
      const winnerPlayerId = round.participantIds.find((participantId) => participantId !== player.playerId) ?? null;
      round.turnPlayerId = null;
      round.paused = false;
      round.result = {
        winnerPlayerId,
        loserPlayerId: player.playerId,
        reason: 'resign',
        winningLine: [],
        endedAt: now(),
      };
      room.state.phase = 'finished';
    }
    room.state.seats[leavingIndex] = null;
    if (player.roomInstanceId === room.state.roomInstanceId) player.roomInstanceId = null;
    clearReady(room.state);
    room.state.washProposal = null;
    updateNoConnectedPlayersSince(room.state, now());
    const patch = commit(room, {
      ...(room.state.phase === 'playing' ? {} : { phase: room.state.phase }),
      ...roomChanges(room, round !== null),
    }, request.actionId);
    broadcastPatch(room, patch);
    memberOperations.finish(room, player.playerId, lease);
    return success(request.actionId, undefined, patch.version);
  };

  const sync = (socket: GameSocket, player: PlayerRecord, request: SyncRequest): AckResult => {
    const member = memberRoom(socket, player, request.roomInstanceId, request.actionId);
    if (isRoomFailure(member)) return member;
    snapshot(socket, member, request.syncRequestId);
    return success(request.actionId, undefined, member.state.version);
  };

  const disconnect = (socket: GameSocket): void => {
    const playerId = socket.data.playerId;
    const epoch = socket.data.controlEpoch;
    if (playerId === undefined || epoch === undefined) return;
    const player = store.players.get(playerId);
    if (player === undefined || player.activeSocketId !== socket.id || player.controlEpoch !== epoch) return;
    player.activeSocketId = null;
    player.lastSeenAt = now();
    if (player.roomInstanceId === null) return;
    const room = store.roomsByInstance.get(player.roomInstanceId);
    if (room === undefined) return;
    const patch = markSeatOffline(room, player);
    if (patch !== null) broadcastPatch(room, patch);
  };

  io.on('connection', (socket) => {
    const gameSocket = socket as GameSocket;
    gameSocket.emit('server:hello', { protocolVersion: PROTOCOL_VERSION, serverEpoch, serverTime: now() });
    gameSocket.on('session:open', (request, ack) => { void handleSessionOpen(gameSocket, request, ack); });
    gameSocket.on('room:create', (request, ack) => {
      void runAuthenticated(gameSocket, 'room:create', request, ack, createSchema, (player, parsed) => createRoom(gameSocket, player, parsed));
    });
    gameSocket.on('room:join', (request, ack) => {
      void runAuthenticated(gameSocket, 'room:join', request, ack, joinSchema, (player, parsed) => joinRoom(gameSocket, player, parsed));
    });
    gameSocket.on('room:resume', (request, ack) => {
      void runAuthenticated(
        gameSocket,
        'room:resume',
        request,
        ack,
        resumeSchema,
        (player, parsed) => resumeRoom(gameSocket, player, parsed),
        (player, parsed, response) => replayCachedResume(gameSocket, player, parsed, response),
      );
    });
    gameSocket.on('room:sync', (request, ack) => {
      void runAuthenticated(gameSocket, 'room:sync', request, ack, syncSchema, (player, parsed) => sync(gameSocket, player, parsed));
    });
    gameSocket.on('room:leave', (request, ack) => {
      void runAuthenticated(gameSocket, 'room:leave', request, ack, leaveSchema, (player, parsed) => leaveRoom(gameSocket, player, parsed));
    });
    gameSocket.on('round:ready', (request, ack) => {
      void runAuthenticated(gameSocket, 'round:ready', request, ack, readySchema, (player, parsed) => setReady(gameSocket, player, parsed));
    });
    gameSocket.on('game:move', (request, ack) => {
      void runAuthenticated(gameSocket, 'game:move', request, ack, moveSchema, (player, parsed) => move(gameSocket, player, parsed));
    });
    gameSocket.on('disconnect:resolve', (request, ack) => {
      void runAuthenticated(gameSocket, 'disconnect:resolve', request, ack, disconnectResolveSchema, (player, parsed) => resolveDisconnect(gameSocket, player, parsed));
    });
    gameSocket.on('disconnect', () => disconnect(gameSocket));
  });

  const configuredMaintenanceInterval = options.maintenanceIntervalMs ?? 1_000;
  const maintenanceTimer = configuredMaintenanceInterval > 0
    ? setInterval(runMaintenance, configuredMaintenanceInterval)
    : undefined;
  maintenanceTimer?.unref();

  const close = async (): Promise<void> => {
    if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { app, httpServer, io, store, runMaintenance, close };
}
