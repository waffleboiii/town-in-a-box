/**
 * Terrain painter: turns the tile grid (map.json) into cozy pixel art.
 *
 * How it works (simple painter's algorithm, done per 32x32-tile chunk):
 *   1. ground pass  - every tile paints its flat ground (grass, water, paving, roads, rails...)
 *   2. decorations  - flat ground under landmarks (round plazas, gravel squares)
 *   3. object pass  - row by row from top to bottom: buildings, trees, landmarks.
 *                     Objects may overflow upward (3/4 view: roofs, chimneys, tall towers), and
 *                     rows painted later sit "in front", so depth looks right.
 *   4. post pass    - fade the land outside the study area and add a soft vignette at the map edge.
 * Everything is deterministic (hash of tile x,y), so chunks join without seams.
 */
import { P, mix, shade, light } from './palette';
import { PixelBuffer } from './pixels';
import { rand2, hash3, valueNoise, bayer, smoothstep } from './util';
import { TT, TS } from './terrainTypes';
import { landmarkDefs, type LandmarkDef } from './landmarks';

export interface PlacedLandmark {
  id: string;
  name: string;
  def: LandmarkDef;
  tx: number;
  ty: number;
  /** World px: bottom-centre of the footprint, where the sprite anchor sits. */
  cx: number;
  by: number;
  baseRow: number;
  /** Sprite bounding box in world px. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const QUAY_TYPES = new Set<number>([TT.haussmann, TT.street, TT.plaza, TT.industrial, TT.rail, TT.ring, TT.house, TT.tower]);
const FLOWERS = [P.white, P.yellow, P.pink, P.red, 0xb9a3e6];

export class Terrain {
  readonly reserved: Uint8Array;
  /** Tiles hidden behind a landmark sprite (footprint + the tall part above it): no villagers stand here. */
  readonly occluded: Uint8Array;
  readonly groundOverride: Uint8Array;
  readonly bridge: Uint8Array;
  readonly landmarks: PlacedLandmark[] = [];

  constructor(
    readonly w: number,
    readonly h: number,
    readonly tiles: Uint8Array,
    landmarks: { id: string; name: string; kind: string; x: number; y: number }[],
  ) {
    this.reserved = new Uint8Array(w * h);
    this.occluded = new Uint8Array(w * h);
    this.groundOverride = new Uint8Array(w * h).fill(255);
    this.bridge = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.bridge[y * w + x] = this.computeBridge(x, y);
    const defs = landmarkDefs();
    for (const lm of landmarks) {
      const def = defs[lm.kind] ?? defs.monument;
      // nudge the footprint (a few tiles at most) so the sprite does not stand in the river
      let tx = Math.floor(lm.x);
      let ty = Math.floor(lm.y);
      const wet = (cx: number, cy: number) => {
        let n = 0;
        for (let j = 0; j < def.fh; j++)
          for (let i = 0; i < def.fw; i++) if (this.T(cx - Math.floor((def.fw - 1) / 2) + i, cy - Math.floor((def.fh - 1) / 2) + j) === TT.water) n++;
        return n;
      };
      let best = wet(tx, ty);
      if (best > 0) {
        const offs = [[0, -1], [0, 1], [-1, 0], [1, 0], [0, -2], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -3], [0, 3], [-2, 0], [2, 0]];
        let bx = tx;
        let by = ty;
        for (const [ox, oy] of offs) {
          const n = wet(tx + ox, ty + oy);
          if (n < best) {
            best = n;
            bx = tx + ox;
            by = ty + oy;
            if (n === 0) break;
          }
        }
        tx = bx;
        ty = by;
      }
      const left = tx - Math.floor((def.fw - 1) / 2);
      const top = ty - Math.floor((def.fh - 1) / 2);
      for (let j = 0; j < def.fh; j++) {
        for (let i = 0; i < def.fw; i++) {
          const x = left + i;
          const y = top + j;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          this.reserved[y * w + x] = 1;
          this.groundOverride[y * w + x] = def.ground;
        }
      }
      const baseRow = top + def.fh - 1;
      const cx = Math.round((left + def.fw / 2) * TS);
      const by = (baseRow + 1) * TS - 2;
      const sx = def.sprite.ox;
      const sy = def.sprite.oy;
      const x0 = cx - def.ax + sx;
      const y0 = by - def.ay + sy;
      // mark every tile covered by the sprite itself (ignoring its transparent margin roughly)
      for (let yy = Math.floor((y0 + def.sprite.h * 0.12) / TS); yy <= baseRow; yy++) {
        for (let xx = Math.floor((x0 + def.sprite.w * 0.15) / TS); xx <= Math.floor((x0 + def.sprite.w * 0.85) / TS); xx++) {
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) this.occluded[yy * w + xx] = 1;
        }
      }
      this.landmarks.push({
        id: lm.id, name: lm.name, def, tx, ty, cx, by, baseRow,
        x0: x0 - 48, y0: y0 - 8, x1: x0 + def.sprite.w + 48, y1: Math.max(y0 + def.sprite.h, by + 40),
      });
    }
  }

  T(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return TT.outside;
    return this.tiles[y * this.w + x];
  }

  // =========================================================== chunk painting

  /** Paint tiles [tx0, tx0+tw) x [ty0, ty0+th) into a new buffer (world-px origin at the chunk). */
  paintChunk(tx0: number, ty0: number, tw: number, th: number): PixelBuffer {
    const b = new PixelBuffer(tw * TS, th * TS, tx0 * TS, ty0 * TS);
    const bx0 = tx0 * TS;
    const by0 = ty0 * TS;
    const bx1 = bx0 + tw * TS;
    const by1 = by0 + th * TS;
    for (let ty = ty0; ty < ty0 + th; ty++) {
      for (let tx = tx0; tx < tx0 + tw; tx++) {
        if (tx >= this.w || ty >= this.h) continue;
        this.ground(b, tx, ty);
      }
    }
    const lms = this.landmarks.filter((l) => l.x1 > bx0 && l.x0 < bx1 && l.y1 > by0 && l.y0 < by1);
    for (const l of lms) l.def.decorate?.(b, l.cx, l.by);
    let lastRow = ty0 + th + 2;
    for (const l of lms) lastRow = Math.max(lastRow, l.baseRow);
    for (let ty = ty0 - 1; ty <= lastRow; ty++) {
      if (ty <= ty0 + th + 2) {
        for (let tx = tx0 - 1; tx <= tx0 + tw; tx++) {
          if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue;
          if (this.reserved[ty * this.w + tx]) continue;
          this.objects(b, tx, ty);
        }
      }
      for (const l of lms) {
        if (l.baseRow !== ty) continue;
        l.def.shadow?.(b, l.cx, l.by);
        b.blit(l.def.sprite, l.cx - l.def.ax + l.def.sprite.ox, l.by - l.def.ay + l.def.sprite.oy);
      }
    }
    for (let ty = ty0; ty < ty0 + th; ty++) {
      for (let tx = tx0; tx < tx0 + tw; tx++) {
        if (tx >= this.w || ty >= this.h) continue;
        this.post(b, tx, ty);
      }
    }
    return b;
  }

  // =========================================================== ground pass

  private ground(b: PixelBuffer, tx: number, ty: number): void {
    let t = this.T(tx, ty);
    const o = this.groundOverride[ty * this.w + tx];
    if (o !== 255 && t !== TT.water) t = o;
    switch (t) {
      case TT.outside: return this.fieldGround(b, tx, ty);
      case TT.water: return this.waterGround(b, tx, ty);
      case TT.grass: return this.grassGround(b, tx, ty, P.grass, P.grassDark, P.grassLight, 11, 0.5, 0.35);
      case TT.park: return this.parkGround(b, tx, ty);
      case TT.forest: return this.grassGround(b, tx, ty, P.leafDark, shade(P.leafDark, 0.15), P.grassDeep, 13, 0, 0.2);
      case TT.plaza: return this.plazaGround(b, tx, ty);
      case TT.haussmann: return this.haussmannGround(b, tx, ty);
      case TT.house: return this.grassGround(b, tx, ty, P.grassLight, P.grass, light(P.grassLight, 0.15), 17, 0.7, 0.2);
      case TT.tower: return this.grassGround(b, tx, ty, P.grass, P.grassDark, P.grassLight, 19, 0.15, 0.3);
      case TT.industrial: return this.industrialGround(b, tx, ty);
      case TT.ring: return this.linearGround(b, tx, ty, 'ring');
      case TT.rail: return this.linearGround(b, tx, ty, 'rail');
      case TT.street:
        if (this.bridge[ty * this.w + tx]) return this.bridgeGround(b, tx, ty);
        return this.linearGround(b, tx, ty, 'street');
      default: return this.grassGround(b, tx, ty, P.grass, P.grassDark, P.grassLight, 11, 0.4, 0.3);
    }
  }

  private grassGround(b: PixelBuffer, tx: number, ty: number, base: number, dark: number, lite: number, salt: number, flowerRate: number, tuftRate: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const n00 = valueNoise(X, Y, 64, salt);
    const n10 = valueNoise(X + TS, Y, 64, salt);
    const n01 = valueNoise(X, Y + TS, 64, salt);
    const n11 = valueNoise(X + TS, Y + TS, 64, salt);
    for (let py = 0; py < TS; py++) {
      const fy = py / TS;
      const a = n00 + (n01 - n00) * fy;
      const c2 = n10 + (n11 - n10) * fy;
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        const wy = Y + py;
        const v = a + (c2 - a) * (px / TS) + (bayer(wx, wy) - 0.5) * 0.14;
        let c = v > 0.64 ? lite : v < 0.36 ? dark : base;
        const r = rand2(wx, wy, salt + 1);
        if (r < 0.03) c = dark;
        else if (r > 0.986) c = lite;
        b.set(wx, wy, c);
      }
    }
    const tuftC = shade(dark, 0.18);
    for (let i = 0; i < 3; i++) {
      const hh = hash3(tx * 3 + i, ty, salt + 3);
      if ((hh & 1023) / 1024 >= tuftRate) continue;
      const x = X + 2 + ((hh >>> 10) % 12);
      const y = Y + 3 + ((hh >>> 16) % 11);
      b.set(x - 1, y - 1, tuftC);
      b.set(x + 1, y - 1, tuftC);
      b.set(x, y, tuftC);
      b.set(x, y - 1, lite);
    }
    for (let i = 0; i < 2; i++) {
      const hh = hash3(tx * 5 + i, ty, salt + 5);
      if ((hh & 1023) / 1024 >= flowerRate * 0.5) continue;
      const x = X + 2 + ((hh >>> 10) % 12);
      const y = Y + 2 + ((hh >>> 16) % 12);
      const col = FLOWERS[(hh >>> 24) % FLOWERS.length];
      b.set(x, y, col);
      b.set(x, y + 1, tuftC);
      if (hh & 2048) {
        b.set(x + 2, y + 1, col);
        b.set(x + 2, y + 2, tuftC);
      }
    }
  }

  private parkGround(b: PixelBuffer, tx: number, ty: number): void {
    this.grassGround(b, tx, ty, P.park, P.grass, P.parkLight, 23, 0.9, 0.25);
    const X = tx * TS;
    const Y = ty * TS;
    const isP = (x: number, y: number) => {
      const t = this.T(x, y);
      return t === TT.park || t === TT.plaza || t === TT.street;
    };
    // Gravel paths on a regular grid (every 5 tiles), like a formal French park.
    const vPath = tx % 5 === 2;
    const hPath = ty % 5 === 2;
    const gravelAt = (x: number, y: number, edge: boolean) => b.set(x, y, edge || rand2(x, y, 29) < 0.08 ? P.gravelDark : P.gravel);
    let anyPath = false;
    if (vPath) {
      const y0 = isP(tx, ty - 1) ? 0 : 6;
      const y1 = isP(tx, ty + 1) ? 16 : 10;
      for (let y = y0; y < y1; y++) for (let x = 6; x < 10; x++) gravelAt(X + x, Y + y, x === 6 || x === 9);
      anyPath = anyPath || y1 - y0 > 4;
    }
    if (hPath) {
      const x0 = isP(tx - 1, ty) ? 0 : 6;
      const x1 = isP(tx + 1, ty) ? 16 : 10;
      for (let x = x0; x < x1; x++) for (let y = 6; y < 10; y++) gravelAt(X + x, Y + y, y === 6 || y === 9);
      anyPath = anyPath || x1 - x0 > 4;
    }
    if (anyPath) return;
    // flower bed (formal French garden style)
    if (rand2(tx, ty, 31) < 0.2) {
      const bx = X + 3;
      const by = Y + 5;
      b.rect(bx, by, 10, 6, P.soil);
      b.rect(bx + 1, by + 1, 8, 4, shade(P.soil, 0.15));
      const cols = [P.red, P.yellow, P.pink, P.white];
      const c0 = hash3(tx, ty, 33) % 4;
      for (let yy = by + 1; yy < by + 5; yy++) {
        for (let xx = bx + 1; xx < bx + 9; xx++) {
          if ((xx + yy) % 2 === 0) b.set(xx, yy, cols[(c0 + ((yy - by) >> 1)) % 4]);
          else if (rand2(xx, yy, 34) < 0.5) b.set(xx, yy, P.leaf);
        }
      }
      b.hline(bx, by + 6, 10, P.grassDeep);
    }
  }

  private plazaGround(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const stones = [0xdcd0b5, 0xd3c6a8, 0xe5dac2];
    const mortar = 0xbfb090;
    for (let py = 0; py < TS; py++) {
      const wy = Y + py;
      const row = Math.floor(wy / 3);
      const off = (row & 1) * 2;
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        if (wy % 3 === 2 || (wx + off) % 4 === 3) b.set(wx, wy, mortar);
        else b.set(wx, wy, stones[hash3(Math.floor((wx + off) / 4), row, 37) % 3]);
      }
    }
    const allPlaza = [[0, -1], [1, 0], [0, 1], [-1, 0]].every(([dx, dy]) => this.T(tx + dx, ty + dy) === TT.plaza);
    if (allPlaza && rand2(tx, ty, 39) < 0.3) {
      // round fountain
      b.ellipse(X + 8, Y + 9, 6, 4, P.limestone);
      b.ellipse(X + 8, Y + 9, 5, 3, P.water);
      b.ellipse(X + 8, Y + 8, 3, 1, P.waterLight);
      b.hline(X + 3, Y + 13, 11, P.limestoneShade);
      b.rect(X + 8, Y + 5, 1, 4, P.foam);
      b.set(X + 7, Y + 5, P.foam);
      b.set(X + 9, Y + 5, P.foam);
    }
  }

  private haussmannGround(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    b.rect(X, Y, TS, TS, P.paving);
    for (let px = 0; px < TS; px++) {
      const wx = X + px;
      b.set(wx, Y + 15, rand2(wx, Y, 41) < 0.1 ? P.roadDark : P.road);
      if (wx % 4 === 0) b.set(wx, Y + 14, P.pavingDark);
    }
  }

  private industrialGround(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    for (let py = 0; py < TS; py++) {
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        const wy = Y + py;
        const r = rand2(wx, wy, 43);
        b.set(wx, wy, r < 0.07 ? P.concreteDark : r > 0.97 ? 0xccc6bb : 0xb3ada3);
      }
    }
    if (rand2(tx, ty, 44) < 0.5) for (let x = X + 1; x < X + 15; x += 4) b.vline(x, Y + 13, 3, P.yellow);
  }

  private fieldGround(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const jx = Math.floor(rand2(0, Math.floor(ty / 7), 51) * 9);
    const fx = Math.floor((tx + jx) / 9);
    const fy = Math.floor(ty / 7);
    const kind = hash3(fx, fy, 53) % 5;
    const leftEdge = Math.floor((tx - 1 + jx) / 9) !== fx;
    const topEdge = ty % 7 === 0;
    for (let py = 0; py < TS; py++) {
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        const wy = Y + py;
        let c: number;
        const r = rand2(wx, wy, 55);
        if (kind === 0) c = wy % 3 === 0 ? shade(P.wheat, 0.08) : P.wheat;
        else if (kind === 1) c = (wx + wy) % 4 === 0 ? shade(P.field, 0.12) : P.field;
        else if (kind === 3) c = r < 0.3 ? P.rapeseed : r < 0.4 ? P.meadow : light(P.rapeseed, 0.1);
        else c = r < 0.08 ? shade(P.meadow, 0.1) : r > 0.97 ? light(P.meadow, 0.2) : P.meadow;
        if ((leftEdge && px < 1) || (topEdge && py < 1)) c = r < 0.5 ? P.grassDeep : P.leaf;
        b.set(wx, wy, c);
      }
    }
  }

  /** What kind of shore does the tile at (x, y) make for a neighbouring water tile? 0 water, 1 stone quay, 2 soft bank. */
  private shoreKind(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const t = this.tiles[y * this.w + x];
    if (t === TT.water) return 0;
    if (t === TT.street && this.bridge[y * this.w + x]) return 0;
    return QUAY_TYPES.has(t) ? 1 : 2;
  }

  private waterGround(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const k = (dx: number, dy: number) => this.shoreKind(tx + dx, ty + dy);
    const n = k(0, -1);
    const s = k(0, 1);
    const w = k(-1, 0);
    const e = k(1, 0);
    const nw = !n && !w ? k(-1, -1) : 0;
    const ne = !n && !e ? k(1, -1) : 0;
    const sw = !s && !w ? k(-1, 1) : 0;
    const se = !s && !e ? k(1, 1) : 0;
    const shallow = mix(P.water, P.waterLight, 0.3);
    const dist = (px: number, py: number) => {
      let d = 99;
      if (n) d = Math.min(d, py);
      if (s) d = Math.min(d, 15 - py);
      if (w) d = Math.min(d, px);
      if (e) d = Math.min(d, 15 - px);
      if (nw) d = Math.min(d, Math.max(px, py));
      if (ne) d = Math.min(d, Math.max(15 - px, py));
      if (sw) d = Math.min(d, Math.max(px, 15 - py));
      if (se) d = Math.min(d, Math.max(15 - px, 15 - py));
      return d;
    };
    for (let py = 0; py < TS; py++) {
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        const wy = Y + py;
        const v = dist(px, py) + (bayer(wx, wy) - 0.5) * 1.6;
        b.set(wx, wy, v < 2.2 ? shallow : v < 5.5 ? P.water : P.waterDeep);
      }
    }
    // little static wave marks
    for (let i = 0; i < 2; i++) {
      const hh = hash3(tx * 7 + i, ty, 61);
      if ((hh & 255) > 150) continue;
      const px = 2 + ((hh >>> 8) % 10);
      const py = 2 + ((hh >>> 16) % 12);
      if (dist(px, py) < 3) continue;
      b.set(X + px, Y + py, mix(P.water, P.waterLight, 0.6));
      b.set(X + px + 1, Y + py, P.waterLight);
      b.set(X + px + 2, Y + py, mix(P.water, P.waterLight, 0.6));
    }
    // shores (straight edges; corners where two sides are land are rounded further below)
    const quayShadow = shade(P.water, 0.25);
    const R = 6;
    const round = { nw: !!(n && w), ne: !!(n && e), sw: !!(s && w), se: !!(s && e) };
    const inRound = (px: number, py: number) =>
      (round.nw && px < R && py < R) || (round.ne && px > 15 - R && py < R) || (round.sw && px < R && py > 15 - R) || (round.se && px > 15 - R && py > 15 - R);
    const saved: number[] = [];
    for (let py = 0; py < TS; py++) for (let px = 0; px < TS; px++) if (inRound(px, py)) saved.push(px, py, b.get(X + px, Y + py));
    for (let i = 0; i < TS; i++) {
      const wobble = rand2(X + i, Y, 63) < 0.5 ? 1 : 2;
      const wobbleV = rand2(X, Y + i, 64) < 0.5 ? 1 : 2;
      if (n === 1) {
        b.set(X + i, Y, P.limestone);
        b.set(X + i, Y + 1, (X + i) % 5 === 0 ? P.limestoneShade : mix(P.limestone, P.limestoneShade, 0.5));
        b.set(X + i, Y + 2, (X + i) % 5 === 0 ? shade(P.limestoneShade, 0.2) : P.limestoneShade);
        b.set(X + i, Y + 3, quayShadow);
      } else if (n === 2) {
        b.set(X + i, Y, P.sand);
        b.set(X + i, Y + 1, wobble === 2 ? P.sand : P.foam);
        if (wobble === 2) b.set(X + i, Y + 2, P.foam);
      }
      if (s === 1) {
        b.set(X + i, Y + 15, P.limestone);
        b.set(X + i, Y + 14, quayShadow);
      } else if (s === 2) {
        b.set(X + i, Y + 15, P.sand);
        b.set(X + i, Y + 14, wobble === 2 ? P.sand : P.foam);
        if (wobble === 2) b.set(X + i, Y + 13, P.foam);
      }
      if (w === 1) {
        b.set(X, Y + i, P.limestone);
        b.set(X + 1, Y + i, quayShadow);
      } else if (w === 2) {
        b.set(X, Y + i, P.sand);
        b.set(X + 1, Y + i, wobbleV === 2 ? P.sand : P.foam);
        if (wobbleV === 2) b.set(X + 2, Y + i, P.foam);
      }
      if (e === 1) {
        b.set(X + 15, Y + i, P.limestone);
        b.set(X + 14, Y + i, quayShadow);
      } else if (e === 2) {
        b.set(X + 15, Y + i, P.sand);
        b.set(X + 14, Y + i, wobbleV === 2 ? P.sand : P.foam);
        if (wobbleV === 2) b.set(X + 13, Y + i, P.foam);
      }
    }
    const corner = (kind: number, cx: number, cy: number, dx: number, dy: number) => {
      if (!kind) return;
      const c = kind === 1 ? P.limestone : P.sand;
      const c2 = kind === 1 ? quayShadow : P.foam;
      b.set(cx, cy, c);
      b.set(cx + dx, cy, c2);
      b.set(cx, cy + dy, c2);
    };
    corner(nw, X, Y, 1, 1);
    corner(ne, X + 15, Y, -1, 1);
    corner(sw, X, Y + 15, 1, -1);
    corner(se, X + 15, Y + 15, -1, -1);
    // rounded corners: restore the water, then cut a quarter circle of land with a curved shore
    for (let i = 0; i < saved.length; i += 3) if (saved[i + 2] >= 0) b.set(X + saved[i], Y + saved[i + 1], saved[i + 2]);
    const roundCorner = (cx: number, cy: number, kind: number, landT: number) => {
      const quay = kind === 1;
      const land = this.landFill(landT);
      for (let py = 0; py < TS; py++) {
        for (let px = 0; px < TS; px++) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          // only the outer part of the corner box (away from the water body) becomes land
          if ((cx === R ? px >= R : px < 16 - R) || (cy === R ? py >= R : py < 16 - R)) continue;
          if (d > R + 0.4) b.set(X + px, Y + py, land);
          else if (d > R - 0.9) b.set(X + px, Y + py, quay ? P.limestone : P.sand);
          else if (d > R - 1.9) b.set(X + px, Y + py, quay ? quayShadow : P.foam);
        }
      }
    };
    if (round.nw) roundCorner(R, R, Math.max(n, w), this.T(tx, ty - 1));
    if (round.ne) roundCorner(16 - R, R, Math.max(n, e), this.T(tx, ty - 1));
    if (round.sw) roundCorner(R, 16 - R, Math.max(s, w), this.T(tx, ty + 1));
    if (round.se) roundCorner(16 - R, 16 - R, Math.max(s, e), this.T(tx, ty + 1));
  }

  /** Ground colour of a land tile, used to fill rounded river corners. */
  private landFill(t: number): number {
    switch (t) {
      case TT.park: return P.park;
      case TT.grass: case TT.house: case TT.tower: return P.grass;
      case TT.forest: return P.leafDark;
      case TT.outside: return P.meadow;
      case TT.industrial: return 0xb3ada3;
      default: return P.paving;
    }
  }

  /** Street tile that crosses water -> a stone bridge. 1 = deck runs north-south, 2 = east-west. */
  private computeBridge(tx: number, ty: number): number {
    if (this.T(tx, ty) !== TT.street) return 0;
    const wW = this.T(tx - 1, ty) === TT.water;
    const wE = this.T(tx + 1, ty) === TT.water;
    const wN = this.T(tx, ty - 1) === TT.water;
    const wS = this.T(tx, ty + 1) === TT.water;
    if (wW && wE) return 1;
    if (wN && wS) return 2;
    return 0;
  }

  private bridgeGround(b: PixelBuffer, tx: number, ty: number): void {
    this.waterGround(b, tx, ty);
    const X = tx * TS;
    const Y = ty * TS;
    const dir = this.bridge[ty * this.w + tx];
    if (dir === 1) {
      for (let py = 0; py < TS; py++) {
        const wy = Y + py;
        b.set(X + 13, wy, shade(P.water, 0.3));
        b.set(X + 14, wy, shade(P.water, 0.18));
        b.set(X + 3, wy, wy % 8 === 0 ? P.limestoneShade : P.limestone);
        b.set(X + 12, wy, wy % 8 === 0 ? P.limestoneShade : P.limestone);
        for (let px = 4; px < 12; px++) b.set(X + px, wy, px === 4 || px === 11 ? P.pavingDark : rand2(X + px, wy, 65) < 0.06 ? P.roadDark : P.road);
      }
    } else {
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        b.set(wx, Y + 3, P.limestone);
        for (let py = 4; py < 10; py++) b.set(wx, Y + py, py === 4 ? P.pavingDark : rand2(wx, Y + py, 66) < 0.06 ? P.roadDark : P.road);
        b.set(wx, Y + 10, P.limestone);
        const a = Math.abs((wx % 16) - 7.5);
        b.set(wx, Y + 11, P.limestoneShade);
        b.set(wx, Y + 12, a < 3.5 ? 0x4a5f78 : P.limestoneShade);
        b.set(wx, Y + 13, a < 4.5 ? 0x3e5571 : P.limestoneShade);
        b.set(wx, Y + 14, shade(P.water, 0.3));
      }
    }
  }

  /**
   * Roads and rails: a band from the tile centre toward each connected neighbour (8 directions).
   * `along` runs with the road (for dashes / sleepers), `across` is the signed distance from its centre line.
   */
  private linearGround(b: PixelBuffer, tx: number, ty: number, kind: 'street' | 'ring' | 'rail'): void {
    const X = tx * TS;
    const Y = ty * TS;
    const conn =
      kind === 'street'
        ? (t: number) => t === TT.street || t === TT.plaza || t === TT.ring
        : kind === 'ring'
          ? (t: number) => t === TT.ring
          : (t: number) => t === TT.rail;
    const has = (dx: number, dy: number) => conn(this.T(tx + dx, ty + dy));
    const N = has(0, -1);
    const E = has(1, 0);
    const S = has(0, 1);
    const Wd = has(-1, 0);
    const NE = !N && !E && has(1, -1);
    const SE = !S && !E && has(1, 1);
    const SW = !S && !Wd && has(-1, 1);
    const NW = !N && !Wd && has(-1, -1);
    const hw = kind === 'street' ? 4 : kind === 'ring' ? 6 : 4.5;
    const r2 = Math.SQRT1_2;
    // An "L" tile (exactly two perpendicular neighbours) is drawn as a quarter-circle bend, so
    // rasterised diagonal roads become smooth S-curves instead of jagged staircases.
    const orth = (N ? 1 : 0) + (E ? 1 : 0) + (S ? 1 : 0) + (Wd ? 1 : 0);
    const anyDiag = NE || SE || SW || NW;
    let bend: [number, number] | null = null;
    if (orth === 2 && !anyDiag) {
      if (N && E) bend = [16, 0];
      else if (E && S) bend = [16, 16];
      else if (S && Wd) bend = [0, 16];
      else if (Wd && N) bend = [0, 0];
    }
    // remember which pixels are road (2), kerb/sidewalk (1) or free (0) for the street "fill" pass below
    const cls = new Int8Array(TS * TS);
    for (let py = 0; py < TS; py++) {
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        const wy = Y + py;
        const u = px + 0.5 - 8;
        const v = py + 0.5 - 8;
        let best = 99;
        let across = 0;
        let along = NaN;
        let multi = 0;
        if (bend) {
          const bx = px + 0.5 - bend[0];
          const by = py + 0.5 - bend[1];
          const d = Math.sqrt(bx * bx + by * by);
          best = Math.abs(d - 8);
          across = d - 8;
          along = Math.atan2(Math.abs(by), Math.abs(bx)) * 8;
          multi = best <= hw ? 1 : 0;
        }
        const test = (cond: boolean, acr: number, alg: number) => {
          if (!cond) return;
          const d = Math.abs(acr);
          if (d <= hw) multi++;
          if (d < best) {
            best = d;
            across = acr;
            along = alg;
          }
        };
        if (!bend && N) test(v <= 0, u, wy);
        if (!bend && S) test(v >= 0, u, wy);
        if (!bend && E) test(u >= 0, v, wx);
        if (!bend && Wd) test(u <= 0, v, wx);
        if (NE) test(u - v >= 0, (u + v) * r2, (wx - wy) * r2);
        if (SW) test(v - u >= 0, (u + v) * r2, (wx - wy) * r2);
        if (SE) test(u + v >= 0, (v - u) * r2, (wx + wy) * r2);
        if (NW) test(u + v <= 0, (v - u) * r2, (wx + wy) * r2);
        const dc = Math.sqrt(u * u + v * v);
        if (!bend && dc < best) {
          best = dc;
          across = dc;
          along = NaN;
        }
        const inBand = best <= hw;
        const nearBand = !inBand && best <= hw + 1;
        cls[py * TS + px] = inBand ? 2 : nearBand ? 1 : 0;
        const straight = multi <= 1 && !Number.isNaN(along);
        const rr = rand2(wx, wy, 67);
        let c: number;
        if (kind === 'street') {
          if (inBand) {
            c = rr < 0.06 ? P.roadDark : P.road;
            if (straight && across < 0 && across > -1 && ((along % 8) + 8) % 8 < 4) c = mix(P.road, P.dash, 0.55);
          } else if (nearBand) c = P.pavingDark;
          else c = wx % 4 === 0 && wy % 4 === 0 ? P.pavingDark : rr < 0.04 ? light(P.paving, 0.3) : P.paving;
        } else if (kind === 'ring') {
          if (inBand) {
            c = rr < 0.07 ? P.asphaltDark : P.asphalt;
            const a = Math.abs(across);
            if (straight) {
              if (a < 1) c = P.steel;
              else if (a > 3 && a < 4 && ((along % 10) + 10) % 10 < 5) c = P.dash;
              else if (a > 5 && a < 6) c = mix(P.asphalt, P.dash, 0.6);
            }
          } else if (nearBand) c = P.steel;
          else c = rr < 0.3 ? P.grassDark : rr < 0.36 ? P.grassDeep : P.grass;
        } else {
          if (inBand) {
            const a = Math.abs(across);
            c = rr < 0.18 ? 0x857868 : 0x9b8f80;
            const alg = Number.isNaN(along) ? 0 : ((along % 3) + 3) % 3;
            if (a <= 3.6 && alg < 1.1) c = 0x7b573a;
            if (a > 2 && a < 3) c = P.steel;
            if (a > 4) c = 0x857868;
          } else c = rr < 0.4 ? mix(P.grassDark, P.gravelDark, 0.45) : rr < 0.5 ? P.grassDeep : mix(P.grass, P.gravelDark, 0.3);
        }
        b.set(wx, wy, c);
      }
    }
    if (kind === 'street') {
      const ctx = this.streetContext(tx, ty);
      if (ctx !== 'paving') this.streetFill(b, tx, ty, cls, ctx);
    }
  }

  /** What surrounds a street tile: Paris blocks ('city'), gardens and lawns ('green') or anything else. */
  streetContext(tx: number, ty: number): 'city' | 'green' | 'paving' {
    let city = 0;
    let green = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const t = this.T(tx + dx, ty + dy);
        if (t === TT.haussmann) city++;
        else if (t === TT.house || t === TT.tower || t === TT.grass || t === TT.park || t === TT.forest || t === TT.outside) green++;
      }
    }
    return city >= 2 ? 'city' : green >= 4 ? 'green' : 'paving';
  }

  /**
   * A street tile is 100 m wide but a real street is ~15-25 m: fill the free space beside the road
   * with what is around it. In the city: zinc roofs, with limestone facades (windows, shops) facing
   * the road below them (3/4 view). In the suburbs: grass verges.
   */
  private streetFill(b: PixelBuffer, tx: number, ty: number, cls: Int8Array, ctx: 'city' | 'green'): void {
    const X = tx * TS;
    const Y = ty * TS;
    const wN = this.T(tx, ty - 1) === TT.water;
    const wS = this.T(tx, ty + 1) === TT.water;
    const wW = this.T(tx - 1, ty) === TT.water;
    const wE = this.T(tx + 1, ty) === TT.water;
    const hv = rand2(tx, ty, 191);
    const roofBase = hv < 0.45 ? P.zinc : hv < 0.75 ? mix(P.zinc, P.zincDark, 0.3) : mix(P.zinc, P.zincLight, 0.35);
    const stone = hv < 0.5 ? P.limestone : mix(P.limestone, 0xf6dfc0, 0.5);
    const free = (px: number, py: number) => px >= 0 && py >= 0 && px < TS && py < TS && cls[py * TS + px] === 0;
    for (let py = 0; py < TS; py++) {
      for (let px = 0; px < TS; px++) {
        if (!free(px, py)) continue;
        // keep the riverside half open (quays)
        if ((wN && py < 8) || (wS && py >= 8) || (wW && px < 8) || (wE && px >= 8)) continue;
        const wx = X + px;
        const wy = Y + py;
        const r = rand2(wx, wy, 193);
        if (ctx === 'green') {
          b.set(wx, wy, r < 0.28 ? P.grassDark : r > 0.97 ? P.grassLight : P.grass);
          continue;
        }
        // distance (in rows) to the road/sidewalk below and above in this column
        let below = 0;
        for (let q = py + 1; q < TS && q <= py + 7; q++) if (cls[q * TS + px] !== 0) { below = q - py; break; }
        let above = 0;
        for (let q = py - 1; q >= 0 && q >= py - 1; q--) if (cls[q * TS + px] !== 0) { above = py - q; break; }
        let c: number;
        if (below === 1) {
          // ground floor: shop windows and doors
          c = wx % 5 === 1 ? P.woodDark : wx % 5 === 3 || wx % 5 === 4 ? mix(P.glass, P.yellow, 0.25) : shade(stone, 0.13);
        } else if (below === 2 || below === 3) c = wx % 3 === 1 ? (r < 0.18 ? P.glassLight : P.glass) : stone;
        else if (below === 4) c = shade(stone, 0.13);
        else if (below === 5) c = P.zincDark;
        else if (below === 6) c = (wx % 4 === 2) ? stone : shade(roofBase, 0.18);
        else {
          c = wx % 4 === 0 ? shade(roofBase, 0.06) : roofBase;
          if (above === 1) c = P.zincLight;
        }
        // building sides next to a north-south road: light edge on the left, shade on the right
        if (below === 0 || below > 4) {
          if (!free(px - 1, py) && px > 0) c = light(c, 0.18);
          else if (!free(px + 1, py) && px < TS - 1) c = shade(c, 0.15);
        }
        b.set(wx, wy, c);
      }
    }
  }

  // =========================================================== object pass

  private objects(b: PixelBuffer, tx: number, ty: number): void {
    switch (this.T(tx, ty)) {
      case TT.haussmann: return this.haussmann(b, tx, ty);
      case TT.house: return this.houses(b, tx, ty);
      case TT.tower: return this.towerBlock(b, tx, ty);
      case TT.industrial: return this.warehouse(b, tx, ty);
      case TT.forest: return this.forestTrees(b, tx, ty);
      case TT.park: return this.parkObjects(b, tx, ty);
      case TT.grass: return this.grassObjects(b, tx, ty);
      case TT.street: return this.streetObjects(b, tx, ty);
      case TT.outside: return this.outsideObjects(b, tx, ty);
      default:
    }
  }

  /** One round tree canopy with outline, top-left highlight, lower-right shade and a soft ground shadow. */
  tree(b: PixelBuffer, cx: number, cy: number, r: number, base: number, trunk: boolean, seed: number): void {
    b.shadeEllipse(cx + 2, cy + r - 1 + (trunk ? 2 : 0), r, Math.max(1.5, r * 0.55), 0.32);
    if (trunk) {
      b.rect(cx - 1, cy + r - 2, 2, 3, P.woodDark);
      b.set(cx - 1, cy + r - 2, P.wood);
    }
    const outline = mix(shade(base, 0.5), P.ink, 0.35);
    const hi = light(base, 0.28);
    const lo = shade(base, 0.22);
    const R = Math.ceil(r) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const ang = Math.atan2(dy, dx);
        const bump = (rand2(Math.floor((ang + 4) * 2.2), seed, 71) - 0.5) * 0.9;
        const rr = r + bump;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > rr + 0.5) continue;
        let c = base;
        if (d > rr - 0.6) c = outline;
        else if (dx + dy < -r * 0.45) c = hi;
        else if (dx + dy > r * 0.55) c = lo;
        if (c === hi && rand2(cx + dx, cy + dy, seed) < 0.15) c = light(base, 0.5);
        b.set(cx + dx, cy + dy, c);
      }
    }
  }

  private treeColour(tx: number, ty: number, i: number): number {
    const r = rand2(tx * 4 + i, ty, 73);
    if (r < 0.04) return 0xd9964e; // autumn orange (Paris in late October)
    if (r < 0.07) return 0xdcb653; // autumn gold
    if (r < 0.3) return P.leafLight;
    if (r < 0.42) return shade(P.leaf, 0.12);
    return P.leaf;
  }

  private forestTrees(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const pts: [number, number][] = [[4, 4], [12, 5], [8, 9], [3, 12], [12, 13]];
    const list = pts.map(([x, y], i) => {
      const hh = hash3(tx * 8 + i, ty, 75);
      return [X + x + ((hh & 7) - 3.5) * 0.5, Y + y + (((hh >>> 3) & 7) - 3.5) * 0.5, i, hh] as const;
    });
    list.sort((a, b2) => a[1] - b2[1]);
    for (const [x, y, i, hh] of list) {
      const r = 3.6 + ((hh >>> 6) & 15) / 12;
      this.tree(b, Math.round(x), Math.round(y), r, this.treeColour(tx, ty, i), false, hh & 1023);
    }
  }

  private parkObjects(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const path = tx % 5 === 2 || ty % 5 === 2;
    const r = rand2(tx, ty, 77);
    if (path) {
      if (r < 0.2) {
        // bench beside the path
        const bx = X + (tx % 5 === 2 ? 11 : 4);
        const by = Y + (tx % 5 === 2 ? 4 : 11);
        b.rect(bx, by, 4, 1, P.wood);
        b.set(bx, by + 1, P.woodDark);
        b.set(bx + 3, by + 1, P.woodDark);
      }
      if (r > 0.75) this.tree(b, X + (tx % 5 === 2 ? 2 : 13), Y + (ty % 5 === 2 ? 2 : 12), 3, this.treeColour(tx, ty, 0), true, hash3(tx, ty, 79) & 1023);
      return;
    }
    if (rand2(tx, ty, 31) < 0.2) return; // flower bed tile
    if (r < 0.7) {
      const hh = hash3(tx, ty, 81);
      this.tree(b, X + 4 + (hh % 8), Y + 3 + ((hh >>> 4) % 7), 4 + ((hh >>> 8) & 1), this.treeColour(tx, ty, 1), true, hh & 1023);
    }
  }

  private grassObjects(b: PixelBuffer, tx: number, ty: number): void {
    const r = rand2(tx, ty, 83);
    if (r < 0.1) {
      const hh = hash3(tx, ty, 85);
      this.tree(b, tx * TS + 4 + (hh % 8), ty * TS + 4 + ((hh >>> 4) % 8), 2.5 + (hh & 1), shade(P.leaf, 0.05), r < 0.05, hh & 1023);
    } else if (r < 0.13) {
      const x = tx * TS + 6;
      const y = ty * TS + 9;
      b.rect(x, y, 3, 2, P.concrete);
      b.set(x, y, 0xd5d0c7);
      b.shadePx(x + 3, y + 1, 0.3);
    }
  }

  private outsideObjects(b: PixelBuffer, tx: number, ty: number): void {
    const jx = Math.floor(rand2(0, Math.floor(ty / 7), 51) * 9);
    const fx = Math.floor((tx + jx) / 9);
    const leftEdge = Math.floor((tx - 1 + jx) / 9) !== fx;
    const topEdge = ty % 7 === 0;
    if ((leftEdge || topEdge) && rand2(tx, ty, 87) < 0.35) {
      const hh = hash3(tx, ty, 89);
      const x = tx * TS + (leftEdge ? 1 : 3 + (hh % 10));
      const y = ty * TS + (topEdge ? 1 : 3 + ((hh >>> 4) % 10));
      this.tree(b, x, y, 3 + (hh & 1), P.leaf, true, hh & 1023);
    } else if (rand2(tx, ty, 91) < 0.012) {
      // a lonely farmhouse
      const X = tx * TS + 4;
      const Y = ty * TS + 5;
      b.shadeRect(X + 8, Y + 2, 2, 7, 0.3);
      b.rect(X, Y + 4, 8, 4, P.wall);
      b.set(X + 3, Y + 6, P.woodDark);
      b.set(X + 3, Y + 7, P.woodDark);
      for (let j = 0; j < 4; j++) b.hline(X - 1 + (j === 0 ? 1 : 0), Y + j, 10 - (j === 0 ? 2 : 0), j === 0 ? P.terracottaLight : j === 3 ? P.terracottaDark : P.terracotta);
    }
  }

  private streetObjects(b: PixelBuffer, tx: number, ty: number): void {
    if (this.bridge[ty * this.w + tx]) {
      // lamp posts on the bridge parapets
      const X = tx * TS;
      const Y = ty * TS;
      if (this.bridge[ty * this.w + tx] === 1 && ty % 2 === 0) {
        for (const x of [X + 3, X + 12]) {
          b.vline(x, Y + 3, 4, P.inkSoft);
          b.set(x, Y + 2, P.yellow);
        }
      }
      return;
    }
    const isS = (x: number, y: number) => {
      const t = this.T(x, y);
      return t === TT.street || t === TT.plaza;
    };
    const N = isS(tx, ty - 1);
    const S = isS(tx, ty + 1);
    const E = isS(tx + 1, ty);
    const W = isS(tx - 1, ty);
    if (rand2(tx, ty, 93) > 0.75) return;
    const X = tx * TS;
    const Y = ty * TS;
    const col = rand2(tx, ty, 95) < 0.12 ? 0xd9964e : P.leafLight;
    const city = this.streetContext(tx, ty) === 'city';
    if (city && rand2(tx, ty, 99) > 0.45) return;
    const o1 = city ? 3 : 1;
    const o2 = city ? 12 : 14;
    if (E && W && !N && !S) {
      // east-west boulevard: plane trees on both sidewalks
      for (const x of [X + 4, X + 12]) {
        this.tree(b, x, Y + o1, 2.4, col, false, hash3(x, Y, 97) & 1023);
        this.tree(b, x, Y + o2, 2.4, col, false, hash3(x, Y + 14, 97) & 1023);
      }
    } else if (N && S && !E && !W) {
      for (const y of [Y + 4, Y + 12]) {
        this.tree(b, X + o1, y, 2.4, col, false, hash3(X, y, 97) & 1023);
        this.tree(b, X + o2, y, 2.4, col, false, hash3(X + 14, y, 97) & 1023);
      }
    }
  }

  // ---------- Parisian blocks

  private hAlley(tx: number, ty: number): boolean {
    return tx % 6 === 0 || rand2(tx, ty, 101) < 0.26;
  }

  private hSegStart(tx: number, ty: number): number {
    let s = tx;
    for (let k = 0; k < 6; k++) {
      if (this.T(s - 1, ty) !== TT.haussmann || this.hAlley(s, ty)) break;
      s--;
    }
    return s;
  }

  /** Does this block continue into the tile below (no street between them)? */
  private hMergeDown(tx: number, ty: number): boolean {
    if (this.T(tx, ty) !== TT.haussmann || this.T(tx, ty + 1) !== TT.haussmann) return false;
    return rand2(this.hSegStart(tx, ty), ty, 103) < 0.45;
  }

  private haussmann(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const H = TT.haussmann;
    const mergeDown = this.hMergeDown(tx, ty);
    const mergeUp = this.hMergeDown(tx, ty - 1);
    const westH = this.T(tx - 1, ty) === H;
    const eastH = this.T(tx + 1, ty) === H;
    const alley = westH && this.hAlley(tx, ty);
    const x0 = X + (alley ? 2 : westH ? 0 : 1);
    const x1 = X + (eastH ? 16 : 15);
    const seg = this.hSegStart(tx, ty);
    const hv = rand2(seg, ty, 105);
    const hv2 = rand2(tx, ty, 107);
    const facadeH = hv < 0.3 ? 6 : 5;
    const facadeBottom = Y + 13;
    const facadeTop = facadeBottom - facadeH + 1;
    const roofBottom = mergeDown ? Y + 15 : facadeTop - 1;
    const roofBase = hv < 0.45 ? P.zinc : hv < 0.75 ? mix(P.zinc, P.zincDark, 0.3) : mix(P.zinc, P.zincLight, 0.35);
    const stone = hv2 < 0.33 ? P.limestone : hv2 < 0.66 ? mix(P.limestone, 0xf6dfc0, 0.5) : mix(P.limestone, 0xe9e2cf, 0.6);
    const stoneS = shade(stone, 0.13);
    // roof with standing zinc seams
    for (let y = Y; y <= roofBottom; y++) {
      for (let x = x0; x < x1; x++) {
        let c = (x - X) % 4 === 0 ? shade(roofBase, 0.06) : roofBase;
        if (!mergeUp && y === Y) c = P.zincLight;
        b.set(x, y, c);
      }
    }
    if (westH && !alley) b.vline(x0, Y + (mergeUp ? 0 : 1), roofBottom - Y, P.zincDark);
    if (mergeDown) {
      // inner courtyard sometimes
      if (rand2(tx, ty, 109) < 0.55) {
        const cx0 = X + 5;
        const cy0 = Y + 8;
        b.rect(cx0, cy0, 6, 6, light(P.paving, 0.1));
        b.hline(cx0, cy0, 6, P.pavingDark);
        b.vline(cx0, cy0, 6, P.pavingDark);
        b.hline(cx0 - 1, cy0 - 1, 8, P.zincLight);
        if (rand2(tx, ty, 111) < 0.75) this.tree(b, cx0 + 3, cy0 + 3, 2.4, P.leafLight, false, tx & 1023);
      }
    } else {
      // mansard with dormer windows
      for (let x = x0; x < x1; x++) {
        b.set(x, roofBottom, P.zincDark);
        b.set(x, roofBottom - 1, shade(roofBase, 0.18));
        if ((x - X) % 4 === 2 && x < x1 - 1) {
          b.set(x, roofBottom - 2, light(stone, 0.2));
          b.set(x, roofBottom - 1, stone);
          b.set(x, roofBottom, P.glass);
        }
      }
      // facade: cornice shadow, two rows of tall windows, a continuous wrought-iron balcony, shops
      const balcony = hv2 < 0.55;
      const awning = rand2(seg, ty, 113) < 0.35;
      const awnCols = [P.red, P.leaf, P.navy, P.orange, 0x8a3d4f];
      const awnC = awnCols[hash3(seg, ty, 115) % awnCols.length];
      for (let y = facadeTop; y <= facadeBottom; y++) {
        for (let x = x0; x < x1; x++) {
          const lx = x - X;
          const row = y - facadeTop;
          let c = stone;
          if (row === 0) c = stoneS;
          else if (y === facadeBottom) {
            c = lx % 5 === 1 ? P.woodDark : lx % 5 === 3 || lx % 5 === 4 ? mix(P.glass, P.yellow, 0.25) : stoneS;
          } else if (row === 2 && balcony) c = (lx & 1) === 0 ? mix(P.inkSoft, stone, 0.25) : mix(P.inkSoft, stone, 0.6);
          else if ((row === 1 || row === 3 || row === 4) && lx % 3 === 1 && y < facadeBottom) {
            c = rand2(x, y, 117) < 0.18 ? P.glassLight : P.glass;
          }
          b.set(x, y, c);
        }
      }
      if (awning) {
        for (let x = x0; x < x1; x++) {
          const stripe = ((x >> 1) & 1) === 0 ? awnC : P.white;
          b.set(x, facadeBottom - 1, stripe);
          b.set(x, facadeBottom, shade(stripe, 0.15));
        }
        for (let x = x0; x < x1; x++) b.shadePx(x, facadeBottom + 1, 0.25);
      }
      if (!westH || alley) for (let y = facadeTop; y <= facadeBottom; y++) b.set(x0, y, light(stone, 0.15));
      if (!eastH) for (let y = facadeTop; y <= facadeBottom; y++) b.set(x1 - 1, y, stoneS);
    }
    if (alley) {
      for (let y = Y; y <= (mergeDown ? Y + 15 : facadeBottom); y++) {
        b.set(X, y, shade(P.paving, 0.22));
        b.set(X + 1, y, shade(P.paving, 0.12));
      }
    }
    // chimneys poke up above the roof line into the street behind (3/4 view)
    if (!mergeUp) {
      for (let k = 0; k < 2; k++) {
        if (rand2(tx * 2 + k, ty, 119) > 0.62) continue;
        const cx = X + 2 + Math.floor(rand2(tx * 2 + k, ty, 121) * 11);
        if (cx >= x1 - 1 || cx < x0) continue;
        b.rect(cx, Y - 2, 2, 3, P.terracotta);
        b.set(cx, Y - 2, P.terracottaLight);
        b.set(cx + 1, Y - 2, P.terracottaLight);
        b.set(cx + 1, Y, P.terracottaDark);
      }
    }
  }

  // ---------- suburbs

  private houses(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const r = rand2(tx, ty, 131);
    if (r < 0.1) {
      // a garden lot: fruit trees and a little shed
      b.rect(X + 9, Y + 4, 5, 3, P.wood);
      b.hline(X + 8, Y + 3, 7, P.woodDark);
      b.set(X + 11, Y + 6, P.woodDark);
      b.shadeRect(X + 14, Y + 4, 1, 3, 0.3);
      this.tree(b, X + 4, Y + 6, 3, this.treeColour(tx, ty, 4), true, hash3(tx, ty, 143) & 1023);
      this.tree(b, X + 11, Y + 11, 2.5, this.treeColour(tx, ty, 5), true, hash3(tx, ty, 145) & 1023);
      return;
    }
    const pool = r < 0.2;
    const two = !pool && r < 0.62;
    const lots: [number, number][] = two ? [[X + 1, 6], [X + 9, 6]] : [[X + 3 + Math.floor(rand2(tx, ty, 133) * 2), 9]];
    if (pool) {
      b.rect(X + 1, Y + 12, 7, 4, P.limestone);
      b.rect(X + 2, Y + 13, 5, 2, P.water);
      b.hline(X + 2, Y + 13, 5, P.waterLight);
    }
    // garden extras first (they sit behind the houses)
    if (this.T(tx, ty + 1) !== TT.house) {
      for (let x = X; x < X + TS; x += 2) b.set(x, Y + 15, P.white);
    }
    if (rand2(tx, ty, 135) < 0.3) {
      for (let x = X + 2; x < X + 8; x++) for (let y = Y + 13; y < Y + 15; y++) b.set(x, y, (x + y) % 2 ? P.soil : P.leafLight);
    }
    lots.forEach(([hx, w], i) => {
      const hh = hash3(tx * 2 + i, ty, 137);
      const wallBottom = Y + 11 - (hh & 1);
      const wallTop = wallBottom - 2;
      const roofH = two ? 4 : 5;
      const roofBottom = wallTop - 1;
      const roofTop = roofBottom - roofH + 1;
      const roofPick = (hh >>> 2) % 10;
      const roofC = roofPick < 7 ? P.terracotta : roofPick < 8 ? 0xa8553a : P.zincDark;
      const wallC = [P.wall, 0xf4e2b8, 0xf2d6cc, 0xe8e2d2][(hh >>> 6) & 3];
      b.shadeRect(hx + w, roofTop + 1, 2, wallBottom - roofTop + 1, 0.3);
      b.shadeRect(hx, wallBottom + 1, w + 1, 1, 0.2);
      b.rect(hx, wallTop, w, 3, wallC);
      b.vline(hx + w - 1, wallTop, 3, shade(wallC, 0.14));
      const door = hx + 1 + ((hh >>> 9) % Math.max(1, w - 3));
      b.vline(door, wallBottom - 1, 2, P.woodDark);
      for (let x = hx + 1; x < hx + w - 1; x += 2) if (x !== door && x !== door + 1) b.set(x, wallTop + 1, P.glass);
      for (let j = 0; j < roofH; j++) {
        const y = roofTop + j;
        const inset = j === 0 ? 1 : 0;
        const c = j === 0 ? light(roofC, 0.25) : j === roofH - 1 ? shade(roofC, 0.28) : j % 2 ? shade(roofC, 0.08) : roofC;
        b.hline(hx - 1 + inset, y, w + 2 - inset * 2, c);
      }
      if ((hh >>> 12) & 1) {
        const cx = hx + w - 3;
        b.rect(cx, roofTop - 2, 2, 2, P.terracottaDark);
        b.set(cx, roofTop - 2, P.terracottaLight);
      }
    });
    if (!two && !pool && rand2(tx, ty, 139) < 0.6) this.tree(b, X + 2, Y + 4, 2.5, this.treeColour(tx, ty, 2), true, hash3(tx, ty, 141) & 1023);
  }

  private towerBlock(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const r = rand2(tx, ty, 151);
    const tall = r < 0.5;
    const w = tall ? 8 : 14;
    const fh = tall ? 13 + Math.floor(rand2(tx, ty, 153) * 6) : 8 + Math.floor(rand2(tx, ty, 155) * 3);
    const x0 = tall ? X + 3 + Math.floor(rand2(tx, ty, 157) * 4) : X + 1;
    const base = Y + 13;
    const top = base - fh + 1;
    const wallC = 0xebe5d8;
    const accents = [P.orange, P.blue, 0x5fae9c, P.yellow, P.red];
    const acc = accents[hash3(tx, ty, 159) % accents.length];
    // cast shadow to the right on the lawn
    for (let y = top; y <= base + 1; y++) {
      const k = Math.min(4, Math.max(1, Math.floor((y - top) / 3)));
      for (let i = 0; i < k; i++) b.shadePx(x0 + w + i, y, 0.3);
    }
    // flat roof
    b.rect(x0, top - 3, w, 3, 0xd3cdc2);
    b.hline(x0, top - 3, w, 0xe4dfd6);
    b.hline(x0, top - 1, w, 0xb3ada3);
    b.rect(x0 + 2, top - 2, 2, 1, P.concreteDark);
    // facade with a grid of windows and coloured balcony panels
    for (let y = top; y <= base; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const lx = x - x0;
        const ly = y - top;
        let c = wallC;
        if (lx === w - 1) c = shade(wallC, 0.16);
        else if (lx === 0) c = light(wallC, 0.3);
        else if (y === base) c = lx % 4 === 2 ? 0x5a5160 : 0xc9c1b3;
        else if (ly % 2 === 1 && lx % 2 === 1) c = rand2(x, y, 161) < 0.15 ? P.glassLight : P.glass;
        else if (ly % 2 === 0 && lx % 4 === 1 && ly > 0) c = acc;
        b.set(x, y, c);
      }
    }
    // parked cars in front sometimes
    if (rand2(tx, ty, 163) < 0.45) {
      const cars = [P.red, P.blue, P.white, P.yellow, 0x5fae9c];
      for (let i = 0; i < 3; i++) {
        const cx = X + 1 + i * 5;
        const c = cars[hash3(tx * 3 + i, ty, 165) % cars.length];
        b.rect(cx, Y + 14, 3, 2, c);
        b.set(cx + 1, Y + 14, P.glass);
      }
    }
  }

  private warehouse(b: PixelBuffer, tx: number, ty: number): void {
    const X = tx * TS;
    const Y = ty * TS;
    const I = TT.industrial;
    const mergeW = this.T(tx - 1, ty) === I && rand2(tx, ty, 171) < 0.6;
    const mergeE = this.T(tx + 1, ty) === I && rand2(tx + 1, ty, 171) < 0.6;
    const x0 = X + (mergeW ? 0 : 1);
    const x1 = X + (mergeE ? 16 : 15);
    const roofTop = Y + 1;
    const wallTop = Y + 10;
    const wallBottom = Y + 12;
    if (!mergeE) b.shadeRect(x1, roofTop + 1, 2, wallBottom - roofTop + 1, 0.3);
    // sawtooth roof: stacked light slopes with dark glazing strips
    for (let y = roofTop; y < wallTop; y++) {
      const k = (y - roofTop) % 3;
      for (let x = x0; x < x1; x++) {
        const edge = (x === x0 && !mergeW) || (x === x1 - 1 && !mergeE);
        if (edge && k === 0) continue; // zig-zag silhouette at the ends
        let c = k === 0 ? 0x5f7390 : k === 1 ? 0xcdd0d4 : 0xadb2b8;
        if (k === 0 && rand2(x, y, 173) < 0.2) c = P.glassLight;
        b.set(x, y, c);
      }
    }
    // corrugated walls + loading doors
    for (let y = wallTop; y <= wallBottom; y++) for (let x = x0; x < x1; x++) b.set(x, y, x % 2 ? 0xa7adb5 : 0x959ba5);
    if (rand2(tx, ty, 175) < 0.7) {
      const dx = X + 3 + Math.floor(rand2(tx, ty, 177) * 8);
      b.rect(dx, wallTop + 1, 3, 2, 0x4e4a57);
      for (let x = dx; x < dx + 3; x++) b.set(x, wallTop, x % 2 ? P.yellow : P.ink);
    }
    // yard: a truck or some containers
    const yr = rand2(tx, ty, 179);
    if (yr < 0.35) {
      b.rect(X + 3, Y + 13, 6, 2, [P.red, P.blue, P.leaf][hash3(tx, ty, 181) % 3]);
      b.rect(X + 9, Y + 13, 2, 2, P.white);
      b.set(X + 10, Y + 13, P.glass);
    } else if (yr < 0.6) {
      const cs = [P.orange, P.blue, P.red, P.leaf];
      for (let i = 0; i < 3; i++) b.rect(X + 1 + i * 5, Y + 14, 4, 2, cs[hash3(tx * 3 + i, ty, 183) % 4]);
    }
  }

  // =========================================================== post pass

  /** Fade land outside the study area and add a dithered vignette near the map edge. */
  private post(b: PixelBuffer, tx: number, ty: number): void {
    const t = this.T(tx, ty);
    const edgeTiles = Math.min(tx, ty, this.w - 1 - tx, this.h - 1 - ty);
    const isOut = t === TT.outside;
    if (!isOut && edgeTiles > 14) return;
    const X = tx * TS;
    const Y = ty * TS;
    const W = this.w * TS;
    const H = this.h * TS;
    for (let py = 0; py < TS; py++) {
      for (let px = 0; px < TS; px++) {
        const wx = X + px;
        const wy = Y + py;
        let c = b.get(wx, wy);
        if (c < 0) continue;
        if (isOut) c = mix(c, 0xd6d1bb, 0.42);
        const e = Math.min(wx, wy, W - 1 - wx, H - 1 - wy) / TS;
        const v = 1 - smoothstep(0, 14, e);
        if (v > 0) {
          const q = Math.floor(v * 5 + bayer(wx, wy)) / 5;
          if (q > 0) c = mix(c, P.bg, Math.min(0.9, q * 0.85));
        }
        b.set(wx, wy, c);
      }
    }
  }
}
