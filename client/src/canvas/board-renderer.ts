import { BOARD_SIZE } from '../../../shared/constants.js';
import type { Point, PublicRound, RoomState } from '../../../shared/models.js';

/** CSS-pixel inset of the outermost intersections. Kept stable for E2E input. */
export const BOARD_PADDING = 28;
export const BOARD_INTERSECTION_COUNT = BOARD_SIZE;
export const BOARD_GRID_SPAN = BOARD_INTERSECTION_COUNT - 1;
export const HIT_THRESHOLD_RATIO = 0.42;

export interface BoardGeometry {
  width: number;
  height: number;
  originX: number;
  originY: number;
  padding: number;
  spacing: number;
  boardExtent: number;
}

export function getBoardGeometry(width: number, height: number): BoardGeometry {
  const boardExtent = Math.max(BOARD_PADDING * 2 + BOARD_GRID_SPAN, Math.min(width, height));
  const originX = (width - boardExtent) / 2 + BOARD_PADDING;
  const originY = (height - boardExtent) / 2 + BOARD_PADDING;
  return {
    width,
    height,
    originX,
    originY,
    padding: BOARD_PADDING,
    spacing: (boardExtent - BOARD_PADDING * 2) / BOARD_GRID_SPAN,
    boardExtent,
  };
}

export function cellPoint(geometry: BoardGeometry, x: number, y: number): Point {
  return {
    x: geometry.originX + x * geometry.spacing,
    y: geometry.originY + y * geometry.spacing,
  };
}

/** Returns null if the pointer is not close enough to a legal intersection. */
export function nearestBoardCell(geometry: BoardGeometry, x: number, y: number): Point | null {
  const column = Math.round((x - geometry.originX) / geometry.spacing);
  const row = Math.round((y - geometry.originY) / geometry.spacing);
  if (column < 0 || column >= BOARD_SIZE || row < 0 || row >= BOARD_SIZE) return null;

  const centre = cellPoint(geometry, column, row);
  const threshold = Math.max(9, geometry.spacing * HIT_THRESHOLD_RATIO);
  if (Math.hypot(x - centre.x, y - centre.y) > threshold) return null;
  return { x: column, y: row };
}

export function boardIndex(x: number, y: number): number {
  return y * BOARD_SIZE + x;
}

export interface BoardVisualState {
  board: PublicRound['board'];
  lastMove: PublicRound['lastMove'];
  winningLine: Point[];
}

/** A pure draw-input projection useful for renderer tests. */
export function getBoardVisualState(round: PublicRound | null): BoardVisualState {
  return {
    board: round ? round.board : [],
    lastMove: round?.lastMove ?? null,
    winningLine: round?.result?.winningLine ?? [],
  };
}

export class BoardRenderer {
  private readonly context: CanvasRenderingContext2D;
  private room: RoomState | null = null;
  private geometry: BoardGeometry = getBoardGeometry(1, 1);
  private readonly resizeObserver: ResizeObserver;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持 Canvas 2D。');
    this.context = context;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  public setRoom(room: RoomState | null): void {
    this.room = room;
    this.draw();
  }

  public getGeometry(): BoardGeometry {
    return this.geometry;
  }

  public destroy(): void {
    this.resizeObserver.disconnect();
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geometry = getBoardGeometry(width, height);

    // Data attributes intentionally expose the logical grid for Playwright:
    // clientX = canvas.left + originX + column * spacing (same for Y).
    // clientLeft/clientTop account for the CSS border because browser pointer
    // coordinates are measured from getBoundingClientRect(), not the bitmap.
    this.canvas.dataset.padding = (this.geometry.originX + this.canvas.clientLeft).toFixed(4);
    this.canvas.dataset.step = this.geometry.spacing.toFixed(4);
    this.canvas.dataset.boardPadding = String(BOARD_PADDING);
    this.canvas.dataset.boardSpacing = this.geometry.spacing.toFixed(4);
    this.canvas.dataset.boardOriginX = (this.geometry.originX + this.canvas.clientLeft).toFixed(4);
    this.canvas.dataset.boardOriginY = (this.geometry.originY + this.canvas.clientTop).toFixed(4);
    this.draw();
  }

  private draw(): void {
    const { context: ctx, geometry } = this;
    const { width, height } = geometry;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f7e5ba';
    ctx.fillRect(0, 0, width, height);

    this.drawGrid();
    const round = this.room?.round ?? null;
    this.canvas.dataset.moveNo = String(round?.moveNo ?? 0);
    const visual = getBoardVisualState(round);
    if (visual.winningLine.length >= 2) this.drawWinningLine(visual.winningLine);
    if (round) this.drawPieces(visual);
    if (visual.lastMove) this.drawLastMove(visual.lastMove);
  }

  private drawGrid(): void {
    const { context: ctx, geometry } = this;
    const first = cellPoint(geometry, 0, 0);
    const last = cellPoint(geometry, BOARD_SIZE - 1, BOARD_SIZE - 1);
    ctx.save();
    ctx.strokeStyle = '#765637';
    ctx.lineWidth = 1;
    for (let index = 0; index < BOARD_SIZE; index += 1) {
      const vertical = cellPoint(geometry, index, 0);
      const horizontal = cellPoint(geometry, 0, index);
      ctx.beginPath();
      ctx.moveTo(Math.round(vertical.x) + 0.5, first.y);
      ctx.lineTo(Math.round(vertical.x) + 0.5, last.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(first.x, Math.round(horizontal.y) + 0.5);
      ctx.lineTo(last.x, Math.round(horizontal.y) + 0.5);
      ctx.stroke();
    }

    ctx.fillStyle = '#765637';
    for (const [x, y] of [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]) {
      const point = cellPoint(geometry, x, y);
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(2, geometry.spacing * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawWinningLine(line: Point[]): void {
    const { context: ctx, geometry } = this;
    const start = cellPoint(geometry, line[0].x, line[0].y);
    const end = cellPoint(geometry, line[line.length - 1].x, line[line.length - 1].y);
    ctx.save();
    ctx.strokeStyle = '#e85b38';
    ctx.globalAlpha = 0.84;
    ctx.lineWidth = Math.max(4, geometry.spacing * 0.18);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawPieces(visual: BoardVisualState): void {
    const { context: ctx, geometry } = this;
    const radius = Math.max(7, geometry.spacing * 0.39);
    visual.board.forEach((cell, index) => {
      if (cell === 0) return;
      const x = index % BOARD_SIZE;
      const y = Math.floor(index / BOARD_SIZE);
      const point = cellPoint(geometry, x, y);
      const gradient = ctx.createRadialGradient(
        point.x - radius * 0.3,
        point.y - radius * 0.35,
        radius * 0.1,
        point.x,
        point.y,
        radius,
      );
      if (cell === 1) {
        gradient.addColorStop(0, '#62666c');
        gradient.addColorStop(0.42, '#20242a');
        gradient.addColorStop(1, '#050608');
      } else {
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.66, '#f0eee8');
        gradient.addColorStop(1, '#cbc6bd');
      }
      ctx.save();
      ctx.fillStyle = gradient;
      ctx.shadowColor = 'rgba(40, 30, 18, 0.25)';
      ctx.shadowBlur = 3;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  private drawLastMove(move: NonNullable<PublicRound['lastMove']>): void {
    const { context: ctx, geometry } = this;
    const point = cellPoint(geometry, move.x, move.y);
    const size = Math.max(10, geometry.spacing * 0.58);
    ctx.save();
    ctx.strokeStyle = move.color === 1 ? '#f8d260' : '#ce4c37';
    ctx.lineWidth = 2;
    ctx.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.restore();
  }
}
