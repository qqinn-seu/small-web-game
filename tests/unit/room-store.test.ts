import { describe, expect, it } from 'vitest';
import type { RoomState, PatchMessage, SnapshotMessage } from '../../shared/models.js';
import { reducePatch, reduceSnapshot } from '../../client/src/state/room-reducer.js';
import { RoomStore } from '../../client/src/state/room-store.js';

function room(version: number): RoomState {
  return {
    roomCode: 'ABC234', roomInstanceId: 'test-instance-0001', version,
    phase: 'waiting', seats: [null, null], round: null,
    faces: {}, drawing: null, washProposal: null,
    noConnectedPlayersSince: null, createdAt: 0, updatedAt: 0,
  };
}
function snapshot(version: number): SnapshotMessage {
  return { roomInstanceId: 'test-instance-0001', version, serverTime: 0, state: room(version) };
}
function patch(version: number): PatchMessage {
  return { roomInstanceId: 'test-instance-0001', prevVersion: version - 1, version, serverTime: 0, changes: { updatedAt: version } };
}
function joinedStore(version = 1): RoomStore {
  const store = new RoomStore();
  store.beginRoomEntry();
  store.receiveSnapshot(snapshot(version));
  store.finishRoomEntry({ roomCode: 'ABC234', roomInstanceId: 'test-instance-0001', invitationPath: '/r/ABC234' });
  return store;
}

describe('client authoritative room mirror', () => {
  it('accepts initial snapshot before room entry ACK and ACK never advances version', () => {
    const store = joinedStore(1);
    expect(store.getState()?.version).toBe(1);
    store.receivePatch(patch(2));
    expect(store.getState()?.version).toBe(2);
  });
  it('discards duplicate and stale patches, snapshots, and foreign instances', () => {
    const current = room(3);
    expect(reducePatch(current, patch(3)).status).toBe('stale');
    expect(reduceSnapshot(current, snapshot(2)).status).toBe('stale');
    expect(reducePatch(current, { ...patch(4), roomInstanceId: 'another-instance' }).status).toBe('foreign');
    expect(reduceSnapshot(current, { ...snapshot(4), roomInstanceId: 'another-instance' }).status).toBe('foreign');
  });
  it('freezes on a missing version and rebuilds from complete snapshot before draining consecutive patches', () => {
    const store = joinedStore();
    const requested: number[] = [];
    store.onSyncNeeded((info) => requested.push(info.lastVersion));
    store.receivePatch(patch(3));
    store.receivePatch(patch(4));
    expect(store.getState()?.version).toBe(1);
    expect(store.isSynchronizing()).toBe(true);
    expect(requested).toEqual([1]);
    store.receiveSnapshot(snapshot(2));
    expect(store.getState()?.version).toBe(4);
    expect(store.isSynchronizing()).toBe(false);
  });
  it('requests another snapshot if a buffered version hole still exists after rebuilding', () => {
    const store = joinedStore();
    const requested: number[] = [];
    store.onSyncNeeded((info) => requested.push(info.lastVersion));
    store.receivePatch(patch(4));
    store.receiveSnapshot(snapshot(2));
    expect(store.getState()?.version).toBe(2);
    expect(requested).toEqual([1, 2]);
    expect(store.isSynchronizing()).toBe(true);
    store.receiveSnapshot(snapshot(4));
    expect(store.getState()?.version).toBe(4);
    expect(store.isSynchronizing()).toBe(false);
  });
  it('rejects unsolicited room snapshots and state after failed/full-room entry', () => {
    const store = new RoomStore();
    store.receiveSnapshot(snapshot(1));
    expect(store.getState()).toBeNull();
    store.beginRoomEntry();
    store.cancelRoomEntry();
    store.receiveSnapshot(snapshot(2));
    store.receivePatch(patch(3));
    expect(store.getState()).toBeNull();
  });
  it('uses a snapshot as a new state rather than mutating the received board', () => {
    const message = snapshot(1);
    message.state.round = {
      roundId: 'round-test-001', participantIds: ['a', 'b'], blackPlayerId: 'a', whitePlayerId: 'b',
      board: Array(225).fill(0), moveNo: 0, turnPlayerId: 'a', lastMove: null, paused: false, result: null,
    };
    const result = reduceSnapshot(null, message);
    expect(result.state?.round?.board).not.toBe(message.state.round.board);
    expect(message.state.round.moveNo).toBe(0);
  });
  it('rebuilds a same-version full snapshot on reconnect without trusting ACKs or early patches', () => {
    const store = joinedStore(3);
    store.beginRoomRecovery({ roomCode: 'ABC234', roomInstanceId: 'test-instance-0001', invitationPath: '/r/ABC234' });
    expect(store.isRecovering()).toBe(true);
    const authoritative = snapshot(3);
    authoritative.state.updatedAt = 999;
    expect(store.receiveSnapshot(authoritative)).toBe(true);
    expect(store.getState()?.updatedAt).toBe(999);
    expect(store.isRecovering()).toBe(false);
  });
  it('does not release recovery for an older or foreign snapshot', () => {
    const store = joinedStore(3);
    store.beginRoomRecovery({ roomCode: 'ABC234', roomInstanceId: 'test-instance-0001', invitationPath: '/r/ABC234' });
    expect(store.receiveSnapshot(snapshot(2))).toBe(false);
    expect(store.receiveSnapshot({ ...snapshot(4), roomInstanceId: 'foreign-instance' })).toBe(false);
    expect(store.isRecovering()).toBe(true);
    expect(store.getState()?.version).toBe(3);
  });
  it('stays frozen when sync fails and rebuilds from an equal-version authoritative snapshot', () => {
    const store = joinedStore(3);
    store.markSyncFailed();
    expect(store.isSynchronizing()).toBe(true);
    expect(store.receiveSnapshot(snapshot(3))).toBe(true);
    expect(store.isSynchronizing()).toBe(false);
  });
});
