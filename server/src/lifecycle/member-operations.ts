import type { RoomRecord } from './store.js';

interface Lease {
  token: symbol;
  socketId: string;
  controlEpoch: number;
}

/** Internal-only leases; never serialized in room snapshots. */
export class MemberOperations {
  private readonly leases = new WeakMap<RoomRecord, Map<string, Lease>>();

  public begin(room: RoomRecord, playerId: string, socketId: string, controlEpoch: number): symbol | null {
    const members = this.leases.get(room) ?? new Map<string, Lease>();
    const previous = members.get(playerId);
    // Different actionIds on one controller must not run overlapping resumes.
    // A genuinely newer controller may supersede an older in-flight operation.
    if (previous?.socketId === socketId && previous.controlEpoch === controlEpoch) return null;
    const token = Symbol('member-operation');
    members.set(playerId, { token, socketId, controlEpoch });
    this.leases.set(room, members);
    room.pendingMemberPlayerIds.add(playerId);
    return token;
  }

  public owns(room: RoomRecord, playerId: string, token: symbol): boolean {
    return this.leases.get(room)?.get(playerId)?.token === token;
  }

  public finish(room: RoomRecord, playerId: string, token: symbol): void {
    if (!this.owns(room, playerId, token)) return;
    this.leases.get(room)?.delete(playerId);
    room.pendingMemberPlayerIds.delete(playerId);
  }
}
