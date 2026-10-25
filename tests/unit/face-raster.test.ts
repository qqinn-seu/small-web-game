import { describe, expect, it } from 'vitest';

import { EMPTY_FACE_PIXEL, FACE_PIXEL_COUNT } from '../../shared/constants.js';
import { emptyFacePixels, paintPolyline, rasterLine } from '../../shared/face-raster.js';

describe('face raster', () => {
  it('creates a fixed transparent 32×32 overlay', () => {
    const pixels = emptyFacePixels();
    expect(pixels).toHaveLength(FACE_PIXEL_COUNT);
    expect(new Set(pixels)).toEqual(new Set([EMPTY_FACE_PIXEL]));
  });

  it('uses endpoint-inclusive integer Bresenham lines in both directions', () => {
    expect(rasterLine({ x: 0, y: 0 }, { x: 4, y: 2 })).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 2 }, { x: 4, y: 2 },
    ]);
    expect(rasterLine({ x: 4, y: 2 }, { x: 0, y: 0 })).toEqual([
      { x: 4, y: 2 }, { x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 },
    ]);
  });

  it('paints every interpolated cell while preserving the immutable base layer', () => {
    const base = emptyFacePixels();
    const painted = paintPolyline(base, [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }], 5);
    expect(base.every((pixel) => pixel === EMPTY_FACE_PIXEL)).toBe(true);
    for (const [x, y] of [[1, 1], [2, 1], [3, 1], [4, 1], [4, 2], [4, 3]]) {
      expect(painted[y * 32 + x]).toBe(5);
    }
  });
});
