/**
 * Villager sprites: 16x16 chibi characters built from a resident's Look (skin, hair, hair style,
 * shirt, pants, accessory). Every frame is drawn from small text templates, then a dark tinted
 * outline is added automatically.
 *
 * Frames per look (one atlas cell each):
 *   0-2 facing down (idle, step A, step B)   3-5 facing up   6-8 facing right (left = mirrored)
 *   9   ghost (pale, desaturated version of the idle frame, for "won't take part" residents)
 */
import { Rectangle, Texture } from 'pixi.js';
import type { Look } from '../types';
import { PixelBuffer } from './pixels';
import { HAIR, P, PANTS, SHIRT, SKIN, abgr, fromAbgr, light, luminance, mix, outlineOf, shade } from './palette';
import { canvasTexture } from './textures';

export const FRAMES_PER_LOOK = 10;
export const FRAME_GHOST = 9;
export const DIR_DOWN = 0;
export const DIR_UP = 1;
export const DIR_RIGHT = 2;
export const DIR_LEFT = 3;

// ---------- body templates (fills only; the outline is added automatically)
// s skin, S skin shadow, e eye, b blush, t shirt, T shirt shadow, p pants, P pants shadow, f shoes
const HEAD_FRONT = [
  '................',
  '................',
  '.....ssssss.....',
  '....ssssssss....',
  '....ssssssss....',
  '....ssssssss....',
  '....ssessess....',
  '....ssessess....',
  '....sbssssbs....',
  '.....SssssS.....',
];
const HEAD_BACK = [
  '................',
  '................',
  '.....ssssss.....',
  '....ssssssss....',
  '....ssssssss....',
  '....ssssssss....',
  '....ssssssss....',
  '....ssssssss....',
  '....ssssssss....',
  '.....SssssS.....',
];
const HEAD_SIDE = [
  '................',
  '................',
  '.....ssssss.....',
  '....ssssssss....',
  '....ssssssss....',
  '....ssssssss....',
  '....sssssses....',
  '....ssssssess...',
  '....Sssssssbs...',
  '.....Sssssss....',
];
const BODY_FRONT = ['....tttttttt....', '...tttttttttT...', '...sttttttTTs...'];
const BODY_BACK = ['....TttttttT....', '...TttttttttT...', '...sTttttttTs...'];
const BODY_SIDE = ['.....tttttT.....', '.....ttttTT.....', '.....ttsTTT.....'];
const LEGS = {
  frontIdle: ['.....ppppPP.....', '.....ff..ff.....'],
  frontA: ['.....pppPff.....', '.....ff.........'],
  frontB: ['.....ffpPPP.....', '.........ff.....'],
  sideIdle: ['.....pppPP......', '......ffff......'],
  sideA: ['....pppPPPP.....', '....ff....ff....'],
  sideB: ['.....pppPP......', '.....fffff......'],
};

// ---------- hair overlays per style and direction: h hair, H shadow, L highlight
type HairSet = { front: string[]; back: string[]; side: string[] };
const HAIRS: HairSet[] = [
  // 0 short
  {
    front: ['................', '.....hhhhhh.....', '....hLLhhhhh....', '....hhhhhhhh....', '....hHhhhhHh....', '....h......h....'],
    back: ['................', '.....hhhhhh.....', '....hLLhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....HhhhhhhH....'],
    side: ['................', '.....hhhhhh.....', '....hLLhhhhh....', '....hhhhhhhh....', '....hhhhhhhH....', '....hhhh........', '....hhh.........', '....hh..........', '....h...........'],
  },
  // 1 long
  {
    front: ['................', '.....hhhhhh.....', '....hLLhhhhh....', '...hhhhhhhhhh...', '...hhhhhhhhhh...', '...hh......hh...', '...h........h...', '...h........h...', '...h........h...', '...hH......Hh...', '...h........h...'],
    back: ['................', '.....hhhhhh.....', '....hLLhhhhh....', '...hhhhhhhhhh...', '...hhhhhhhhhh...', '...hhhhhhhhhh...', '...hhhhhhhhhh...', '...hhhhhhhhhh...', '...hhhhhhhhhh...', '...hhhhhhhhhh...', '...HhhhhhhhhH...'],
    side: ['................', '.....hhhhhh.....', '....hLLhhhhh....', '...hhhhhhhhh....', '...hhhhhhhhH....', '...hhhhh........', '...hhhh.........', '...hhhh.........', '...hhhh.........', '...hhhH.........', '...hhh..........'],
  },
  // 2 bun on top
  {
    front: ['......hhhh......', '.....hLhhhh.....', '....hLLhhhhh....', '....hhhhhhhh....', '....hHhhhhHh....', '....h......h....'],
    back: ['......hhhh......', '.....hLhhhh.....', '....hLLhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....HhhhhhhH....'],
    side: ['....hhh.........', '...hLhhhhhh.....', '....hLLhhhhh....', '....hhhhhhhh....', '....hhhhhhhH....', '....hhhh........', '....hhh.........', '....hh..........'],
  },
  // 3 curly / big volume
  {
    front: ['.....hhhhhh.....', '...hhhLLhhhhh...', '..hhLLhhhhhhhh..', '..hhhhhhhhhhhh..', '..hhhhhhhhhhhh..', '..hhH......Hhh..', '..hh........hh..', '...h........h...'],
    back: ['.....hhhhhh.....', '...hhhLLhhhhh...', '..hhLLhhhhhhhh..', '..hhhhhhhhhhhh..', '..hhhhhhhhhhhh..', '..hhhhhhhhhhhh..', '..hhhhhhhhhhhh..', '...hhhhhhhhhh...', '....HhhhhhhH....'],
    side: ['.....hhhhhh.....', '...hhhLLhhhhh...', '..hhLLhhhhhhh...', '..hhhhhhhhhhhh..', '..hhhhhhhhhhH...', '..hhhhhh........', '..hhhhh.........', '...hhh..........'],
  },
  // 4 side parting + ponytail
  {
    front: ['................', '.....hhhhhh.....', '....hhhhhhLh....', '....hhhhhhhh....', '....hhhhhH.h....', '....hhH....h....'],
    back: ['................', '.....hhhhhh.....', '....hhhhhhLh....', '....hhhhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....HhhhhhhH....', '.......hh.......', '.......hH.......', '.......H........'],
    side: ['................', '.....hhhhhh.....', '....hhhhhhLh....', '....hhhhhhhh....', '....hhhhhhhH....', '...hhhhh........', '..hhhhh.........', '..hhhh..........', '..hH............', '..H.............'],
  },
  // 5 buzz cut
  {
    front: ['................', '.....hhhhhh.....', '....hhhLhhhh....', '....HhhhhhhH....'],
    back: ['................', '.....hhhhhh.....', '....hhhLhhhh....', '....hhhhhhhh....', '....hhhhhhhh....', '....HhhhhhhH....'],
    side: ['................', '.....hhhhhh.....', '....hhhLhhhh....', '....hhhhhhH.....', '....hhh.........', '....hh..........'],
  },
];

// ---------- accessories: a accessory colour, A darker, g frame, L lens
type AccSet = { front: string[]; back: string[]; side: string[] } | null;
const ACCESSORIES: AccSet[] = [
  null,
  // 1 glasses
  {
    front: ['', '', '', '', '', '', '.....gLggLg.....'],
    back: [],
    side: ['', '', '', '', '', '', '........ggLg....'],
  },
  // 2 beret (very Parisian)
  {
    front: ['.......aA.......', '....aaaaaaaa....', '...aaaaaaaaaA...', '....AAAAAAAA....'],
    back: ['.......aA.......', '....aaaaaaaa....', '...aaaaaaaaaA...', '....AAAAAAAA....'],
    side: ['......aA........', '....aaaaaaaa....', '...aaaaaaaaaA...', '....AAAAAAAA....'],
  },
  // 3 cap
  {
    front: ['................', '.....aaaaaa.....', '....aaaaaaaa....', '....AAAAAAAA....'],
    back: ['................', '.....aaaaaa.....', '....aaaaaaaa....', '....aaaaaaaa....', '....AAAAAAAA....'],
    side: ['................', '.....aaaaaa.....', '....aaaaaaaa....', '....aaaaAAAAAA..'],
  },
  // 4 scarf
  {
    front: ['', '', '', '', '', '', '', '', '', '', '....aaaaaaaa....', '....aA..........', '....A...........'],
    back: ['', '', '', '', '', '', '', '', '', '', '....aaaaaaaa....', '.........aA.....'],
    side: ['', '', '', '', '', '', '', '', '', '', '.....aaaaaa.....', '....aA..........', '....A...........'],
  },
];

function lookColours(look: Look): Record<string, number> {
  const skin = SKIN[look.skin % SKIN.length];
  const hair = HAIR[look.hair % HAIR.length];
  const shirt = SHIRT[look.shirt % SHIRT.length];
  const pants = PANTS[look.pants % PANTS.length];
  const accPal = [P.red, P.navy, 0x3a3a48, P.leaf, P.yellow, P.purple];
  let acc = accPal[(look.shirt + look.hair) % accPal.length];
  if (acc === shirt) acc = accPal[(look.shirt + 1) % accPal.length];
  return {
    s: skin,
    S: shade(skin, 0.14),
    e: P.ink,
    b: mix(skin, 0xe8707a, 0.4),
    t: shirt,
    T: shade(shirt, 0.22),
    p: pants,
    P: shade(pants, 0.25),
    f: P.woodDark,
    h: hair,
    H: shade(hair, 0.25),
    L: light(hair, 0.3),
    a: acc,
    A: shade(acc, 0.28),
    g: P.ink,
  };
}

function drawRows(b: PixelBuffer, rows: string[], col: Record<string, number>, dy: number, flip = false): void {
  b.template(0, dy, rows, col, flip);
}

/** Draw one 16x16 frame. dir: 0 down, 1 up, 2 right. step: 0 idle, 1 step A, 2 step B. */
function drawFrame(look: Look, dir: number, step: number): PixelBuffer {
  const b = new PixelBuffer(16, 16);
  const col = lookColours(look);
  const bob = step === 0 ? 0 : 0; // walk frames keep the head steady; idle bob is done by moving the sprite
  const hair = HAIRS[look.hairStyle % HAIRS.length];
  const acc = ACCESSORIES[look.accessory % ACCESSORIES.length];
  if (dir === DIR_DOWN) {
    drawRows(b, HEAD_FRONT, col, bob);
    drawRows(b, BODY_FRONT, col, 10 + bob);
    drawRows(b, step === 0 ? LEGS.frontIdle : step === 1 ? LEGS.frontA : LEGS.frontB, col, 13);
    drawRows(b, hair.front, col, 0);
    if (acc) drawRows(b, acc.front, col, 0);
  } else if (dir === DIR_UP) {
    drawRows(b, HEAD_BACK, col, bob);
    drawRows(b, BODY_BACK, col, 10 + bob);
    drawRows(b, step === 0 ? LEGS.frontIdle : step === 1 ? LEGS.frontB : LEGS.frontA, col, 13);
    drawRows(b, hair.back, col, 0);
    if (acc && acc.back.length) drawRows(b, acc.back, col, 0);
  } else {
    drawRows(b, HEAD_SIDE, col, bob);
    drawRows(b, BODY_SIDE, col, 10 + bob);
    drawRows(b, step === 0 ? LEGS.sideIdle : step === 1 ? LEGS.sideA : LEGS.sideB, col, 13);
    drawRows(b, hair.side, col, 0);
    if (acc) drawRows(b, acc.side, col, 0);
  }
  b.autoOutline((c) => mix(outlineOf(c), P.ink, 0.35));
  return b;
}

/** Pale bluish "ghost" version of a frame (keeps the silhouette, drops the colours). */
function ghostify(src: PixelBuffer): PixelBuffer {
  const b = new PixelBuffer(src.w, src.h);
  for (let i = 0; i < src.data.length; i++) {
    const v = src.data[i];
    if (v >>> 24 === 0) continue;
    const l = luminance(fromAbgr(v));
    b.data[i] = abgr(mix(0x6b7a99, 0xeef3fb, Math.min(1, l * 1.25)));
  }
  return b;
}

/**
 * Atlas of villager frames. Looks are deduplicated; each look gets FRAMES_PER_LOOK cells.
 * Pages are 2048x2048 canvases (16384 cells each).
 */
export class VillagerAtlas {
  private pages: { canvas: HTMLCanvasElement; tex: Texture | null }[] = [];
  private keyToSlot = new Map<string, number>();
  private textures: Texture[][] = [];
  private nextSlot = 0;
  private readonly cellsPerRow = 128;
  private readonly cellsPerPage = 128 * 128;

  /** Register a look and return its slot (frames are painted immediately). */
  add(look: Look): number {
    const key = `${look.skin}.${look.hair}.${look.hairStyle}.${look.shirt}.${look.pants}.${look.accessory}`;
    const existing = this.keyToSlot.get(key);
    if (existing !== undefined) return existing;
    const slot = this.nextSlot++;
    this.keyToSlot.set(key, slot);
    const frames: PixelBuffer[] = [];
    for (let dir = 0; dir < 3; dir++) for (let step = 0; step < 3; step++) frames.push(drawFrame(look, dir, step));
    frames.push(ghostify(frames[0]));
    frames.forEach((f, i) => {
      const cell = slot * FRAMES_PER_LOOK + i;
      const page = Math.floor(cell / this.cellsPerPage);
      const local = cell % this.cellsPerPage;
      while (this.pages.length <= page) {
        const c = document.createElement('canvas');
        c.width = 2048;
        c.height = 2048;
        this.pages.push({ canvas: c, tex: null });
      }
      f.drawInto(this.pages[page].canvas, (local % this.cellsPerRow) * 16, Math.floor(local / this.cellsPerRow) * 16);
    });
    return slot;
  }

  /** Turn the canvases into GPU textures. Call once after all looks were added. */
  finalize(): void {
    for (const p of this.pages) if (!p.tex) p.tex = canvasTexture(p.canvas);
    this.textures = [];
    for (let slot = 0; slot < this.nextSlot; slot++) {
      const list: Texture[] = [];
      for (let i = 0; i < FRAMES_PER_LOOK; i++) {
        const cell = slot * FRAMES_PER_LOOK + i;
        const page = Math.floor(cell / this.cellsPerPage);
        const local = cell % this.cellsPerPage;
        list.push(
          new Texture({
            source: this.pages[page].tex!.source,
            frame: new Rectangle((local % this.cellsPerRow) * 16, Math.floor(local / this.cellsPerRow) * 16, 16, 16),
          }),
        );
      }
      this.textures.push(list);
    }
  }

  frame(slot: number, index: number): Texture {
    return this.textures[slot][index];
  }

  destroy(): void {
    for (const p of this.pages) p.tex?.destroy(true);
    this.pages = [];
    this.textures = [];
  }
}

/**
 * Portrait for the resident card: the villager facing the viewer, scaled up with crisp pixels,
 * on a soft round backdrop inside a little wooden frame.
 */
export function renderPortrait(look: Look, scale = 4): HTMLCanvasElement {
  const size = 22;
  const b = new PixelBuffer(size, size);
  const backdrops = [0xf6e7c8, 0xdcebd0, 0xd8e4f0, 0xf1d9d9, 0xe8dff2, 0xf4e3c0];
  const bg = backdrops[(look.shirt + look.skin) % backdrops.length];
  // wooden frame
  b.rect(0, 0, size, size, P.woodDark);
  b.rect(1, 1, size - 2, size - 2, P.wood);
  b.hline(1, 1, size - 2, P.woodLight);
  b.rect(2, 2, size - 4, size - 4, bg);
  b.ellipse(11, 13, 7, 6, light(bg, 0.4));
  // the character, shifted down so the head sits in the middle
  const f = drawFrame(look, DIR_DOWN, 0);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = f.data[y * 16 + x];
      if (v >>> 24 === 0) continue;
      const yy = y + 4;
      if (yy >= size - 2) continue;
      b.data[yy * size + x + 3] = v;
    }
  }
  const small = b.toCanvas();
  const out = document.createElement('canvas');
  out.width = size * scale;
  out.height = size * scale;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, size * scale, size * scale);
  return out;
}
