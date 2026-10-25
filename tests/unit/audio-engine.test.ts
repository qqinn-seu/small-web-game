import { describe, expect, it, vi } from 'vitest';
import {
  AudioEngine,
  type AudioContextLike,
  type AudioDocumentLike,
  type AudioStorageLike,
  type AudioWindowLike,
} from '../../client/src/audio/audio-engine.js';

type Listener = EventListenerOrEventListenerObject;

class EventHub {
  public readonly listeners = new Map<string, Set<Listener>>();

  public addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  public removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

function parameter(value = 0) {
  return {
    value,
    setValueAtTime: vi.fn((next: number) => { value = next; }),
    linearRampToValueAtTime: vi.fn((next: number) => { value = next; }),
    exponentialRampToValueAtTime: vi.fn((next: number) => { value = next; }),
  };
}

class FakeContext implements AudioContextLike {
  public state: AudioContextState | 'closed' = 'suspended';
  public currentTime = 0;
  public sampleRate = 44_100;
  public destination = {};
  public onstatechange: (() => void) | null = null;
  public shouldRejectResume = false;
  public readonly sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  public readonly gains: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  public readonly filters: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  public readonly resume = vi.fn(async () => {
    if (this.shouldRejectResume) throw new Error('autoplay rejected');
    this.state = 'running';
    this.onstatechange?.();
  });
  public readonly close = vi.fn(async () => {
    this.state = 'closed';
    this.onstatechange?.();
  });

  public createGain() {
    const gain = { gain: parameter(), connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(gain);
    return gain;
  }

  public createOscillator() {
    const source = {
      frequency: parameter(),
      type: 'sine' as OscillatorType,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    this.sources.push(source);
    return source;
  }

  public createBuffer() {
    return { getChannelData: vi.fn(() => new Float32Array(3_087)) };
  }

  public createBufferSource() {
    const source = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    this.sources.push(source);
    return source;
  }

  public createBiquadFilter() {
    const filter = { frequency: parameter(), Q: parameter(), connect: vi.fn(), disconnect: vi.fn(), type: 'lowpass' as BiquadFilterType };
    this.filters.push(filter);
    return filter;
  }

  public suspend(): void {
    this.state = 'suspended';
    this.onstatechange?.();
  }
}

function memoryStorage(initial: Record<string, string> = {}): AudioStorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

function setup(options: { muted?: boolean; reject?: boolean } = {}) {
  const documentHub = new EventHub();
  const windowHub = new EventHub();
  const storage = memoryStorage(options.muted ? { 'gomoku.muted.v1': 'true' } : {});
  const document = Object.assign(documentHub, { visibilityState: 'visible' as DocumentVisibilityState }) as AudioDocumentLike & EventHub;
  const window = Object.assign(windowHub, { localStorage: storage }) as AudioWindowLike & EventHub;
  const context = new FakeContext();
  context.shouldRejectResume = options.reject ?? false;
  const factory = vi.fn(() => context);
  return { document, window, storage, context, factory };
}

describe('AudioEngine', () => {
  it('does not create an AudioContext or queue any cue before an explicit unlock', () => {
    const { document, window, factory } = setup();
    const engine = new AudioEngine({ createAudioContext: factory, document, window });
    engine.play('stone');
    expect(factory).not.toHaveBeenCalled();
    expect(engine.getState().played.stone).toBe(0);
    expect(engine.getState().unlocked).toBe(false);
  });

  it('recovers from a rejected resume on a later real gesture attempt', async () => {
    const { document, window, context, factory } = setup({ reject: true });
    const engine = new AudioEngine({ createAudioContext: factory, document, window });
    await expect(engine.unlock()).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(engine.getState().unlocked).toBe(false);

    context.shouldRejectResume = false;
    await engine.unlock();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(engine.getState().unlocked).toBe(true);

    context.suspend();
    expect(engine.getState().unlocked).toBe(false);
  });

  it('restores mute safely, persists changes, synchronizes storage events, and stops active nodes immediately', async () => {
    const { document, window, storage, context } = setup({ muted: true });
    const engine = new AudioEngine({ createAudioContext: () => context, document, window });
    expect(engine.getState().muted).toBe(true);
    await engine.unlock();
    engine.play('stone');
    expect(engine.getState().played.stone).toBe(0);

    engine.setMuted(false);
    expect(storage.setItem).toHaveBeenLastCalledWith('gomoku.muted.v1', 'false');
    engine.play('stone');
    const source = context.sources[0];
    expect(engine.getState().played.stone).toBe(1);
    expect(source.stop).toHaveBeenCalledTimes(1); // scheduled natural end

    engine.setMuted(true);
    expect(source.stop).toHaveBeenCalledTimes(2); // immediate stop, no queue
    engine.setMuted(false);
    expect(engine.getState().played.stone).toBe(1);

    const event = Object.assign(new Event('storage'), { key: 'gomoku.muted.v1', newValue: 'true' }) as StorageEvent;
    window.emit('storage', event);
    expect(engine.getState().muted).toBe(true);
  });

  it('counts all five cues only when actually scheduled and throttles brush to 150ms', async () => {
    const { document, window, context } = setup();
    let now = 1_000;
    const engine = new AudioEngine({ createAudioContext: () => context, document, window, now: () => now });
    await engine.unlock();
    engine.play('stone');
    engine.play('turn');
    engine.play('win');
    engine.play('lose');
    engine.play('brush');
    engine.play('brush');
    now += 150;
    engine.play('brush');

    expect(engine.getState().played).toEqual({ stone: 1, turn: 1, win: 1, lose: 1, brush: 2 });
  });

  it('stops on a hidden page and destroys all listeners/context without future playback', async () => {
    const { document, window, context } = setup();
    const engine = new AudioEngine({ createAudioContext: () => context, document, window });
    await engine.unlock();
    engine.play('stone');
    const source = context.sources[0];

    document.visibilityState = 'hidden';
    document.emit('visibilitychange', new Event('visibilitychange'));
    expect(source.stop).toHaveBeenCalledTimes(2);
    engine.play('turn');
    expect(engine.getState().played.turn).toBe(0);

    engine.destroy();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(document.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
    expect(window.listeners.get('storage')?.size ?? 0).toBe(0);
    document.visibilityState = 'visible';
    engine.play('stone');
    expect(engine.getState().played.stone).toBe(1);
  });

  it('disconnects owned gains and filters on natural completion or immediate mute', async () => {
    const { document, window, context } = setup();
    const engine = new AudioEngine({ createAudioContext: () => context, document, window });
    await engine.unlock();
    engine.play('stone');
    context.sources[0].onended?.();
    expect(context.gains[0].disconnect).toHaveBeenCalledTimes(1);
    engine.play('brush');
    context.sources[1].onended?.();
    expect(context.gains[1].disconnect).toHaveBeenCalledTimes(1);
    expect(context.filters[0].disconnect).toHaveBeenCalledTimes(1);
    engine.play('win');
    engine.setMuted(true);
    for (const gain of context.gains.slice(2)) expect(gain.disconnect).toHaveBeenCalledTimes(1);
    engine.stop();
    for (const gain of context.gains) expect(gain.disconnect).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('does not relock a running context when an older concurrent resume rejects', async () => {
    const { document, window, context } = setup();
    let rejectEarlier!: (reason: Error) => void;
    context.resume.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectEarlier = reject; }));
    const engine = new AudioEngine({ createAudioContext: () => context, document, window });
    const earlier = engine.unlock();
    await engine.unlock();
    rejectEarlier(new Error('old policy rejection'));
    await earlier;
    expect(engine.getState().unlocked).toBe(true);
    engine.play('stone');
    expect(engine.getState().played.stone).toBe(1);
    engine.destroy();
  });

  it('degrades safely when storage throws or Web Audio is unsupported', async () => {
    const { document, window, context } = setup();
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const engine = new AudioEngine({ createAudioContext: () => context, storage, document, window });
    await engine.unlock();
    expect(() => engine.setMuted(true)).not.toThrow();
    engine.setMuted(false);
    engine.play('stone');
    expect(engine.getState().played.stone).toBe(1);
    engine.destroy();
    const unsupported = new AudioEngine({ document, window });
    expect(unsupported.getState().supported).toBe(false);
    await expect(unsupported.unlock()).resolves.toBeUndefined();
    unsupported.play('win');
    expect(unsupported.getState().played.win).toBe(0);
    unsupported.destroy();
  });
});
