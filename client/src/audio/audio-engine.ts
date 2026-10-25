import type { AudioCue, GameAudioState } from './types.js';

export type { AudioCue, GameAudioState } from './types.js';

const MUTED_STORAGE_KEY = 'gomoku.muted.v1';
const CUES: readonly AudioCue[] = ['stone', 'turn', 'win', 'lose', 'brush'];
const BRUSH_THROTTLE_MS = 150;

type AudioParamLike = {
  value: number;
  setValueAtTime?: (value: number, time: number) => void;
  linearRampToValueAtTime?: (value: number, time: number) => void;
  exponentialRampToValueAtTime?: (value: number, time: number) => void;
};

type AudioNodeLike = {
  connect: (destination: unknown) => unknown;
  disconnect?: () => void;
};

type AudioSourceLike = AudioNodeLike & {
  start: (when?: number) => void;
  stop: (when?: number) => void;
  onended?: (() => void) | null;
};

type OscillatorLike = AudioSourceLike & {
  type?: OscillatorType;
  frequency: AudioParamLike;
};

type GainLike = AudioNodeLike & { gain: AudioParamLike };

type BiquadLike = AudioNodeLike & {
  type?: BiquadFilterType;
  frequency?: AudioParamLike;
  Q?: AudioParamLike;
};

type AudioBufferLike = { getChannelData: (channel: number) => Float32Array };

/** Deliberately small structural subset, so unit tests need no browser AudioContext. */
export interface AudioContextLike {
  state: AudioContextState | 'closed';
  currentTime: number;
  sampleRate?: number;
  destination: unknown;
  onstatechange: ((this: BaseAudioContext, event: Event) => unknown) | null;
  resume: () => Promise<void>;
  close?: () => Promise<void>;
  createGain: () => GainLike;
  createOscillator: () => OscillatorLike;
  createBuffer?: (channels: number, length: number, sampleRate: number) => AudioBufferLike;
  createBufferSource?: () => AudioSourceLike & { buffer?: AudioBufferLike | null };
  createBiquadFilter?: () => BiquadLike;
}

export interface AudioStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface AudioDocumentLike {
  visibilityState?: DocumentVisibilityState;
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

export interface AudioWindowLike {
  localStorage?: AudioStorageLike;
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

export interface AudioEngineOptions {
  onStateChange?: (state: GameAudioState) => void;
  /** Optional factory keeps construction side-effect free and makes Web Audio mockable. */
  createAudioContext?: () => AudioContextLike;
  storage?: AudioStorageLike | null;
  document?: AudioDocumentLike | null;
  window?: AudioWindowLike | null;
  now?: () => number;
}

function emptyPlayed(): Record<AudioCue, number> {
  return { stone: 0, turn: 0, win: 0, lose: 0, brush: 0 };
}

function safely<T>(callback: () => T): T | undefined {
  try {
    return callback();
  } catch {
    return undefined;
  }
}

function setParam(param: AudioParamLike | undefined, value: number, time: number): void {
  if (!param) return;
  if (typeof param.setValueAtTime === 'function') param.setValueAtTime(value, time);
  else param.value = value;
}

function rampParam(param: AudioParamLike | undefined, value: number, time: number, exponential = false): void {
  if (!param) return;
  if (exponential && typeof param.exponentialRampToValueAtTime === 'function') {
    param.exponentialRampToValueAtTime(Math.max(value, 0.0001), time);
  } else if (typeof param.linearRampToValueAtTime === 'function') {
    param.linearRampToValueAtTime(value, time);
  } else {
    param.value = value;
  }
}

function defaultContextFactory(): (() => AudioContextLike) | null {
  const candidate = (globalThis as typeof globalThis & {
    webkitAudioContext?: new () => AudioContextLike;
  }).AudioContext ?? (globalThis as typeof globalThis & {
    webkitAudioContext?: new () => AudioContextLike;
  }).webkitAudioContext;
  return typeof candidate === 'function' ? () => new candidate() as unknown as AudioContextLike : null;
}

/**
 * A lazy Web Audio facade for five deliberately short synthesized game cues.
 * It owns no game state and never creates an AudioContext until `unlock()` is
 * called directly from a real user gesture.
 */
export class AudioEngine {
  private readonly onStateChange?: (state: GameAudioState) => void;
  private readonly createAudioContext: (() => AudioContextLike) | null;
  private readonly storage: AudioStorageLike | null;
  private readonly document: AudioDocumentLike | null;
  private readonly window: AudioWindowLike | null;
  private readonly now: () => number;
  private readonly activeStops = new Set<() => void>();
  private readonly played = emptyPlayed();
  private context: AudioContextLike | null = null;
  private muted: boolean;
  private unlocked = false;
  private destroyed = false;
  private lastBrushAt = Number.NEGATIVE_INFINITY;

  private readonly visibilityListener: EventListener = () => {
    if (this.document?.visibilityState === 'hidden') this.stop();
  };

  private readonly storageListener: EventListener = (event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== MUTED_STORAGE_KEY) return;
    this.applyMuted(storageEvent.newValue === 'true', false);
  };

  public constructor(options: AudioEngineOptions = {}) {
    this.onStateChange = options.onStateChange;
    this.window = options.window ?? (typeof window !== 'undefined' ? window : null);
    this.document = options.document ?? (typeof document !== 'undefined' ? document : null);
    this.storage = options.storage ?? this.readWindowStorage();
    this.createAudioContext = options.createAudioContext ?? defaultContextFactory();
    this.now = options.now ?? (() => Date.now());
    this.muted = this.readStoredMuted();

    this.document?.addEventListener?.('visibilitychange', this.visibilityListener);
    this.window?.addEventListener?.('storage', this.storageListener);
    this.emitState();
  }

  public getState(): GameAudioState {
    return {
      muted: this.muted,
      unlocked: this.unlocked,
      supported: this.createAudioContext !== null,
      played: { ...this.played },
    };
  }

  public setMuted(muted: boolean): void {
    this.applyMuted(Boolean(muted), true);
  }

  /** Call only from a pointerdown/keydown user gesture; failures remain retryable. */
  public async unlock(): Promise<void> {
    if (this.destroyed || !this.createAudioContext) return;

    let context = this.context;
    if (!context || context.state === 'closed') {
      context = safely(() => this.createAudioContext!()) ?? null;
      if (!context) {
        this.updateUnlocked(false);
        return;
      }
      this.installContext(context);
    }

    try {
      await context.resume();
      if (this.destroyed || this.context !== context) return;
      this.updateUnlocked(context.state === 'running');
    } catch {
      // Autoplay policy rejection is expected before a valid gesture. Do not
      // poison the context: a later pointer/key gesture may resume it.
      if (!this.destroyed && this.context === context) this.updateUnlocked(context.state === 'running');
    }
  }

  /** Never queues or replays a cue while muted, locked, hidden, or suspended. */
  public play(cue: AudioCue): void {
    if (!this.canPlay()) return;
    if (cue === 'brush') {
      const now = this.now();
      if (now - this.lastBrushAt < BRUSH_THROTTLE_MS) return;
      this.lastBrushAt = now;
    }

    const scheduled = safely(() => this.schedule(cue)) === true;
    if (!scheduled) return;
    this.played[cue] += 1;
    this.emitState();
  }

  /** Stop every currently active source. Scheduled cues are never retained. */
  public stop(): void {
    for (const stop of [...this.activeStops]) safely(stop);
    this.activeStops.clear();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.document?.removeEventListener?.('visibilitychange', this.visibilityListener);
    this.window?.removeEventListener?.('storage', this.storageListener);

    const context = this.context;
    this.context = null;
    this.unlocked = false;
    if (context) {
      context.onstatechange = null;
      const closing = safely(() => context.close?.());
      if (closing && typeof (closing as Promise<void>).then === 'function') {
        void (closing as Promise<void>).catch(() => undefined);
      }
    }
  }

  private readWindowStorage(): AudioStorageLike | null {
    return safely(() => this.window?.localStorage ?? null) ?? null;
  }

  private readStoredMuted(): boolean {
    return safely(() => this.storage?.getItem(MUTED_STORAGE_KEY) === 'true') ?? false;
  }

  private applyMuted(muted: boolean, persist: boolean): void {
    if (this.destroyed) return;
    const changed = this.muted !== muted;
    this.muted = muted;
    if (muted) this.stop();
    if (persist) safely(() => this.storage?.setItem(MUTED_STORAGE_KEY, muted ? 'true' : 'false'));
    if (changed) this.emitState();
  }

  private installContext(context: AudioContextLike): void {
    this.context = context;
    context.onstatechange = () => {
      if (this.context !== context || this.destroyed) return;
      if (context.state === 'closed') this.context = null;
      this.updateUnlocked(context.state === 'running');
    };
  }

  private updateUnlocked(unlocked: boolean): void {
    if (this.unlocked === unlocked) return;
    this.unlocked = unlocked;
    this.emitState();
  }

  private canPlay(): boolean {
    return !this.destroyed
      && !this.muted
      && this.unlocked
      && this.context?.state === 'running'
      && this.document?.visibilityState !== 'hidden';
  }

  private emitState(): void {
    try {
      this.onStateChange?.(this.getState());
    } catch {
      // UI observers must never make a user gesture or network patch fail.
    }
  }

  private schedule(cue: AudioCue): boolean {
    switch (cue) {
      case 'stone':
        return this.scheduleNotes([{ at: 0, frequency: 155, endFrequency: 82, duration: 0.085, gain: 0.07, type: 'triangle' }]);
      case 'turn':
        return this.scheduleNotes([
          { at: 0, frequency: 523.25, duration: 0.045, gain: 0.038, type: 'sine' },
          { at: 0.06, frequency: 783.99, duration: 0.075, gain: 0.048, type: 'sine' },
        ]);
      case 'win':
        return this.scheduleNotes([
          { at: 0, frequency: 523.25, duration: 0.09, gain: 0.045, type: 'sine' },
          { at: 0.095, frequency: 659.25, duration: 0.09, gain: 0.05, type: 'sine' },
          { at: 0.19, frequency: 783.99, duration: 0.16, gain: 0.06, type: 'sine' },
        ]);
      case 'lose':
        return this.scheduleNotes([
          { at: 0, frequency: 440, endFrequency: 415.3, duration: 0.1, gain: 0.042, type: 'sine' },
          { at: 0.11, frequency: 349.23, endFrequency: 329.63, duration: 0.1, gain: 0.04, type: 'sine' },
          { at: 0.22, frequency: 261.63, endFrequency: 233.08, duration: 0.15, gain: 0.045, type: 'triangle' },
        ]);
      case 'brush':
        return this.scheduleBrush();
    }
  }

  private scheduleNotes(notes: Array<{
    at: number;
    frequency: number;
    endFrequency?: number;
    duration: number;
    gain: number;
    type: OscillatorType;
  }>): boolean {
    const context = this.context;
    if (!context) return false;
    const group = this.createGroup();
    let created = 0;

    for (const note of notes) {
      const oscillator = safely(() => context.createOscillator());
      const gain = safely(() => context.createGain());
      if (!oscillator || !gain) continue;
      const start = context.currentTime + note.at;
      const end = start + note.duration;
      oscillator.type = note.type;
      setParam(oscillator.frequency, note.frequency, start);
      if (note.endFrequency !== undefined) rampParam(oscillator.frequency, note.endFrequency, end, true);
      setParam(gain.gain, 0.0001, start);
      rampParam(gain.gain, note.gain, start + Math.min(0.012, note.duration / 3));
      rampParam(gain.gain, 0.0001, end, true);
      if (!this.connect(oscillator, gain, context.destination)) continue;
      if (!this.addSourceToGroup(group, oscillator, start, end + 0.012, () => gain.disconnect?.())) continue;
      created += 1;
    }

    if (!created) group.stop();
    return created > 0;
  }

  private scheduleBrush(): boolean {
    const context = this.context;
    if (!context?.createBuffer || !context.createBufferSource) {
      // A constrained implementation still receives a quiet, percussive cue.
      return this.scheduleNotes([{ at: 0, frequency: 180, endFrequency: 90, duration: 0.045, gain: 0.015, type: 'triangle' }]);
    }

    const source = safely(() => context.createBufferSource!());
    const gain = safely(() => context.createGain());
    if (!source || !gain) return false;
    const sampleRate = context.sampleRate ?? 44_100;
    const frames = Math.max(1, Math.floor(sampleRate * 0.07));
    const buffer = safely(() => context.createBuffer!(1, frames, sampleRate));
    if (!buffer) return false;
    const samples = safely(() => buffer.getChannelData(0));
    if (!samples) return false;
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
    source.buffer = buffer;

    const filter = safely(() => context.createBiquadFilter?.());
    if (filter) {
      filter.type = 'bandpass';
      setParam(filter.frequency, 1_200, context.currentTime);
      setParam(filter.Q, 0.7, context.currentTime);
    }
    const start = context.currentTime;
    const end = start + 0.07;
    setParam(gain.gain, 0.0001, start);
    rampParam(gain.gain, 0.022, start + 0.006);
    rampParam(gain.gain, 0.0001, end, true);
    const connected = filter
      ? this.connect(source, filter, gain, context.destination)
      : this.connect(source, gain, context.destination);
    if (!connected) return false;
    const group = this.createGroup();
    if (!this.addSourceToGroup(group, source, start, end + 0.012, () => {
      safely(() => filter?.disconnect?.());
      safely(() => gain.disconnect?.());
    })) {
      group.stop();
      return false;
    }
    return true;
  }

  private connect(...nodes: unknown[]): boolean {
    try {
      for (let index = 0; index < nodes.length - 1; index += 1) {
        (nodes[index] as AudioNodeLike).connect(nodes[index + 1]);
      }
      return true;
    } catch {
      for (const node of nodes) safely(() => (node as AudioNodeLike).disconnect?.());
      return false;
    }
  }

  private createGroup(): { add: (stop: () => void) => () => void; stop: () => void } {
    const stops = new Set<() => void>();
    let stopped = false;
    const groupStop = () => {
      if (stopped) return;
      stopped = true;
      for (const stop of [...stops]) safely(stop);
      stops.clear();
      this.activeStops.delete(groupStop);
    };
    this.activeStops.add(groupStop);
    return {
      add: (stop) => {
        stops.add(stop);
        return () => {
          stops.delete(stop);
          if (stops.size === 0) this.activeStops.delete(groupStop);
        };
      },
      stop: groupStop,
    };
  }

  private addSourceToGroup(
    group: { add: (stop: () => void) => () => void; stop: () => void },
    source: AudioSourceLike,
    start: number,
    end: number,
    cleanup: () => void = () => {},
  ): boolean {
    let stopped = false;
    let removeFromGroup: () => void = () => {};
    const stop = () => {
      if (stopped) return;
      stopped = true;
      source.onended = null;
      safely(() => source.stop());
      safely(() => source.disconnect?.());
      safely(cleanup);
      removeFromGroup();
    };
    source.onended = stop;
    removeFromGroup = group.add(stop);
    try {
      source.start(start);
      source.stop(end);
      return true;
    } catch {
      stop();
      return false;
    }
  }
}
