/**
 * Map overlays drawn above the ground:
 *  - district borders: subtle dotted lines (static, half resolution canvas)
 *  - choropleth: each district tinted with an ordered-dither pixel pattern (diverging red/cream/green
 *    for stance and vote shares, amber for exposure)
 *  - outlines: zone districts, picked districts, hovered district (marching dashes)
 *  - rings: concentric dotted circles around a scenario site, with a slow "sonar" pulse
 *  - site sprite: animated data centre + construction crane, or a construction yard for custom sites
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { P, STANCE, abgr, mix } from './palette';
import { TS } from './terrainTypes';
import { bayer } from './util';
import { canvasTexture, bufferTexture } from './textures';
import { makeConstructionYard, makeCrane, makeDataCentreFrames } from './landmarks';

interface Outline {
  colour: number;
  fillAlpha: number;
  dashed: boolean;
  runs: number[][];
  fillRows: number[][];
  a: Graphics;
  b: Graphics;
  fill: Graphics;
}

interface RingSet {
  a: Graphics;
  b: Graphics;
  pulse: Graphics;
  centre: { x: number; y: number; radii: number[] } | null;
}

const HALF = 8; // overlay resolution: 8 px per tile (each overlay pixel covers 2x2 world px)

export class DistrictGrid {
  readonly bbox = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number }>();
  constructor(
    readonly w: number,
    readonly h: number,
    readonly districts: Uint16Array,
    readonly dept: Map<number, string>,
  ) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = districts[y * w + x];
        if (!d) continue;
        const b = this.bbox.get(d);
        if (!b) this.bbox.set(d, { x0: x, y0: y, x1: x, y1: y, n: 1 });
        else {
          if (x < b.x0) b.x0 = x;
          if (y < b.y0) b.y0 = y;
          if (x > b.x1) b.x1 = x;
          if (y > b.y1) b.y1 = y;
          b.n++;
        }
      }
    }
  }
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.districts[y * this.w + x];
  }
}

/** Diverging colour for a yes-share 0..1 (0 = oppose red, 0.5 = cream, 1 = support green). */
export function divergingColour(v: number): number {
  const t = Math.max(0, Math.min(1, v));
  if (t < 0.5) return mix(STANCE[0], STANCE[2], t / 0.5);
  return mix(STANCE[2], STANCE[4], (t - 0.5) / 0.5);
}

/** Sequential amber for exposure 0..3. */
export function exposureColour(v: number): number {
  const t = Math.max(0, Math.min(1, v / 3));
  return mix(0xf6ecd0, 0xd9772b, t);
}

export class OverlayLayer {
  readonly container = new Container();
  private borderSprite: Sprite;
  private choroSprite: Sprite;
  private choroCanvas: HTMLCanvasElement;
  private choroTex: Texture;
  /** District outlines (zone / picked / hover) and site rings, rebuilt when the zoom changes a lot
   *  so lines keep the same thickness on screen. Two dash phases are swapped for a marching effect. */
  private outlines = new Map<string, Outline>();
  private ringSets = new Map<string, RingSet>();
  private lineLayer = new Container();
  private builtZoom = 1;
  private hoverIdx = 0;
  private time = 0;
  readonly siteLayer = new Container();
  private siteFrames: Texture[] = [];
  private sites = new Map<string, { node: Container; anim: Sprite | null }>();
  private craneTex: Texture | null = null;
  private yardTex: Texture | null = null;

  constructor(private grid: DistrictGrid) {
    const W = grid.w * HALF;
    const H = grid.h * HALF;
    // ---- static dotted borders
    const borderCanvas = document.createElement('canvas');
    borderCanvas.width = W;
    borderCanvas.height = H;
    const ctx = borderCanvas.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    const soft = abgr(P.ink, 120);
    const strong = abgr(P.ink, 190);
    const lite = abgr(P.white, 120);
    const put = (x: number, y: number, v: number) => {
      if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = v;
    };
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        const d = grid.at(x, y);
        const dr = grid.at(x + 1, y);
        const dd = grid.at(x, y + 1);
        if (x + 1 < grid.w && d !== dr && (d || dr)) {
          const deptEdge = !d || !dr || grid.dept.get(d) !== grid.dept.get(dr);
          for (let k = 0; k < HALF; k++) {
            const gy = y * HALF + k;
            if (deptEdge ? gy % 2 === 0 : gy % 3 === 0) {
              put((x + 1) * HALF - 1, gy, deptEdge ? strong : soft);
              put((x + 1) * HALF, gy, lite);
            }
          }
        }
        if (y + 1 < grid.h && d !== dd && (d || dd)) {
          const deptEdge = !d || !dd || grid.dept.get(d) !== grid.dept.get(dd);
          for (let k = 0; k < HALF; k++) {
            const gx = x * HALF + k;
            if (deptEdge ? gx % 2 === 0 : gx % 3 === 0) {
              put(gx, (y + 1) * HALF - 1, deptEdge ? strong : soft);
              put(gx, (y + 1) * HALF, lite);
            }
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this.borderSprite = new Sprite(canvasTexture(borderCanvas, { mipmaps: true }));
    this.borderSprite.scale.set(TS / HALF);
    this.borderSprite.alpha = 0.75;
    // ---- choropleth canvas (repainted on setOverlay)
    this.choroCanvas = document.createElement('canvas');
    this.choroCanvas.width = W;
    this.choroCanvas.height = H;
    this.choroTex = canvasTexture(this.choroCanvas, { mipmaps: true });
    this.choroSprite = new Sprite(this.choroTex);
    this.choroSprite.scale.set(TS / HALF);
    this.choroSprite.visible = false;
    this.choroSprite.alpha = 0.82;
    this.container.addChild(this.choroSprite, this.borderSprite, this.lineLayer);
  }

  setBorderStrength(strong: boolean): void {
    this.borderSprite.alpha = strong ? 1 : 0.75;
  }

  /** Paint the dithered choropleth. colourOf(districtIdx) returns a colour or null (= no tint). */
  setChoropleth(colourOf: ((d: number) => { colour: number; coverage: number } | null) | null): void {
    if (!colourOf) {
      this.choroSprite.visible = false;
      return;
    }
    const { w, h } = this.grid;
    const W = w * HALF;
    const H = h * HALF;
    const ctx = this.choroCanvas.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    const cache = new Map<number, { v: number; coverage: number } | null>();
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const d = this.grid.at(tx, ty);
        if (!d) continue;
        let c = cache.get(d);
        if (c === undefined) {
          const r = colourOf(d);
          c = r ? { v: abgr(r.colour, 255), coverage: r.coverage } : null;
          cache.set(d, c);
        }
        if (!c) continue;
        for (let j = 0; j < HALF; j++) {
          const gy = ty * HALF + j;
          for (let i = 0; i < HALF; i++) {
            const gx = tx * HALF + i;
            if (bayer(gx, gy) < c.coverage) px[gy * W + gx] = c.v;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this.choroTex.source.update();
    this.choroSprite.visible = true;
  }

  /** Boundary runs (merged straight edges in world px) around the tiles whose district passes `inSet`. */
  private edgesOf(inSet: (d: number) => boolean, bbox?: { x0: number; y0: number; x1: number; y1: number }): { runs: number[][]; fillRows: number[][] } {
    const { w, h } = this.grid;
    const x0 = bbox ? Math.max(0, bbox.x0 - 1) : 0;
    const y0 = bbox ? Math.max(0, bbox.y0 - 1) : 0;
    const x1 = bbox ? Math.min(w - 1, bbox.x1 + 1) : w - 1;
    const y1 = bbox ? Math.min(h - 1, bbox.y1 + 1) : h - 1;
    const inside = (x: number, y: number) => {
      const d = this.grid.at(x, y);
      return d !== 0 && inSet(d);
    };
    const runs: number[][] = [];
    const fillRows: number[][] = [];
    for (let y = y0; y <= y1 + 1; y++) {
      let start = -1;
      for (let x = x0; x <= x1 + 1; x++) {
        const edge = x <= x1 && inside(x, y) !== inside(x, y - 1);
        if (edge && start < 0) start = x;
        if (!edge && start >= 0) {
          runs.push([start * TS, y * TS, x * TS, y * TS]);
          start = -1;
        }
      }
    }
    for (let x = x0; x <= x1 + 1; x++) {
      let start = -1;
      for (let y = y0; y <= y1 + 1; y++) {
        const edge = y <= y1 && inside(x, y) !== inside(x - 1, y);
        if (edge && start < 0) start = y;
        if (!edge && start >= 0) {
          runs.push([x * TS, start * TS, x * TS, y * TS]);
          start = -1;
        }
      }
    }
    for (let y = y0; y <= y1; y++) {
      let start = -1;
      for (let x = x0; x <= x1 + 1; x++) {
        const inn = x <= x1 && inside(x, y);
        if (inn && start < 0) start = x;
        if (!inn && start >= 0) {
          fillRows.push([start * TS, y * TS, (x - start) * TS, TS]);
          start = -1;
        }
      }
    }
    return { runs, fillRows };
  }

  private setOutline(key: string, inSet: ((d: number) => boolean) | null, style: { colour: number; fillAlpha: number; dashed: boolean }, bbox?: { x0: number; y0: number; x1: number; y1: number }): void {
    const old = this.outlines.get(key);
    if (old) {
      old.a.destroy();
      old.b.destroy();
      old.fill.destroy();
      this.outlines.delete(key);
    }
    if (!inSet) return;
    const { runs, fillRows } = this.edgesOf(inSet, bbox);
    if (!runs.length) return;
    const o: Outline = { ...style, runs, fillRows, a: new Graphics(), b: new Graphics(), fill: new Graphics() };
    for (const [x, y, w, h] of fillRows) o.fill.rect(x, y, w, h);
    if (style.fillAlpha > 0) o.fill.fill({ color: style.colour, alpha: style.fillAlpha });
    this.lineLayer.addChildAt(o.fill, 0);
    this.lineLayer.addChild(o.a, o.b);
    this.outlines.set(key, o);
    this.buildOutline(o, this.builtZoom);
  }

  /**
   * Swap in a brand-new Graphics at the same place in the layer. Re-using one Graphics with
   * clear() + redraw sometimes left stale GPU geometry on screen when the vertex count changed a lot
   * (seen as giant dashes after zooming), so rebuilt line art always gets fresh objects.
   */
  private freshGraphics(old: Graphics): Graphics {
    const g = new Graphics();
    const parent = old.parent;
    if (parent) parent.addChildAt(g, parent.getChildIndex(old));
    old.destroy();
    return g;
  }

  private buildOutline(o: Outline, zoom: number): void {
    o.a = this.freshGraphics(o.a);
    o.b = this.freshGraphics(o.b);
    const k = 1 / Math.max(zoom, 0.2);
    const width = Math.max(1.5, 2.6 * k);
    const dash = 8 * k;
    const gap = 6 * k;
    const period = dash + gap;
    for (const [g, phase] of [[o.a, 0], [o.b, 0.5]] as const) {
      g.clear();
      const segs: number[][] = [];
      for (const [x0, y0, x1, y1] of o.runs) {
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (!o.dashed) {
          segs.push([x0, y0, x1, y1]);
          continue;
        }
        // dash positions are anchored to world coordinates so neighbouring runs line up
        const startT = ((x0 + y0) % period + period) % period;
        for (let d = -startT + phase * period; d < len; d += period) {
          const a = Math.max(0, d);
          const b = Math.min(len, d + dash);
          if (b <= a) continue;
          segs.push([x0 + ((x1 - x0) * a) / len, y0 + ((y1 - y0) * a) / len, x0 + ((x1 - x0) * b) / len, y0 + ((y1 - y0) * b) / len]);
        }
      }
      for (const [ax, ay, bx, by] of segs) g.moveTo(ax, ay).lineTo(bx, by);
      g.stroke({ width: width + 2.4 * k, color: P.ink, alpha: 0.75, cap: 'butt' });
      for (const [ax, ay, bx, by] of segs) g.moveTo(ax, ay).lineTo(bx, by);
      g.stroke({ width, color: o.colour, cap: 'butt' });
    }
    o.b.visible = false;
  }

  setZone(districts: number[] | null): void {
    const set = new Set(districts ?? []);
    this.setOutline('zone', districts && districts.length ? (d) => set.has(d) : null, { colour: 0xffd27a, fillAlpha: 0.12, dashed: true });
  }

  setPicked(districts: number[]): void {
    const set = new Set(districts);
    this.setOutline('picked', districts.length ? (d) => set.has(d) : null, { colour: 0x8fd0ff, fillAlpha: 0.2, dashed: true });
  }

  setHover(d: number): void {
    if (d === this.hoverIdx) return;
    this.hoverIdx = d;
    const bb = d ? this.grid.bbox.get(d) : undefined;
    this.setOutline('hover', d && bb ? (x) => x === d : null, { colour: P.white, fillAlpha: 0.1, dashed: false }, bb);
  }

  /** Concentric dashed rings around a site (radii in tiles). key = 'scenario' or 'custom'. null clears. */
  setRings(key: string, centre: { x: number; y: number; radii: number[] } | null): void {
    let r = this.ringSets.get(key);
    if (!r) {
      r = { a: new Graphics(), b: new Graphics(), pulse: new Graphics(), centre: null };
      this.ringSets.set(key, r);
      this.lineLayer.addChild(r.pulse, r.a, r.b);
    }
    r.centre = centre;
    this.buildRings(r, this.builtZoom);
  }

  private buildRings(r: RingSet, zoom: number): void {
    r.a = this.freshGraphics(r.a);
    r.b = this.freshGraphics(r.b);
    r.pulse.clear();
    if (!r.centre) return;
    const k = 1 / Math.max(zoom, 0.2);
    const cx = r.centre.x * TS + 8;
    const cy = r.centre.y * TS + 8;
    const colours = [0xffb36b, 0xffd27a, 0xfff0b8, 0xfff6dc];
    r.centre.radii.forEach((rad, i) => {
      const R = rad * TS;
      const dashLen = 9 * k;
      const period = 15 * k;
      const steps = Math.max(12, Math.floor((2 * Math.PI * R) / period));
      for (const [g, off] of [[r.a, 0], [r.b, 0.5]] as const) {
        const draw = () => {
          for (let s2 = 0; s2 < steps; s2++) {
            const a0 = ((s2 + off) / steps) * Math.PI * 2;
            const a1 = a0 + dashLen / R;
            g.moveTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
            for (let t = 1; t <= 3; t++) {
              const a = a0 + ((a1 - a0) * t) / 3;
              g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
            }
          }
        };
        draw();
        g.stroke({ width: 5.2 * k, color: P.ink, alpha: 0.7, cap: 'butt' });
        draw();
        g.stroke({ width: 2.6 * k, color: colours[Math.min(i, colours.length - 1)], cap: 'butt' });
      }
    });
    r.b.visible = false;
  }

  /** Site sprite: 'datacentre' (animated building + crane) or 'yard' (construction yard + crane). null clears. */
  setSite(key: string, site: { x: number; y: number; kind: 'datacentre' | 'yard' } | null): void {
    const old = this.sites.get(key);
    if (old) {
      old.node.destroy({ children: true });
      this.sites.delete(key);
    }
    if (!site) return;
    const node = new Container();
    const bx = site.x * TS + 8;
    const by = site.y * TS + 16;
    if (!this.craneTex) this.craneTex = bufferTexture(makeCrane());
    let anim: Sprite | null = null;
    if (site.kind === 'datacentre') {
      if (!this.siteFrames.length) this.siteFrames = makeDataCentreFrames().map((b) => bufferTexture(b));
      const s = new Sprite(this.siteFrames[0]);
      s.anchor.set(0.5, 1);
      s.position.set(bx, by + 10);
      anim = s;
      const c = new Sprite(this.craneTex);
      c.anchor.set(0.2, 1);
      c.position.set(bx + 30, by + 2);
      node.addChild(s, c);
    } else {
      if (!this.yardTex) this.yardTex = bufferTexture(makeConstructionYard());
      const y = new Sprite(this.yardTex);
      y.anchor.set(0.5, 1);
      y.position.set(bx, by + 6);
      const c = new Sprite(this.craneTex);
      c.anchor.set(0.2, 1);
      c.position.set(bx - 4, by - 2);
      node.addChild(y, c);
    }
    this.siteLayer.addChild(node);
    this.sites.set(key, { node, anim });
  }

  update(dtMs: number, zoom: number): void {
    this.time += dtMs;
    if (Math.abs(Math.log(zoom / this.builtZoom)) > 0.16) {
      this.builtZoom = zoom;
      for (const o of this.outlines.values()) this.buildOutline(o, zoom);
      for (const r of this.ringSets.values()) this.buildRings(r, zoom);
    }
    const phase = Math.floor(this.time / 300) % 2 === 1;
    for (const o of this.outlines.values()) {
      if (!o.dashed) continue;
      o.a.visible = !phase;
      o.b.visible = phase;
    }
    const rphase = Math.floor(this.time / 600) % 2 === 1;
    for (const r of this.ringSets.values()) {
      r.a.visible = !rphase;
      r.b.visible = rphase;
      r.pulse.clear();
      if (!r.centre || !r.centre.radii.length) continue;
      // sonar pulse travelling outward from the site
      const maxR = Math.max(...r.centre.radii) * TS;
      const t = (this.time % 2600) / 2600;
      const R = 12 + t * maxR;
      r.pulse.circle(r.centre.x * TS + 8, r.centre.y * TS + 8, R).stroke({ width: 3 / Math.max(zoom, 0.2), color: 0xffd27a, alpha: (1 - t) * (1 - t) * 0.55 });
    }
    const f = Math.floor(this.time / 160) % Math.max(1, this.siteFrames.length);
    for (const site of this.sites.values()) {
      if (site.anim && this.siteFrames.length && site.anim.texture !== this.siteFrames[f]) site.anim.texture = this.siteFrames[f];
    }
  }
}
