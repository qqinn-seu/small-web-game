import { getBoardGeometry, nearestBoardCell } from '../canvas/board-renderer.js';

export interface BoardInputOptions {
  canPlace: () => boolean;
  onPlaceIntent: (x: number, y: number) => void;
}

/**
 * Converts mouse, touch, and pen input into a server-bound move intent. It has
 * no board mutation path; actual pieces only appear after room state updates.
 */
export function bindBoardInput(canvas: HTMLCanvasElement, options: BoardInputOptions): () => void {
  const placeAtClientPoint = (clientX: number, clientY: number): boolean => {
    if (!options.canPlace()) return false;
    const rect = canvas.getBoundingClientRect();
    const geometry = getBoardGeometry(canvas.clientWidth, canvas.clientHeight);
    const cell = nearestBoardCell(
      geometry,
      clientX - rect.left - canvas.clientLeft,
      clientY - rect.top - canvas.clientTop,
    );
    if (!cell) return false;
    options.onPlaceIntent(cell.x, cell.y);
    return true;
  };

  const onPointerDown = (event: PointerEvent): void => {
    // Some mobile browsers expose a non-mouse button value for a synthetic
    // touch PointerEvent. Touch is still a primary placement gesture.
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    if (!placeAtClientPoint(event.clientX, event.clientY)) return;
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
  };

  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.changedTouches[0];
    if (!touch || !placeAtClientPoint(touch.clientX, touch.clientY)) return;
    // When Pointer Events are also emitted, placeAtClientPoint sees the
    // synchronous pending lock and becomes a no-op, so one tap is one intent.
    event.preventDefault();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  // Pointer Events are the primary implementation. This explicit fallback is
  // needed for older/mobile webviews and synthetic touch drivers that expose
  // TouchEvents but do not dispatch pointerdown to canvas.
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('touchstart', onTouchStart);
  };
}
