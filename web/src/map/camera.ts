/**
 * Camera: which part of the town is on screen.
 *  - x, y: world pixel at the centre of the screen; zoom: screen pixels per world pixel.
 *  - Drag to pan (with a little inertia), mouse wheel zooms around the cursor (smoothly),
 *    two-finger pinch on touch screens, arrow keys / WASD to pan, +/- to zoom.
 *  - flyTo(): animated glide (zooms out a bit on long trips), follow(): track a moving target.
 * The camera never lets you wander far away from the map.
 */
import { clamp, easeInOutCubic, lerp } from './util';

export interface CameraInput {
  onClick: (sx: number, sy: number) => void;
  onHover: (sx: number, sy: number) => void;
}

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  viewW = 800;
  viewH = 600;
  minZoom = 0.35;
  maxZoom = 4;
  /** True while the camera moved this frame (used to throttle label layout). */
  moved = true;
  /** Screen pixels covered by UI on each side (phones: top bar and bottom board). */
  insets = { top: 0, right: 0, bottom: 0, left: 0 };

  private targetZoom = 1;
  private anchor: { sx: number; sy: number; wx: number; wy: number } | null = null;
  private fly: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t: number; dur: number; bump: number } | null = null;
  private followFn: (() => { x: number; y: number } | null) | null = null;
  private vx = 0;
  private vy = 0;
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number }>();
  /** Where the pointer went down; `stopsGlide`: that press caught the map mid-glide, so it is not a click. */
  private downAt: { x: number; y: number; t: number; stopsGlide: boolean } | null = null;
  private dragging = false;
  private pinchDist = 0;
  private lastMove = { x: 0, y: 0, t: 0 };
  private cleanup: (() => void)[] = [];

  constructor(
    private worldW: number,
    private worldH: number,
  ) {
    this.x = worldW / 2;
    this.y = worldH / 2;
  }

  resize(w: number, h: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.minZoom = Math.min(0.35, this.fitZoom() * 0.92);
    this.zoom = clamp(this.zoom, this.minZoom, this.maxZoom);
    this.targetZoom = clamp(this.targetZoom, this.minZoom, this.maxZoom);
    this.moved = true;
  }

  /** Zoom at which the whole map fits on screen. */
  fitZoom(): number {
    return Math.min(this.viewW / this.worldW, this.viewH / this.worldH);
  }

  setInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
    this.insets = { ...insets };
    this.moved = true;
  }

  /** Size of the part of the screen the UI leaves visible, in screen pixels. */
  visibleSize(): { w: number; h: number } {
    const { top, right, bottom, left } = this.insets;
    return { w: Math.max(1, this.viewW - left - right), h: Math.max(1, this.viewH - top - bottom) };
  }

  /** Smallest zoom at which the map fills the visible part of the screen (no empty band). */
  coverZoom(): number {
    const v = this.visibleSize();
    return Math.max(v.w / this.worldW, v.h / this.worldH);
  }

  /** Camera centre that puts world point (wx, wy) in the middle of the visible part, at `zoom`. */
  centreFor(wx: number, wy: number, zoom: number): { x: number; y: number } {
    const { top, right, bottom, left } = this.insets;
    return { x: wx - (left - right) / 2 / zoom, y: wy - (top - bottom) / 2 / zoom };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.x + (sx - this.viewW / 2) / this.zoom, y: this.y + (sy - this.viewH / 2) / this.zoom };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.viewW / 2, y: (wy - this.y) * this.zoom + this.viewH / 2 };
  }

  /** Visible world rectangle (with an optional margin in world px). */
  viewRect(margin = 0): { x0: number; y0: number; x1: number; y1: number } {
    const hw = this.viewW / 2 / this.zoom + margin;
    const hh = this.viewH / 2 / this.zoom + margin;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }

  /** Glide to a world point. zoom undefined = keep the current zoom. */
  flyTo(wx: number, wy: number, zoom?: number, animate = true): void {
    const z1 = clamp(zoom ?? this.targetZoom, this.minZoom, this.maxZoom);
    this.anchor = null;
    this.vx = this.vy = 0;
    if (!animate) {
      this.fly = null;
      this.x = wx;
      this.y = wy;
      this.zoom = this.targetZoom = z1;
      this.clampToMap();
      this.moved = true;
      return;
    }
    const distScreen = Math.hypot(wx - this.x, wy - this.y) * Math.min(this.zoom, z1);
    const dur = clamp(650 + distScreen * 0.35, 700, 1500);
    const bump = clamp(distScreen / (Math.max(this.viewW, this.viewH) * 2.2), 0, 0.45);
    this.fly = { x0: this.x, y0: this.y, z0: this.zoom, x1: wx, y1: wy, z1, t: 0, dur, bump };
    this.targetZoom = z1;
  }

  follow(fn: (() => { x: number; y: number } | null) | null): void {
    this.followFn = fn;
  }

  isFlying(): boolean {
    return this.fly !== null;
  }

  update(dtMs: number): void {
    const dt = Math.min(dtMs, 50) / 1000;
    const before = { x: this.x, y: this.y, z: this.zoom };
    if (this.fly) {
      const f = this.fly;
      f.t += dtMs;
      const t = clamp(f.t / f.dur, 0, 1);
      const e = easeInOutCubic(t);
      this.x = lerp(f.x0, f.x1, e);
      this.y = lerp(f.y0, f.y1, e);
      const z = Math.exp(lerp(Math.log(f.z0), Math.log(f.z1), e));
      this.zoom = z * (1 - f.bump * Math.sin(Math.PI * t));
      if (t >= 1) {
        this.fly = null;
        this.zoom = f.z1;
      }
    } else {
      // smooth wheel zoom around the cursor
      if (Math.abs(this.zoom - this.targetZoom) > 1e-4) {
        const k = 1 - Math.exp(-dt * 14);
        this.zoom = Math.exp(lerp(Math.log(this.zoom), Math.log(this.targetZoom), k));
        if (Math.abs(this.zoom - this.targetZoom) < 1e-3) this.zoom = this.targetZoom;
        if (this.anchor) {
          this.x = this.anchor.wx - (this.anchor.sx - this.viewW / 2) / this.zoom;
          this.y = this.anchor.wy - (this.anchor.sy - this.viewH / 2) / this.zoom;
        }
      } else this.anchor = null;
      // keyboard panning
      let kx = 0;
      let ky = 0;
      if (this.keys.has('ArrowLeft') || this.keys.has('a')) kx -= 1;
      if (this.keys.has('ArrowRight') || this.keys.has('d')) kx += 1;
      if (this.keys.has('ArrowUp') || this.keys.has('w')) ky -= 1;
      if (this.keys.has('ArrowDown') || this.keys.has('s')) ky += 1;
      if (kx || ky) {
        this.followFn = null;
        this.x += (kx * 650 * dt) / this.zoom;
        this.y += (ky * 650 * dt) / this.zoom;
      }
      // inertia after a drag
      if (!this.dragging && (Math.abs(this.vx) > 0.01 || Math.abs(this.vy) > 0.01)) {
        this.x -= (this.vx * dtMs) / this.zoom;
        this.y -= (this.vy * dtMs) / this.zoom;
        const decay = Math.exp(-dt * 6);
        this.vx *= decay;
        this.vy *= decay;
      }
      // follow a target (selected resident)
      if (this.followFn && !this.dragging) {
        const p = this.followFn();
        if (p) {
          const k = 1 - Math.exp(-dt * 5);
          this.x = lerp(this.x, p.x, k);
          this.y = lerp(this.y, p.y, k);
        }
      }
    }
    this.clampToMap();
    this.moved = Math.abs(before.x - this.x) > 0.01 || Math.abs(before.y - this.y) > 0.01 || Math.abs(before.z - this.zoom) > 1e-4;
  }

  /** Keep the map in the visible part of the screen (the whole screen when there are no insets). */
  private clampToMap(): void {
    const v = this.visibleSize();
    const hw = v.w / 2 / this.zoom;
    const hh = v.h / 2 / this.zoom;
    // Centre of the visible part, in world pixels.
    const off = this.centreFor(0, 0, this.zoom);
    let cx = this.x - off.x;
    let cy = this.y - off.y;
    const marginX = hw * 0.25;
    const marginY = hh * 0.25;
    if (hw * 2 >= this.worldW) cx = this.worldW / 2;
    else cx = clamp(cx, hw - marginX, this.worldW - hw + marginX);
    if (hh * 2 >= this.worldH) cy = this.worldH / 2;
    else cy = clamp(cy, hh - marginY, this.worldH - hh + marginY);
    this.x = cx + off.x;
    this.y = cy + off.y;
  }

  // ------------------------------------------------------------ input

  attach(canvas: HTMLCanvasElement, input: CameraInput): void {
    const rect = () => canvas.getBoundingClientRect();
    const local = (e: PointerEvent | WheelEvent) => {
      const r = rect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      canvas.setPointerCapture?.(e.pointerId);
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) {
        this.downAt = { ...p, t: performance.now(), stopsGlide: Math.hypot(this.vx, this.vy) > 0.03 };
        this.dragging = false;
        this.vx = this.vy = 0;
        this.lastMove = { ...p, t: performance.now() };
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        this.dragging = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (!this.pointers.has(e.pointerId)) {
        input.onHover(p.x, p.y);
        return;
      }
      const prev = this.pointers.get(e.pointerId)!;
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) {
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          this.zoomAt(mid.x, mid.y, d / this.pinchDist, true);
        }
        this.pinchDist = d;
        return;
      }
      if (!this.downAt) return;
      if (!this.dragging && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > 5) {
        this.dragging = true;
        this.fly = null;
        this.followFn = null;
        this.anchor = null;
        canvas.style.cursor = 'grabbing';
      }
      if (this.dragging) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        this.x -= dx / this.zoom;
        this.y -= dy / this.zoom;
        const now = performance.now();
        const dtm = Math.max(1, now - this.lastMove.t);
        this.vx = lerp(this.vx, dx / dtm, 0.5);
        this.vy = lerp(this.vy, dy / dtm, 0.5);
        this.lastMove = { ...p, t: now };
        this.moved = true;
      }
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      const wasDrag = this.dragging;
      this.pointers.delete(e.pointerId);
      canvas.releasePointerCapture?.(e.pointerId);
      if (this.pointers.size > 0) return;
      if (!wasDrag && this.downAt && !this.downAt.stopsGlide && e.type !== 'pointercancel') input.onClick(p.x, p.y);
      if (performance.now() - this.lastMove.t > 80) this.vx = this.vy = 0;
      this.downAt = null;
      this.dragging = false;
      canvas.style.cursor = '';
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAt(p.x, p.y, Math.exp(-delta * 0.0018), false);
    };
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd'].includes(k)) {
        this.keys.add(k);
        this.fly = null;
        if (k.startsWith('Arrow')) e.preventDefault();
      } else if (k === '+' || k === '=') this.zoomAt(this.viewW / 2, this.viewH / 2, 1.35, false);
      else if (k === '-' || k === '_') this.zoomAt(this.viewW / 2, this.viewH / 2, 1 / 1.35, false);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
    };
    const onBlur = () => this.keys.clear();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    canvas.style.touchAction = 'none';
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    });
  }

  /** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number, immediate: boolean): void {
    this.fly = null;
    const w = this.screenToWorld(sx, sy);
    const base = immediate ? this.zoom : this.targetZoom;
    this.targetZoom = clamp(base * factor, this.minZoom, this.maxZoom);
    if (immediate) {
      this.zoom = this.targetZoom;
      this.x = w.x - (sx - this.viewW / 2) / this.zoom;
      this.y = w.y - (sy - this.viewH / 2) / this.zoom;
      this.anchor = null;
    } else {
      // keep the anchor from the first wheel tick while the smooth zoom is running
      if (!this.anchor || Math.abs(this.anchor.sx - sx) > 2 || Math.abs(this.anchor.sy - sy) > 2) this.anchor = { sx, sy, wx: w.x, wy: w.y };
    }
    this.moved = true;
  }

  detach(): void {
    for (const c of this.cleanup) c();
    this.cleanup = [];
  }
}
