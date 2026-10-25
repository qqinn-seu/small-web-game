import type { RoomState } from '../../../shared/models.js';

export interface ActionCacheEntry {
  payloadHash: string;
  response: unknown;
  createdAt: number;
}

export interface PlayerRecord {
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

/** A pending member has a reserved seat but may not issue room actions yet. */
export interface RoomRecord {
  state: RoomState;
  pendingMemberPlayerIds: Set<string>;
}

export interface GameStoreView {
  readonly rooms: ReadonlyMap<string, RoomRecord>;
  readonly players: ReadonlyMap<string, PlayerRecord>;
}

export interface GameStoreDependencies {
  now: () => number;
  randomId: (bytes: number) => string;
  makeRoomCode: () => string;
  hashSecret: (secret: string, salt: string) => string;
  maxRooms: number;
  maxPlayers: number;
  maxActionsPerPlayer: number;
  actionCacheTtlMs: number;
}

const PLAYER_ID_BYTES = 18;
const SECRET_BYTES = 32;
const ROOM_INSTANCE_BYTES = 18;

export class GameStore implements GameStoreView {
  readonly rooms = new Map<string, RoomRecord>();
  readonly roomsByInstance = new Map<string, RoomRecord>();
  readonly players = new Map<string, PlayerRecord>();

  constructor(private readonly dependencies: GameStoreDependencies) {}

  createPlayer(nickname: string): { player: PlayerRecord; secret: string } | null {
    this.pruneInactivePlayers();
    if (this.players.size >= this.dependencies.maxPlayers) return null;

    const secret = this.dependencies.randomId(SECRET_BYTES);
    const secretSalt = this.dependencies.randomId(16);
    const now = this.dependencies.now();
    const player: PlayerRecord = {
      playerId: this.dependencies.randomId(PLAYER_ID_BYTES),
      nickname: nickname.trim(),
      secretSalt,
      secretHash: this.dependencies.hashSecret(secret, secretSalt),
      activeSocketId: null,
      controlEpoch: 0,
      roomInstanceId: null,
      createdAt: now,
      lastSeenAt: now,
      actionCache: new Map(),
    };
    this.players.set(player.playerId, player);
    return { player, secret };
  }

  createRoom(state: RoomState, ownerPlayer: PlayerRecord): RoomRecord | null {
    if (this.rooms.size >= this.dependencies.maxRooms) return null;
    const room: RoomRecord = { state, pendingMemberPlayerIds: new Set([ownerPlayer.playerId]) };
    this.rooms.set(state.roomCode, room);
    this.roomsByInstance.set(state.roomInstanceId, room);
    ownerPlayer.roomInstanceId = state.roomInstanceId;
    return room;
  }

  nextRoomIdentity(): { roomCode: string; roomInstanceId: string } {
    let roomCode = this.dependencies.makeRoomCode();
    while (this.rooms.has(roomCode)) roomCode = this.dependencies.makeRoomCode();
    return { roomCode, roomInstanceId: this.dependencies.randomId(ROOM_INSTANCE_BYTES) };
  }

  removeRoom(room: RoomRecord): void {
    this.rooms.delete(room.state.roomCode);
    this.roomsByInstance.delete(room.state.roomInstanceId);
    for (const player of this.players.values()) {
      if (player.roomInstanceId === room.state.roomInstanceId) player.roomInstanceId = null;
    }
  }

  pruneCache(player: PlayerRecord): void {
    const now = this.dependencies.now();
    for (const [key, entry] of player.actionCache) {
      if (now - entry.createdAt > this.dependencies.actionCacheTtlMs) player.actionCache.delete(key);
    }
    while (player.actionCache.size > this.dependencies.maxActionsPerPlayer) {
      const oldest = player.actionCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      player.actionCache.delete(oldest);
    }
  }

  private pruneInactivePlayers(): void {
    if (this.players.size < this.dependencies.maxPlayers) return;
    for (const [playerId, player] of this.players) {
      if (this.players.size < this.dependencies.maxPlayers) break;
      if (player.activeSocketId === null && player.roomInstanceId === null) this.players.delete(playerId);
    }
  }
}
