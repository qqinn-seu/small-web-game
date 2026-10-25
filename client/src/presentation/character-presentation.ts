import { confirmedPixelCount } from '../canvas/face-renderer.js';
import type { StoredStroke, RoomState, SeatId } from '../../../shared/models.js';
import { CharacterRenderer } from './character-renderer.js';
import {
  CHARACTER_STATE_LABELS,
  characterStateFor,
  facePixelHash,
  livePatchEffects,
} from './character-state.js';

const FRAME_INTERVAL_MS = 84; // capped at roughly 12 FPS
const WATCH_DURATION_MS = 1_150;
const RESULT_PARTICLE_DURATION_MS = 1_500;

interface CharacterEntry {
  seatId: SeatId;
  canvas: HTMLCanvasElement;
  card: HTMLElement;
  label: HTMLElement;
  renderer: CharacterRenderer;
  visible: boolean;
}

export interface CharacterPresentationSeat {
  seatId: SeatId;
  canvas: HTMLCanvasElement;
  card: HTMLElement;
  label: HTMLElement;
  bodyAsset: string;
}

/**
 * A tiny presentation-only coordinator. It never edits the room mirror; it
 * consumes snapshots for static display and accepted patches for transient
 * watching/particle effects. This separation prevents recovery snapshots from
 * replaying old celebrations.
 */
export class CharacterPresentation {
  private readonly entries: CharacterEntry[];
  private readonly watchingUntil = new Map<string, number>();
  private readonly particleUntil = new Map<string, number>();
  private readonly intersectionObserver: IntersectionObserver | null;
  private readonly motionQuery: MediaQueryList | null;
  private room: RoomState | null = null;
  private localPreview: StoredStroke | null = null;
  private reducedMotion = false;
  private active = false;
  private frame = 0;
  private lastFrameAt = 0;
  private rafId: number | null = null;
  private destroyed = false;

  public constructor(seats: CharacterPresentationSeat[]) {
    this.entries = seats.map((seat) => ({
      ...seat,
      renderer: new CharacterRenderer(seat.canvas, seat.bodyAsset),
      visible: true,
    }));
    this.intersectionObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((observations) => {
        for (const observation of observations) {
          const entry = this.entries.find((candidate) => candidate.canvas === observation.target);
          if (entry) entry.visible = observation.isIntersecting;
        }
        this.syncAnimationLoop();
      }, { threshold: 0.02 });
    this.entries.forEach((entry) => this.intersectionObserver?.observe(entry.canvas));

    this.motionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this.reducedMotion = Boolean(this.motionQuery?.matches);
    this.motionQuery?.addEventListener('change', this.onMotionPreference);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.renderAll();
  }

  /** Snapshot path: update the static authoritative projection only. */
  public setRoom(room: RoomState | null): void {
    this.room = room;
    if (!room) {
      this.watchingUntil.clear();
      this.particleUntil.clear();
    }
    this.renderAll();
    this.syncAnimationLoop();
  }

  public setLocalPreview(preview: StoredStroke | null): void {
    this.localPreview = preview;
    this.renderAll();
  }

  /** Live patch path: the only source allowed to create short-lived effects. */
  public onLivePatch(before: RoomState, next: RoomState): void {
    if (!this.active || before.roomInstanceId !== next.roomInstanceId) return;
    const now = Date.now();
    const effects = livePatchEffects(before, next);
    for (const playerId of effects.watchingPlayerIds) this.watchingUntil.set(playerId, now + WATCH_DURATION_MS);
    for (const playerId of effects.resultPlayerIds) this.particleUntil.set(playerId, now + RESULT_PARTICLE_DURATION_MS);
    this.renderAll();
    this.syncAnimationLoop();
  }

  /** Disable transient motion/effects whenever the UI is not operational. */
  public setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.watchingUntil.clear();
      this.particleUntil.clear();
      this.stopAnimationLoop();
    }
    this.renderAll();
    this.syncAnimationLoop();
  }

  public destroy(): void {
    this.destroyed = true;
    this.stopAnimationLoop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.motionQuery?.removeEventListener('change', this.onMotionPreference);
    this.intersectionObserver?.disconnect();
    this.entries.forEach((entry) => entry.renderer.destroy());
  }

  private readonly onVisibilityChange = (): void => this.syncAnimationLoop();

  private readonly onMotionPreference = (): void => {
    this.reducedMotion = Boolean(this.motionQuery?.matches);
    this.renderAll();
    this.syncAnimationLoop();
  };

  private syncAnimationLoop(): void {
    if (this.destroyed || !this.shouldAnimate()) {
      this.stopAnimationLoop();
      return;
    }
    if (this.rafId === null) this.rafId = window.requestAnimationFrame(this.onAnimationFrame);
  }

  private stopAnimationLoop(): void {
    if (this.rafId !== null) window.cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastFrameAt = 0;
  }

  private shouldAnimate(): boolean {
    if (!this.active || !this.room || document.visibilityState === 'hidden') return false;
    if (this.reducedMotion) return false;
    return this.entries.some((entry, index) => entry.visible && Boolean(this.room?.seats[index]));
  }

  private readonly onAnimationFrame = (timestamp: number): void => {
    this.rafId = null;
    if (!this.shouldAnimate()) return;
    if (!this.lastFrameAt || timestamp - this.lastFrameAt >= FRAME_INTERVAL_MS) {
      this.lastFrameAt = timestamp;
      this.frame = (this.frame + 1) % 10_000;
      this.renderAll();
    }
    this.syncAnimationLoop();
  };

  private renderAll(): void {
    const now = Date.now();
    this.pruneExpired(now);
    this.entries.forEach((entry, index) => {
      const seat = this.room?.seats[index] ?? null;
      const playerId = seat?.playerId ?? '';
      const face = playerId ? this.room?.faces[playerId] ?? null : null;
      const watchingUntil = playerId ? this.watchingUntil.get(playerId) : undefined;
      const state = characterStateFor(this.room, seat, { now, watchingUntil });
      const isTarget = this.room?.phase === 'drawing' && this.room.drawing?.targetPlayerId === playerId;
      const particles = Boolean(playerId && (this.particleUntil.get(playerId) ?? 0) > now);

      entry.renderer.setState({
        face,
        draft: isTarget ? this.room?.drawing?.draft ?? null : null,
        localPreview: isTarget ? this.localPreview : null,
        state,
        frame: this.reducedMotion ? 0 : this.frame,
        boardDirection: entry.seatId === 'A' ? 1 : -1,
        reducedMotion: this.reducedMotion,
        showResultParticles: particles,
      });
      entry.label.textContent = CHARACTER_STATE_LABELS[state];
      entry.canvas.dataset.playerId = playerId;
      entry.canvas.dataset.seatId = entry.seatId;
      entry.canvas.dataset.state = state;
      entry.canvas.dataset.animationFrame = String(this.reducedMotion ? 0 : this.frame);
      entry.canvas.dataset.confirmedPixelCount = String(confirmedPixelCount(face));
      entry.canvas.dataset.reducedMotion = String(this.reducedMotion);
      entry.canvas.dataset.faceHash = facePixelHash(face);
      entry.card.dataset.characterState = state;
      if (playerId) entry.card.dataset.playerId = playerId;
      else delete entry.card.dataset.playerId;
    });
  }

  private pruneExpired(now: number): void {
    for (const [playerId, until] of this.watchingUntil) if (until <= now) this.watchingUntil.delete(playerId);
    for (const [playerId, until] of this.particleUntil) if (until <= now) this.particleUntil.delete(playerId);
  }
}
