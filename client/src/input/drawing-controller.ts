import {
  STROKE_BATCH_MAX_POINTS,
  STROKE_MAX_INPUT_POINTS,
  STROKE_SEND_INTERVAL_MS,
} from '../../../shared/constants.js';
import type { Point, RoomState, StoredStroke } from '../../../shared/models.js';
import type {
  AckResult,
  DrawingRequest,
  StrokeBeginRequest,
  StrokeEndRequest,
  StrokePointsRequest,
} from '../../../shared/protocol.js';
import { faceCellAt, getFaceGeometry } from '../canvas/face-renderer.js';
import type { ClientIdentity } from '../network/socket-client.js';

export interface DrawingNetworkSender {
  strokeBegin: (request: StrokeBeginRequest) => Promise<AckResult>;
  strokePoints: (request: StrokePointsRequest) => Promise<AckResult>;
  strokeEnd: (request: StrokeEndRequest) => Promise<AckResult>;
  drawingSkip: (request: DrawingRequest) => Promise<AckResult>;
}

export interface DrawingControllerOptions {
  canvas: HTMLCanvasElement;
  getRoom: () => RoomState | null;
  getIdentity: () => ClientIdentity | null;
  isOperational: () => boolean;
  getColorIndex: () => number;
  sender: DrawingNetworkSender;
  requestSync: (reason: string) => void;
  notify: (message: string) => void;
  onLocalPreview: (preview: StoredStroke | null) => void;
  now?: () => number;
  makeId?: () => string;
}

type InFlight = (
  | { kind: 'begin'; actionId: string; retryAfterRecovery: boolean }
  | { kind: 'points'; actionId: string; seq: number; points: Point[]; retryAfterRecovery: boolean }
  | { kind: 'end'; actionId: string; retryAfterRecovery: boolean }
) & { baseVersion: number };

interface ActiveStroke {
  roomInstanceId: string;
  drawingId: string;
  roundId: string;
  strokeId: string;
  colorIndex: number;
  startPoint: Point;
  points: Point[];
  queued: Point[];
  pointCount: number;
  confirmedSeq: number;
  beginAcknowledged: boolean;
  pointerId: number;
  nextBatchAt: number;
  pointerEnded: boolean;
  cancelled: boolean;
  endAcknowledged: boolean;
  inFlight: InFlight | null;
}

function defaultId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function samePoint(left: Point | undefined, right: Point): boolean {
  return Boolean(left && left.x === right.x && left.y === right.y);
}

/**
 * Winner-side input pipeline. It never paints authoritative state itself: the
 * preview is visual only, while `setRoom()` reconciles ACK loss with server
 * draft/snapshot state. A cancelled pointer intentionally never becomes end.
 */
export class DrawingController {
  private active: ActiveStroke | null = null;
  private blockedDrawingId: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private skipInFlight = false;
  private latestRoom: RoomState | null = null;

  public constructor(private readonly options: DrawingControllerOptions) {
    options.canvas.addEventListener('pointerdown', this.onPointerDown);
    options.canvas.addEventListener('pointermove', this.onPointerMove);
    options.canvas.addEventListener('pointerup', this.onPointerUp);
    options.canvas.addEventListener('pointercancel', this.onPointerCancel);
  }

  public destroy(): void {
    this.stopTimer();
    const { canvas } = this.options;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.active = null;
    this.options.onLocalPreview(null);
  }

  /** Called for every snapshot/patch, including same-version recovery snapshots. */
  public setRoom(room: RoomState | null): void {
    this.latestRoom = room;
    const active = this.active;
    if (!active) {
      if (this.blockedDrawingId && room?.drawing?.drawingId !== this.blockedDrawingId) this.blockedDrawingId = null;
      return;
    }

    const drawing = room?.phase === 'drawing' ? room.drawing : null;
    if (!room || room.roomInstanceId !== active.roomInstanceId || !drawing || drawing.drawingId !== active.drawingId) {
      this.finishLocalStroke();
      return;
    }

    const draft = drawing.draft;
    if (draft?.strokeId === active.strokeId) {
      active.beginAcknowledged = true;
      if (active.inFlight?.kind === 'begin') active.inFlight = null;
      if (active.inFlight?.kind === 'points' && draft.lastSeq >= active.inFlight.seq) {
        active.confirmedSeq = Math.max(active.confirmedSeq, active.inFlight.seq);
        active.inFlight = null;
      } else if (!active.inFlight && draft.lastSeq > active.confirmedSeq) {
        // The same page owns this stroke. A full reconnect snapshot may prove a
        // prior batch despite its ACK being lost, so it can unlock the queue.
        active.confirmedSeq = draft.lastSeq;
      }
    }

    if (this.isDrawingExpired(drawing.deadlineAt)) {
      this.finishLocalStroke();
      return;
    }
    this.pump();
  }

  /** Opens a preserved same-page queue only after auth/snapshot gates reopen. */
  public setOperational(): void {
    if (!this.options.isOperational()) {
      // In particular, a session:replaced page must not let its old interval
      // wake up and emit a stale batch after another tab has taken control.
      this.stopTimer();
      return;
    }
    if (this.active && !this.active.cancelled && !this.active.endAcknowledged && this.flushTimer === null) {
      this.startTimer();
    }
    this.pump();
  }

  public canStart(): boolean {
    const { room, drawing } = this.currentDrawing();
    const identity = this.options.getIdentity();
    return Boolean(
      room
      && drawing
      && identity
      && this.options.isOperational()
      && !this.active
      && this.blockedDrawingId !== drawing.drawingId
      && drawing.winnerPlayerId === identity.playerId
      && !drawing.strokeUsed
      && !drawing.draft
      && !this.isDrawingExpired(drawing.deadlineAt),
    );
  }

  /** Winner can discard either an unused turn or an incomplete draft. */
  public canSkip(): boolean {
    const { drawing } = this.currentDrawing();
    const identity = this.options.getIdentity();
    return Boolean(
      drawing
      && identity
      && this.options.isOperational()
      && !this.skipInFlight
      && drawing.winnerPlayerId === identity.playerId
      && !this.isDrawingExpired(drawing.deadlineAt),
    );
  }

  public skip(): void {
    const { room, drawing } = this.currentDrawing();
    if (!room || !drawing || !this.canSkip()) return;
    this.cancelWithoutEnd();
    this.skipInFlight = true;
    const request: DrawingRequest = {
      actionId: this.makeId(),
      roomInstanceId: room.roomInstanceId,
      baseVersion: room.version,
      roundId: drawing.roundId,
      drawingId: drawing.drawingId,
    };
    void this.options.sender.drawingSkip(request).then((response) => {
      if (!response.ok) this.handleRejected(response, '跳过画脸未被服务器接受。');
    }).catch(() => {
      this.options.requestSync('跳过画脸确认超时，正在同步…');
    }).finally(() => {
      this.skipInFlight = false;
    });
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    if (!this.canStart()) return;
    const point = this.pointerPoint(event);
    if (!point) return;
    const { room, drawing } = this.currentDrawing();
    if (!room || !drawing) return;

    event.preventDefault();
    this.options.canvas.setPointerCapture?.(event.pointerId);
    const colorIndex = this.options.getColorIndex();
    const active: ActiveStroke = {
      roomInstanceId: room.roomInstanceId,
      drawingId: drawing.drawingId,
      roundId: drawing.roundId,
      strokeId: this.makeId(),
      colorIndex,
      startPoint: point,
      points: [point],
      queued: [],
      pointCount: 1,
      confirmedSeq: 0,
      beginAcknowledged: false,
      pointerId: event.pointerId,
      nextBatchAt: 0,
      pointerEnded: false,
      cancelled: false,
      endAcknowledged: false,
      inFlight: null,
    };
    this.active = active;
    this.emitPreview();
    this.startTimer();
    this.sendBegin(active);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId || active.cancelled || active.pointerEnded) return;
    const point = this.pointerPoint(event);
    if (!point || samePoint(active.points[active.points.length - 1], point)) return;
    event.preventDefault();
    if (active.pointCount >= STROKE_MAX_INPUT_POINTS) return;
    active.points.push(point);
    active.queued.push(point);
    active.pointCount += 1;
    this.emitPreview();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId || active.cancelled || active.pointerEnded || active.endAcknowledged) return;
    const point = this.pointerPoint(event);
    if (point && !samePoint(active.points[active.points.length - 1], point) && active.pointCount < STROKE_MAX_INPUT_POINTS) {
      active.points.push(point);
      active.queued.push(point);
      active.pointCount += 1;
      this.emitPreview();
    }
    event.preventDefault();
    active.pointerEnded = true;
    this.options.canvas.releasePointerCapture?.(event.pointerId);
    this.pump();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) return;
    // A cancel has no reliable final position. Do not send the residual queue,
    // do not fabricate stroke:end, and do not offer a second stroke.
    active.cancelled = true;
    active.queued = [];
    this.blockedDrawingId = active.drawingId;
    this.stopTimer();
    this.options.onLocalPreview(null);
    this.options.canvas.releasePointerCapture?.(event.pointerId);
  };

  private pointerPoint(event: PointerEvent): Point | null {
    const canvas = this.options.canvas;
    const rect = canvas.getBoundingClientRect();
    const geometry = getFaceGeometry(canvas.clientWidth, canvas.clientHeight);
    return faceCellAt(
      geometry,
      event.clientX - rect.left - canvas.clientLeft,
      event.clientY - rect.top - canvas.clientTop,
    );
  }

  private currentDrawing(): { room: RoomState | null; drawing: NonNullable<RoomState['drawing']> | null } {
    const room = this.latestRoom ?? this.options.getRoom();
    return { room, drawing: room?.phase === 'drawing' ? room.drawing : null };
  }

  private startTimer(): void {
    this.stopTimer();
    this.flushTimer = setInterval(() => this.pump(), STROKE_SEND_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  private pump(): void {
    const active = this.active;
    if (!active || active.cancelled || active.endAcknowledged) return;
    const { room, drawing } = this.currentDrawing();
    if (!room || !drawing || room.roomInstanceId !== active.roomInstanceId || drawing.drawingId !== active.drawingId) return;
    if (this.isDrawingExpired(drawing.deadlineAt)) {
      this.finishLocalStroke();
      return;
    }
    if (!this.options.isOperational()) return;

    if (active.inFlight) {
      if (active.inFlight.retryAfterRecovery) this.retryInFlight(active);
      return;
    }
    if (!active.beginAcknowledged) return;
    if (active.queued.length > 0) {
      const timestamp = (this.options.now ?? Date.now)();
      if (timestamp < active.nextBatchAt) return;
      active.nextBatchAt = timestamp + STROKE_SEND_INTERVAL_MS;
      const points = active.queued.splice(0, STROKE_BATCH_MAX_POINTS);
      this.sendPoints(active, points, active.confirmedSeq + 1);
      return;
    }
    if (active.pointerEnded) this.sendEnd(active);
  }

  private sendBegin(active: ActiveStroke): void {
    const { room } = this.currentDrawing();
    if (!room || !this.options.isOperational()) return;
    const inFlight: InFlight = { kind: 'begin', actionId: this.makeId(), retryAfterRecovery: false, baseVersion: room.version };
    active.inFlight = inFlight;
    const request: StrokeBeginRequest = {
      actionId: inFlight.actionId,
      roomInstanceId: active.roomInstanceId,
      baseVersion: room.version,
      roundId: active.roundId,
      drawingId: active.drawingId,
      strokeId: active.strokeId,
      colorIndex: active.colorIndex,
      startPoint: active.startPoint,
    };
    void this.options.sender.strokeBegin(request).then((response) => {
      if (this.active !== active || active.inFlight !== inFlight) return;
      if (!response.ok) {
        this.handleRejected(response, '开始画脸未被服务器接受。');
        return;
      }
      active.beginAcknowledged = true;
      active.inFlight = null;
      this.pump();
    }).catch(() => this.markForRecovery(active, inFlight, '开始笔画确认超时，正在等待恢复状态。'));
  }

  private sendPoints(active: ActiveStroke, points: Point[], seq: number): void {
    const { room } = this.currentDrawing();
    if (!room || points.length === 0) return;
    const inFlight: InFlight = { kind: 'points', actionId: this.makeId(), seq, points, retryAfterRecovery: false, baseVersion: room.version };
    active.inFlight = inFlight;
    const request: StrokePointsRequest = {
      actionId: inFlight.actionId,
      roomInstanceId: active.roomInstanceId,
      baseVersion: room.version,
      roundId: active.roundId,
      drawingId: active.drawingId,
      strokeId: active.strokeId,
      seq,
      points,
    };
    void this.options.sender.strokePoints(request).then((response) => {
      if (this.active !== active || active.inFlight !== inFlight) return;
      if (!response.ok) {
        this.handleRejected(response, '笔画批次未被服务器接受。');
        return;
      }
      active.confirmedSeq = seq;
      active.inFlight = null;
      this.pump();
    }).catch(() => this.markForRecovery(active, inFlight, '笔画批次确认超时，正在等待恢复状态。'));
  }

  private sendEnd(active: ActiveStroke): void {
    const { room } = this.currentDrawing();
    if (!room) return;
    const inFlight: InFlight = { kind: 'end', actionId: this.makeId(), retryAfterRecovery: false, baseVersion: room.version };
    active.inFlight = inFlight;
    const request: StrokeEndRequest = {
      actionId: inFlight.actionId,
      roomInstanceId: active.roomInstanceId,
      baseVersion: room.version,
      roundId: active.roundId,
      drawingId: active.drawingId,
      strokeId: active.strokeId,
      lastSeq: active.confirmedSeq,
      pointCount: active.pointCount,
    };
    void this.options.sender.strokeEnd(request).then((response) => {
      if (this.active !== active || active.inFlight !== inFlight) return;
      if (!response.ok) {
        this.handleRejected(response, '结束笔画未被服务器接受。');
        return;
      }
      active.inFlight = null;
      active.endAcknowledged = true;
      this.stopTimer();
      this.options.onLocalPreview(null);
    }).catch(() => this.markForRecovery(active, inFlight, '结束笔画确认超时，正在等待恢复状态。'));
  }

  private retryInFlight(active: ActiveStroke): void {
    const inFlight = active.inFlight;
    if (!inFlight || !inFlight.retryAfterRecovery) return;
    inFlight.retryAfterRecovery = false;
    const { room } = this.currentDrawing();
    if (!room) return;
    if (inFlight.kind === 'begin') {
      const request: StrokeBeginRequest = {
        actionId: inFlight.actionId, roomInstanceId: active.roomInstanceId, baseVersion: inFlight.baseVersion,
        roundId: active.roundId, drawingId: active.drawingId, strokeId: active.strokeId,
        colorIndex: active.colorIndex, startPoint: active.startPoint,
      };
      void this.options.sender.strokeBegin(request).then((response) => {
        if (this.active !== active || active.inFlight !== inFlight) return;
        if (!response.ok) return this.handleRejected(response, '恢复笔画开始失败。');
        active.beginAcknowledged = true; active.inFlight = null; this.pump();
      }).catch(() => this.markForRecovery(active, inFlight, '恢复笔画开始仍未确认。'));
      return;
    }
    if (inFlight.kind === 'points') {
      const request: StrokePointsRequest = {
        actionId: inFlight.actionId, roomInstanceId: active.roomInstanceId, baseVersion: inFlight.baseVersion,
        roundId: active.roundId, drawingId: active.drawingId, strokeId: active.strokeId,
        seq: inFlight.seq, points: inFlight.points,
      };
      void this.options.sender.strokePoints(request).then((response) => {
        if (this.active !== active || active.inFlight !== inFlight) return;
        if (!response.ok) return this.handleRejected(response, '恢复笔画批次失败。');
        active.confirmedSeq = inFlight.seq; active.inFlight = null; this.pump();
      }).catch(() => this.markForRecovery(active, inFlight, '恢复笔画批次仍未确认。'));
      return;
    }
    const request: StrokeEndRequest = {
      actionId: inFlight.actionId, roomInstanceId: active.roomInstanceId, baseVersion: inFlight.baseVersion,
      roundId: active.roundId, drawingId: active.drawingId, strokeId: active.strokeId,
      lastSeq: active.confirmedSeq, pointCount: active.pointCount,
    };
    void this.options.sender.strokeEnd(request).then((response) => {
      if (this.active !== active || active.inFlight !== inFlight) return;
      if (!response.ok) return this.handleRejected(response, '恢复结束笔画失败。');
      active.inFlight = null; active.endAcknowledged = true; this.stopTimer(); this.options.onLocalPreview(null);
    }).catch(() => this.markForRecovery(active, inFlight, '恢复结束笔画仍未确认。'));
  }

  private markForRecovery(active: ActiveStroke, inFlight: InFlight, message: string): void {
    if (this.active !== active || active.inFlight !== inFlight || active.cancelled) return;
    inFlight.retryAfterRecovery = true;
    this.options.requestSync(message);
  }

  private handleRejected(response: Exclude<AckResult, { ok: true }>, fallback: string): void {
    this.options.notify(response.message || fallback);
    if (response.needsSnapshot) this.options.requestSync('服务器要求同步绘画状态…');
    this.cancelWithoutEnd();
  }

  private cancelWithoutEnd(): void {
    if (this.active) {
      this.blockedDrawingId = this.active.drawingId;
      this.active.cancelled = true;
    }
    this.stopTimer();
    this.options.onLocalPreview(null);
  }

  private finishLocalStroke(): void {
    this.stopTimer();
    this.active = null;
    this.blockedDrawingId = null;
    this.options.onLocalPreview(null);
  }

  private emitPreview(): void {
    const active = this.active;
    this.options.onLocalPreview(active ? {
      strokeId: active.strokeId,
      colorIndex: active.colorIndex,
      points: active.points.map((point) => ({ ...point })),
    } : null);
  }

  private isDrawingExpired(deadlineAt: number): boolean {
    return (this.options.now ?? Date.now)() >= deadlineAt;
  }

  private makeId(): string {
    return (this.options.makeId ?? defaultId)();
  }
}
