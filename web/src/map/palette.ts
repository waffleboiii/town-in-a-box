/**
 * The one colour palette for the whole town (cozy pixel-art style).
 *
 * About 40 hand-picked warm colours for the world, plus small palettes for villagers.
 * Rules we follow everywhere:
 *  - outlines are dark tinted plum/brown, never pure black;
 *  - shadows are a cool purple tint multiplied onto the colour below (see shade()).
 * Colours are plain 0xRRGGBB numbers.
 */

export const P = {
  // darks / outlines (never pure black)
  ink: 0x3a2a35,
  inkSoft: 0x5b4352,
  shadow: 0x6a5f8a,

  // greens
  grass: 0x8cc063,
  grassDark: 0x74a852,
  grassLight: 0xa9d279,
  grassDeep: 0x5c8c45,
  park: 0x80bd58,
  parkLight: 0x9cd06b,
  leaf: 0x4f8a3f,
  leafDark: 0x355f34,
  leafLight: 0x72aa4c,
  leafHi: 0x9ccb64,

  // earth, gravel, paving
  soil: 0x8b5e3c,
  gravel: 0xe3cf9f,
  gravelDark: 0xc8ae7c,
  paving: 0xdccdab,
  pavingDark: 0xc2b08e,
  road: 0x958b85,
  roadDark: 0x7e746f,
  asphalt: 0x5d5663,
  asphaltDark: 0x4a4450,
  dash: 0xf3e6bd,

  // stone, roofs, glass
  limestone: 0xf2e5c6,
  limestoneShade: 0xd8c59f,
  zinc: 0x8798ad,
  zincLight: 0xabbacb,
  zincDark: 0x66778f,
  glass: 0x4d6282,
  glassLight: 0x93b4d1,
  terracotta: 0xc8663f,
  terracottaLight: 0xe38d5d,
  terracottaDark: 0x93462f,
  wall: 0xf5ecd9,
  concrete: 0xbdb7ac,
  concreteDark: 0x938d86,
  steel: 0xc6cbd2,

  // water
  water: 0x4f97c3,
  waterDeep: 0x3f7dad,
  waterLight: 0x86c8e3,
  foam: 0xe2f4f1,
  sand: 0xe7d49d,

  // accents
  red: 0xd6534a,
  orange: 0xe9954f,
  yellow: 0xf2cb52,
  pink: 0xf0a4b8,
  purple: 0x8d6bb5,
  blue: 0x5b8fc7,
  navy: 0x3d5a8a,
  white: 0xfcf7eb,
  iron: 0x8c6449,
  ironDark: 0x5e4232,
  ironLight: 0xb48d68,
  wood: 0xa8744a,
  woodDark: 0x6e4630,
  woodLight: 0xd09a67,

  // faded farmland outside the study area
  wheat: 0xd9ca91,
  field: 0xb9a77c,
  meadow: 0xb0c088,
  rapeseed: 0xdcd172,

  // app background (shown around the map and blended into the edge vignette)
  bg: 0x2f3a3a,
} as const;

/** Villager palettes (indexes match the Look fields in types.ts). */
export const SKIN = [0xfbe1cd, 0xf1c8a6, 0xdea780, 0xc08559, 0x915f3f, 0x6b4431];
export const HAIR = [0x3a2c28, 0x5c3b29, 0x8b5b37, 0xb0532f, 0xe3c06b, 0xf2e8d0, 0xa9a7a4, 0xc9607f];
export const SHIRT = [
  0xd6534a, 0xe9954f, 0xf2cb52, 0x80b35b, 0x4f8a6f, 0x5b8fc7,
  0x3d5a8a, 0x8d6bb5, 0xe590a9, 0xf5ecd9, 0x938d86, 0xa8744a,
];
export const PANTS = [0x3f5f8a, 0x3c3949, 0xb49b6b, 0x6d4d37, 0x7c8089, 0x6b7445];

/** Stance colours: -2 .. +2 (index = stance + 2). Diverging: orange = oppose, cream = neutral, blue = support.
 *  Same colours as the UI legend (--oppose #c4562a / --support #2f6fa8 in styles/ui.css), and safe for
 *  the common kinds of colour blindness (unlike red/green). */
export const STANCE = [0xc4562a, 0xe89a62, 0xf3e7c6, 0x7fb0dc, 0x2f6fa8];
export const STANCE_NONE = 0xfbf3e2;

// ---------- colour helpers ----------

export function rgb(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

export function fromRgb(r: number, g: number, b: number): number {
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Linear mix between two colours, t = 0 -> a, t = 1 -> b. */
export function mix(a: number, b: number, t: number): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return fromRgb(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** Darker version with a cool purple shift (pixel-art style shadows, never grey-black). */
export function shade(c: number, amount: number): number {
  const [r, g, b] = rgb(c);
  const [sr, sg, sb] = rgb(P.shadow);
  const k = 1 - amount;
  return fromRgb(r * k + (r * sr) / 255 * amount * 0.6, g * k + (g * sg) / 255 * amount * 0.6, b * k + (b * sb) / 255 * amount * 0.75);
}

/** Lighter version with a warm cream shift. */
export function light(c: number, amount: number): number {
  return mix(c, 0xfff6dc, amount);
}

/** Outline colour derived from a fill: much darker and pulled toward the ink colour. */
export function outlineOf(c: number): number {
  return mix(shade(c, 0.55), P.ink, 0.55);
}

/** Convert 0xRRGGBB to the little-endian ABGR uint32 used by ImageData buffers. */
export function abgr(c: number, a = 255): number {
  return ((a << 24) | ((c & 255) << 16) | (c & 0xff00) | ((c >> 16) & 255)) >>> 0;
}

/** Back from ABGR uint32 to 0xRRGGBB. */
export function fromAbgr(v: number): number {
  return ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255);
}

export function luminance(c: number): number {
  const [r, g, b] = rgb(c);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function toCss(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}
