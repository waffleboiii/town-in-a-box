/**
 * Pixel speech bubbles (screen space, 9-slice frame + little tail) with typewriter text.
 * Each bubble follows a world point given by a callback (usually a resident's head).
 */
import { CanvasTextMetrics, Container, NineSliceSprite, Sprite, Text, TextStyle, type Texture } from 'pixi.js';
import type { Camera } from './camera';
import { FONT } from './labels';
import { P, toCss } from './palette';
import { clamp } from './util';

const PX = 2; // art pixel size in screen px
const MAX_TEXT_W = 230;

export class SpeechBubble {
  readonly node = new Container();
  private body: NineSliceSprite;
  private tail: Sprite;
  private text: Text;
  private lines: string;
  private shown = 0;
  private age = 0;
  private w = 0;
  private h = 0;
  done = false;

  constructor(
    parts: { body: Texture; tail: Texture },
    content: string,
    private anchor: () => { x: number; y: number } | null,
    private ms: number,
    private typewriter: boolean,
    private side: -1 | 0 | 1 = 0,
  ) {
    const style = new TextStyle({ fontFamily: FONT, fontSize: 14, fill: toCss(P.ink), lineHeight: 17, fontWeight: '500', wordWrap: true, wordWrapWidth: MAX_TEXT_W });
    // pre-wrap the full text so the bubble size never changes while letters appear
    const m = CanvasTextMetrics.measureText(content, style);
    this.lines = m.lines.join('\n');
    const plain = new TextStyle({ fontFamily: FONT, fontSize: 14, fill: toCss(P.ink), lineHeight: 17, fontWeight: '500' });
    this.text = new Text({ text: typewriter ? '' : this.lines, style: plain, resolution: Math.max(2, (globalThis.devicePixelRatio || 1) * 1.5) });
    this.shown = typewriter ? 0 : this.lines.length;
    const tw = Math.ceil(m.maxLineWidth);
    const th = Math.ceil(m.lines.length * 17);
    const bw = Math.ceil((tw + 20) / PX);
    const bh = Math.ceil((th + 14) / PX);
    this.w = bw * PX;
    this.h = bh * PX;
    this.body = new NineSliceSprite({ texture: parts.body, leftWidth: 4, rightWidth: 4, topHeight: 4, bottomHeight: 4 });
    this.body.width = bw;
    this.body.height = bh;
    this.body.scale.set(PX);
    this.tail = new Sprite(parts.tail);
    this.tail.scale.set(PX);
    this.node.addChild(this.body, this.tail, this.text);
    this.node.alpha = 0;
    this.fitToText();
  }

  /** Safety net: if the rendered text is bigger than the box (e.g. a late font swap), grow the box. */
  private fitToText(): void {
    const needW = Math.ceil((this.text.width + 20) / PX);
    const needH = Math.ceil((this.text.height + 14) / PX);
    if (needW > this.body.width) this.body.width = needW;
    if (needH > this.body.height) this.body.height = needH;
    this.w = this.body.width * PX;
    this.h = this.body.height * PX;
  }

  update(dtMs: number, cam: Camera): void {
    this.age += dtMs;
    if (this.typewriter && this.shown < this.lines.length) {
      const target = Math.min(this.lines.length, Math.floor((this.age / 1000) * 48));
      if (target !== this.shown) {
        this.shown = target;
        this.text.text = this.lines.slice(0, this.shown);
        this.fitToText();
      }
    }
    const fadeIn = clamp(this.age / 140, 0, 1);
    const left = this.ms - this.age;
    const fadeOut = this.ms > 0 ? clamp(left / 200, 0, 1) : 1;
    this.node.alpha = Math.min(fadeIn, fadeOut);
    if (this.ms > 0 && left <= 0) this.done = true;
    const a = this.anchor();
    if (!a) {
      this.node.visible = false;
      return;
    }
    const p = cam.worldToScreen(a.x, a.y);
    const pop = 1 + 0.08 * Math.sin(clamp(this.age / 180, 0, 1) * Math.PI);
    this.node.visible = true;
    // the tail points at the speaker; the box shifts sideways so two speakers don't overlap
    const shift = this.side * (this.w * 0.35);
    const bx = clamp(Math.round(p.x - this.w / 2 + shift), 6, Math.max(6, cam.viewW - this.w - 6));
    const by = clamp(Math.round(p.y - this.h - 12), 6, Math.max(6, cam.viewH - this.h - 20));
    this.node.position.set(bx, by);
    this.node.scale.set(pop);
    const tailX = clamp(Math.round(p.x - bx - 3), 6, this.w - 18);
    this.tail.position.set(tailX, this.h - PX * 2);
    this.text.position.set(10, 6);
  }

  /** Is the screen point (sx, sy) on this bubble? */
  contains(sx: number, sy: number): boolean {
    if (!this.node.visible || this.node.alpha < 0.2) return false;
    const { x, y } = this.node.position;
    const k = this.node.scale.x;
    return sx >= x && sx <= x + this.w * k && sy >= y && sy <= y + (this.h + 8) * k;
  }

  destroy(): void {
    this.node.destroy({ children: true });
  }
}

export class BubbleLayer {
  readonly container = new Container();
  private bubbles = new Map<string, SpeechBubble>();

  constructor(private parts: { body: Texture; tail: Texture }) {}

  show(key: string, text: string, anchor: () => { x: number; y: number } | null, ms: number, typewriter = true, side: -1 | 0 | 1 = 0): SpeechBubble {
    this.hide(key);
    const b = new SpeechBubble(this.parts, text, anchor, ms, typewriter, side);
    this.bubbles.set(key, b);
    this.container.addChild(b.node);
    return b;
  }

  hide(key: string): void {
    const b = this.bubbles.get(key);
    if (!b) return;
    this.bubbles.delete(key);
    b.destroy();
  }

  hidePrefix(prefix: string): void {
    for (const k of [...this.bubbles.keys()]) if (k.startsWith(prefix)) this.hide(k);
  }

  /** Is the screen point (sx, sy) on any bubble? */
  hit(sx: number, sy: number): boolean {
    for (const b of this.bubbles.values()) if (b.contains(sx, sy)) return true;
    return false;
  }

  update(dtMs: number, cam: Camera): void {
    for (const [k, b] of this.bubbles) {
      b.update(dtMs, cam);
      if (b.done) this.hide(k);
    }
  }

  destroy(): void {
    for (const k of [...this.bubbles.keys()]) this.hide(k);
    this.container.destroy({ children: true });
  }
}
