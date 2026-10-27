/**
 * Small UI-in-the-world art: emotes, exposure icons, map pins, dots, speech bubbles,
 * signposts and water shimmer frames. All drawn here in code.
 */
import { Texture } from 'pixi.js';
import { PixelBuffer } from './pixels';
import { P, light, mix, shade } from './palette';
import { canvasTexture, packTextures } from './textures';

// ------------------------------------------------------------------ 9x7 icon art

const IC: Record<string, number> = {
  k: P.ink,
  K: P.inkSoft,
  r: P.red,
  R: shade(P.red, 0.3),
  g: P.glassLight,
  w: P.white,
  W: 0xdcd6ca,
  y: P.yellow,
  Y: shade(P.yellow, 0.25),
  o: P.orange,
  O: shade(P.orange, 0.3),
  b: P.blue,
  B: P.navy,
  n: P.wood,
  N: P.woodDark,
  l: P.leaf,
  L: P.leafLight,
  p: P.purple,
};

const ICON_ROWS: Record<string, string[]> = {
  car: ['.........', '...rrrr..', '..rggrgr.', '.rrrrrrrr', 'rrRrrrRrr', '.kK...Kk.', '.........'],
  home: ['....r....', '...rrr...', '..rrrrr..', '.rrRrrRr.', '..wwwww..', '..wwNww..', '..wwNww..'],
  noise: ['...k...k.', '..kk.k..k', 'kkkk..k.k', 'kkkk..k.k', 'kkkk..k.k', '..kk.k..k', '...k...k.'],
  heat: ['y...y...y', '.y..y..y.', '...ooo...', 'yyoooooyy', '...ooo...', '.y..y..y.', 'y...y...y'],
  job: ['...NNN...', '...N.N...', '.nnnnnnn.', '.nnnynnn.', '.NNNNNNN.', '.nnnnnnn.', '.NNNNNNN.'],
  tax: ['.wwwwww..', '.wkkkkw..', '.wwwwwwW.', '.wkkwwwW.', '.wwwwrrr.', '.wkkwrwr.', '..WWWrrr.'],
  water: ['....b....', '...bb....', '...bbb...', '..bbbbb..', '..bwbbb..', '..bbbbb..', '...bbb...'],
  power: ['....yyy..', '...yyy...', '..yyyyy..', '....yy...', '...yy....', '..yy.....', '..y......'],
  scooter: ['.....kk..', '......k..', '......k..', '.......k.', '.kkkkkkk.', 'oo.....oo', 'oo.....oo'],
  walk: ['....k....', '...kkk...', '..k.k.k..', '....k....', '...k.k...', '..k...k..', '.kk...kk.'],
  park: ['...lll...', '..lLlll..', '.lLllllL.', '..lllll..', '...lll...', '....N....', '...NNN...'],
  money: ['..yyyyy..', '.yYYYYyy.', 'yYyyyyyy.', 'YYYYyyyy.', 'yYyyyyyy.', '.yYYYYyy.', '..yyyyy..'],
  construction: ['....o....', '...ooo...', '...www...', '..ooooo..', '..wwwww..', '.ooooooo.', 'kkkkkkkkk'],
  none: ['.........', '.........', '...kkk...', '...kkk...', '...kkk...', '.........', '.........'],
  metro: ['.BBBBBBB.', 'BwBBBBBwB', 'BwwBBBwwB', 'BwBwBwBwB', 'BwBBwBBwB', 'BwBBBBBwB', '.BBBBBBB.'],
  rer: ['..kkkkk..', '.kgggggk.', '.kgggggk.', '.kkkkkkk.', '.kykkkyk.', '.kkkkkkk.', '..k...k..'],
  bus: ['.ooooooo.', '.ogggggo.', '.ogggggo.', '.ooooooo.', '.oyoooyo.', '.ooooooo.', '..k...k..'],
  bike: ['......kk.', '.....k...', '..kkkkk..', '.k.k..kk.', 'k.k.kk.kk', 'k...kk..k', '.kk...kk.'],
  briefcase: ['...NNN...', '...N.N...', '.nnnnnnn.', '.nnnynnn.', '.NNNNNNN.', '.nnnnnnn.', '.NNNNNNN.'],
};

export type IconName = keyof typeof ICON_ROWS;

function iconBuffer(name: string): PixelBuffer {
  const b = new PixelBuffer(9, 7);
  b.template(0, 0, ICON_ROWS[name] ?? ICON_ROWS.none, IC);
  return b;
}

// ------------------------------------------------------------------ emotes

const EMOTE_W = 11;
const EMOTE_H = 12;

function bubbleShape(fill: number, outline: number, thought: boolean): PixelBuffer {
  const b = new PixelBuffer(EMOTE_W, EMOTE_H);
  // 11 columns wide: body rows 0-8, bottom outline row 9, tail rows 10-11
  const rows = [
    '..ooooooo..',
    '.owwwwwwwo.',
    'owwwwwwwwwo',
    'owwwwwwwwwo',
    'owwwwwwwwwo',
    'owwwwwwwwwo',
    'owwwwwwwwwo',
    'oswwwwwwwso',
    '.ossssssso.',
  ];
  const cols = { o: outline, w: fill, s: shade(fill, 0.12) };
  b.template(0, 0, rows, cols);
  if (thought) {
    b.template(0, 9, ['..ooooooo..', '...o.......', '..o........'], cols);
  } else {
    b.template(0, 9, ['..oowoooo..', '...owo.....', '....o......'], cols);
  }
  return b;
}

function face(b: PixelBuffer, fill: number, mood: 'smile' | 'frown'): void {
  b.ellipse(5, 4, 3, 3, fill);
  const dark = P.ink;
  b.set(4, 3, dark);
  b.set(6, 3, dark);
  if (mood === 'smile') {
    b.set(3, 5, dark);
    b.set(4, 6, dark);
    b.set(5, 6, dark);
    b.set(6, 6, dark);
    b.set(7, 5, dark);
    b.set(3, 4, mix(fill, P.red, 0.4));
    b.set(7, 4, mix(fill, P.red, 0.4));
  } else {
    b.set(3, 6, dark);
    b.set(4, 5, dark);
    b.set(5, 5, dark);
    b.set(6, 5, dark);
    b.set(7, 6, dark);
  }
}

/**
 * Emote textures. index: 0 '-2' anger puff, 1 '-1' frown, 2 '0' dots, 3 '+1' smile, 4 '+2' heart,
 * 5..7 thinking frames (1, 2, 3 dots), 8 '!' (opinion changed), 9 small chat dots (ambient talk).
 */
export function makeEmotes(): Texture[] {
  const list: PixelBuffer[] = [];
  // -2 anger: red puff with a white anger mark
  {
    const b = bubbleShape(0xe0584c, shade(0xe0584c, 0.55), false);
    const W = P.white;
    for (const [x, y, dx, dy] of [[3, 2, 1, 1], [7, 2, -1, 1], [3, 6, 1, -1], [7, 6, -1, -1]] as const) {
      b.set(x, y, W);
      b.set(x + dx, y, W);
      b.set(x, y + dy, W);
    }
    b.set(8, 0, light(0xe0584c, 0.3));
    list.push(b);
  }
  // -1 frown: pale blue face
  {
    const b = bubbleShape(P.white, P.ink, false);
    face(b, 0x9dbbe0, 'frown');
    list.push(b);
  }
  // 0: "..."
  {
    const b = bubbleShape(P.white, P.ink, false);
    for (const x of [3, 5, 7]) b.set(x, 4, P.inkSoft);
    list.push(b);
  }
  // +1 smile: yellow face
  {
    const b = bubbleShape(P.white, P.ink, false);
    face(b, P.yellow, 'smile');
    list.push(b);
  }
  // +2 heart
  {
    const b = bubbleShape(P.white, P.ink, false);
    b.template(2, 1, ['.rr.rr.', 'rwrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'], { r: P.red, w: light(P.red, 0.6) });
    list.push(b);
  }
  // thinking 1..3 dots (thought bubble)
  for (let n = 1; n <= 3; n++) {
    const b = bubbleShape(P.white, P.inkSoft, true);
    for (let i = 0; i < n; i++) b.set(3 + i * 2, 4, P.inkSoft);
    list.push(b);
  }
  // '!' changed their mind
  {
    const b = bubbleShape(P.yellow, shade(P.yellow, 0.6), false);
    b.vline(5, 2, 3, P.ink);
    b.set(5, 6, P.ink);
    list.push(b);
  }
  // ambient chat: tiny bubble with dots
  {
    const b = bubbleShape(P.white, P.inkSoft, false);
    b.set(4, 4, P.inkSoft);
    b.set(6, 4, P.inkSoft);
    list.push(b);
  }
  return packTextures(list);
}

// ------------------------------------------------------------------ badges, pins and dots

/** Round badge (13x13) with an icon, used for exposure markers. */
export function makeBadges(names: string[], ring: number): Record<string, Texture> {
  const bufs = names.map((n) => {
    const b = new PixelBuffer(13, 14);
    b.disc(6, 6, 6, P.ink);
    b.disc(6, 6, 5, ring);
    b.disc(6, 6, 4, P.white);
    b.hline(3, 12, 7, shade(P.ink, 0));
    b.blit(iconBuffer(n), 2, 3);
    return b;
  });
  const tex = packTextures(bufs);
  const out: Record<string, Texture> = {};
  names.forEach((n, i) => (out[n] = tex[i]));
  return out;
}

/** Map pin (15x19) with an icon inside. */
export function makePin(icon: string, ring: number): Texture {
  const b = new PixelBuffer(15, 20);
  b.disc(7, 7, 7, P.ink);
  for (let y = 12; y < 19; y++) {
    const half = Math.max(0, Math.round((19 - y) * 0.55));
    b.hline(7 - half, y, half * 2 + 1, P.ink);
  }
  b.disc(7, 7, 6, ring);
  for (let y = 12; y < 18; y++) {
    const half = Math.max(0, Math.round((18 - y) * 0.5) - 1);
    if (half >= 0) b.hline(7 - half, y, half * 2 + 1, ring);
  }
  b.disc(7, 7, 5, P.white);
  b.set(4, 3, light(ring, 0.6));
  b.blit(iconBuffer(icon), 3, 4);
  return packTextures([b])[0];
}

/** Dot used for residents when zoomed out (white, tinted by stance). variant 1 = highlighted ring. */
export function makeDots(): Texture[] {
  const a = new PixelBuffer(7, 7);
  a.disc(3, 3, 3, mix(P.ink, P.white, 0.15));
  a.disc(3, 3, 2, P.white);
  a.set(2, 2, P.white);
  const b = new PixelBuffer(11, 11);
  b.disc(5, 5, 5, P.white);
  b.disc(5, 5, 4, P.ink);
  b.disc(5, 5, 3, P.white);
  const c = new PixelBuffer(5, 5);
  c.disc(2, 2, 2, P.white);
  return packTextures([a, b, c]);
}

/** Soft selection ellipse under a resident's feet. */
export function makeSelectRing(): Texture {
  const b = new PixelBuffer(16, 7);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = (x + 0.5 - 8) / 7.6;
      const dy = (y + 0.5 - 3.5) / 3.4;
      const v = dx * dx + dy * dy;
      if (v <= 1 && v > 0.5) b.set(x, y, P.white);
    }
  }
  return packTextures([b])[0];
}

// ------------------------------------------------------------------ speech bubble + signposts (9-slice)

/** 12x12 bubble body for a NineSliceSprite (borders 4px) + a 7x5 tail. */
export function makeBubbleParts(): { body: Texture; tail: Texture; tag: Texture } {
  const o = P.ink;
  const w = 0xfffaf0;
  const s = 0xeee3cf;
  const body = new PixelBuffer(12, 12);
  body.template(0, 0, [
    '..oooooooo..',
    '.owwwwwwwwo.',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'osswwwwwwsso',
    '.osssssssso.',
    '..oooooooo..',
  ], { o, w, s });
  const tail = new PixelBuffer(7, 5);
  tail.template(0, 0, ['osssso.', '.owwo..', '.owo...', '.oo....', '.o.....'], { o, w, s });
  const tag = new PixelBuffer(12, 12);
  tag.template(0, 0, [
    '.oooooooooo.',
    'oyyyyyyyyyyo',
    'oywwwwwwwwyo',
    'oywwwwwwwwyo',
    'oywwwwwwwwyo',
    'oywwwwwwwwyo',
    'oywwwwwwwwyo',
    'oywwwwwwwwyo',
    'oywwwwwwwwyo',
    'oyyyyyyyyyyo',
    'oSSSSSSSSSSo',
    '.oooooooooo.',
  ], { o, w, y: 0xf3e6c4, S: shade(0xf3e6c4, 0.2) });
  const [b, t, g] = packTextures([body, tail, tag]);
  return { body: b, tail: t, tag: g };
}

/** Wooden signpost plank (suburbs) and blue enamel plaque (Paris arrondissements), both 12x10 for 9-slice. */
export function makeSigns(): { plank: Texture; plaque: Texture; post: Texture } {
  const plank = new PixelBuffer(12, 10);
  plank.template(0, 0, [
    '.oooooooooo.',
    'oLLLLLLLLLLo',
    'onwwwwwwwwno',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'owwwwwwwwwwo',
    'onwwwwwwwwno',
    'oSSSSSSSSSSo',
    '.oooooooooo.',
  ], { o: mix(P.woodDark, P.ink, 0.5), L: P.woodLight, w: P.wood, n: P.woodLight, S: P.woodDark });
  const plaque = new PixelBuffer(12, 10);
  plaque.template(0, 0, [
    '.gggggggggg.',
    'gwwwwwwwwwwg',
    'gwbbbbbbbbwg',
    'gwbbbbbbbbwg',
    'gwbbbbbbbbwg',
    'gwbbbbbbbbwg',
    'gwbbbbbbbbwg',
    'gwbbbbbbbbwg',
    'gwwwwwwwwwwg',
    '.gggggggggg.',
  ], { g: 0x2f5a44, w: P.white, b: 0x2c4d8f });
  const post = new PixelBuffer(4, 8);
  post.template(0, 0, ['oLwo', 'oLwo', 'oLwo', 'oLwo', 'oLwo', 'oLwo', 'oLwo', 'oooo'], { o: mix(P.woodDark, P.ink, 0.5), L: P.woodLight, w: P.wood });
  const [a, b, c] = packTextures([plank, plaque, post]);
  return { plank: a, plaque: b, post: c };
}

// ------------------------------------------------------------------ water shimmer (animated highlights)

/** 4 variants x 3 frames of transparent 16x16 highlight overlays for water tiles. Returned as [variant][frame]. */
export function makeShimmer(): Texture[][] {
  const lite = P.waterLight;
  const foam = P.foam;
  const bufs: PixelBuffer[] = [];
  const spots: [number, number][][] = [
    [[3, 5], [10, 11]],
    [[8, 4], [4, 12]],
    [[11, 7], [5, 9]],
    [[6, 6], [12, 12]],
  ];
  for (const sp of spots) {
    for (let f = 0; f < 3; f++) {
      const b = new PixelBuffer(16, 16);
      sp.forEach(([x, y], i) => {
        const phase = (f + i) % 3;
        if (phase === 0) {
          b.set(x, y, lite);
          b.set(x + 1, y, foam);
          b.set(x + 2, y, lite);
        } else if (phase === 1) {
          b.set(x + 1, y, lite);
          b.set(x + 2, y, lite);
          b.set(x + 3, y, mix(lite, P.water, 0.4));
        } else {
          b.set(x + 2, y + 1, mix(lite, P.water, 0.5));
        }
      });
      bufs.push(b);
    }
  }
  const tex = packTextures(bufs);
  return [0, 1, 2, 3].map((v) => [tex[v * 3], tex[v * 3 + 1], tex[v * 3 + 2]]);
}

export function makeIconTexture(name: string, scale = 1): Texture {
  const b = iconBuffer(name);
  if (scale === 1) return packTextures([b])[0];
  const c = b.toCanvas();
  const out = document.createElement('canvas');
  out.width = b.w * scale;
  out.height = b.h * scale;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, 0, 0, out.width, out.height);
  return canvasTexture(out);
}
