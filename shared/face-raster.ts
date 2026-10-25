import { EMPTY_FACE_PIXEL, FACE_GRID_SIZE, FACE_PIXEL_COUNT } from './constants.js';
import type { Point } from './models.js';

export function emptyFacePixels(): number[] {
  return Array<number>(FACE_PIXEL_COUNT).fill(EMPTY_FACE_PIXEL);
}

/** Integer Bresenham; covers both endpoints and stays on the 32×32 logical grid. */
export function rasterLine(start: Point, end: Point): Point[] {
  const result: Point[] = [];
  let x = start.x;
  let y = start.y;
  const dx = Math.abs(end.x - start.x);
  const sx = start.x < end.x ? 1 : -1;
  const dy = -Math.abs(end.y - start.y);
  const sy = start.y < end.y ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    result.push({ x, y });
    if (x === end.x && y === end.y) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
  return result;
}

/** Inputs are protocol-validated grid points. Returns a fresh opaque overlay. */
export function paintPolyline(base: readonly number[], points: readonly Point[], colorIndex: number): number[] {
  const pixels = base.length === FACE_PIXEL_COUNT ? [...base] : emptyFacePixels();
  if (points.length === 0) return pixels;
  for (let i = 0; i < points.length; i++) {
    const end = points[i]!;
    const start = points[Math.max(0, i - 1)]!;
    for (const point of rasterLine(start, end)) {
      if (point.x >= 0 && point.x < FACE_GRID_SIZE && point.y >= 0 && point.y < FACE_GRID_SIZE) {
        pixels[point.y * FACE_GRID_SIZE + point.x] = colorIndex;
      }
    }
  }
  return pixels;
}
