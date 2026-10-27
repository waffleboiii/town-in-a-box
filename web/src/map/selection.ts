/**
 * What ONE citizen sees of the change, drawn on the map when a resident is selected:
 *  - a house pin on their home and a briefcase pin on their workplace,
 *  - their commute as an animated dashed line (along streets; metro/RER as an arc),
 *  - exposure badges where the proposal touches them (ExposureReason.at, computed by the
 *    simulation, NOT by the AI) linked to their home with faint dotted lines,
 *  - a soft pulsing ring under their feet.
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { CommuteMode, ExposureReason } from '../types';
import type { Camera } from './camera';
import { P } from './palette';
import { TS } from './terrainTypes';
import { costTable, findPath, simplify } from './pathfind';
import { clamp } from './util';

const MODE_COLOUR: Record<string, number> = {
  metro: 0x5b6fd6,
  rer: 0xc8508a,
  bus: 0xe9954f,
  car: 0xd6534a,
  bike: 0x4fa152,
  walk: 0x8a6a4a,
  none: 0x8a6a4a,
};

export interface SelectionInput {
  home: [number, number];
  work: [number, number] | null;
  mode: CommuteMode;
  reasons: ExposureReason[];
  feet: () => { x: number; y: number } | null;
}

export class SelectionLayer {
  readonly under = new Container();
  readonly over = new Container();
  private path = new Graphics();
  private connectors = new Graphics();
  private ring: Sprite;
  private homePin: Sprite;
  private workPin: Sprite;
  private modeBadge: Sprite;
  private badges: { s: Sprite; x: number; y: number; t0: number; slot: number }[] = [];
  private pts: { x: number; y: number }[] = [];
  private lens: number[] = [];
  private total = 0;
  private colour = 0;
  private dotted = false;
  private sel: SelectionInput | null = null;
  private time = 0;

  constructor(
    private tex: { ring: Texture; homePin: Texture; workPin: Texture; badges: Record<string, Texture>; modes: Record<string, Texture> },
    private grid: { w: number; h: number; tiles: Uint8Array },
  ) {
    this.ring = new Sprite(tex.ring);
    this.ring.anchor.set(0.5);
    this.homePin = new Sprite(tex.homePin);
    this.homePin.anchor.set(0.5, 1);
    this.workPin = new Sprite(tex.workPin);
    this.workPin.anchor.set(0.5, 1);
    this.modeBadge = new Sprite(tex.modes.metro);
    this.modeBadge.anchor.set(0.5);
    this.under.addChild(this.connectors, this.path, this.ring);
    this.over.addChild(this.homePin, this.workPin, this.modeBadge);
    this.set(null);
  }

  set(sel: SelectionInput | null): void {
    this.sel = sel;
    for (const b of this.badges) b.s.destroy();
    this.badges = [];
    this.pts = [];
    this.path.clear();
    this.connectors.clear();
    const on = !!sel;
    this.under.visible = on;
    this.over.visible = on;
    if (!sel) return;
    this.time = 0;
    const hx = sel.home[0] * TS + 8;
    const hy = sel.home[1] * TS + 8;
    this.homePin.position.set(hx, hy);
    this.workPin.visible = !!sel.work;
    this.modeBadge.visible = false;
    if (sel.work && sel.mode !== 'none') {
      const wx = sel.work[0] * TS + 8;
      const wy = sel.work[1] * TS + 8;
      this.workPin.position.set(wx, wy);
      this.colour = MODE_COLOUR[sel.mode] ?? P.ink;
      this.dotted = sel.mode === 'metro' || sel.mode === 'rer';
      if (this.dotted) {
        // underground: a gentle arc between home and work
        const mx = (hx + wx) / 2;
        const my = (hy + wy) / 2;
        const dx = wx - hx;
        const dy = wy - hy;
        const len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(80, len * 0.18);
        const cx = mx - (dy / len) * bend;
        const cy = my + (dx / len) * bend;
        for (let i = 0; i <= 32; i++) {
          const t = i / 32;
          const x = (1 - t) * (1 - t) * hx + 2 * (1 - t) * t * cx + t * t * wx;
          const y = (1 - t) * (1 - t) * hy + 2 * (1 - t) * t * cy + t * t * wy;
          this.pts.push({ x, y });
        }
      } else {
        const tiles = findPath(this.grid.w, this.grid.h, this.grid.tiles, costTable(sel.mode), sel.home[0], sel.home[1], sel.work[0], sel.work[1]);
        const simple = tiles ? simplify(tiles) : [sel.home, sel.work];
        this.pts = simple.map(([x, y]) => ({ x: x * TS + 8, y: y * TS + 8 }));
      }
      this.lens = [0];
      for (let i = 1; i < this.pts.length; i++) this.lens.push(this.lens[i - 1] + Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].y - this.pts[i - 1].y));
      this.total = this.lens[this.lens.length - 1];
      const mid = this.pointAt(this.total / 2);
      this.modeBadge.texture = this.tex.modes[sel.mode] ?? this.tex.modes.walk;
      this.modeBadge.position.set(mid.x, mid.y);
      this.modeBadge.visible = true;
    }
    // exposure badges (group reasons that share a tile side by side)
    const seen = new Map<string, number>();
    sel.reasons.forEach((r, ri) => {
      (r.at ?? []).slice(0, 6).forEach((at) => {
        const key = `${Math.round(at[0])},${Math.round(at[1])}`;
        const k = seen.get(key) ?? 0;
        seen.set(key, k + 1);
        const s = new Sprite(this.tex.badges[r.icon] ?? this.tex.badges.none);
        s.anchor.set(0.5);
        this.over.addChild(s);
        this.badges.push({ s, x: at[0] * TS + 8, y: at[1] * TS + 8, t0: 120 * (ri + k) + 200, slot: k });
      });
    });
  }

  private pointAt(d: number): { x: number; y: number } {
    if (this.pts.length === 0) return { x: 0, y: 0 };
    if (this.pts.length === 1) return this.pts[0];
    let i = 1;
    while (i < this.lens.length - 1 && this.lens[i] < d) i++;
    const a = this.pts[i - 1];
    const b = this.pts[i];
    const seg = this.lens[i] - this.lens[i - 1] || 1;
    const t = clamp((d - this.lens[i - 1]) / seg, 0, 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  update(dtMs: number, cam: Camera): void {
    if (!this.sel) return;
    this.time += dtMs;
    const z = cam.zoom;
    const ui = clamp(2.2 / z, 0.45, 3); // keep markers about the same size on screen
    const bob = Math.sin(this.time / 380) * 2 * ui;
    this.homePin.scale.set(ui);
    this.homePin.y = this.sel.home[1] * TS + 8 + bob * 0.5;
    this.workPin.scale.set(ui);
    if (this.sel.work) this.workPin.y = this.sel.work[1] * TS + 8 - bob * 0.5;
    this.modeBadge.scale.set(ui * 0.9);
    const feet = this.sel.feet();
    if (feet) {
      this.ring.visible = true;
      this.ring.position.set(feet.x, feet.y - 1);
      const pulse = 1.35 + 0.15 * Math.sin(this.time / 260);
      this.ring.scale.set(pulse * Math.max(1, 0.9 / z));
      this.ring.tint = 0xffe08a;
      this.ring.alpha = 0.75 + 0.25 * Math.sin(this.time / 260);
    } else this.ring.visible = false;
    // badges pop in one after another
    for (const b of this.badges) {
      const slot = b.slot;
      const t = clamp((this.time - b.t0) / 260, 0, 1);
      const pop = t <= 0 ? 0 : t < 1 ? 1 + 0.35 * Math.sin(t * Math.PI) : 1;
      b.s.scale.set(ui * pop);
      b.s.visible = t > 0;
      b.s.position.set(b.x + slot * 15 * ui, b.y - 6 * ui + Math.sin(this.time / 420 + slot) * ui);
    }
    // animated commute dashes + connectors
    const g = this.path;
    g.clear();
    if (this.pts.length > 1) {
      const dash = (this.dotted ? 3 : 7) * clamp(1.6 / z, 0.6, 3);
      const gap = (this.dotted ? 5 : 5) * clamp(1.6 / z, 0.6, 3);
      const width = 3.2 * clamp(1.6 / z, 0.6, 3);
      const offset = ((this.time / 1000) * 26 * clamp(1.6 / z, 0.6, 3)) % (dash + gap);
      const segs: [number, number, number, number][] = [];
      for (let d = offset - (dash + gap); d < this.total; d += dash + gap) {
        const a = this.pointAt(Math.max(0, d));
        const b = this.pointAt(Math.min(this.total, d + dash));
        if (d + dash <= 0) continue;
        segs.push([a.x, a.y, b.x, b.y]);
      }
      for (const [ax, ay, bx, by] of segs) g.moveTo(ax, ay).lineTo(bx, by);
      g.stroke({ width: width + 2.4 * clamp(1.6 / z, 0.6, 3), color: P.ink, alpha: 0.75, cap: 'round' });
      for (const [ax, ay, bx, by] of segs) g.moveTo(ax, ay).lineTo(bx, by);
      g.stroke({ width, color: this.colour, cap: 'round' });
    }
    const c = this.connectors;
    c.clear();
    if (this.badges.length) {
      const hx = this.sel.home[0] * TS + 8;
      const hy = this.sel.home[1] * TS + 8;
      const k = clamp(1.6 / z, 0.45, 3);
      const step = 10 * k;
      const r = 2 * k;
      // one dotted line per distinct badge spot, marching slowly from home toward the exposure
      const spots = new Map<string, { x: number; y: number }>();
      for (const b of this.badges) if (b.s.visible) spots.set(`${b.x},${b.y}`, b);
      const march = ((this.time / 1000) * 12 * k) % step;
      const dots: [number, number][] = [];
      for (const b of spots.values()) {
        const len = Math.hypot(b.x - hx, b.y - hy);
        for (let d = step * 0.6 + march; d < len - step * 0.8; d += step) {
          const t = d / len;
          dots.push([hx + (b.x - hx) * t, hy + (b.y - hy) * t]);
        }
      }
      for (const [x, y] of dots) c.circle(x, y, r + 1.1 * k);
      c.fill({ color: P.ink, alpha: 0.7 });
      for (const [x, y] of dots) c.circle(x, y, r);
      c.fill({ color: 0xffb84f });
    }
  }

  destroy(): void {
    this.under.destroy({ children: true });
    this.over.destroy({ children: true });
  }
}
