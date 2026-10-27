/**
 * Labels drawn in SCREEN space (so text stays crisp and readable at any zoom):
 *  - Paris arrondissements: little blue enamel street plaques (white text)
 *  - suburban communes: wooden signposts on a post
 *  - landmark names and ring distances: cream tags
 * A simple greedy collision pass hides lower-priority labels that would overlap.
 */
import { Container, NineSliceSprite, Sprite, Text, type Texture } from 'pixi.js';
import type { Camera } from './camera';
import { P, toCss } from './palette';
import { clamp } from './util';

export type LabelStyle = 'plaque' | 'plank' | 'tag' | 'site';

export interface LabelSpec {
  id: string;
  text: string;
  /** World px of the anchor (bottom centre of the sign). */
  wx: number;
  wy: number;
  style: LabelStyle;
  priority: number;
  minZoom?: number;
  maxZoom?: number;
  /** Hang the label BELOW the anchor point instead of standing on it (used for landmark names). */
  below?: boolean;
}

interface LabelNode {
  spec: LabelSpec;
  node: Container;
  w: number;
  h: number;
  alpha: number;
  target: number;
}

// Digits come from 'Silkscreen' (loaded with digits only in index.html): Pixelify's 5 reads like an S or an 8.
export const FONT = '"Silkscreen", "Pixelify Sans", ui-monospace, monospace';

export class LabelLayer {
  readonly container = new Container();
  private items: LabelNode[] = [];
  private layoutTimer = 0;
  private lastZoom = -1;

  constructor(private signs: { plank: Texture; plaque: Texture; post: Texture; tag: Texture }) {}

  private makeNode(spec: LabelSpec): LabelNode {
    const node = new Container();
    const px = 2; // art pixel size in screen px
    const style = spec.style;
    const fontSize = style === 'plaque' ? 13 : style === 'site' ? 14 : 12;
    const colour = style === 'plaque' ? P.white : style === 'plank' ? 0xfff1d6 : P.ink;
    const text = new Text({
      text: spec.text,
      style: {
        fontFamily: FONT,
        fontSize,
        fontWeight: style === 'site' || style === 'plaque' ? '600' : '500',
        fill: toCss(colour),
        dropShadow: style === 'plank' ? { color: toCss(P.woodDark), distance: 1, angle: Math.PI / 2, blur: 0, alpha: 1 } : undefined,
      },
      resolution: Math.max(2, (globalThis.devicePixelRatio || 1) * 1.5),
    });
    text.anchor.set(0.5, 0.5);
    const padX = style === 'tag' ? 7 : 9;
    const w = Math.ceil(text.width + padX * 2);
    const h = Math.ceil(fontSize + (style === 'plaque' ? 12 : 10));
    const tex = style === 'plaque' ? this.signs.plaque : style === 'plank' ? this.signs.plank : this.signs.tag;
    const bg = new NineSliceSprite({ texture: tex, leftWidth: 4, rightWidth: 4, topHeight: 4, bottomHeight: 4 });
    bg.width = Math.ceil(w / px);
    bg.height = Math.ceil(h / px);
    bg.scale.set(px);
    bg.position.set(-Math.ceil(w / px) * px * 0.5, -h - (style === 'plank' ? 10 : 0));
    if (style === 'plank') {
      const post = new Sprite(this.signs.post);
      post.scale.set(px);
      post.anchor.set(0.5, 1);
      post.position.set(0, 0);
      node.addChild(post);
    }
    node.addChild(bg);
    text.position.set(0, bg.y + h / 2 - (style === 'plaque' ? 0 : 1));
    node.addChild(text);
    node.visible = false;
    node.alpha = 0;
    this.container.addChild(node);
    return { spec, node, w, h: h + (style === 'plank' ? 10 : 0), alpha: 0, target: 0 };
  }

  set(specs: LabelSpec[]): void {
    for (const it of this.items) it.node.destroy({ children: true });
    this.items = specs.map((s) => this.makeNode(s));
    this.lastZoom = -1;
  }

  /** Add/replace a group of labels identified by an id prefix (e.g. 'ring:'). */
  replaceGroup(prefix: string, specs: LabelSpec[]): void {
    this.items = this.items.filter((it) => {
      if (!it.spec.id.startsWith(prefix)) return true;
      it.node.destroy({ children: true });
      return false;
    });
    for (const s of specs) this.items.push(this.makeNode(s));
    this.lastZoom = -1;
  }

  update(dtMs: number, cam: Camera): void {
    const zoom = cam.zoom;
    const scale = zoom < 0.5 ? 0.8 : zoom < 1.6 ? 0.9 : 1;
    this.layoutTimer -= dtMs;
    if (this.layoutTimer <= 0 || Math.abs(zoom - this.lastZoom) > 0.04) {
      this.layoutTimer = 180;
      this.lastZoom = zoom;
      this.layout(cam, scale);
    }
    const k = 1 - Math.exp(-dtMs / 120);
    for (const it of this.items) {
      it.alpha += (it.target - it.alpha) * k;
      if (Math.abs(it.alpha - it.target) < 0.02) it.alpha = it.target;
      if (it.alpha <= 0.01) {
        if (it.node.visible) it.node.visible = false;
        continue;
      }
      const p = cam.worldToScreen(it.spec.wx, it.spec.wy);
      it.node.visible = true;
      it.node.alpha = it.alpha;
      it.node.scale.set(scale);
      it.node.position.set(Math.round(p.x), Math.round(p.y + (it.spec.below ? it.h * scale : 0)));
    }
  }

  private layout(cam: Camera, scale: number): void {
    const zoom = cam.zoom;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const sorted = [...this.items].sort((a, b) => b.spec.priority - a.spec.priority);
    for (const it of sorted) {
      const s = it.spec;
      if ((s.minZoom !== undefined && zoom < s.minZoom) || (s.maxZoom !== undefined && zoom > s.maxZoom)) {
        it.target = 0;
        continue;
      }
      const p0 = cam.worldToScreen(s.wx, s.wy);
      const w = it.w * scale;
      const h = it.h * scale;
      const p = { x: p0.x, y: p0.y + (s.below ? h : 0) };
      const r = { x0: p.x - w / 2 - 3, y0: p.y - h - 3, x1: p.x + w / 2 + 3, y1: p.y + 3 };
      if (r.x1 < -50 || r.x0 > cam.viewW + 50 || r.y1 < -50 || r.y0 > cam.viewH + 50) {
        it.target = 0;
        continue;
      }
      const hit = placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
      if (hit && s.style !== 'site') {
        it.target = 0;
        continue;
      }
      placed.push(r);
      it.target = clamp(1, 0, 1);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.items = [];
  }
}
