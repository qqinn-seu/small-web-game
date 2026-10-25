import {
  BRUSH_COLORS,
  EMPTY_FACE_PIXEL,
  FACE_GRID_SIZE,
  FACE_PIXEL_COUNT,
} from '../../../shared/constants.js';
import { emptyFacePixels, paintPolyline } from '../../../shared/face-raster.js';
import type { FaceCanvas, Point, StoredStroke } from '../../../shared/models.js';

export interface FaceGeometry {
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
  size: number;
  cellSize: number;
}

export interface FaceRenderState {
  face: FaceCanvas | null;
  /** The authoritative, still-uncommitted server stroke. */
  draft?: StoredStroke | null;
  /** The winner-only, not-yet-confirmed pointer preview. */
  localPreview?: StoredStroke | null;
}

/** Logical square face grid centred inside a CSS-pixel canvas. */
export function getFaceGeometry(width: number, height: number): FaceGeometry {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const size = Math.min(safeWidth, safeHeight);
  return {
    width: safeWidth,
    height: safeHeight,
    paddingX: (safeWidth - size) / 2,
    paddingY: (safeHeight - size) / 2,
    size,
    cellSize: size / FACE_GRID_SIZE,
  };
}

/** Convert a CSS-content coordinate into a legal protocol grid point. */
export function faceCellAt(geometry: FaceGeometry, x: number, y: number): Point | null {
  const gridX = Math.floor((x - geometry.paddingX) / geometry.cellSize);
  const gridY = Math.floor((y - geometry.paddingY) / geometry.cellSize);
  if (gridX < 0 || gridX >= FACE_GRID_SIZE || gridY < 0 || gridY >= FACE_GRID_SIZE) return null;
  return { x: gridX, y: gridY };
}

export function confirmedPixelCount(face: FaceCanvas | null | undefined): number {
  if (!face) return 0;
  return face.pixels.reduce((count, color) => count + (color === EMPTY_FACE_PIXEL ? 0 : 1), 0);
}

/**
 * Public faces are already flattened into `pixels`; `strokes` are merely a
 * recent-history/debug aid and must never be drawn again. The two transient
 * paths use shared Bresenham interpolation so local and server visuals agree.
 */
export function composeFacePixels(state: FaceRenderState): number[] {
  let pixels = state.face?.pixels.length === FACE_PIXEL_COUNT
    ? [...state.face.pixels]
    : emptyFacePixels();
  if (state.draft?.points.length) pixels = paintPolyline(pixels, state.draft.points, state.draft.colorIndex);
  if (state.localPreview?.points.length) {
    pixels = paintPolyline(pixels, state.localPreview.points, state.localPreview.colorIndex);
  }
  return pixels;
}

function fallbackFace(context: CanvasRenderingContext2D, geometry: FaceGeometry): void {
  const { paddingX, paddingY, size } = geometry;
  context.fillStyle = '#f1c6a9';
  context.fillRect(paddingX, paddingY, size, size);
  context.fillStyle = '#4d3532';
  const eye = Math.max(1, size / 10);
  context.fillRect(paddingX + size * 0.28, paddingY + size * 0.34, eye, eye);
  context.fillRect(paddingX + size * 0.64, paddingY + size * 0.34, eye, eye);
  context.fillRect(paddingX + size * 0.39, paddingY + size * 0.66, size * 0.22, Math.max(1, size / 26));
}

/** A DPR-aware 32×32 face surface. The supplied static base image is optional at runtime. */
export class FaceRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly baseImage: HTMLImageElement;
  private state: FaceRenderState = { face: null };
  private geometry = getFaceGeometry(1, 1);

  public constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持 Canvas 2D。');
    this.context = context;
    this.baseImage = new Image();
    this.baseImage.decoding = 'async';
    this.baseImage.addEventListener('load', () => this.draw());
    // The asset is supplied independently of this implementation. Do not block
    // drawing if it is not yet present; the neutral fallback remains usable.
    this.baseImage.src = '/assets/face-base.png';
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  public setState(state: FaceRenderState): void {
    this.state = state;
    this.draw();
  }

  public getGeometry(): FaceGeometry {
    return this.geometry;
  }

  public destroy(): void {
    this.resizeObserver.disconnect();
    this.baseImage.removeAttribute('src');
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
    this.context.imageSmoothingEnabled = false;
    this.geometry = getFaceGeometry(width, height);
    this.canvas.dataset.gridSize = String(FACE_GRID_SIZE);
    this.canvas.dataset.cellSize = this.geometry.cellSize.toFixed(4);
    this.canvas.dataset.padding = this.geometry.paddingX.toFixed(4);
    this.draw();
  }

  private draw(): void {
    const { context, geometry } = this;
    context.clearRect(0, 0, geometry.width, geometry.height);
    context.imageSmoothingEnabled = false;
    if (this.baseImage.complete && this.baseImage.naturalWidth > 0) {
      context.drawImage(this.baseImage, geometry.paddingX, geometry.paddingY, geometry.size, geometry.size);
    } else {
      fallbackFace(context, geometry);
    }

    const face = this.state.face;
    const pixels = composeFacePixels(this.state);
    this.canvas.dataset.playerId = face?.ownerPlayerId ?? '';
    this.canvas.dataset.ownerPlayerId = face?.ownerPlayerId ?? '';
    this.canvas.dataset.revision = String(face?.revision ?? 0);
    this.canvas.dataset.confirmedPixelCount = String(confirmedPixelCount(face));

    for (let index = 0; index < pixels.length; index += 1) {
      const colorIndex = pixels[index]!;
      if (colorIndex === EMPTY_FACE_PIXEL || colorIndex < 0 || colorIndex >= BRUSH_COLORS.length) continue;
      const x = index % FACE_GRID_SIZE;
      const y = Math.floor(index / FACE_GRID_SIZE);
      context.fillStyle = BRUSH_COLORS[colorIndex]!;
      context.fillRect(
        geometry.paddingX + x * geometry.cellSize,
        geometry.paddingY + y * geometry.cellSize,
        geometry.cellSize,
        geometry.cellSize,
      );
    }
  }
}
