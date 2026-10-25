import type { RoomEntryData } from '../../../shared/protocol.js';

export const IDENTITY_STORAGE_KEY = 'gomoku.identity.v1';
export const ROOM_STORAGE_KEY = 'gomoku.room.v1';

export interface StoredIdentity {
  playerId: string;
  secret: string;
  nickname: string;
  serverEpoch: string;
}

export interface StoredRoomEntry extends RoomEntryData {
  lastVersion: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistenceMode = 'persistent' | 'memory';

const MAX_PLAYER_ID_LENGTH = 256;
const MAX_SECRET_LENGTH = 4_096;
const MAX_NICKNAME_LENGTH = 12;
const MAX_EPOCH_LENGTH = 256;
const MAX_ROOM_CODE_LENGTH = 64;
const MAX_INSTANCE_LENGTH = 256;
const MAX_PATH_LENGTH = 2_048;

function browserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    // Reading can throw in private/sandboxed browser contexts. Do not probe by
    // writing a marker because this module must not leave unrelated data behind.
    storage.getItem(IDENTITY_STORAGE_KEY);
    return storage;
  } catch {
    return null;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function strictText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPath(value: unknown): value is string {
  return strictText(value, MAX_PATH_LENGTH)
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\');
}

export function parseStoredIdentity(raw: string | null): StoredIdentity | null {
  if (!raw || raw.length > 8_192) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!plainRecord(value) || !exactKeys(value, ['playerId', 'secret', 'nickname', 'serverEpoch'])) return null;
    if (
      !strictText(value.playerId, MAX_PLAYER_ID_LENGTH)
      || !strictText(value.secret, MAX_SECRET_LENGTH)
      || !strictText(value.nickname, MAX_NICKNAME_LENGTH)
      || !strictText(value.serverEpoch, MAX_EPOCH_LENGTH)
    ) return null;
    return {
      playerId: value.playerId,
      secret: value.secret,
      nickname: value.nickname,
      serverEpoch: value.serverEpoch,
    };
  } catch {
    return null;
  }
}

export function parseStoredRoomEntry(raw: string | null): StoredRoomEntry | null {
  if (!raw || raw.length > 8_192) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!plainRecord(value) || !exactKeys(value, ['roomCode', 'roomInstanceId', 'invitationPath', 'lastVersion'])) return null;
    const lastVersion = value.lastVersion;
    if (
      !strictText(value.roomCode, MAX_ROOM_CODE_LENGTH)
      || !strictText(value.roomInstanceId, MAX_INSTANCE_LENGTH)
      || !validPath(value.invitationPath)
      || typeof lastVersion !== 'number'
      || !Number.isSafeInteger(lastVersion)
      || lastVersion < 0
    ) return null;
    return {
      roomCode: value.roomCode,
      roomInstanceId: value.roomInstanceId,
      invitationPath: value.invitationPath,
      lastVersion,
    };
  } catch {
    return null;
  }
}

function copyIdentity(identity: StoredIdentity | null): StoredIdentity | null {
  return identity ? { ...identity } : null;
}

function copyRoom(room: StoredRoomEntry | null): StoredRoomEntry | null {
  return room ? { ...room } : null;
}

/**
 * Stores only the private browser credential and a room *entry hint*. The
 * authoritative board and room state deliberately never enter local storage.
 * Any storage API failure falls back to this tab's memory instead of throwing
 * or deleting a valid credential because a transient browser/storage failure is
 * not evidence that the server identity or room has expired.
 */
export class IdentityRoomStorage {
  private storage: StorageLike | null;
  private mode: PersistenceMode;
  private identityMemory: StoredIdentity | null = null;
  private roomMemory: StoredRoomEntry | null = null;
  private downgradeNotified = false;

  public constructor(storage: StorageLike | null = browserStorage()) {
    this.storage = storage;
    this.mode = storage ? 'persistent' : 'memory';
  }

  public getMode(): PersistenceMode {
    return this.mode;
  }

  /** Returns a one-time user-facing warning after persistent storage fails. */
  public takeDowngradeWarning(): string | null {
    if (this.mode !== 'memory' || this.downgradeNotified) return null;
    this.downgradeNotified = true;
    return '浏览器不支持本地恢复记录；本页将仅在内存中保留身份和房间入口。刷新后无法自动恢复。';
  }

  public loadIdentity(): StoredIdentity | null {
    if (!this.storage) return copyIdentity(this.identityMemory);
    const raw = this.read(IDENTITY_STORAGE_KEY);
    if (raw === null) {
      if (this.storage) this.identityMemory = null;
      return copyIdentity(this.identityMemory);
    }
    const parsed = parseStoredIdentity(raw);
    if (!parsed) {
      this.removeCorrupt(IDENTITY_STORAGE_KEY);
      return null;
    }
    this.identityMemory = parsed;
    return copyIdentity(parsed);
  }

  public saveIdentity(identity: StoredIdentity): boolean {
    const parsed = parseStoredIdentity(JSON.stringify(identity));
    if (!parsed) return false;
    this.identityMemory = parsed;
    return this.write(IDENTITY_STORAGE_KEY, JSON.stringify(parsed));
  }

  public clearIdentity(): void {
    this.identityMemory = null;
    this.remove(IDENTITY_STORAGE_KEY);
  }

  public loadRoom(): StoredRoomEntry | null {
    if (!this.storage) return copyRoom(this.roomMemory);
    const raw = this.read(ROOM_STORAGE_KEY);
    if (raw === null) {
      if (this.storage) this.roomMemory = null;
      return copyRoom(this.roomMemory);
    }
    const parsed = parseStoredRoomEntry(raw);
    if (!parsed) {
      this.removeCorrupt(ROOM_STORAGE_KEY);
      return null;
    }
    this.roomMemory = parsed;
    return copyRoom(parsed);
  }

  public saveRoom(room: StoredRoomEntry): boolean {
    const parsed = parseStoredRoomEntry(JSON.stringify(room));
    if (!parsed) return false;
    this.roomMemory = parsed;
    return this.write(ROOM_STORAGE_KEY, JSON.stringify(parsed));
  }

  public updateRoomVersion(roomInstanceId: string, lastVersion: number): boolean {
    const current = this.loadRoom();
    if (!current || current.roomInstanceId !== roomInstanceId || !Number.isSafeInteger(lastVersion) || lastVersion < 0) return false;
    return this.saveRoom({ ...current, lastVersion });
  }

  public clearRoom(): void {
    this.roomMemory = null;
    this.remove(ROOM_STORAGE_KEY);
  }

  private read(key: string): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      this.downgrade();
      return null;
    }
  }

  private write(key: string, value: string): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(key, value);
      return true;
    } catch {
      this.downgrade();
      return false;
    }
  }

  private remove(key: string): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(key);
    } catch {
      this.downgrade();
    }
  }

  private removeCorrupt(key: string): void {
    // Corrupt browser data is never sent to the server. Best-effort cleanup is
    // safe; a remove failure still keeps the application alive in memory mode.
    this.remove(key);
  }

  private downgrade(): void {
    this.storage = null;
    this.mode = 'memory';
  }
}
