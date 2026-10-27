/**
 * PixelBuffer: a tiny "paint program" in memory. We draw every pixel of the town ourselves
 * (no image files), then copy the buffer into a <canvas> which PixiJS turns into a texture.
 *
 * Coordinates are in WORLD pixels: the buffer covers [ox, ox+w) x [oy, oy+h).
 * Anything drawn outside is silently clipped, which lets us paint big multi-tile objects
 * (trees, landmarks) chunk by chunk without seams.
 */
import { abgr, fromAbgr, mix, outlineOf, shade } from './palette';

export class PixelBuffer {
  readonly data: Uint32Array<ArrayBuffer>;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly ox = 0,
    readonly oy = 0,
  ) {
    this.data = new Uint32Array(w * h);
  }

  inside(x: number, y: number): boolean {
    const lx = x - this.ox;
    const ly = y - this.oy;
    return lx >= 0 && ly >= 0 && lx < this.w && ly < this.h;
  }

  /** Set one pixel to colour c (0xRRGGBB, fully opaque). */
  set(x: number, y: number, c: number): void {
    const lx = (x | 0) - this.ox;
    const ly = (y | 0) - this.oy;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return;
    this.data[ly * this.w + lx] = abgr(c);
  }

  /** Set one pixel with an alpha (0..255) -- stored as is (no blending). */
  setA(x: number, y: number, c: number, a: number): void {
    const lx = (x | 0) - this.ox;
    const ly = (y | 0) - this.oy;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return;
    this.data[ly * this.w + lx] = abgr(c, a);
  }

  /** Raw ABGR value, or 0 (transparent) outside. */
  raw(x: number, y: number): number {
    const lx = (x | 0) - this.ox;
    const ly = (y | 0) - this.oy;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return 0;
    return this.data[ly * this.w + lx];
  }

  /** Colour 0xRRGGBB at (x, y), or -1 if transparent / outside. */
  get(x: number, y: number): number {
    const v = this.raw(x, y);
    if (v >>> 24 === 0) return -1;
    return fromAbgr(v);
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(x | 0, this.ox);
    const y0 = Math.max(y | 0, this.oy);
    const x1 = Math.min((x | 0) + w, this.ox + this.w);
    const y1 = Math.min((y | 0) + h, this.oy + this.h);
    if (x1 <= x0 || y1 <= y0) return;
    const v = abgr(c);
    for (let yy = y0; yy < y1; yy++) {
      const row = (yy - this.oy) * this.w - this.ox;
      this.data.fill(v, row + x0, row + x1);
    }
  }

  hline(x: number, y: number, w: number, c: number): void {
    this.rect(x, y, w, 1, c);
  }

  vline(x: number, y: number, h: number, c: number): void {
    this.rect(x, y, 1, h, c);
  }

  /** Filled disc (pixel-art circle). */
  disc(cx: number, cy: number, r: number, c: number): void {
    const r2 = (r + 0.35) * (r + 0.35);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy <= r2) this.set(cx + dx, cy + dy, c);
      }
    }
  }

  /** Filled axis-aligned ellipse. */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: number): void {
    for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
      for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
        const v = (dx * dx) / ((rx + 0.4) * (rx + 0.4)) + (dy * dy) / ((ry + 0.4) * (ry + 0.4));
        if (v <= 1) this.set(cx + dx, cy + dy, c);
      }
    }
  }

  /** Darken what is already there (cast shadows). amount 0..1. */
  shadePx(x: number, y: number, amount: number): void {
    const c = this.get(x, y);
    if (c < 0) return;
    this.set(x, y, shade(c, amount));
  }

  shadeRect(x: number, y: number, w: number, h: number, amount: number): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.shadePx(xx, yy, amount);
  }

  shadeEllipse(cx: number, cy: number, rx: number, ry: number, amount: number): void {
    for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
      for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
        const v = (dx * dx) / ((rx + 0.4) * (rx + 0.4)) + (dy * dy) / ((ry + 0.4) * (ry + 0.4));
        if (v <= 1) this.shadePx(cx + dx, cy + dy, amount);
      }
    }
  }

  /** Blend colour c over the existing pixel with strength t (0..1). */
  tint(x: number, y: number, c: number, t: number): void {
    const old = this.get(x, y);
    if (old < 0) return;
    this.set(x, y, mix(old, c, t));
  }

  /** Simple 1px line (Bresenham). */
  line(x0: number, y0: number, x1: number, y1: number, c: number): void {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /**
   * Draw a little picture described by text rows. Each character is looked up in `colours`;
   * '.' and ' ' are transparent; unknown characters are skipped.
   */
  template(x: number, y: number, rows: string[], colours: Record<string, number>, flipX = false): void {
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      for (let i = 0; i < row.length; i++) {
        const ch = row[flipX ? row.length - 1 - i : i];
        if (ch === '.' || ch === ' ') continue;
        const c = colours[ch];
        if (c === undefined) continue;
        this.set(x + i, y + j, c);
      }
    }
  }

  /**
   * Add a 1px outline around every opaque shape: each transparent pixel touching an opaque one
   * becomes a dark tinted version of that neighbour (never pure black).
   */
  autoOutline(colourFn: (neighbour: number) => number = outlineOf): void {
    const { w, h, data } = this;
    const out = data.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (data[i] >>> 24 !== 0) continue;
        let n = 0;
        if (y + 1 < h && data[i + w] >>> 24) n = data[i + w];
        else if (y > 0 && data[i - w] >>> 24) n = data[i - w];
        else if (x > 0 && data[i - 1] >>> 24) n = data[i - 1];
        else if (x + 1 < w && data[i + 1] >>> 24) n = data[i + 1];
        if (n) out[i] = abgr(colourFn(fromAbgr(n)));
      }
    }
    data.set(out);
  }

  /** Copy into a fresh canvas element. */
  toCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.w;
    canvas.height = this.h;
    this.drawInto(canvas, 0, 0);
    return canvas;
  }

  /** Copy into an existing canvas at (dx, dy). */
  drawInto(canvas: HTMLCanvasElement, dx: number, dy: number): void {
    const ctx = canvas.getContext('2d')!;
    const img = new ImageData(new Uint8ClampedArray(this.data.buffer, this.data.byteOffset, this.w * this.h * 4), this.w, this.h);
    ctx.putImageData(img, dx, dy);
  }

  /** Copy another buffer into this one (opaque pixels only) at world position (x, y). */
  blit(src: PixelBuffer, x: number, y: number, flipX = false): void {
    for (let j = 0; j < src.h; j++) {
      for (let i = 0; i < src.w; i++) {
        const v = src.data[j * src.w + (flipX ? src.w - 1 - i : i)];
        if (v >>> 24 === 0) continue;
        const lx = x + i - this.ox;
        const ly = y + j - this.oy;
        if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) continue;
        this.data[ly * this.w + lx] = v;
      }
    }
  }
}
