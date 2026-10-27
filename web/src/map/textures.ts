/** Helpers to turn our painted canvases into crisp PixiJS textures. */
import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import type { PixelBuffer } from './pixels';

/**
 * Canvas -> Texture with NEAREST filtering (crisp pixels when zoomed in).
 * `mipmaps: true` additionally blends smoothly when zoomed far out, so the map does not shimmer.
 */
export function canvasTexture(canvas: HTMLCanvasElement, opts: { mipmaps?: boolean } = {}): Texture {
  const source = new CanvasSource({
    resource: canvas,
    scaleMode: 'nearest',
    ...(opts.mipmaps ? { autoGenerateMipmaps: true, minFilter: 'linear' as const, mipmapFilter: 'linear' as const, magFilter: 'nearest' as const } : {}),
  });
  return new Texture({ source });
}

export function bufferTexture(b: PixelBuffer, opts: { mipmaps?: boolean } = {}): Texture {
  return canvasTexture(b.toCanvas(), opts);
}

/** Pack several small buffers side by side into one texture and return one sub-texture per buffer. */
export function packTextures(buffers: PixelBuffer[], pad = 1): Texture[] {
  const width = buffers.reduce((s, b) => s + b.w + pad, pad);
  const height = buffers.reduce((m, b) => Math.max(m, b.h), 0) + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let x = pad;
  const rects: Rectangle[] = [];
  for (const b of buffers) {
    b.drawInto(canvas, x, pad);
    rects.push(new Rectangle(x, pad, b.w, b.h));
    x += b.w + pad;
  }
  const base = canvasTexture(canvas);
  return rects.map((frame) => new Texture({ source: base.source, frame }));
}
