/**
 * ResidentLayer: the ~2,000 villagers.
 *
 * Each resident has up to four display objects:
 *   sprite  - the walking chibi villager (zoomed in)
 *   ghost   - pale see-through twin, cross-faded in when the resident is filtered out
 *             ("would not take part" in attendee mode, or "not eligible")
 *   dot     - a small coloured marker used when zoomed out (colour = stance), so the
 *             mood of the city reads at a glance
 *   emote   - a little speech icon over the head (heart, smile, ..., frown, anger, thinking)
 * Only residents that are on screen are animated (wandering, walk cycles, bobbing).
 */
import { Container, Sprite, type Texture } from 'pixi.js';
import type { Resident } from '../types';
import { STANCE, STANCE_NONE, mix } from './palette';
import { DIR_DOWN, DIR_LEFT, DIR_RIGHT, DIR_UP, FRAME_GHOST, VillagerAtlas } from './villagers';
import { TS, isWalkable } from './terrainTypes';
import type { Camera } from './camera';
import { clamp, easeInOutCubic, easeOutBack, rand2 } from './util';

const NO_STANCE = 99;
const GHOST_GREY = 0x9aa3b5;

export class ResidentLayer {
  readonly dotLayer = new Container();
  readonly ghostLayer = new Container();
  readonly spriteLayer = new Container();
  readonly emoteLayer = new Container();
  readonly n: number;
  readonly ids: number[];

  // per-resident state, stored in flat arrays for speed
  readonly homeX: Float32Array;
  readonly homeY: Float32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  private tx: Float32Array;
  private ty: Float32Array;
  private state: Uint8Array; // 0 idle, 1 walking, 2 scripted (conversation)
  private timer: Float32Array;
  private dir: Uint8Array;
  private walkT: Float32Array;
  private speed: Float32Array;
  readonly fade: Float32Array;
  private fadeFrom: Float32Array;
  private fadeTo: Float32Array;
  private fadeStart: Float64Array;
  private fadeDur: Float32Array;
  private dim: Float32Array;
  readonly dimTarget: Float32Array;
  private hopStart: Float64Array;
  private popStart: Float64Array;
  readonly stance: Int8Array;
  private thinking: Uint8Array;
  private emoteOverride: Int8Array; // -1 none, else emote texture index (e.g. '!' or chat dots)
  private emoteOverrideUntil: Float64Array;
  private highlightRing: Uint8Array;
  private lastFrame: Int16Array;
  private lastZ: Int32Array;

  private sprites: Sprite[] = [];
  private ghosts: Sprite[] = [];
  private dots: Sprite[] = [];
  private emotes: Sprite[] = [];
  private slots: Int32Array;
  private idToIndex = new Map<number, number>();
  /** Emote textures: see makeEmotes() for the index meaning. */
  private emoteTex: Texture[];
  private dotTex: Texture[];

  forceSolid = -1;
  showEmotes = false;
  private thinkFrame = 0;
  private time = 0;

  constructor(
    residents: Resident[],
    private atlas: VillagerAtlas,
    emoteTex: Texture[],
    dotTex: Texture[],
    private tileAt: (tx: number, ty: number) => number,
    blocked: (tx: number, ty: number) => boolean = () => false,
  ) {
    this.n = residents.length;
    const n = this.n;
    this.ids = residents.map((r) => r.id);
    this.homeX = new Float32Array(n);
    this.homeY = new Float32Array(n);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.ty = new Float32Array(n);
    this.state = new Uint8Array(n);
    this.timer = new Float32Array(n);
    this.dir = new Uint8Array(n);
    this.walkT = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.fade = new Float32Array(n);
    this.fadeFrom = new Float32Array(n);
    this.fadeTo = new Float32Array(n);
    this.fadeStart = new Float64Array(n);
    this.fadeDur = new Float32Array(n).fill(1);
    this.dim = new Float32Array(n);
    this.dimTarget = new Float32Array(n);
    this.hopStart = new Float64Array(n).fill(-1e9);
    this.popStart = new Float64Array(n).fill(-1e9);
    this.stance = new Int8Array(n).fill(NO_STANCE);
    this.thinking = new Uint8Array(n);
    this.emoteOverride = new Int8Array(n).fill(-1);
    this.emoteOverrideUntil = new Float64Array(n);
    this.highlightRing = new Uint8Array(n);
    this.lastFrame = new Int16Array(n).fill(-1);
    this.lastZ = new Int32Array(n).fill(-1);
    this.slots = new Int32Array(n);
    this.emoteTex = emoteTex;
    this.dotTex = dotTex;
    this.spriteLayer.sortableChildren = true;
    this.ghostLayer.sortableChildren = true;

    residents.forEach((r, i) => {
      this.idToIndex.set(r.id, i);
      this.slots[i] = atlas.add(r.look);
      // stand on the sidewalk in front of the home building; spread neighbours a little
      const jitter = Math.round((rand2(r.id, 7, 3) - 0.5) * 10);
      let [hx, hy] = r.home;
      if (blocked(hx, hy)) {
        // home tile is under a landmark sprite: stand on the nearest free walkable tile instead
        search: for (let rad = 1; rad <= 6; rad++) {
          for (let dy = -rad; dy <= rad; dy++) {
            for (let dx = -rad; dx <= rad; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
              if (!blocked(hx + dx, hy + dy) && isWalkable(tileAt(hx + dx, hy + dy))) {
                hx += dx;
                hy += dy;
                break search;
              }
            }
          }
        }
      }
      this.homeX[i] = hx * TS + 8 + jitter;
      this.homeY[i] = hy * TS + 15;
      this.x[i] = this.homeX[i];
      this.y[i] = this.homeY[i];
      this.timer[i] = rand2(r.id, 1, 5) * 6;
      this.speed[i] = 8 + rand2(r.id, 2, 5) * 6;
    });
  }

  /** Create the PixiJS objects (call after atlas.finalize()). */
  build(): void {
    for (let i = 0; i < this.n; i++) {
      const s = new Sprite(this.atlas.frame(this.slots[i], 0));
      s.anchor.set(0.5, 1);
      s.position.set(this.x[i], this.y[i]);
      s.visible = false;
      this.sprites.push(s);
      this.spriteLayer.addChild(s);
      const g = new Sprite(this.atlas.frame(this.slots[i], FRAME_GHOST));
      g.anchor.set(0.5, 1);
      g.visible = false;
      this.ghosts.push(g);
      this.ghostLayer.addChild(g);
      const d = new Sprite(this.dotTex[0]);
      d.anchor.set(0.5);
      d.position.set(this.x[i], this.y[i] - 5);
      d.tint = STANCE_NONE;
      this.dots.push(d);
      this.dotLayer.addChild(d);
      const e = new Sprite(this.emoteTex[2]);
      e.anchor.set(0.5, 1);
      e.visible = false;
      this.emotes.push(e);
      this.emoteLayer.addChild(e);
    }
  }

  index(id: number): number {
    return this.idToIndex.get(id) ?? -1;
  }

  /** Current feet position of resident id (world px). */
  pos(id: number): { x: number; y: number } | null {
    const i = this.index(id);
    if (i < 0) return null;
    return { x: this.x[i], y: this.y[i] };
  }

  // ------------------------------------------------------------ stances, emotes, transitions

  setStance(i: number, s: number | null, pop: boolean): void {
    const v = s === null ? NO_STANCE : clamp(Math.round(s), -2, 2);
    if (this.stance[i] === v) return;
    this.stance[i] = v;
    if (pop) this.popStart[i] = this.time + Math.random() * 400;
  }

  clearStances(): void {
    this.stance.fill(NO_STANCE);
    this.thinking.fill(0);
  }

  setThinking(i: number, on: boolean): void {
    this.thinking[i] = on ? 1 : 0;
  }

  /** Temporary emote (index into the emote textures) for `ms` milliseconds. */
  flashEmote(i: number, emote: number, ms: number): void {
    this.emoteOverride[i] = emote;
    this.emoteOverrideUntil[i] = this.time + ms;
    this.popStart[i] = this.time;
  }

  pop(i: number, delay = 0): void {
    this.popStart[i] = this.time + delay;
  }

  hop(i: number, delay = 0): void {
    this.hopStart[i] = this.time + delay;
  }

  /**
   * Animate who is "ghosted". target[i] = 1 means faded out. The change ripples outward
   * from the screen centre and is complete in about 600 ms.
   */
  setGhostTargets(target: Float32Array, cam: Camera, celebrate: boolean): void {
    const view = cam.viewRect(40);
    const maxD = Math.hypot(view.x1 - view.x0, view.y1 - view.y0) / 2;
    for (let i = 0; i < this.n; i++) {
      const to = target[i];
      if (Math.abs(this.fadeTo[i] - to) < 1e-3 && Math.abs(this.fade[i] - to) < 1e-3) continue;
      const onScreen = this.x[i] > view.x0 && this.x[i] < view.x1 && this.y[i] > view.y0 && this.y[i] < view.y1;
      const d = Math.hypot(this.x[i] - cam.x, this.y[i] - cam.y);
      const delay = onScreen ? (d / maxD) * 230 + rand2(i, 3, 9) * 40 : 0;
      this.fadeFrom[i] = this.fade[i];
      this.fadeTo[i] = to;
      this.fadeStart[i] = this.time + delay;
      this.fadeDur[i] = 340;
      if (celebrate && to < 0.5 && onScreen) this.hop(i, delay + 160);
    }
  }

  setHighlightRing(i: number, on: boolean): void {
    this.highlightRing[i] = on ? 1 : 0;
  }

  // ------------------------------------------------------------ scripted movement (conversations)

  walkTo(i: number, x: number, y: number, speed = 34): void {
    this.state[i] = 2;
    this.tx[i] = x;
    this.ty[i] = y;
    this.speed[i] = speed;
  }

  arrived(i: number): boolean {
    return Math.abs(this.x[i] - this.tx[i]) < 0.6 && Math.abs(this.y[i] - this.ty[i]) < 0.6;
  }

  face(i: number, dir: number): void {
    this.dir[i] = dir;
  }

  teleport(i: number, x: number, y: number): void {
    this.x[i] = x;
    this.y[i] = y;
  }

  /** Give a scripted resident back to idle life: walk home. */
  release(i: number): void {
    this.state[i] = 1;
    this.tx[i] = this.homeX[i];
    this.ty[i] = this.homeY[i];
    this.speed[i] = 14;
  }

  isScripted(i: number): boolean {
    return this.state[i] === 2;
  }

  // ------------------------------------------------------------ picking

  /** Nearest resident to a world point within `radius` world px, or -1. */
  pick(wx: number, wy: number, radius: number, spriteMode: boolean): number {
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < this.n; i++) {
      const cy = spriteMode ? this.y[i] - 7 : this.y[i] - 5;
      const dx = this.x[i] - wx;
      const dy = cy - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ per-frame update

  update(dtMs: number, cam: Camera): void {
    this.time += dtMs;
    const now = this.time;
    const dt = Math.min(dtMs, 60) / 1000;
    const zoom = cam.zoom;
    // level of detail: full sprites when zoomed in, coloured dots when zoomed out
    const lodSprite = clamp((zoom - 0.72) / 0.28, 0, 1);
    const lodDot = 1 - clamp((zoom - 0.85) / 0.3, 0, 1);
    const view = cam.viewRect(24);
    const emoteVis = this.showEmotes && zoom >= 1.05;
    const emoteAlphaZoom = clamp((zoom - 1.05) / 0.3, 0, 1);
    this.thinkFrame = Math.floor(now / 260) % 3;
    const dotPx = zoom < 0.5 ? 5 : 6;
    const dotScale = dotPx / (7 * zoom);
    const ringScale = 9 / (11 * zoom);
    this.spriteLayer.visible = lodSprite > 0;
    this.ghostLayer.visible = lodSprite > 0;
    this.emoteLayer.visible = emoteVis;
    this.dotLayer.visible = lodDot > 0;

    for (let i = 0; i < this.n; i++) {
      // ghost fade animation (runs for everyone so off-screen residents are ready)
      if (this.fade[i] !== this.fadeTo[i]) {
        const t = (now - this.fadeStart[i]) / this.fadeDur[i];
        if (t >= 1) this.fade[i] = this.fadeTo[i];
        else if (t > 0) this.fade[i] = this.fadeFrom[i] + (this.fadeTo[i] - this.fadeFrom[i]) * easeInOutCubic(t);
      }
      if (this.dim[i] !== this.dimTarget[i]) {
        const k = 1 - Math.exp(-dt * 8);
        this.dim[i] += (this.dimTarget[i] - this.dim[i]) * k;
        if (Math.abs(this.dim[i] - this.dimTarget[i]) < 0.01) this.dim[i] = this.dimTarget[i];
      }
      const fade = i === this.forceSolid ? 0 : this.fade[i];
      const onScreen = this.x[i] > view.x0 && this.x[i] < view.x1 && this.y[i] > view.y0 && this.y[i] < view.y1;

      // movement: idle wandering only on screen (cheap), scripted walkers always
      if (this.state[i] === 2 || (onScreen && lodSprite > 0) || this.state[i] === 1) this.move(i, dt, onScreen);

      const s = this.sprites[i];
      const g = this.ghosts[i];
      const e = this.emotes[i];
      const d = this.dots[i];
      const st = this.stance[i];
      const stanceCol = st === NO_STANCE ? STANCE_NONE : STANCE[st + 2];

      // ---- dots (zoomed out)
      if (lodDot > 0 && onScreen) {
        if (!d.visible) d.visible = true;
        d.position.set(this.x[i], this.y[i] - 5);
        const ring = this.highlightRing[i] && fade < 0.5;
        const tex = ring ? this.dotTex[1] : this.dotTex[0];
        if (d.texture !== tex) d.texture = tex;
        const sc = (ring ? ringScale : dotScale) * (1 - 0.4 * fade) * (1 + 0.6 * this.popBoost(i, now));
        d.scale.set(sc);
        d.tint = fade > 0.02 ? mix(stanceCol, GHOST_GREY, fade) : stanceCol;
        d.alpha = lodDot * (1 - 0.72 * fade) * (1 - 0.6 * this.dim[i]);
        d.zIndex = ring ? 1 : 0;
      } else if (d.visible) d.visible = false;

      // ---- sprites + ghosts (zoomed in)
      if (lodSprite > 0 && onScreen) {
        const hop = this.hopOffset(i, now);
        const bob = this.state[i] === 0 && Math.sin(now / 520 + i * 1.7) > 0.72 ? -1 : 0;
        const yy = this.y[i] + bob - hop;
        const solidA = (1 - fade) * lodSprite * (1 - 0.62 * this.dim[i]);
        if (solidA > 0.01) {
          if (!s.visible) s.visible = true;
          s.position.set(this.x[i], yy);
          s.alpha = solidA;
          const frame = this.frameIndex(i, now);
          if (frame !== this.lastFrame[i]) {
            s.texture = this.atlas.frame(this.slots[i], frame);
            this.lastFrame[i] = frame;
          }
          const sx = this.dir[i] === DIR_LEFT ? -1 : 1;
          if (s.scale.x !== sx) s.scale.x = sx;
          const tint = this.dim[i] > 0.02 ? mix(0xffffff, 0xc3c7d6, this.dim[i]) : 0xffffff;
          if (s.tint !== tint) s.tint = tint;
          const z = Math.round(this.y[i]);
          if (z !== this.lastZ[i]) {
            s.zIndex = z;
            this.lastZ[i] = z;
          }
        } else if (s.visible) s.visible = false;
        if (fade > 0.01) {
          if (!g.visible) g.visible = true;
          const float = Math.sin(now / 700 + i) * 1.2;
          g.position.set(this.x[i], yy - fade * 3 + float);
          g.alpha = fade * 0.6 * lodSprite * (1 - 0.5 * this.dim[i]);
          g.zIndex = Math.round(this.y[i]);
        } else if (g.visible) g.visible = false;
        // ---- emote
        let emote = -1;
        if (this.emoteOverride[i] >= 0 && now < this.emoteOverrideUntil[i]) emote = this.emoteOverride[i];
        else if (this.thinking[i]) emote = 5 + this.thinkFrame;
        else if (emoteVis && st !== NO_STANCE) emote = st + 2;
        if (emote >= 0 && (emoteVis || this.emoteOverride[i] >= 0 || this.thinking[i]) && fade < 0.85) {
          if (!e.visible) e.visible = true;
          if (e.texture !== this.emoteTex[emote]) e.texture = this.emoteTex[emote];
          const p = this.popScale(i, now);
          e.scale.set(p);
          e.position.set(this.x[i], yy - 16 + (emote >= 5 && emote <= 7 ? 0 : Math.round(Math.sin(now / 600 + i) * 0.6)));
          const neutral = emote === 2 ? 0.6 : 1;
          e.alpha = (this.emoteOverride[i] >= 0 || this.thinking[i] ? 1 : emoteAlphaZoom * neutral) * (1 - fade) * (1 - 0.9 * this.dim[i]);
        } else if (e.visible) e.visible = false;
      } else {
        if (s.visible) s.visible = false;
        if (g.visible) g.visible = false;
        if (e.visible) e.visible = false;
      }
    }
    // emotes must be visible as a layer when there are temporary ones even if scenario emotes are off
    this.emoteLayer.visible = lodSprite > 0;
  }

  private popBoost(i: number, now: number): number {
    const t = (now - this.popStart[i]) / 320;
    if (t < 0 || t > 1) return 0;
    return Math.sin(t * Math.PI);
  }

  private popScale(i: number, now: number): number {
    const t = (now - this.popStart[i]) / 320;
    if (t < 0) return 0.01;
    if (t >= 1) return 1;
    return Math.max(0.01, easeOutBack(t));
  }

  private hopOffset(i: number, now: number): number {
    const t = (now - this.hopStart[i]) / 340;
    if (t < 0 || t > 1) return 0;
    return Math.round(Math.sin(t * Math.PI) * 4);
  }

  private frameIndex(i: number, now: number): number {
    const dir = this.dir[i];
    const base = dir === DIR_DOWN ? 0 : dir === DIR_UP ? 3 : 6;
    const walking = this.state[i] !== 0 && !this.arrived(i);
    if (!walking) return base;
    const cycle = Math.floor(this.walkT[i] * 7) % 4;
    return base + (cycle === 0 ? 1 : cycle === 2 ? 2 : 0);
  }

  private move(i: number, dt: number, onScreen: boolean): void {
    const st = this.state[i];
    if (st === 0) {
      this.timer[i] -= dt;
      if (this.timer[i] > 0) return;
      // choose a new stroll target: mostly along the sidewalk in front of home
      const r = rand2(i, Math.floor(this.time / 997), 13);
      let nx = this.homeX[i] + (r - 0.5) * 36;
      let ny = this.homeY[i];
      if (rand2(i, Math.floor(this.time / 991), 17) < 0.2) {
        // sometimes step into an open neighbouring tile (street, plaza, park, grass)
        const dx = Math.round((rand2(i, Math.floor(this.time / 983), 19) - 0.5) * 3);
        const dy = Math.round((rand2(i, Math.floor(this.time / 977), 23) - 0.5) * 3);
        const htx = Math.floor(this.homeX[i] / TS) + dx;
        const hty = Math.floor((this.homeY[i] - 1) / TS) + dy;
        if (isWalkable(this.tileAt(htx, hty))) {
          nx = htx * TS + 4 + rand2(i, 5, 29) * 8;
          ny = hty * TS + 15;
        }
      }
      const ttx = Math.floor(nx / TS);
      const tty = Math.floor((ny - 1) / TS);
      if (!isWalkable(this.tileAt(ttx, tty))) {
        nx = this.homeX[i];
        ny = this.homeY[i];
      }
      this.tx[i] = nx;
      this.ty[i] = ny;
      this.state[i] = 1;
      return;
    }
    const dx = this.tx[i] - this.x[i];
    const dy = this.ty[i] - this.y[i];
    const dist = Math.hypot(dx, dy);
    if (dist < 0.6) {
      this.x[i] = this.tx[i];
      this.y[i] = this.ty[i];
      if (st === 1) {
        this.state[i] = 0;
        this.timer[i] = 2.5 + rand2(i, Math.floor(this.time / 1009), 31) * 6;
        if (rand2(i, Math.floor(this.time / 1013), 37) < 0.6) this.dir[i] = DIR_DOWN;
      }
      return;
    }
    const sp = this.speed[i] * (st === 1 && !onScreen ? 4 : 1);
    const step = Math.min(dist, sp * dt);
    this.x[i] += (dx / dist) * step;
    this.y[i] += (dy / dist) * step;
    this.walkT[i] += dt;
    if (Math.abs(dx) > Math.abs(dy)) this.dir[i] = dx > 0 ? DIR_RIGHT : DIR_LEFT;
    else this.dir[i] = dy > 0 ? DIR_DOWN : DIR_UP;
  }

  destroy(): void {
    this.dotLayer.destroy({ children: true });
    this.ghostLayer.destroy({ children: true });
    this.spriteLayer.destroy({ children: true });
    this.emoteLayer.destroy({ children: true });
  }
}
