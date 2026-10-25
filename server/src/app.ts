import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express, { type Express } from 'express';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';

import { BOARD_CELLS, BOARD_SIZE, NICKNAME_MAX_LENGTH, PROTOCOL_VERSION } from '../../shared/constants.js';
import type {
  Cell,
  PatchMessage,
  PublicRound,
  PublicSeat,
  RoomChanges,
  RoomState,
  SeatId,
  SnapshotMessage,
} from '../../shared/models.js';
import type {
  AckResult,
  ClientToServerEvents,
  ErrorCode,
  JoinRequest,
  MoveRequest,
  ReadyRequest,
  RoomEntryData,
  ServerToClientEvents,
  SessionData,
  SessionOpenRequest,
  SocketData,
  SyncRequest,
} from '../../shared/protocol.js';
import { isBoardFull, boardIndex, winningLineForMove } from './domain/rules.js';

const ROOM_CODE_LENGTH = 6;
const PLAYER_ID_BYTES = 18;
const SECRET_BYTES = 32;
const ROOM_INSTANCE_BYTES = 18;
const ROUND_ID_BYTES = 18;
const SERVER_EPOCH_BYTES = 12;
const MAX_ROOMS = 500;
const MAX_PLAYERS = 2_000;
const MAX_ACTIONS_PER_PLAYER = 200;
const ACTION_CACHE_TTL_MS = 10 * 60_000;
const RATE_WINDOW_MS = 10_000;
// A player can legally place up to 113 stones in one complete 15×15 game.
// Keep this comfortably above that legitimate burst while still bounding abuse.
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

interface PlayerRecord {
  playerId: string;
  nickname: string;
  secretSalt: string;
  secretHash: string;
  activeSocketId: string | null;
  controlEpoch: number;
  roomInstanceId: string | null;
  createdAt: number;
  lastSeenAt: number;
  actionCache: Map<string, ActionCacheEntry>;
}

interface ActionCacheEntry {
  payloadHash: string;
  response: AckResult<unknown>;
  createdAt: number;
}

interface RoomRecord {
  state: RoomState;
  pendingJoinPlayerIds: Set<string>;
}

interface RateBucket {
  timestamps: number[];
}

export interface CreateGameServerOptions {
  /** Tests normally disable static files. Production index.ts enables them. */
  serveStatic?: boolean;
}

export interface GameStoreView {
  readonly rooms: ReadonlyMap<string, RoomRecord>;
  readonly players: ReadonlyMap<string, PlayerRecord>;
}

export interface GameServer {
  app: Express;
  httpServer: HttpServer;
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  store: GameStoreView;
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
const joinSchema = z.object({
  actionId: actionIdSchema,
  roomCode: roomCodeSchema,
}).strict();
const syncSchema = z.object({
  actionId: actionIdSchema,
  roomInstanceId: opaqueIdSchema,
  lastVersion: versionSchema,
  syncRequestId: opaqueIdSchema,
}).strict();
const readySchema = z.object({
  actionId: actionIdSchema,
  roomInstanceId: opaqueIdSchema,
  baseVersion: versionSchema,
  roundId: z.string().min(12).max(128).nullable(),
  ready: z.boolean(),
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

function randomId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function makeRoomCode(): string {
  // Ambiguous characters are deliberately omitted for verbal room-code entry.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
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
  if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).actionId === 'string') {
    const actionId = (raw as Record<string, unknown>).actionId;
    return actionId as string;
  }
  return '';
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

function publicSeat(seatId: SeatId, player: PlayerRecord, now: number): PublicSeat {
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

function isAllowedOrigin(request: import('node:http').IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    // Socket.IO clients and health probes do not send Origin. Browser WebSocket
    // requests are still checked below.
    return true;
  }
  if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173' || origin === 'http://[::1]:5173') {
    return true;
  }
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

class GameStore {
  readonly rooms = new Map<string, RoomRecord>();
  readonly roomsByInstance = new Map<string, RoomRecord>();
  readonly players = new Map<string, PlayerRecord>();

  createPlayer(nickname: string): PlayerRecord | null {
    this.pruneInactivePlayers();
    if (this.players.size >= MAX_PLAYERS) {
      return null;
    }
    const secret = randomId(SECRET_BYTES);
    const salt = randomId(16);
    const player: PlayerRecord = {
      playerId: randomId(PLAYER_ID_BYTES),
      nickname: nickname.trim(),
      secretSalt: salt,
      secretHash: hashSecret(secret, salt),
      activeSocketId: null,
      controlEpoch: 0,
      roomInstanceId: null,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      actionCache: new Map(),
    };
    this.players.set(player.playerId, player);
    // The one-time cleartext is intentionally not retained in PlayerRecord.
    Object.defineProperty(player, '__issuedSecret', { value: secret, enumerable: false, configurable: true });
    return player;
  }

  issuedSecret(player: PlayerRecord): string | undefined {
    const candidate = (player as PlayerRecord & { __issuedSecret?: string }).__issuedSecret;
    if (candidate !== undefined) {
      delete (player as PlayerRecord & { __issuedSecret?: string }).__issuedSecret;
    }
    return candidate;
  }

  createRoom(player: PlayerRecord): RoomRecord | null {
    if (this.rooms.size >= MAX_ROOMS) {
      return null;
    }
    let roomCode = makeRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = makeRoomCode();
    }
    const now = Date.now();
    const state: RoomState = {
      roomCode,
      roomInstanceId: randomId(ROOM_INSTANCE_BYTES),
      version: 1,
      phase: 'waiting',
      seats: [publicSeat('A', player, now), null],
      round: null,
      faces: {},
      drawing: null,
      washProposal: null,
      noConnectedPlayersSince: null,
      createdAt: now,
      updatedAt: now,
    };
    const room: RoomRecord = { state, pendingJoinPlayerIds: new Set([player.playerId]) };
    this.rooms.set(state.roomCode, room);
    this.roomsByInstance.set(state.roomInstanceId, room);
    player.roomInstanceId = state.roomInstanceId;
    return room;
  }

  pruneCache(player: PlayerRecord, now = Date.now()): void {
    for (const [key, entry] of player.actionCache) {
      if (now - entry.createdAt > ACTION_CACHE_TTL_MS) {
        player.actionCache.delete(key);
      }
    }
    while (player.actionCache.size > MAX_ACTIONS_PER_PLAYER) {
      const oldest = player.actionCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      player.actionCache.delete(oldest);
    }
  }

  private pruneInactivePlayers(): void {
    if (this.players.size < MAX_PLAYERS) return;
    for (const [playerId, player] of this.players) {
      if (this.players.size < MAX_PLAYERS) break;
      if (player.activeSocketId === null && player.roomInstanceId === null) {
        this.players.delete(playerId);
      }
    }
  }
}

export function createGameServer(options: CreateGameServerOptions = {}): GameServer {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.status(200).type('text/plain').send('ok'));

  if (options.serveStatic ?? true) {
    const clientDirectory = path.resolve(process.cwd(), 'dist/client');
    app.use(express.static(clientDirectory));
    // Express 5 / path-to-regexp v8 requires a named wildcard.
    app.get('/r/{*roomPath}', (_request, response) => response.sendFile(path.join(clientDirectory, 'index.html')));
  }

  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    maxHttpBufferSize: 16 * 1024,
    cors: { origin: true, credentials: false },
    allowRequest: (request, callback) => callback(null, isAllowedOrigin(request)),
  });
  const store = new GameStore();
  const serverEpoch = randomId(SERVER_EPOCH_BYTES);
  const rateBuckets = new WeakMap<GameSocket, RateBucket>();
  const inFlightActions = new WeakMap<PlayerRecord, Map<string, {
    fingerprint: string;
    response: Promise<AckResult<unknown>>;
  }>>();

  const rateLimited = (socket: GameSocket): boolean => {
    const now = Date.now();
    const bucket = rateBuckets.get(socket) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
    if (bucket.timestamps.length >= RATE_MAX_REQUESTS) {
      rateBuckets.set(socket, bucket);
      return true;
    }
    bucket.timestamps.push(now);
    rateBuckets.set(socket, bucket);
    return false;
  };

  const actionFingerprint = (event: string, hash: string): string => `${event}\u0000${hash}`;

  const getCached = (player: PlayerRecord, event: string, actionId: string, hash: string): AckResult<unknown> | 'reused' | null => {
    store.pruneCache(player);
    const entry = player.actionCache.get(actionId);
    if (entry === undefined) return null;
    return entry.payloadHash === actionFingerprint(event, hash) ? clone(entry.response) : 'reused';
  };

  const cacheResponse = (player: PlayerRecord, event: string, actionId: string, hash: string, response: AckResult<unknown>): void => {
    player.actionCache.set(actionId, { payloadHash: actionFingerprint(event, hash), response: clone(response), createdAt: Date.now() });
    store.pruneCache(player);
  };

  const actorForSocket = (socket: GameSocket, actionId: string): PlayerRecord | AckResult<never> => {
    const playerId = socket.data.playerId;
    const controlEpoch = socket.data.controlEpoch;
    if (playerId === undefined || controlEpoch === undefined) {
      return failure(actionId, 'AUTH_REQUIRED', '请先建立会话。');
    }
    const player = store.players.get(playerId);
    if (player === undefined) {
      return failure(actionId, 'IDENTITY_EXPIRED', '身份已失效，请重新建立会话。');
    }
    if (player.activeSocketId !== socket.id || player.controlEpoch !== controlEpoch) {
      return failure(actionId, 'SESSION_REPLACED', '此标签页已被新的控制连接接管。');
    }
    player.lastSeenAt = Date.now();
    return player;
  };

  const isFailure = (value: PlayerRecord | AckResult<never>): value is AckResult<never> => !('playerId' in value);

  const memberRoom = (socket: GameSocket, player: PlayerRecord, roomInstanceId: string, actionId: string): RoomRecord | AckResult<never> => {
    if (player.roomInstanceId !== roomInstanceId) {
      return failure(actionId, 'NOT_IN_ROOM', '你不在该房间中。');
    }
    const room = store.roomsByInstance.get(roomInstanceId);
    if (room === undefined || room.pendingJoinPlayerIds.has(player.playerId) || !socket.rooms.has(roomInstanceId)) {
      return failure(actionId, 'NOT_IN_ROOM', '你不在该房间中。');
    }
    if (!room.state.seats.some((seat) => seat?.playerId === player.playerId)) {
      return failure(actionId, 'SEAT_RELEASED', '你的座位已失效。');
    }
    return room;
  };

  const isRoomFailure = (value: RoomRecord | AckResult<never>): value is AckResult<never> => !('state' in value);

  const snapshot = (socket: GameSocket, room: RoomRecord, syncRequestId?: string): void => {
    const message: SnapshotMessage = {
      roomInstanceId: room.state.roomInstanceId,
      version: room.state.version,
      serverTime: Date.now(),
      ...(syncRequestId === undefined ? {} : { syncRequestId }),
      state: clone(room.state),
    };
    socket.emit('room:snapshot', message);
  };

  const commit = (room: RoomRecord, changes: RoomChanges, causedByActionId?: string): PatchMessage => {
    const previousVersion = room.state.version;
    room.state.version += 1;
    room.state.updatedAt = Date.now();
    const patchChanges: RoomChanges = { ...changes, updatedAt: room.state.updatedAt };
    return {
      roomInstanceId: room.state.roomInstanceId,
      prevVersion: previousVersion,
      version: room.state.version,
      serverTime: Date.now(),
      ...(causedByActionId === undefined ? {} : { causedByActionId }),
      changes: clone(patchChanges),
    };
  };

  const broadcastPatch = (room: RoomRecord, patch: PatchMessage, except?: GameSocket): void => {
    // Every gameplay update is scoped to this exact room instance, never io.emit().
    if (except === undefined) {
      io.to(room.state.roomInstanceId).emit('room:patch', patch);
    } else {
      except.to(room.state.roomInstanceId).emit('room:patch', patch);
    }
  };

  const runAuthenticated = async <T>(
    socket: GameSocket,
    event: string,
    rawRequest: unknown,
    rawAck: unknown,
    schema: z.ZodType<T>,
    handler: (player: PlayerRecord, request: T) => Promise<AckResult<unknown>> | AckResult<unknown>,
  ): Promise<void> => {
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
    const hash = payloadHash(rawRequest);
    const cached = getCached(actor, event, (request as { actionId: string }).actionId, hash);
    if (cached === 'reused') {
      ack(failure((request as { actionId: string }).actionId, 'ACTION_ID_REUSED', '同一 actionId 不能用于不同请求。'));
      return;
    }
    if (cached !== null) {
      ack(cached);
      return;
    }
    const requestId = (request as { actionId: string }).actionId;
    const fingerprint = actionFingerprint(event, hash);
    const pendingActions = inFlightActions.get(actor) ?? new Map();
    const pending = pendingActions.get(requestId);
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) {
        ack(failure(requestId, 'ACTION_ID_REUSED', '同一 actionId 不能用于不同请求。'));
      } else {
        ack(clone(await pending.response));
      }
      return;
    }
    if (rateLimited(socket)) {
      const response = failure((request as { actionId: string }).actionId, 'RATE_LIMITED', '请求过于频繁，请稍后重试。', true);
      cacheResponse(actor, event, (request as { actionId: string }).actionId, hash, response);
      ack(response);
      return;
    }

    // Reserve the intent before a handler can yield (e.g. socket.join).
    // Concurrent retries await this exact result instead of executing again.
    let resolvePending!: (result: AckResult<unknown>) => void;
    const pendingResponse = new Promise<AckResult<unknown>>((resolve) => { resolvePending = resolve; });
    pendingActions.set(requestId, { fingerprint, response: pendingResponse });
    inFlightActions.set(actor, pendingActions);
    let response: AckResult<unknown>;
    try {
      response = await handler(actor, request);
    } catch {
      response = failure((request as { actionId: string }).actionId, 'INTERNAL_ERROR', '服务器暂时无法处理该请求。', true);
    }
    cacheResponse(actor, event, (request as { actionId: string }).actionId, hash, response);
    resolvePending(clone(response));
    pendingActions.delete(requestId);
    ack(response);
  };

  const handleSessionOpen = async (socket: GameSocket, rawRequest: unknown, rawAck: unknown): Promise<void> => {
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

    const alreadyAuthenticatedId = socket.data.playerId;
    if (alreadyAuthenticatedId !== undefined) {
      const existing = actorForSocket(socket, request.actionId);
      if (isFailure(existing)) {
        ack(existing);
        return;
      }
      const existingHash = payloadHash(rawRequest);
      const cached = getCached(existing, 'session:open', request.actionId, existingHash);
      if (cached === 'reused') {
        ack(failure(request.actionId, 'ACTION_ID_REUSED', '同一 actionId 不能用于不同请求。'));
      } else if (cached !== null) {
        ack(cached);
      } else {
        // A connected tab cannot switch into another identity and thereby inherit it.
        ack(failure(request.actionId, 'AUTH_INVALID', '已认证连接不能切换身份。'));
      }
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
      if (recoveredPlayer === undefined || !secretMatches(request.secret, recoveredPlayer.secretSalt, recoveredPlayer.secretHash)) {
        ack(failure(request.actionId, 'AUTH_INVALID', '身份凭据无效。'));
        return;
      }
      player = recoveredPlayer;
    } else {
      const newPlayer = store.createPlayer(request.nickname ?? '');
      if (newPlayer === null) {
        ack(failure(request.actionId, 'RATE_LIMITED', '服务器暂时无法创建更多身份。', true));
        return;
      }
      player = newPlayer;
      issuedSecret = store.issuedSecret(player);
    }

    const oldSocketId = player.activeSocketId;
    if (oldSocketId !== null && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId) as GameSocket | undefined;
      if (oldSocket !== undefined) {
        oldSocket.emit('session:replaced', { message: '此标签页已被新的控制连接接管。' });
        if (player.roomInstanceId !== null) {
          oldSocket.leave(player.roomInstanceId);
        }
      }
    }
    player.controlEpoch += 1;
    player.activeSocketId = socket.id;
    player.lastSeenAt = Date.now();
    socket.data.playerId = player.playerId;
    socket.data.controlEpoch = player.controlEpoch;

    const response = success<SessionData>(request.actionId, {
      playerId: player.playerId,
      nickname: player.nickname,
      ...(issuedSecret === undefined ? {} : { secret: issuedSecret }),
      serverEpoch,
      serverTime: Date.now(),
    });
    cacheResponse(player, 'session:open', request.actionId, payloadHash(rawRequest), response);
    ack(response);
  };

  const createRoom = async (socket: GameSocket, player: PlayerRecord, request: { actionId: string }): Promise<AckResult<RoomEntryData>> => {
    if (player.roomInstanceId !== null) {
      return failure(request.actionId, 'ALREADY_IN_ROOM', '你已经在一个房间中。');
    }
    const room = store.createRoom(player);
    if (room === null) {
      return failure(request.actionId, 'RATE_LIMITED', '服务器暂时无法创建更多房间。', true);
    }
    try {
      // Seat reservation happens synchronously in createRoom before this await.
      await socket.join(room.state.roomInstanceId);
      room.pendingJoinPlayerIds.delete(player.playerId);
    } catch {
      return failure(request.actionId, 'INTERNAL_ERROR', '加入新房间失败。', true);
    }
    snapshot(socket, room);
    return success(request.actionId, {
      roomCode: room.state.roomCode,
      roomInstanceId: room.state.roomInstanceId,
      invitationPath: `/r/${room.state.roomCode}`,
    }, room.state.version);
  };

  const joinRoom = async (socket: GameSocket, player: PlayerRecord, request: JoinRequest): Promise<AckResult<RoomEntryData>> => {
    if (player.roomInstanceId !== null) {
      return failure(request.actionId, 'ALREADY_IN_ROOM', '你已经在一个房间中。');
    }
    const room = store.rooms.get(request.roomCode);
    if (room === undefined) {
      return failure(request.actionId, 'ROOM_NOT_FOUND', '房间不存在。');
    }
    const seatIndex = room.state.seats.findIndex((seat) => seat === null);
    if (seatIndex === -1) {
      // Do not join the Socket.IO room or emit a snapshot before this check.
      return failure(request.actionId, 'ROOM_FULL', '房间已满，请创建新房间。');
    }

    const seatId: SeatId = seatIndex === 0 ? 'A' : 'B';
    // This is the atomic reservation. JavaScript runs this whole section before
    // the await below, so a concurrent third join sees the occupied seat.
    room.state.seats[seatIndex] = publicSeat(seatId, player, Date.now());
    player.roomInstanceId = room.state.roomInstanceId;
    room.pendingJoinPlayerIds.add(player.playerId);
    const patch = commit(room, { seats: clone(room.state.seats) }, request.actionId);

    try {
      await socket.join(room.state.roomInstanceId);
      room.pendingJoinPlayerIds.delete(player.playerId);
    } catch {
      return failure(request.actionId, 'INTERNAL_ERROR', '加入房间失败。', true);
    }
    broadcastPatch(room, patch, socket);
    snapshot(socket, room);
    return success(request.actionId, {
      roomCode: room.state.roomCode,
      roomInstanceId: room.state.roomInstanceId,
      invitationPath: `/r/${room.state.roomCode}`,
    }, room.state.version);
  };

  const setReady = (socket: GameSocket, player: PlayerRecord, request: ReadyRequest): AckResult => {
    const member = memberRoom(socket, player, request.roomInstanceId, request.actionId);
    if (isRoomFailure(member)) return member;
    const room = member;
    if (room.state.phase !== 'waiting') {
      return failure(request.actionId, 'INVALID_PHASE', '当前阶段不能准备。');
    }
    if (request.roundId !== null) {
      return failure(request.actionId, 'STALE_ROUND', '准备请求引用了过期对局。', false, true);
    }
    const seatIndex = room.state.seats.findIndex((seat) => seat?.playerId === player.playerId);
    const seat = room.state.seats[seatIndex];
    if (seat === undefined || seat === null) {
      return failure(request.actionId, 'SEAT_RELEASED', '你的座位已失效。');
    }
    if (seat.ready === request.ready) {
      return success(request.actionId, undefined, room.state.version);
    }

    seat.ready = request.ready;
    const [seatA, seatB] = room.state.seats;
    let changes: RoomChanges = { seats: clone(room.state.seats) };
    if (seatA !== null && seatB !== null && seatA.connected && seatB.connected && seatA.ready && seatB.ready) {
      const round: PublicRound = {
        roundId: randomId(ROUND_ID_BYTES),
        participantIds: [seatA.playerId, seatB.playerId],
        blackPlayerId: seatA.playerId,
        whitePlayerId: seatB.playerId,
        board: Array<Cell>(BOARD_CELLS).fill(0),
        moveNo: 0,
        turnPlayerId: seatA.playerId,
        lastMove: null,
        paused: false,
        result: null,
      };
      room.state.phase = 'playing';
      room.state.round = round;
      seatA.ready = false;
      seatB.ready = false;
      changes = { phase: room.state.phase, seats: clone(room.state.seats), round: clone(round) };
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
    if (round === null || round.roundId !== request.roundId) {
      return failure(request.actionId, 'STALE_ROUND', '该对局已经过期。', false, true);
    }
    if (room.state.phase !== 'playing') {
      return failure(request.actionId, 'INVALID_PHASE', '当前阶段不能落子。', false, true);
    }
    if (round.paused) {
      return failure(request.actionId, 'GAME_PAUSED', '对局已暂停。', true, true);
    }
    if (!round.participantIds.includes(player.playerId)) {
      return failure(request.actionId, 'SEAT_RELEASED', '你不是本局参与者。');
    }
    if (round.turnPlayerId !== player.playerId) {
      return failure(request.actionId, 'NOT_YOUR_TURN', '尚未轮到你落子。', false, true);
    }
    if (request.expectedMoveNo !== round.moveNo) {
      return failure(request.actionId, 'STALE_MOVE', '落子序号已过期。', false, true);
    }
    const index = boardIndex(request.x, request.y);
    if (round.board[index] !== 0) {
      return failure(request.actionId, 'CELL_OCCUPIED', '该位置已有棋子。', false, true);
    }

    const color: 1 | 2 = round.blackPlayerId === player.playerId ? 1 : 2;
    round.board[index] = color;
    round.moveNo += 1;
    round.lastMove = { x: request.x, y: request.y, playerId: player.playerId, color, moveNo: round.moveNo };
    const winningLine = winningLineForMove(round.board, request.x, request.y, color);
    if (winningLine !== null) {
      const loserPlayerId = round.participantIds.find((participantId) => participantId !== player.playerId) ?? null;
      round.turnPlayerId = null;
      round.result = {
        winnerPlayerId: player.playerId,
        loserPlayerId,
        reason: 'five',
        winningLine,
        endedAt: Date.now(),
      };
      room.state.phase = 'finished';
    } else if (isBoardFull(round.board)) {
      round.turnPlayerId = null;
      round.result = {
        winnerPlayerId: null,
        loserPlayerId: null,
        reason: 'draw',
        winningLine: [],
        endedAt: Date.now(),
      };
      room.state.phase = 'finished';
    } else {
      round.turnPlayerId = round.participantIds.find((participantId) => participantId !== player.playerId) ?? null;
    }

    const patch = commit(room, { phase: room.state.phase, round: clone(round) }, request.actionId);
    broadcastPatch(room, patch);
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
    player.lastSeenAt = Date.now();
    if (player.roomInstanceId === null) return;
    const room = store.roomsByInstance.get(player.roomInstanceId);
    if (room === undefined) return;
    const seat = room.state.seats.find((candidate) => candidate?.playerId === player.playerId);
    if (seat === undefined || seat === null) return;
    seat.connected = false;
    seat.disconnectedAt = Date.now();
    seat.reconnectDeadline = null;
    seat.disconnectDecisionAvailable = false;
    let changes: RoomChanges = { seats: clone(room.state.seats) };
    if (room.state.phase === 'playing' && room.state.round !== null) {
      room.state.round.paused = true;
      changes = { seats: clone(room.state.seats), round: clone(room.state.round) };
    }
    const patch = commit(room, changes);
    broadcastPatch(room, patch);
  };

  io.on('connection', (socket) => {
    const gameSocket = socket as GameSocket;
    gameSocket.emit('server:hello', { protocolVersion: PROTOCOL_VERSION, serverEpoch, serverTime: Date.now() });
    gameSocket.on('session:open', (request, ack) => { void handleSessionOpen(gameSocket, request, ack); });
    gameSocket.on('room:create', (request, ack) => {
      void runAuthenticated(gameSocket, 'room:create', request, ack, createSchema, (player, parsed) => createRoom(gameSocket, player, parsed));
    });
    gameSocket.on('room:join', (request, ack) => {
      void runAuthenticated(gameSocket, 'room:join', request, ack, joinSchema, (player, parsed) => joinRoom(gameSocket, player, parsed));
    });
    gameSocket.on('room:sync', (request, ack) => {
      void runAuthenticated(gameSocket, 'room:sync', request, ack, syncSchema, (player, parsed) => sync(gameSocket, player, parsed));
    });
    gameSocket.on('round:ready', (request, ack) => {
      void runAuthenticated(gameSocket, 'round:ready', request, ack, readySchema, (player, parsed) => setReady(gameSocket, player, parsed));
    });
    gameSocket.on('game:move', (request, ack) => {
      void runAuthenticated(gameSocket, 'game:move', request, ack, moveSchema, (player, parsed) => move(gameSocket, player, parsed));
    });
    gameSocket.on('disconnect', () => disconnect(gameSocket));
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };

  return { app, httpServer, io, store, close };
}
