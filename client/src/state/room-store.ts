import type { PatchMessage, RoomState, SnapshotMessage } from '../../../shared/models.js';
import type { RoomEntryData } from '../../../shared/protocol.js';
import { reducePatch, reduceSnapshot } from './room-reducer.js';

export interface SyncRequestInfo {
  roomInstanceId: string;
  lastVersion: number;
}

type Listener = (state: RoomState | null) => void;

/**
 * Owns the mirrored room state and protocol ordering policy. It intentionally
 * has no Socket.IO dependency so version behaviour can be unit tested.
 */
export class RoomStore {
  private state: RoomState | null = null;
  private listeners = new Set<Listener>();
  private bufferedPatches = new Map<number, PatchMessage>();
  private entryInProgress = false;
  private expectedInstanceId: string | null = null;
  private recovering = false;
  private syncing = false;
  private syncHandler: ((info: SyncRequestInfo) => void) | null = null;

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  public getState(): RoomState | null {
    return this.state;
  }

  public isSynchronizing(): boolean {
    return this.syncing;
  }

  /** UI actions remain closed until this recovery receives a full snapshot. */
  public isRecovering(): boolean {
    return this.recovering;
  }

  public onSyncNeeded(handler: (info: SyncRequestInfo) => void): void {
    this.syncHandler = handler;
  }

  /** Permit a snapshot which races ahead of a create/join ACK. */
  public beginRoomEntry(): void {
    this.entryInProgress = true;
    this.expectedInstanceId = null;
    this.recovering = false;
    this.state = null;
    this.bufferedPatches.clear();
    this.syncing = false;
    this.publish();
  }

  /**
   * Prepare to replace a stale in-memory mirror with the exact room's complete
   * resume snapshot. Existing board data is display-only while recovering and
   * is never persisted.
   */
  public beginRoomRecovery(entry: RoomEntryData): void {
    this.entryInProgress = true;
    this.expectedInstanceId = entry.roomInstanceId;
    this.recovering = true;
    if (this.state && this.state.roomInstanceId !== entry.roomInstanceId) this.state = null;
    this.bufferedPatches.clear();
    this.syncing = false;
    this.publish();
  }

  /** Correlate an ACK without assuming it advances the room version. */
  public finishRoomEntry(entry: RoomEntryData): void {
    this.entryInProgress = true;
    this.expectedInstanceId = entry.roomInstanceId;
    if (this.state && this.state.roomInstanceId !== entry.roomInstanceId) {
      this.state = null;
      this.bufferedPatches.clear();
      this.publish();
    }
    // The server snapshot may win the Socket.IO ordering race and arrive
    // before this ACK. The snapshot is already the authoritative admission;
    // do not reopen a fictitious entry-in-progress state afterwards.
    if (this.state?.roomInstanceId === entry.roomInstanceId) {
      this.entryInProgress = false;
      this.expectedInstanceId = null;
    }
  }

  /** Reject unsolicited or failed-entry room traffic (notably ROOM_FULL). */
  public cancelRoomEntry(): void {
    this.clearRoom();
  }

  /** Clear only the local authoritative mirror; persistent policy lives above. */
  public clearRoom(): void {
    this.entryInProgress = false;
    this.expectedInstanceId = null;
    this.recovering = false;
    this.state = null;
    this.bufferedPatches.clear();
    this.syncing = false;
    this.publish();
  }

  /** @returns true when the complete snapshot was adopted. */
  public receiveSnapshot(message: SnapshotMessage): boolean {
    if (!this.mayAcceptSnapshot(message)) return false;

    const result = reduceSnapshot(this.state, message, { replaceAtSameVersion: this.recovering || this.syncing });
    if (result.status !== 'applied' || !result.state) return false;

    this.state = result.state;
    this.entryInProgress = false;
    this.expectedInstanceId = null;
    this.recovering = false;
    this.syncing = false;
    this.dropObsoleteBufferedPatches();
    this.drainBufferedPatches();
    if (this.bufferedPatches.size > 0) this.requestSync();
    this.publish();
    return true;
  }

  public receivePatch(message: PatchMessage): void {
    if (!this.state || this.state.roomInstanceId !== message.roomInstanceId) return;
    if (message.version <= this.state.version) return;

    // Once a hole exists, avoid showing a guessed intermediate state. Buffer
    // short concurrent bursts until the authoritative sync snapshot arrives.
    if (this.recovering || this.syncing || message.prevVersion !== this.state.version) {
      this.bufferPatch(message);
      this.requestSync();
      return;
    }

    const result = reducePatch(this.state, message);
    if (result.status === 'applied') {
      this.state = result.state;
      this.publish();
    } else if (result.status === 'gap') {
      this.bufferPatch(message);
      this.requestSync();
    }
  }

  public markSyncFailed(): void {
    // Keep the mirror frozen rather than applying buffered patches without the
    // missing state. A future server snapshot can still recover it.
    this.syncing = true;
    this.publish();
  }

  private mayAcceptSnapshot(message: SnapshotMessage): boolean {
    if (this.state) return this.state.roomInstanceId === message.roomInstanceId;
    if (!this.entryInProgress) return false;
    return !this.expectedInstanceId || this.expectedInstanceId === message.roomInstanceId;
  }

  private bufferPatch(message: PatchMessage): void {
    if (this.bufferedPatches.size >= 16 && !this.bufferedPatches.has(message.version)) {
      const oldest = [...this.bufferedPatches.keys()].sort((a, b) => a - b)[0];
      if (oldest !== undefined) this.bufferedPatches.delete(oldest);
    }
    this.bufferedPatches.set(message.version, message);
  }

  private requestSync(): void {
    if (this.syncing || !this.state) return;
    this.syncing = true;
    this.syncHandler?.({
      roomInstanceId: this.state.roomInstanceId,
      lastVersion: this.state.version,
    });
    this.publish();
  }

  private dropObsoleteBufferedPatches(): void {
    if (!this.state) return;
    for (const version of this.bufferedPatches.keys()) {
      if (version <= this.state.version) this.bufferedPatches.delete(version);
    }
  }

  private drainBufferedPatches(): void {
    if (!this.state) return;
    let state: RoomState = this.state;
    let next = this.bufferedPatches.get(state.version + 1);
    while (next && next.prevVersion === state.version) {
      const result = reducePatch(state, next);
      this.bufferedPatches.delete(next.version);
      if (result.status !== 'applied' || !result.state) break;
      state = result.state;
      next = this.bufferedPatches.get(state.version + 1);
    }
    this.state = state;
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
