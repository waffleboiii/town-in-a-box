/**
 * Landmark sprites, painted pixel by pixel in code (original art, no image files).
 *
 * Each landmark has:
 *  - a footprint in tiles (no ordinary buildings are drawn there),
 *  - a ground type painted under it (plaza / park),
 *  - a sprite (PixelBuffer) with an anchor point that sits on the bottom-centre of the footprint,
 *  - optional flat ground decoration and a soft cast shadow.
 * The data centre and the construction crane are NOT baked into the map: they are dynamic
 * sprites used for scenario sites (see makeDataCentreFrames / makeCrane).
 */
import { PixelBuffer } from './pixels';
import { P, mix, shade, light } from './palette';
import { rand2 } from './util';
import { TT } from './terrainTypes';

export interface LandmarkDef {
  kind: string;
  /** Footprint in tiles (centred on the landmark tile). */
  fw: number;
  fh: number;
  ground: number;
  sprite: PixelBuffer;
  /** Pixel inside the sprite that sits on the footprint's bottom-centre. */
  ax: number;
  ay: number;
  decorate?: (b: PixelBuffer, cx: number, by: number) => void;
  shadow?: (b: PixelBuffer, cx: number, by: number) => void;
}

// ---------------------------------------------------------------- iron lattice tower

function ironTower(): PixelBuffer {
  const W = 48;
  const H = 104;
  const b = new PixelBuffer(W, H);
  const axis = W / 2;
  const base = H - 2;
  const halfWidth = (r: number): number => {
    if (r < 26) return 20 - 9.5 * Math.pow(r / 26, 0.9);
    if (r < 30) return 14;
    if (r < 56) return 10.2 - 5.6 * Math.pow((r - 30) / 26, 0.8);
    if (r < 59) return 6.6;
    if (r < 89) return 4.0 - 2.3 * ((r - 59) / 30);
    if (r < 94) return 2.6;
    return 0.6;
  };
  for (let r = 0; r < 101; r++) {
    const y = base - r;
    const w = halfWidth(r);
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - axis;
      const ax = Math.abs(dx);
      if (ax > w) continue;
      // the big arch between the four legs
      if (r < 21) {
        const a = 13.6 * Math.sqrt(Math.max(0, 1 - (r / 21) * (r / 21)));
        if (ax < a) continue;
      }
      // small opening just above the first platform
      if (r >= 31 && r < 45 && ax < 3.3 - (r - 31) * 0.2) continue;
      let c: number = P.iron;
      const ix = Math.floor(dx + 64);
      if ((ix + r) % 4 === 0 || (ix - r + 512) % 4 === 0) c = P.ironDark; // lattice crosses
      if (dx < -w + 1.6) c = P.ironLight; // lit edge (light comes from the top-left)
      else if (dx > w - 1.6) c = shade(P.iron, 0.32);
      if (r >= 26 && r < 30) {
        // first platform: railing + warm restaurant windows
        c = r === 29 ? P.ironLight : r === 26 ? P.ironDark : ix % 3 === 0 ? P.yellow : P.iron;
      }
      if (r >= 56 && r < 59) c = r === 58 ? P.ironLight : ix % 2 === 0 ? P.ironDark : P.iron;
      if (r >= 89 && r < 94) c = r === 93 ? P.ironLight : ix % 2 === 0 ? P.yellow : P.ironDark;
      if (r < 2 && ax > 13.6) c = r === 0 ? P.limestoneShade : P.limestone; // stone piers at the feet
      b.set(x, y, c);
    }
  }
  b.set(axis - 1, base - 101, P.red); // tiny beacon on the antenna
  b.autoOutline();
  return b;
}

// ---------------------------------------------------------------- gothic cathedral

function cathedral(): PixelBuffer {
  const W = 66;
  const H = 58;
  const b = new PixelBuffer(W, H);
  const stone = 0xdccfb1;
  const stoneL = 0xede3ca;
  const stoneS = 0xb7a889;
  const lead = 0x737c90;
  const leadL = 0x9ea6b7;
  const glassC = 0x4a4870;
  const base = H - 2;

  // nave roof (lead), behind everything
  for (let y = 25; y <= 33; y++) {
    const inset = y === 25 ? 1 : 0;
    b.rect(18 + inset, y, 40 - inset * 2, 1, y === 25 ? leadL : y % 2 ? lead : shade(lead, 0.1));
  }
  // nave wall
  b.rect(18, 34, 40, base - 34 + 1, stone);
  b.hline(18, 34, 40, stoneS);
  for (let x = 20; x < 56; x += 6) {
    // tall pointed stained-glass windows
    b.rect(x, 39, 2, 7, glassC);
    b.set(x, 38, glassC);
    b.set(x + (x % 12 === 2 ? 0 : 1), 41, x % 12 === 2 ? P.red : P.blue);
    // flying buttress: a pier in front + a diagonal arch
    b.rect(x + 3, 44, 2, base - 44 + 1, stoneS);
    b.set(x + 3, 43, stone);
    b.line(x + 1, 36, x + 4, 43, stoneS);
  }
  // apse (rounded east end)
  b.ellipse(59, 44, 5, 10, stone);
  b.rect(54, 44, 6, base - 44 + 1, stone);
  for (let y = 36; y <= base; y++) b.set(63, y, stoneS);
  // transept with the south rose window and a gable
  b.rect(34, 26, 11, base - 26 + 1, stone);
  for (let k = 0; k < 6; k++) b.hline(34 + k, 25 - k, 11 - k * 2, k === 5 ? stoneL : stone);
  b.vline(44, 26, base - 26, stoneS);
  b.disc(39, 33, 3.6, glassC);
  const rose = [P.red, P.blue, P.yellow, P.purple];
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    b.set(Math.round(39 + Math.cos(ang) * 2.4), Math.round(33 + Math.sin(ang) * 2.4), rose[a % 4]);
  }
  b.set(39, 33, P.yellow);
  b.rect(37, 45, 5, base - 45 + 1, glassC); // portal
  b.hline(37, 44, 5, stoneS);
  // the slender spire above the crossing
  for (let y = 2; y < 26; y++) {
    const w = y < 12 ? 1 : y < 20 ? 2 : 3;
    b.rect(39 - Math.floor(w / 2), y, w, 1, y % 3 === 0 ? leadL : lead);
  }
  b.set(39, 1, P.yellow);
  // west front: twin square towers
  b.rect(2, 22, 17, base - 22 + 1, stone);
  b.rect(2, 9, 7, 14, stone);
  b.rect(12, 9, 7, 14, stone);
  for (let x = 2; x < 19; x++) {
    if (x === 9 || x === 10 || x === 11) continue;
    b.set(x, 8, x % 2 ? stoneL : stone); // crenellations
    b.set(x, 9, stoneL);
  }
  for (const tx of [4, 6, 14, 16]) b.rect(tx, 12, 1, 8, glassC); // belfry openings
  for (let x = 3; x < 18; x += 2) b.set(x, 25, stoneS); // gallery of small columns
  b.hline(2, 26, 17, stoneS);
  b.disc(10, 32, 3.1, glassC); // west rose
  b.set(10, 32, P.red);
  b.set(9, 31, P.blue);
  b.set(11, 33, P.yellow);
  for (const px of [3, 8, 14]) {
    // three portals with pointed arches
    b.rect(px, 45, 3, base - 45 + 1, glassC);
    b.set(px + 1, 44, glassC);
  }
  // light from the left, shade on the right of each block
  for (let y = 9; y <= base; y++) {
    b.tint(2, y, stoneL, 0.8);
    b.tint(18, y, stoneS, 0.8);
  }
  b.autoOutline();
  return b;
}

// ---------------------------------------------------------------- triumphal arch

function triumphalArch(): PixelBuffer {
  const W = 36;
  const H = 34;
  const b = new PixelBuffer(W, H);
  const stone = 0xeadcbc;
  const stoneL = 0xf6eedb;
  const stoneS = 0xcbb994;
  const base = H - 2;
  b.rect(2, 4, 32, base - 4 + 1, stone);
  // attic + cornice
  b.hline(2, 4, 32, stoneL);
  b.hline(2, 8, 32, stoneS);
  for (let x = 3; x < 33; x += 2) b.set(x, 6, stoneS); // frieze
  b.hline(1, 9, 34, stoneL);
  b.hline(1, 10, 34, stoneS);
  // the great arch
  const cx = 17.5;
  for (let y = 13; y <= base; y++) {
    for (let x = 11; x < 25; x++) {
      const dx = x + 0.5 - cx;
      const top = 18;
      if (y < top && dx * dx + (y - top) * (y - top) > 5.6 * 5.6) continue;
      if (Math.abs(dx) > 5.6) continue;
      b.set(x, y, y < 20 ? 0x5a4c61 : 0x4a3e52);
    }
  }
  // relief panels on the pillars
  for (const px of [4, 26]) {
    b.rect(px, 17, 6, 8, stoneS);
    b.set(px + 2, 19, stoneL);
    b.set(px + 3, 20, stoneL);
    b.set(px + 2, 21, stoneL);
    b.set(px + 4, 22, stoneL);
  }
  // shading
  for (let y = 4; y <= base; y++) {
    b.set(2, y, stoneL);
    b.set(33, y, stoneS);
  }
  b.hline(2, base, 32, stoneS);
  // a little tricolour flag inside the arch
  b.set(17, 21, P.navy);
  b.set(18, 21, P.white);
  b.set(19, 21, P.red);
  b.set(17, 22, P.navy);
  b.set(18, 22, P.white);
  b.set(19, 22, P.red);
  b.vline(16, 20, 6, P.inkSoft);
  b.autoOutline();
  return b;
}

// ---------------------------------------------------------------- white-domed basilica on a hill

function basilica(): PixelBuffer {
  const W = 58;
  const H = 62;
  const b = new PixelBuffer(W, H);
  const white = 0xf8f4ea;
  const whiteS = 0xdcd5c6;
  const whiteD = 0xc4bba9;
  const base = 42;
  // the hill (park lawn) with stairs
  b.ellipse(29, 50, 28, 10, P.park);
  for (let y = 41; y < 61; y++) {
    for (let x = 0; x < W; x++) {
      if (b.get(x, y) < 0) continue;
      const v = rand2(x, y, 909);
      if (v < 0.12) b.set(x, y, P.grassDark);
      else if (v > 0.95) b.set(x, y, P.parkLight);
    }
  }
  for (let y = 43; y < 61; y++) {
    const half = 3 + Math.floor((y - 43) / 4);
    b.hline(29 - half, y, half * 2, y % 2 ? P.limestone : P.limestoneShade);
  }
  for (const tx of [10, 47]) {
    // trees on the slopes
    b.disc(tx, 48, 4, P.leaf);
    b.disc(tx - 1, 47, 2, P.leafLight);
  }
  // main body
  b.rect(13, 27, 32, base - 27 + 1, white);
  b.hline(13, 27, 32, whiteS);
  // portico with three arches
  b.rect(19, 33, 20, base - 33 + 1, whiteS);
  for (const ax of [21, 28, 35]) {
    b.rect(ax, 36, 3, base - 36 + 1, 0x6c6478);
    b.set(ax + 1, 35, 0x6c6478);
  }
  b.hline(18, 32, 22, white);
  // drum + great dome
  b.rect(21, 20, 16, 8, white);
  for (let x = 22; x < 36; x += 3) b.rect(x, 22, 1, 4, 0x8c8496);
  b.ellipse(29, 16, 8, 9, white);
  for (let y = 7; y < 26; y++) {
    for (let x = 20; x < 39; x++) {
      if (b.get(x, y) !== white) continue;
      const dx = x - 29;
      const dy = y - 16;
      if (dx + dy * 0.4 > 4) b.set(x, y, whiteS);
      if (dx > 6) b.set(x, y, whiteD);
      if (dx < -4 && dy < 0) b.set(x, y, 0xffffff);
    }
  }
  // lantern on top
  b.rect(27, 3, 4, 5, white);
  b.rect(28, 1, 2, 2, whiteS);
  b.set(28, 0, P.yellow);
  b.set(30, 5, whiteD);
  // side domes
  for (const dx of [16, 42]) {
    b.ellipse(dx, 24, 4, 4, white);
    b.rect(dx - 1, 19, 2, 2, whiteS);
    b.set(dx + 2, 25, whiteS);
    b.set(dx + 3, 24, whiteD);
  }
  // campanile (bell tower) on the right
  b.rect(46, 13, 6, base - 13 + 1, white);
  b.ellipse(49, 12, 3, 3, white);
  b.rect(47, 16, 1, 6, 0x8c8496);
  b.rect(50, 16, 1, 6, 0x8c8496);
  for (let y = 13; y <= base; y++) b.set(51, y, whiteS);
  for (let y = 27; y <= base; y++) b.set(44, y, whiteS);
  b.autoOutline((c) => mix(shade(c, 0.5), P.ink, 0.5));
  return b;
}

// ---------------------------------------------------------------- stadium

function stadium(): PixelBuffer {
  const W = 84;
  const H = 62;
  const b = new PixelBuffer(W, H);
  const cx = 42;
  const cy = 28;
  const wallH = 6;
  // front wall (visible face below the ellipse)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / 40;
      const dy0 = (y + 0.5 - cy) / 24;
      const dyW = (y + 0.5 - cy - wallH) / 24;
      const inTop = dx * dx + dy0 * dy0 <= 1;
      const inWall = dx * dx + dyW * dyW <= 1 && y > cy;
      if (!inTop && inWall) b.set(x, y, x % 4 === 0 ? 0x9aa0a8 : y % 3 === 0 ? 0xb9bec5 : 0xc8ccd2);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / 40;
      const dy = (y + 0.5 - cy) / 24;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      let c: number;
      if (d > 0.62) {
        // floating roof ring
        c = 0xe8eaec;
        if (dy < -0.2 && d > 0.9) c = 0xffffff;
        if (dy > 0.3) c = 0xd3d7dc;
        if (Math.floor((Math.atan2(dy, dx) + 4) * 12) % 3 === 0) c = shade(c, 0.06);
      } else if (d > 0.4) {
        // stands: blue seats with a few colourful fans
        const v = rand2(x, y, 515);
        c = v < 0.1 ? P.red : v < 0.16 ? P.white : v < 0.22 ? P.yellow : y % 2 ? 0x4f6fa8 : 0x5d7db6;
        if (d < 0.43) c = 0x3f557f;
      } else {
        // pitch with mowing stripes
        c = Math.floor(x / 3) % 2 ? 0x6fb64f : 0x5ea845;
      }
      b.set(x, y, c);
    }
  }
  // pitch lines
  const pw = 18;
  const ph = 8;
  for (let x = cx - pw; x <= cx + pw; x++) {
    b.set(x, cy - ph, P.white);
    b.set(x, cy + ph, P.white);
  }
  for (let y = cy - ph; y <= cy + ph; y++) {
    b.set(cx - pw, y, P.white);
    b.set(cx + pw, y, P.white);
    b.set(cx, y, P.white);
  }
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    b.set(Math.round(cx + Math.cos(ang) * 3.5), Math.round(cy + Math.sin(ang) * 3), P.white);
  }
  b.autoOutline();
  return b;
}

// ---------------------------------------------------------------- business district glass towers

function glassTowers(): PixelBuffer {
  const W = 80;
  const H = 96;
  const b = new PixelBuffer(W, H);
  const base = H - 2;
  // the big hollow cube arch on the left (top face + front face)
  const ax = 2;
  const aw = 22;
  const ah = 24;
  const top = base - ah;
  for (let k = 0; k < 5; k++) b.hline(ax + 5 - k, top - 5 + k, aw, k === 0 ? 0xffffff : 0xf0f0ec);
  b.rect(ax, top, aw, ah + 1, 0xf3f3ef);
  b.rect(ax + 5, top + 5, aw - 10, ah - 4, 0x5b6f86);
  b.rect(ax + 5, top + 5, aw - 10, 2, 0x485a70);
  for (let y = top; y <= base; y++) b.set(ax + aw - 1, y, 0xcfd2d4);
  // towers: x, width, height, glass colour
  const towers: [number, number, number, number][] = [
    [26, 11, 84, 0x5f93b5],
    [39, 9, 66, 0x6fa7b8],
    [49, 12, 76, 0x4c7398],
    [63, 10, 56, 0x7bb4c9],
    [33, 9, 44, 0x8bbfd1],
  ];
  for (const [x, w, h, glass] of towers) {
    const y0 = base - h;
    b.rect(x, y0, w, h + 1, glass);
    for (let y = y0; y <= base; y++) {
      for (let xx = x; xx < x + w; xx++) {
        const lx = xx - x;
        let c = glass;
        if (lx % 3 === 0) c = light(glass, 0.18); // mullions
        if ((y - y0) % 4 === 3) c = shade(glass, 0.12); // floors
        if (lx === 0) c = light(glass, 0.35);
        if (lx === w - 1) c = shade(glass, 0.3);
        // sky reflection streak
        const s = lx + (y - y0) * 0.5;
        if (s > w * 0.3 + 6 && s < w * 0.3 + 8) c = light(c, 0.45);
        b.set(xx, y, c);
      }
    }
    b.hline(x, y0, w, light(glass, 0.55));
    b.hline(x, y0 + 1, w, light(glass, 0.3));
  }
  b.autoOutline((c) => mix(shade(c, 0.55), P.ink, 0.45));
  return b;
}

// ---------------------------------------------------------------- city hall

function cityHall(): PixelBuffer {
  const W = 64;
  const H = 46;
  // 8 extra rows above y=0 so the flag on the belfry fits (buffer origin at y = -8)
  const b = new PixelBuffer(W, H + 8, 0, -8);
  const stone = 0xf0e3c3;
  const stoneS = 0xd5c29b;
  const slate = P.zincDark;
  const slateL = P.zinc;
  const base = H - 2;
  // roofs: tall pavilions at the ends and the centre, lower roofs between
  const roof = (x: number, w: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) {
      const inset = Math.max(0, Math.floor((y0 + 3 - y) / 1));
      b.rect(x + Math.min(inset, 3), y, w - Math.min(inset, 3) * 2, 1, y === y0 ? slateL : y % 2 ? slate : shade(slate, 0.1));
    }
  };
  roof(4, 56, 12, 19);
  roof(3, 13, 5, 19);
  roof(48, 13, 5, 19);
  roof(24, 16, 3, 19);
  // dormers + chimneys
  for (let x = 7; x < 58; x += 5) {
    b.set(x, 17, stone);
    b.set(x, 18, P.glass);
  }
  for (const x of [8, 20, 44, 55]) {
    b.rect(x, 9, 2, 3, P.terracotta);
    b.set(x, 9, P.terracottaLight);
  }
  // belfry + flag
  b.rect(30, 0, 4, 4, stone);
  b.set(31, 1, P.glass);
  b.vline(32, -6, 6, P.inkSoft);
  b.rect(33, -6, 3, 2, P.white);
  // facade
  b.rect(3, 20, 58, base - 20 + 1, stone);
  b.hline(3, 20, 58, stoneS);
  for (let row = 0; row < 3; row++) {
    const y = 23 + row * 6;
    for (let x = 5; x < 60; x += 3) {
      if (row === 2 && x % 2 === 0) {
        b.rect(x, y, 2, 4, 0x5a4c61); // arcade at street level
        continue;
      }
      b.rect(x, y, 1, 3, P.glass);
      b.set(x, y, P.glassLight);
    }
    b.hline(3, y + 4, 58, stoneS);
  }
  // clock on the centre pavilion
  b.disc(32, 22, 2, P.white);
  b.set(32, 22, P.ink);
  b.set(32, 21, P.ink);
  // pavilion edges
  for (let y = 20; y <= base; y++) {
    for (const x of [16, 24, 40, 48]) b.set(x, y, stoneS);
    b.set(3, y, 0xfbf3e0);
    b.set(60, y, stoneS);
  }
  b.autoOutline();
  // the flag colours (after outline so they stay bright)
  b.set(33, -6, P.navy);
  b.set(35, -6, P.red);
  b.set(33, -5, P.navy);
  b.set(35, -5, P.red);
  return b;
}

// ---------------------------------------------------------------- generic monument (fallback)

function obelisk(): PixelBuffer {
  const b = new PixelBuffer(14, 40);
  const base = 38;
  b.rect(2, base - 3, 10, 4, P.limestoneShade);
  for (let y = 4; y < base - 3; y++) {
    const w = 4 - Math.floor((y - 4) / 14);
    b.rect(7 - Math.ceil(w / 2), y, Math.max(2, w), 1, y % 5 === 0 ? 0xd9c08c : 0xe7cf9a);
  }
  b.rect(6, 1, 2, 3, P.yellow);
  b.autoOutline();
  return b;
}

// ---------------------------------------------------------------- ground decorations & shadows

function softShadow(rx: number, ry: number, dx = 4) {
  return (b: PixelBuffer, cx: number, by: number) => b.shadeEllipse(cx + dx, by - ry + 2, rx, ry, 0.28);
}

function roundPlaza(radius: number) {
  return (b: PixelBuffer, cx: number, by: number) => {
    const cy = by - 10;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (d > radius - 3) b.set(x, y, (x + y) % 3 === 0 ? P.pavingDark : P.paving);
        else if (d > radius - 9) b.set(x, y, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 ? 0xd1c4a6 : 0xc4b597);
        else b.set(x, y, (x * 7 + y * 3) % 5 === 0 ? P.pavingDark : P.paving);
      }
    }
  };
}

function gravelSquare(w: number, h: number) {
  return (b: PixelBuffer, cx: number, by: number) => {
    b.rect(cx - w / 2, by - h, w, h, P.gravel);
    for (let x = cx - w / 2; x < cx + w / 2; x++) {
      b.set(x, by - h, P.gravelDark);
      b.set(x, by - 1, P.gravelDark);
    }
  };
}

let cache: Record<string, LandmarkDef> | null = null;

/** All landmark kinds we can draw (built lazily once). Unknown kinds get a small monument. */
export function landmarkDefs(): Record<string, LandmarkDef> {
  if (cache) return cache;
  const tower = ironTower();
  const cath = cathedral();
  const arc = triumphalArch();
  const bas = basilica();
  const stad = stadium();
  const tw = glassTowers();
  const hall = cityHall();
  const ob = obelisk();
  cache = {
    tower: {
      kind: 'tower', fw: 3, fh: 3, ground: TT.park, sprite: tower, ax: tower.w / 2, ay: tower.h - 2,
      decorate: gravelSquare(46, 14), shadow: softShadow(20, 5, 6),
    },
    cathedral: { kind: 'cathedral', fw: 4, fh: 2, ground: TT.plaza, sprite: cath, ax: cath.w / 2, ay: cath.h - 2, shadow: softShadow(30, 4) },
    arc: { kind: 'arc', fw: 3, fh: 3, ground: TT.plaza, sprite: arc, ax: arc.w / 2, ay: arc.h - 8, decorate: roundPlaza(30), shadow: softShadow(16, 4) },
    basilica: { kind: 'basilica', fw: 4, fh: 3, ground: TT.park, sprite: bas, ax: bas.w / 2, ay: bas.h - 4 },
    stadium: { kind: 'stadium', fw: 5, fh: 4, ground: TT.plaza, sprite: stad, ax: stad.w / 2, ay: stad.h - 4, shadow: softShadow(40, 8, 3) },
    towers: { kind: 'towers', fw: 5, fh: 4, ground: TT.plaza, sprite: tw, ax: tw.w / 2, ay: tw.h - 2, shadow: softShadow(36, 6) },
    cityhall: { kind: 'cityhall', fw: 4, fh: 2, ground: TT.plaza, sprite: hall, ax: hall.w / 2, ay: hall.h - 2, shadow: softShadow(30, 4) },
    monument: { kind: 'monument', fw: 1, fh: 1, ground: TT.plaza, sprite: ob, ax: ob.w / 2, ay: ob.h - 2, shadow: softShadow(6, 2) },
  };
  return cache;
}

// ================================================================ dynamic site sprites

/** Modern data centre: grey block, rooftop fans (animated), blinking status lights. Returns 4 frames. */
export function makeDataCentreFrames(): PixelBuffer[] {
  const frames: PixelBuffer[] = [];
  for (let f = 0; f < 4; f++) {
    const W = 72;
    const H = 62;
    const b = new PixelBuffer(W, H);
    // fenced pad
    b.rect(0, 40, W, 22, 0x6c6771);
    for (let x = 0; x < W; x++) {
      for (let y = 40; y < 62; y++) if (rand2(x, y, 31) < 0.06) b.set(x, y, 0x5f5a64);
      if (x % 3 === 0) {
        b.set(x, 40, 0x9aa0a8);
        b.set(x, 61, 0x9aa0a8);
      }
      b.set(x, 41, 0x83888f);
    }
    for (let x = 8; x < W - 8; x += 9) b.rect(x, 57, 5, 1, P.yellow); // parking marks
    // hazard-striped power transformer
    b.rect(60, 44, 9, 9, 0x8f949b);
    for (let x = 60; x < 69; x++) b.set(x, 44, (x >> 1) % 2 ? P.yellow : P.ink);
    b.rect(62, 47, 5, 4, 0x6f747b);
    // the building: roof
    b.rect(5, 8, 56, 22, 0xc6cacf);
    b.hline(5, 8, 56, 0xe1e4e7);
    b.hline(5, 29, 56, 0xa3a8ae);
    // roof panel seams + rooftop units
    for (let x = 6; x < 60; x++) for (let y = 9; y < 29; y++) if ((x - 6) % 9 === 0 || (y - 9) % 10 === 0) b.set(x, y, 0xb6bbc2);
    // rooftop cooling fans (2 rows of 4) in light casings; blades rotate each frame
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 4; i++) {
        const fx = 14 + i * 12;
        const fy = 14 + j * 9;
        b.disc(fx, fy, 3.6, 0xa4aab2);
        b.set(fx - 2, fy - 3, 0xe4e7ea);
        b.set(fx - 3, fy - 2, 0xe4e7ea);
        b.disc(fx, fy, 2.6, 0x4a4f58);
        const ang = (f / 4) * ((Math.PI * 2) / 3) + (i + j) * 0.7;
        for (let k = 0; k < 3; k++) {
          const a = ang + (k * Math.PI * 2) / 3;
          for (let r = 1; r <= 2; r++) b.set(Math.round(fx + Math.cos(a) * r), Math.round(fy + Math.sin(a) * r), 0xd9dde1);
        }
        b.set(fx, fy, 0x9aa0a8);
      }
    }
    // facade
    b.rect(5, 30, 56, 18, 0x6e7682);
    for (let x = 7; x < 59; x += 4) b.rect(x, 32, 1, 13, 0x8a929e);
    b.hline(5, 30, 56, 0x5b626d);
    b.hline(5, 39, 56, 0x63c7e6); // glowing blue strip
    b.rect(30, 42, 6, 6, 0x3c424b); // entrance
    b.set(32, 43, 0x63c7e6);
    // status lights: blink pattern depends on frame
    const leds = [0x6ee07a, 0x63c7e6, 0xf2cb52];
    for (let k = 0; k < 12; k++) {
      const x = 8 + k * 4;
      const on = (k + f) % 3 !== 0;
      b.set(x, 35, on ? leds[k % 3] : 0x4b5059);
      b.set(x + 1, 43, (k * 7 + f) % 4 === 0 ? 0xff6b5b : 0x4b5059);
    }
    for (let y = 8; y < 48; y++) {
      b.set(5, y, y < 30 ? 0xdfe3e7 : 0x7d8591);
      b.set(60, y, y < 30 ? 0xa3a8ae : 0x5b626d);
    }
    b.autoOutline();
    frames.push(b);
  }
  return frames;
}

/** Tall yellow tower crane (construction). */
export function makeCrane(): PixelBuffer {
  const W = 52;
  const H = 96;
  const b = new PixelBuffer(W, H);
  const yel = 0xe8b83a;
  const yelD = 0xa37722;
  const mastX = 12;
  // mast (lattice)
  for (let y = 18; y < H - 4; y++) {
    for (let x = mastX; x < mastX + 4; x++) {
      const edge = x === mastX || x === mastX + 3;
      const diag = (x - mastX + y) % 4 === 0;
      if (edge || diag) b.set(x, y, edge && x === mastX ? light(yel, 0.2) : diag ? yelD : yel);
    }
  }
  // base block
  b.rect(mastX - 4, H - 5, 12, 4, P.concrete);
  b.hline(mastX - 4, H - 5, 12, 0xd5d0c7);
  // jib + counter-jib
  for (let x = 0; x < W - 1; x++) {
    b.set(x, 14, yel);
    b.set(x, 17, yelD);
    if (x % 3 === 0) {
      b.set(x, 15, yelD);
      b.set(x, 16, yel);
    }
  }
  b.rect(1, 17, 7, 5, P.concreteDark); // counterweights
  b.hline(1, 17, 7, P.concrete);
  // apex + tie lines
  b.rect(mastX + 1, 6, 2, 8, yel);
  b.line(mastX + 1, 6, 1, 13, yelD);
  b.line(mastX + 2, 6, W - 3, 13, yelD);
  // cab
  b.rect(mastX - 2, 18, 8, 5, P.white);
  b.rect(mastX + 2, 19, 3, 2, P.glass);
  // hook, cable and a hanging steel beam
  b.vline(40, 18, 26, P.inkSoft);
  b.rect(39, 44, 3, 2, yelD);
  b.rect(33, 47, 15, 2, P.orange);
  b.line(40, 45, 34, 47, P.inkSoft);
  b.line(40, 45, 46, 47, P.inkSoft);
  b.autoOutline();
  return b;
}

/** Small construction yard (fence + dirt + cones) for user-placed custom sites. */
export function makeConstructionYard(): PixelBuffer {
  const b = new PixelBuffer(44, 26);
  b.rect(1, 6, 42, 18, 0xb08a5e);
  for (let x = 1; x < 43; x++) for (let y = 6; y < 24; y++) if (rand2(x, y, 41) < 0.12) b.set(x, y, 0x96734d);
  for (let x = 1; x < 43; x++) {
    if (x % 3 === 0) {
      b.set(x, 5, P.white);
      b.set(x, 23, P.white);
    }
    b.set(x, 6, x % 6 < 3 ? P.orange : P.white);
  }
  b.rect(6, 10, 10, 6, P.concrete); // a pile of beams
  b.hline(6, 10, 10, 0xd5d0c7);
  b.rect(24, 12, 6, 4, P.yellow); // a little digger
  b.rect(25, 10, 3, 2, P.glass);
  b.line(30, 12, 35, 9, P.yellow);
  b.rect(35, 9, 3, 3, P.yellow);
  for (const cx of [8, 20, 38]) {
    b.set(cx, 19, P.orange);
    b.set(cx, 20, P.white);
    b.rect(cx - 1, 21, 3, 1, P.orange);
  }
  b.autoOutline();
  return b;
}
