import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterRenderer } from '../../client/src/presentation/character-renderer.js';
import type { CharacterState } from '../../client/src/presentation/character-state.js';
import type { FaceCanvas } from '../../shared/models.js';

class FakeImage {
  public src = '';
  public complete = true;
  public decoding = '';
  public get naturalWidth() { return this.src.includes('face-base') ? 32 : 64; }
  public addEventListener() {}
  public removeAttribute() { this.src = ''; }
}
function setup() {
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const context = {
    imageSmoothingEnabled: false, fillStyle: '',
    clearRect: vi.fn(), setTransform: vi.fn(), drawImage: vi.fn((..._args: unknown[]) => {}),
    fillRect: vi.fn((..._args: number[]) => {}), save: vi.fn(), restore: vi.fn(),
    translate: vi.fn((..._args: number[]) => {}), scale: vi.fn((..._args: number[]) => {}),
  };
  const canvas = { clientWidth: 192, clientHeight: 312, width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { context, canvas, renderer: new CharacterRenderer(canvas, '/assets/sprites/body-a.png') };
}
function face(): FaceCanvas {
  const pixels = Array.from({ length: 1024 }, () => -1);
  pixels[0] = 0; pixels[1023] = 1;
  return { ownerPlayerId: 'a', revision: 1, pixels, strokes: [] };
}
afterEach(() => vi.unstubAllGlobals());

describe('character compositing safety', () => {
  it('keeps the complete head and feet inside the canvas for every animated pose', () => {
    const { renderer, context, canvas } = setup();
    const states: CharacterState[] = ['idle', 'thinking', 'watching', 'cheering', 'defiant', 'being-drawn'];
    for (const state of states) {
      for (let frame = 0; frame < 12; frame++) {
        context.drawImage.mockClear(); context.translate.mockClear(); context.scale.mockClear();
        renderer.setState({ state, frame, boardDirection: 1, reducedMotion: false, showResultParticles: false, face: face() });
        const head = context.drawImage.mock.calls.find((call) => call.length === 5 && (call[0] as FakeImage).src.includes('face-base'))!;
        const body = context.drawImage.mock.calls.find((call) => call.length === 5 && (call[0] as FakeImage).src.includes('body-a'))!;
        const translateY = context.translate.mock.calls[0][1];
        const scale = context.scale.mock.calls[0][1];
        expect(translateY + Number(head[2]) * scale).toBeGreaterThanOrEqual(0);
        expect(translateY + (Number(body[2]) + Number(body[4])) * scale).toBeLessThanOrEqual(canvas.clientHeight);
      }
    }
    renderer.destroy();
  });

  it('replaces neutral features before expression rendering and paints saved pixels last without mutation', () => {
    const { renderer, context } = setup(); const saved = face(); const pixels = [...saved.pixels];
    context.drawImage.mockClear(); context.fillRect.mockClear();
    renderer.setState({ state: 'defiant', frame: 3, boardDirection: -1, reducedMotion: false, showResultParticles: false, face: saved });
    expect(context.drawImage.mock.calls.some((call) => call.length === 9 && call[3] === 1 && call[4] === 1)).toBe(true);
    expect(context.fillRect.mock.calls.slice(-2)).toEqual([[16, 6, 1, 1], [47, 37, 1, 1]]);
    expect(saved.pixels).toEqual(pixels);
    renderer.destroy();
  });
});
