import { describe, expect, it } from 'vitest';
import {
  IDENTITY_STORAGE_KEY,
  IdentityRoomStorage,
  ROOM_STORAGE_KEY,
  parseStoredIdentity,
  parseStoredRoomEntry,
  type StorageLike,
} from '../../client/src/state/identity-storage.js';

class MapStorage implements StorageLike {
  public readonly values = new Map<string, string>();
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public setItem(key: string, value: string): void { this.values.set(key, value); }
  public removeItem(key: string): void { this.values.delete(key); }
}

class ThrowingStorage implements StorageLike {
  public getItem(): string | null { throw new Error('blocked'); }
  public setItem(): void { throw new Error('blocked'); }
  public removeItem(): void { throw new Error('blocked'); }
}

const identity = {
  playerId: 'player-123',
  secret: 'private-secret-must-not-be-rendered',
  nickname: '小林',
  serverEpoch: 'epoch-456',
};
const room = {
  roomCode: 'AB12CD',
  roomInstanceId: 'room-instance-789',
  invitationPath: '/r/AB12CD',
  lastVersion: 12,
};

describe('M2 identity and room entry persistence', () => {
  it('uses the fixed keys and stores only the strict credential and room entry shapes', () => {
    const backend = new MapStorage();
    const storage = new IdentityRoomStorage(backend);

    expect(storage.saveIdentity(identity)).toBe(true);
    expect(storage.saveRoom(room)).toBe(true);
    expect([...backend.values.keys()].sort()).toEqual([IDENTITY_STORAGE_KEY, ROOM_STORAGE_KEY]);
    expect(JSON.parse(backend.values.get(IDENTITY_STORAGE_KEY)!)).toEqual(identity);
    expect(JSON.parse(backend.values.get(ROOM_STORAGE_KEY)!)).toEqual(room);
    expect(storage.loadIdentity()).toEqual(identity);
    expect(storage.loadRoom()).toEqual(room);
  });

  it('rejects malformed, widened, unsafe, and cross-origin-shaped recovery data without throwing', () => {
    expect(parseStoredIdentity('{bad json')).toBeNull();
    expect(parseStoredIdentity(JSON.stringify({ ...identity, extra: 'not allowed' }))).toBeNull();
    expect(parseStoredIdentity(JSON.stringify({ ...identity, nickname: ' nickname' }))).toBeNull();
    expect(parseStoredRoomEntry(JSON.stringify({ ...room, lastVersion: -1 }))).toBeNull();
    expect(parseStoredRoomEntry(JSON.stringify({ ...room, invitationPath: '//other.example/r/AB12CD' }))).toBeNull();
    expect(parseStoredRoomEntry(JSON.stringify({ ...room, extra: true }))).toBeNull();

    const backend = new MapStorage();
    backend.setItem(IDENTITY_STORAGE_KEY, '{broken');
    backend.setItem(ROOM_STORAGE_KEY, JSON.stringify({ ...room, lastVersion: 1.25 }));
    const storage = new IdentityRoomStorage(backend);
    expect(storage.loadIdentity()).toBeNull();
    expect(storage.loadRoom()).toBeNull();
    expect(backend.getItem(IDENTITY_STORAGE_KEY)).toBeNull();
    expect(backend.getItem(ROOM_STORAGE_KEY)).toBeNull();
  });

  it('updates only the room entry version and never creates a local board mirror', () => {
    const backend = new MapStorage();
    const storage = new IdentityRoomStorage(backend);
    storage.saveRoom(room);
    expect(storage.updateRoomVersion(room.roomInstanceId, 13)).toBe(true);
    expect(storage.loadRoom()).toEqual({ ...room, lastVersion: 13 });
    expect(storage.updateRoomVersion('different-instance', 14)).toBe(false);
    expect(Object.keys(JSON.parse(backend.getItem(ROOM_STORAGE_KEY)!)).sort()).toEqual(
      ['invitationPath', 'lastVersion', 'roomCode', 'roomInstanceId'],
    );
  });

  it('degrades to tab memory when browser storage is unavailable and still supports explicit clearing', () => {
    const storage = new IdentityRoomStorage(new ThrowingStorage());
    expect(storage.loadIdentity()).toBeNull();
    expect(storage.getMode()).toBe('memory');
    expect(storage.takeDowngradeWarning()).toContain('仅在内存中');
    expect(storage.takeDowngradeWarning()).toBeNull();

    expect(storage.saveIdentity(identity)).toBe(false);
    expect(storage.saveRoom(room)).toBe(false);
    expect(storage.loadIdentity()).toEqual(identity);
    expect(storage.loadRoom()).toEqual(room);
    storage.clearIdentity();
    storage.clearRoom();
    expect(storage.loadIdentity()).toBeNull();
    expect(storage.loadRoom()).toBeNull();
  });
});
