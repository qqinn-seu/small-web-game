import {
  BRUSH_COLORS,
  EMPTY_FACE_PIXEL,
  FACE_GRID_SIZE,
} from '../../../shared/constants.js';
import { composeFacePixels, type FaceRenderState } from '../canvas/face-renderer.js';
import type { CharacterState } from './character-state.js';

const LOGICAL_WIDTH = 64;
const LOGICAL_HEIGHT = 104;
const HEAD_X = 16;
const HEAD_Y = 6;
const HEAD_SIZE = 32;
const BODY_Y = 34;

export interface CharacterRenderState extends FaceRenderState {
  state: CharacterState;
  frame: number;
  /** A-side looks right; B-side looks left when watching the central board. */
  boardDirection: -1 | 1;
  reducedMotion: boolean;
  showResultParticles: boolean;
}

function drawFallbackHead(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#f1c6a9';
  context.fillRect(HEAD_X, HEAD_Y, HEAD_SIZE, HEAD_SIZE);
}

function drawPixelRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  context.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

/**
 * Draws one composed character from the supplied transparent clothing sprite,
 * the existing face base, and the authoritative 32×32 face overlay. All three
 * layers share one transform, so head movement cannot clear or detach pixels.
 */
export class CharacterRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly bodyImage = new Image();
  private readonly faceImage = new Image();
  private readonly resizeObserver: ResizeObserver | null;
  private state: CharacterRenderState = {
    face: null,
    draft: null,
    localPreview: null,
    state: 'idle',
    frame: 0,
    boardDirection: 1,
    reducedMotion: false,
    showResultParticles: false,
  };
  private width = 1;
  private height = 1;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    bodyAsset: string,
  ) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持 Canvas 2D。');
    this.context = context;
    this.context.imageSmoothingEnabled = false;
    this.bodyImage.decoding = 'async';
    this.faceImage.decoding = 'async';
    this.bodyImage.addEventListener('load', () => this.draw());
    this.faceImage.addEventListener('load', () => this.draw());
    this.bodyImage.src = bodyAsset;
    this.faceImage.src = '/assets/face-base.png';
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(canvas);
    this.resize();
  }

  public setState(state: CharacterRenderState): void {
    this.state = state;
    this.draw();
  }

  public destroy(): void {
    this.resizeObserver?.disconnect();
    this.bodyImage.removeAttribute('src');
    this.faceImage.removeAttribute('src');
  }

  private resize(): void {
    this.width = Math.max(1, this.canvas.clientWidth);
    this.height = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(this.width * dpr);
    const pixelHeight = Math.round(this.height * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.context.imageSmoothingEnabled = false;
    this.draw();
  }

  private draw(): void {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = false;

    const scale = Math.min(this.width / LOGICAL_WIDTH, this.height / LOGICAL_HEIGHT);
    const offsetX = (this.width - LOGICAL_WIDTH * scale) / 2;
    const offsetY = (this.height - LOGICAL_HEIGHT * scale) / 2;
    const transform = this.motionTransform();

    ctx.save();
    ctx.translate(offsetX + LOGICAL_WIDTH * scale / 2 + transform.x * scale, offsetY + transform.y * scale);
    ctx.scale(scale, scale);
    ctx.translate(-LOGICAL_WIDTH / 2, 0);

    // The generated PNG is the complete clothing/limb layer. No hand-drawn
    // replacement sprite is used if it has not loaded yet; the existing head
    // remains visible while a network asset is pending.
    if (this.bodyImage.complete && this.bodyImage.naturalWidth > 0) {
      ctx.drawImage(this.bodyImage, 0, BODY_Y, 64, 64);
    }

    if (this.faceImage.complete && this.faceImage.naturalWidth > 0) {
      ctx.drawImage(this.faceImage, HEAD_X, HEAD_Y, HEAD_SIZE, HEAD_SIZE);
    } else {
      drawFallbackHead(ctx);
    }
    this.drawExpression(ctx);
    this.drawFaceOverlay(ctx);
    if (this.state.showResultParticles && !this.state.reducedMotion) this.drawParticles(ctx);
    ctx.restore();
  }

  private motionTransform(): { x: number; y: number } {
    if (this.state.reducedMotion) return { x: 0, y: 0 };
    const phase = this.state.frame;
    switch (this.state.state) {
      case 'idle':
        return { x: 0, y: Math.round(Math.sin(phase * 0.52) * 1) };
      case 'thinking':
        return { x: Math.round(Math.sin(phase * 0.4) * 1), y: 0 };
      case 'watching':
        return { x: this.state.boardDirection * 2, y: 0 };
      case 'cheering':
        return { x: 0, y: phase % 10 < 4 ? -4 : 0 };
      case 'defiant':
        return { x: phase % 6 < 3 ? -1 : 1, y: 0 };
      case 'being-drawn':
        return { x: phase % 8 < 4 ? -1 : 1, y: 0 };
      default:
        return { x: 0, y: 0 };
    }
  }

  /** Expressions are intentionally drawn before the public pixel overlay. */
  private drawExpression(ctx: CanvasRenderingContext2D): void {
    const state = this.state.state;
    if (this.faceImage.complete && this.faceImage.naturalWidth > 0) {
      // Reuse an unmarked forehead pixel from the supplied skin sprite to
      // replace its neutral features before drawing a new expression.
      // Saved doodles are drawn afterwards and are never erased here.
      ctx.drawImage(this.faceImage, 16, 4, 1, 1, HEAD_X + 3, HEAD_Y + 6, 29, 26);
    }
    const blink = !this.state.reducedMotion && state === 'idle' && this.state.frame > 0 && this.state.frame % 42 === 0;
    const gaze = state === 'watching' ? this.state.boardDirection * 2 : state === 'thinking' ? 1 : 0;
    ctx.fillStyle = '#4d3532';

    if (state === 'cheering') {
      drawPixelRect(ctx, HEAD_X + 9, HEAD_Y + 14, 5, 2);
      drawPixelRect(ctx, HEAD_X + 26, HEAD_Y + 14, 5, 2);
      drawPixelRect(ctx, HEAD_X + 15, HEAD_Y + 26, 10, 4);
      return;
    }
    if (state === 'defiant') {
      drawPixelRect(ctx, HEAD_X + 8, HEAD_Y + 11, 8, 2);
      drawPixelRect(ctx, HEAD_X + 25, HEAD_Y + 13, 8, 2);
      drawPixelRect(ctx, HEAD_X + 16, HEAD_Y + 28, 8, 2);
      return;
    }
    if (state === 'being-drawn') {
      drawPixelRect(ctx, HEAD_X + 10, HEAD_Y + 15, 4, 5);
      drawPixelRect(ctx, HEAD_X + 26, HEAD_Y + 15, 4, 5);
      drawPixelRect(ctx, HEAD_X + 17, HEAD_Y + 28, 6, 2);
      return;
    }

    const eyeHeight = blink ? 1 : 3;
    drawPixelRect(ctx, HEAD_X + 10 + gaze, HEAD_Y + 15, 4, eyeHeight);
    drawPixelRect(ctx, HEAD_X + 26 + gaze, HEAD_Y + 15, 4, eyeHeight);
    if (state === 'thinking') drawPixelRect(ctx, HEAD_X + 16, HEAD_Y + 28, 7, 1);
    else if (state === 'watching') drawPixelRect(ctx, HEAD_X + 15, HEAD_Y + 27, 9, 2);
    else drawPixelRect(ctx, HEAD_X + 16, HEAD_Y + 27, 8, 2);
  }

  private drawFaceOverlay(ctx: CanvasRenderingContext2D): void {
    const pixels = composeFacePixels(this.state);
    const cell = HEAD_SIZE / FACE_GRID_SIZE;
    for (let index = 0; index < pixels.length; index += 1) {
      const colorIndex = pixels[index]!;
      if (colorIndex === EMPTY_FACE_PIXEL || colorIndex < 0 || colorIndex >= BRUSH_COLORS.length) continue;
      ctx.fillStyle = BRUSH_COLORS[colorIndex]!;
      const x = index % FACE_GRID_SIZE;
      const y = Math.floor(index / FACE_GRID_SIZE);
      ctx.fillRect(HEAD_X + x * cell, HEAD_Y + y * cell, cell, cell);
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    const cycle = this.state.frame % 12;
    const color = this.state.state === 'cheering' ? '#f0bd47' : '#84bfa3';
    ctx.fillStyle = color;
    const points = [
      [8, 13 - cycle % 3], [51, 16 - (cycle + 1) % 3], [4, 34 - cycle % 2], [56, 38 - (cycle + 2) % 3],
    ] as const;
    for (const [x, y] of points) drawPixelRect(ctx, x, y, 3, 3);
  }
}
