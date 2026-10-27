/**
 * A deliberately simple 2D-canvas town map that implements ITownMap.
 * Used only while the real PixiJS renderer (web/src/map) is not available, or with ?map=stub.
 * Coloured tiles + dots: enough to develop and test the UI, not the final look.
 */
import type { ITownMap, Overlay, TownMapEvents } from '../../mapApi';
import type { Conversation, MapFile, PopulationFile, ResidentResult, Scenario, ViewMode } from '../../types';

const TILE_COLORS: Record<string, string> = {
  outside: '#d9c9a3',
  water: '#5c9fd0',
  grass: '#a5c86f',
  park: '#86b85a',
  forest: '#4f8a3f',
  plaza: '#e6d3ad',
  haussmann: '#d6bf95',
  suburb_house: '#d9a57a',
  suburb_tower: '#bdb5a6',
  industrial: '#aaa092',
  ring_road: '#7d7469',
  rail: '#8c705a',
  street: '#efe3c6',
};

const STANCE_COLORS: Record<string, string> = { support: '#2F6FA8', oppose: '#C4562A', neutral: '#8F8574', none: '#5A3A22' };
const BASE_PX = 4; // pixels per tile in the pre-rendered base layer

type Listener = { [K in keyof TownMapEvents]: Set<TownMapEvents[K]> };

interface Bubble {
  text: string;
  until: number;
}

function sideColor(stance: number | undefined): string {
  if (stance === undefined) return STANCE_COLORS.none;
  if (stance >= 1) return STANCE_COLORS.support;
  if (stance <= -1) return STANCE_COLORS.oppose;
  return STANCE_COLORS.neutral;
}

/** Blend orange (0) -> grey (0.5) -> blue (1) for yes-share overlays. */
function divergingColor(v: number): [number, number, number] {
  const a = [196, 86, 42];
  const m = [214, 204, 186];
  const b = [47, 111, 168];
  const t = Math.max(0, Math.min(1, v));
  const [from, to, k] = t < 0.5 ? [a, m, t / 0.5] : [m, b, (t - 0.5) / 0.5];
  return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * k)) as [number, number, number];
}

function sequentialColor(v: number): [number, number, number] {
  const a = [246, 231, 196];
  const b = [110, 52, 20];
  const t = Math.max(0, Math.min(1, v / 3));
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as [number, number, number];
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class StubTownMap implements ITownMap {
  private host: HTMLElement | null = null;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private base = document.createElement('canvas');
  private overlayLayer = document.createElement('canvas');
  private map!: MapFile;
  private pop!: PopulationFile;
  private resultById = new Map<number, ResidentResult>();
  private scenario: Scenario | null = null;
  private view: ViewMode = 'everyone';
  private afterTalk = false;
  private overlay: Overlay = 'none';
  private group: string | null = null;
  private selected: number | null = null;
  private bubbles = new Map<number, Bubble>();
  private thinking = new Set<number>();
  private revealed = new Map<number, number>();
  private pickMode: 'none' | 'districts' | 'site' = 'none';
  private picked = new Set<number>();
  private customSite: { x: number; y: number; ringsTiles: number[]; label?: string } | null = null;
  private talking = new Set<number>();
  private listeners: Listener = { residentClick: new Set(), districtClick: new Set(), tileClick: new Set() };
  private cam = { x: 132, y: 100, z: 4 };
  private camAnim: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; t0: number; ms: number } | null = null;
  private fade = { from: new Map<number, number>(), t0: 0 };
  private raf = 0;
  private resizeObs: ResizeObserver | null = null;
  private jitter = new Map<number, [number, number]>();
  private residentById = new Map<number, PopulationFile['residents'][number]>();
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private cleanup: (() => void)[] = [];

  async mount(el: HTMLElement, map: MapFile, population: PopulationFile): Promise<void> {
    this.host = el;
    this.map = map;
    this.pop = population;
    this.canvas.className = 'stub-map-canvas';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none';
    el.appendChild(this.canvas);
    for (const r of population.residents) {
      const h = (r.id * 2654435761) >>> 0;
      this.jitter.set(r.id, [((h & 0xff) / 255) * 0.8 + 0.1, (((h >> 8) & 0xff) / 255) * 0.8 + 0.1]);
      this.residentById.set(r.id, r);
    }
    this.renderBase();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(el);
    this.resize();
    this.fitAll();
    this.bindInput();
    // Pretend texture generation takes a moment, so the loading screen is visible in dev.
    await new Promise((r) => setTimeout(r, 150));
    this.requestDraw();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    for (const off of this.cleanup) off();
    this.canvas.remove();
    this.host = null;
  }

  // ---------- state setters ----------

  setScenario(s: Scenario | null): void {
    this.scenario = s;
    this.resultById = new Map((s?.results ?? []).map((r) => [r.id, r]));
    this.revealed.clear();
    this.thinking.clear();
    this.startFade();
  }

  setViewMode(m: ViewMode): void {
    if (m === this.view) return;
    this.startFade();
    this.view = m;
  }

  setAfterTalk(on: boolean): void {
    this.afterTalk = on;
    this.requestDraw();
  }

  setOverlay(o: Overlay, values?: Record<number, number>): void {
    this.overlay = o;
    const W = this.map.width;
    const H = this.map.height;
    this.overlayLayer.width = W;
    this.overlayLayer.height = H;
    const octx = this.overlayLayer.getContext('2d')!;
    const img = octx.createImageData(W, H);
    if (o !== 'none' && o !== 'districts' && values) {
      for (let i = 0; i < W * H; i++) {
        const d = this.map.districts[i];
        const v = d ? values[d] : undefined;
        if (v === undefined) continue;
        const [r, g, b] = o === 'exposure' ? sequentialColor(v) : divergingColor(v);
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = g;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = 150;
      }
    }
    octx.putImageData(img, 0, 0);
    this.requestDraw();
  }

  highlightGroup(groupId: string | null): void {
    this.group = groupId;
    this.startFade();
  }

  selectResident(id: number | null, opts?: { bubbleText?: string }): void {
    this.selected = id;
    if (id !== null) {
      const r = this.residentById.get(id);
      if (r) this.focus(r.home[0] + 0.5, r.home[1] + 0.5, Math.max(this.cam.z, 9) / (this.map.tilePx || 16), true);
      if (opts?.bubbleText) this.say(id, opts.bubbleText, 7000);
    }
    this.requestDraw();
  }

  say(id: number, text: string, ms = 6000): void {
    this.bubbles.set(id, { text, until: performance.now() + ms });
    this.requestDraw();
  }

  async playConversation(c: Conversation, opts?: { lang?: 'en' | 'fr'; lineMs?: number }): Promise<void> {
    const lineMs = opts?.lineMs ?? 2600;
    this.talking = new Set([c.a, c.b]);
    this.focus(c.where[0] + 0.5, c.where[1] + 0.5, Math.max(this.cam.z, 10) / (this.map.tilePx || 16), true);
    for (const line of c.lines) {
      this.say(line.speaker, opts?.lang === 'fr' ? line.fr : line.en, lineMs);
      await new Promise((r) => setTimeout(r, lineMs));
    }
    this.talking.clear();
    this.requestDraw();
  }

  setAmbientConversations(_on: boolean): void {
    // The stub has no ambient animations.
  }

  /** zoom follows the renderer's convention: 1 = native tile size (map.tilePx pixels per tile). */
  focus(x: number, y: number, zoom?: number, animate = true): void {
    const to = { x, y, z: zoom !== undefined ? zoom * (this.map.tilePx || 16) : this.cam.z };
    if (!animate) {
      this.cam = to;
      this.camAnim = null;
    } else this.camAnim = { from: { ...this.cam }, to, t0: performance.now(), ms: 650 };
    this.requestDraw();
  }

  focusDistrict(districtIdx: number): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const W = this.map.width;
    for (let i = 0; i < this.map.districts.length; i++) {
      if (this.map.districts[i] !== districtIdx) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) return;
    const { w, h } = this.size();
    const z = Math.min(w / (maxX - minX + 12), h / (maxY - minY + 12), 18);
    this.focus((minX + maxX + 1) / 2, (minY + maxY + 1) / 2, z / (this.map.tilePx || 16), true);
  }

  fitAll(): void {
    const { w, h } = this.size();
    const z = Math.min(w / this.map.width, h / this.map.height) * 1.05;
    this.focus(this.map.width / 2, this.map.height / 2, z / (this.map.tilePx || 16), false);
  }

  setPickMode(mode: 'none' | 'districts' | 'site'): void {
    this.pickMode = mode;
    this.canvas.style.cursor = mode === 'none' ? 'grab' : 'crosshair';
  }

  setPickedDistricts(idxs: number[]): void {
    this.picked = new Set(idxs);
    this.requestDraw();
  }

  setCustomSite(site: { x: number; y: number; ringsTiles: number[]; label?: string } | null): void {
    this.customSite = site;
    this.requestDraw();
  }

  setThinking(ids: number[]): void {
    for (const id of ids) this.thinking.add(id);
    this.requestDraw();
  }

  revealResult(id: number, stance: number): void {
    this.thinking.delete(id);
    this.revealed.set(id, stance);
    this.requestDraw();
  }

  on<K extends keyof TownMapEvents>(ev: K, cb: TownMapEvents[K]): () => void {
    (this.listeners[ev] as Set<TownMapEvents[K]>).add(cb);
    return () => (this.listeners[ev] as Set<TownMapEvents[K]>).delete(cb);
  }

  // ---------- internals ----------

  private size() {
    const r = this.host?.getBoundingClientRect();
    return { w: Math.max(1, r?.width ?? 800), h: Math.max(1, r?.height ?? 600) };
  }

  private resize() {
    const { w, h } = this.size();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.requestDraw();
  }

  private renderBase() {
    const { width: W, height: H, tiles, tileTypes } = this.map;
    this.base.width = W * BASE_PX;
    this.base.height = H * BASE_PX;
    const b = this.base.getContext('2d')!;
    for (let i = 0; i < W * H; i++) {
      const type = tileTypes[tiles[i]] ?? 'outside';
      b.fillStyle = TILE_COLORS[type] ?? '#ccc';
      const x = (i % W) * BASE_PX;
      const y = Math.floor(i / W) * BASE_PX;
      b.fillRect(x, y, BASE_PX, BASE_PX);
      if (type === 'haussmann' || type === 'suburb_house' || type === 'suburb_tower') {
        b.fillStyle = 'rgba(80,50,30,0.18)';
        b.fillRect(x, y + BASE_PX - 1, BASE_PX, 1);
      }
    }
    // District borders
    b.fillStyle = 'rgba(59,35,19,0.35)';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = this.map.districts[y * W + x];
        if (x + 1 < W && this.map.districts[y * W + x + 1] !== d) b.fillRect((x + 1) * BASE_PX - 1, y * BASE_PX, 1, BASE_PX);
        if (y + 1 < H && this.map.districts[(y + 1) * W + x] !== d) b.fillRect(x * BASE_PX, (y + 1) * BASE_PX - 1, BASE_PX, 1);
      }
    }
  }

  private bindInput() {
    const c = this.canvas;
    const down = (e: PointerEvent) => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      c.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.camAnim = null;
        this.cam.x = this.drag.cx - dx / this.cam.z;
        this.cam.y = this.drag.cy - dy / this.cam.z;
        c.style.cursor = 'grabbing';
        this.requestDraw();
      }
    };
    const up = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = null;
      c.style.cursor = this.pickMode === 'none' ? 'grab' : 'crosshair';
      if (d && !d.moved) this.handleClick(e);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const before = this.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      this.camAnim = null;
      this.cam.z = Math.max(1.5, Math.min(40, this.cam.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const after = this.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      this.cam.x += before[0] - after[0];
      this.cam.y += before[1] - after[1];
      this.requestDraw();
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('wheel', wheel, { passive: false });
    this.cleanup.push(() => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('wheel', wheel);
    });
  }

  private screenToTile(sx: number, sy: number): [number, number] {
    const { w, h } = this.size();
    return [this.cam.x + (sx - w / 2) / this.cam.z, this.cam.y + (sy - h / 2) / this.cam.z];
  }

  private tileToScreen(tx: number, ty: number): [number, number] {
    const { w, h } = this.size();
    return [(tx - this.cam.x) * this.cam.z + w / 2, (ty - this.cam.y) * this.cam.z + h / 2];
  }

  private residentPos(id: number): [number, number] {
    const r = this.residentById.get(id)!;
    const j = this.jitter.get(id) ?? [0.5, 0.5];
    return [r.home[0] + j[0], r.home[1] + j[1]];
  }

  private handleClick(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [tx, ty] = this.screenToTile(sx, sy);
    const x = Math.floor(tx);
    const y = Math.floor(ty);
    if (this.pickMode === 'none') {
      // Nearest visible resident within 10 screen pixels
      let best = -1;
      let bestD = 10;
      for (const r of this.pop.residents) {
        if (this.alphaOf(r.id) < 0.3) continue;
        const [px, py] = this.tileToScreen(...this.residentPos(r.id));
        const d = Math.hypot(px - sx, py - sy);
        if (d < bestD) {
          bestD = d;
          best = r.id;
        }
      }
      if (best >= 0) {
        for (const cb of this.listeners.residentClick) cb(best);
        return;
      }
    }
    if (x >= 0 && y >= 0 && x < this.map.width && y < this.map.height) {
      const d = this.map.districts[y * this.map.width + x];
      if (d) for (const cb of this.listeners.districtClick) cb(d);
      for (const cb of this.listeners.tileClick) cb(x, y);
    }
  }

  private targetAlpha(id: number): number {
    const r = this.residentById.get(id)!;
    const res = this.resultById.get(id);
    if (this.group && !r.groupIds.includes(this.group)) return 0.12;
    if (!this.scenario) return 1;
    if (!res) return this.scenario.kind === 'custom' ? 0.15 : 1;
    if (this.view === 'eligible' && !res.eligible) return 0.15;
    if (this.view === 'attendees' && !res.attendee) return 0.12;
    return 1;
  }

  private alphaOf(id: number): number {
    const to = this.targetAlpha(id);
    const t = Math.min(1, (performance.now() - this.fade.t0) / 450);
    const from = this.fade.from.get(id) ?? to;
    return from + (to - from) * ease(t);
  }

  private startFade() {
    const from = new Map<number, number>();
    if (this.pop) for (const r of this.pop.residents) from.set(r.id, this.alphaOf(r.id));
    this.fade = { from, t0: performance.now() };
    this.requestDraw();
  }

  private requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw() {
    if (!this.host) return;
    const now = performance.now();
    let animating = false;
    if (this.camAnim) {
      const t = Math.min(1, (now - this.camAnim.t0) / this.camAnim.ms);
      const k = ease(t);
      const { from, to } = this.camAnim;
      this.cam = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k };
      if (t >= 1) this.camAnim = null;
      else animating = true;
    }
    if (now - this.fade.t0 < 500) animating = true;

    const ctx = this.ctx;
    const dpr = this.canvas.width / this.size().w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { w, h } = this.size();
    ctx.fillStyle = '#cdb98e';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    const [ox, oy] = this.tileToScreen(0, 0);
    const z = this.cam.z;
    ctx.drawImage(this.base, ox, oy, this.map.width * z, this.map.height * z);
    if (this.overlay !== 'none' && this.overlay !== 'districts') {
      ctx.drawImage(this.overlayLayer, ox, oy, this.map.width * z, this.map.height * z);
    }

    // Picked districts (custom proposal)
    if (this.picked.size) {
      ctx.fillStyle = 'rgba(227,167,47,0.45)';
      const W = this.map.width;
      for (let i = 0; i < this.map.districts.length; i++) {
        if (!this.picked.has(this.map.districts[i])) continue;
        const [sx, sy] = this.tileToScreen(i % W, Math.floor(i / W));
        ctx.fillRect(sx, sy, z + 0.5, z + 0.5);
      }
    }

    // Labels (arrondissements always, suburbs when zoomed in)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of this.map.districtList) {
      if (d.kind === 'commune' && z < 5) continue;
      const [sx, sy] = this.tileToScreen(d.labelPos[0] + 0.5, d.labelPos[1] + 0.5);
      if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) continue;
      ctx.font = `600 ${d.kind === 'arrondissement' ? 13 : 11}px "Pixelify Sans", sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(246,231,196,0.85)';
      ctx.strokeText(d.name, sx, sy);
      ctx.fillStyle = '#3B2313';
      ctx.fillText(d.name, sx, sy);
    }

    // Scenario site / custom site with rings
    const site = this.scenario?.site ?? null;
    const drawSite = (s: { x: number; y: number; ringsTiles: number[] }, color: string) => {
      const [sx, sy] = this.tileToScreen(s.x + 0.5, s.y + 0.5);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      for (const r of s.ringsTiles) {
        ctx.beginPath();
        ctx.arc(sx, sy, r * z, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const size = Math.max(8, z * 2);
      ctx.fillStyle = '#3B2313';
      ctx.fillRect(sx - size / 2 - 2, sy - size / 2 - 2, size + 4, size + 4);
      ctx.fillStyle = '#9fb3c8';
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    };
    if (site) drawSite(site, 'rgba(59,35,19,0.8)');
    if (this.customSite) drawSite(this.customSite, 'rgba(160,90,10,0.95)');

    // Residents
    const r0 = Math.max(1.6, Math.min(5, z * 0.32));
    const t = now / 1000;
    for (const r of this.pop.residents) {
      const a = this.alphaOf(r.id);
      const res = this.resultById.get(r.id);
      const revealed = this.revealed.get(r.id);
      const stance = revealed ?? (res ? (this.afterTalk && res.stanceAfter !== undefined ? res.stanceAfter : res.stance) : undefined);
      const [sx, sy] = this.tileToScreen(...this.residentPos(r.id));
      if (sx < -10 || sy < -10 || sx > w + 10 || sy > h + 10) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = this.scenario ? sideColor(stance) : STANCE_COLORS.none;
      const rr = this.thinking.has(r.id) ? r0 * (1 + 0.25 * Math.sin(t * 6 + r.id)) : r0;
      ctx.fillRect(sx - rr, sy - rr, rr * 2, rr * 2);
      if (this.thinking.has(r.id)) animating = true;
    }
    ctx.globalAlpha = 1;

    // Selected resident: home, work, commute line, exposure markers
    const sel = this.selected !== null ? this.residentById.get(this.selected) : undefined;
    if (sel) {
      const r = sel;
      const [hx, hy] = this.tileToScreen(...this.residentPos(r.id));
      if (r.work) {
        const [wx, wy] = this.tileToScreen(r.work[0] + 0.5, r.work[1] + 0.5);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#3B2313';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(wx, wy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#3B2313';
        ctx.fillRect(wx - 6, wy - 6, 12, 12);
        ctx.fillStyle = '#E3A72F';
        ctx.fillRect(wx - 4, wy - 4, 8, 8);
      }
      const res = this.resultById.get(r.id);
      for (const reason of res?.exposure.reasons ?? []) {
        for (const at of reason.at ?? []) {
          const [ex, ey] = this.tileToScreen(at[0] + 0.5, at[1] + 0.5);
          ctx.fillStyle = '#C4562A';
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - 6, ey - 12);
          ctx.lineTo(ex + 6, ey - 12);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.strokeStyle = '#E3A72F';
      ctx.lineWidth = 3;
      ctx.strokeRect(hx - r0 - 5, hy - r0 - 5, r0 * 2 + 10, r0 * 2 + 10);
    }

    // Talking pair highlight
    for (const id of this.talking) {
      const [sx, sy] = this.tileToScreen(...this.residentPos(id));
      ctx.strokeStyle = '#3B2313';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - r0 - 4, sy - r0 - 4, r0 * 2 + 8, r0 * 2 + 8);
    }

    // Thinking dots and speech bubbles
    ctx.font = '600 13px Nunito, sans-serif';
    for (const id of this.thinking) {
      const [sx, sy] = this.tileToScreen(...this.residentPos(id));
      if (z >= 3) this.drawBubble(sx, sy - r0 - 4, '.'.repeat(1 + (Math.floor(t * 3 + id) % 3)), 60);
    }
    for (const [id, b] of this.bubbles) {
      if (b.until < now) {
        this.bubbles.delete(id);
        continue;
      }
      animating = true;
      const [sx, sy] = this.tileToScreen(...this.residentPos(id));
      this.drawBubble(sx, sy - r0 - 6, b.text, 230);
    }

    if (animating) this.requestDraw();
    else if (this.bubbles.size) setTimeout(() => this.requestDraw(), 250);
  }

  private drawBubble(x: number, y: number, text: string, maxW: number) {
    const ctx = this.ctx;
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, 4);
    if (lines.length > 4) shown[3] = `${shown[3]}…`;
    const lh = 17;
    const bw = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l).width))) + 16;
    const bh = shown.length * lh + 10;
    const bx = Math.round(x - bw / 2);
    const by = Math.round(y - bh - 8);
    ctx.fillStyle = '#3B2313';
    ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    ctx.fillStyle = '#FBF3DE';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#3B2313';
    ctx.fillRect(Math.round(x) - 4, by + bh + 2, 8, 3);
    ctx.fillRect(Math.round(x) - 2, by + bh + 5, 4, 3);
    ctx.fillStyle = '#2A1A0E';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    shown.forEach((l, i) => ctx.fillText(l, bx + 8, by + 6 + i * lh));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }
}
