/**
 * Town renderer (PixiJS 8): the cozy pixel-art map of Paris and its inner suburbs.
 * Implements ITownMap from ../mapApi.ts -- the UI talks to the map ONLY through that interface.
 *
 * Layer order (bottom to top), all inside one camera-transformed "world" container:
 *   ground chunks -> water shimmer -> overlays (choropleth, borders, zones, rings)
 *   -> scenario sites -> selection (commute path, ring) -> ghosts -> villagers -> dots
 *   -> emotes -> selection pins/badges
 * Screen-space layers on top: signposts/labels, speech bubbles.
 */
import { Application, Container, Sprite, type Texture } from 'pixi.js';
import type { ITownMap, Overlay, TownMapEvents } from '../mapApi';
import type { Conversation, MapFile, PopulationFile, Resident, ResidentResult, Scenario, ViewMode } from '../types';
import config from '../../shared/config.json';
import { Camera } from './camera';
import { BubbleLayer } from './bubbles';
import { makeBadges, makeBubbleParts, makeDots, makeEmotes, makePin, makeSelectRing, makeShimmer, makeSigns } from './icons';
import { LabelLayer, type LabelSpec } from './labels';
import { DistrictGrid, OverlayLayer, divergingColour, exposureColour } from './overlays';
import { P } from './palette';
import { ResidentLayer } from './residents';
import { SelectionLayer } from './selection';
import { Terrain } from './terrain';
import { TS, TT, tileTypeTable } from './terrainTypes';
import { canvasTexture } from './textures';
import { clamp, nextFrame, rand2 } from './util';
import { DIR_LEFT, DIR_RIGHT, VillagerAtlas } from './villagers';

export { renderPortrait } from './villagers';

const CHUNK = 32;

export function createTownMap(): ITownMap {
  return new TownMap();
}

type Listeners = { [K in keyof TownMapEvents]: Set<TownMapEvents[K]> };

class TownMap implements ITownMap {
  private app: Application | null = null;
  private el: HTMLElement | null = null;
  private map!: MapFile;
  private pop!: PopulationFile;
  private tiles!: Uint8Array;
  private terrain!: Terrain;
  private grid!: DistrictGrid;
  private cam!: Camera;
  private world = new Container({ isRenderGroup: true });
  private groundLayer = new Container();
  private shimmerLayer = new Container();
  private residents!: ResidentLayer;
  private overlays!: OverlayLayer;
  private selection!: SelectionLayer;
  private labels!: LabelLayer;
  private bubbles!: BubbleLayer;
  private atlas = new VillagerAtlas();
  private chunks: { s: Sprite; x0: number; y0: number; x1: number; y1: number }[] = [];
  private shimmer: { s: Sprite; v: number; ph: number }[] = [];
  private shimmerTex: Texture[][] = [];
  private shimmerFrame = 0;
  private shimmerClock = 0;
  private listeners: Listeners = { residentClick: new Set(), districtClick: new Set(), tileClick: new Set() };
  private residentById = new Map<number, Resident>();
  private scenario: Scenario | null = null;
  private results = new Map<number, ResidentResult>();
  private stanceOverride = new Map<number, number>();
  private fallbackAttendee = new Set<number>();
  private viewMode: ViewMode = 'everyone';
  private afterTalk = false;
  private groupId: string | null = null;
  private selectedId: number | null = null;
  private pickMode: 'none' | 'districts' | 'site' = 'none';
  private picked: number[] = [];
  private overlayMode: Overlay = 'none';
  private overlayValues: Record<number, number> | undefined;
  private ambient = false;
  private ambientClock = 0;
  private ambientPairs: { a: number; b: number; until: number; next: number; turn: number }[] = [];
  private convToken = 0;
  private convBusy = new Set<number>();
  /** Resident ids of the pair currently talking in playConversation (others are dimmed). */
  private convPair: number[] = [];
  private time = 0;
  private hoverClock = 0;
  private pendingHover: { x: number; y: number } | null = null;
  private resizeObs: ResizeObserver | null = null;
  private destroyed = false;
  private tickFn = () => this.tick();
  /** Calls made before mount() finished (e.g. by React effects): replayed in order once ready. */
  private pending: (() => void)[] = [];

  /** Run now if the map is ready, otherwise remember the call for later. */
  private whenReady(fn: () => void): boolean {
    if (this.ready) return true;
    if (!this.destroyed) this.pending.push(fn);
    return false;
  }

  // =========================================================== lifecycle

  async mount(el: HTMLElement, map: MapFile, population: PopulationFile): Promise<void> {
    try {
      await this.mountInner(el, map, population);
    } catch (err) {
      // leave the element clean so the UI can fall back to its simple map
      this.destroy();
      throw err;
    }
  }

  private async mountInner(el: HTMLElement, map: MapFile, population: PopulationFile): Promise<void> {
    this.el = el;
    this.map = map;
    this.pop = population;
    for (const r of population.residents) this.residentById.set(r.id, r);

    const app = new Application();
    await app.init({
      resizeTo: el,
      antialias: false,
      roundPixels: true,
      background: P.bg,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      autoDensity: true,
      preference: 'webgl',
    });
    if (this.destroyed) {
      app.destroy({ removeView: true });
      return;
    }
    this.app = app;
    app.canvas.style.display = 'block';
    app.canvas.style.width = '100%';
    app.canvas.style.height = '100%';
    app.canvas.style.imageRendering = 'pixelated';
    el.appendChild(app.canvas);
    app.stage.eventMode = 'none';
    app.stage.addChild(this.world);

    // wait (briefly) for the pixel font so signposts measure correctly
    try {
      // every weight we use must be loaded, otherwise text is measured with the fallback font
      const weights = ['400', '500', '600'].flatMap((w) => [
        document.fonts.load(`${w} 14px "Pixelify Sans"`),
        document.fonts.load(`${w} 14px "Silkscreen"`, '0123456789'), // digits-only font
      ]);
      await Promise.race([Promise.all(weights), new Promise((r) => setTimeout(r, 2500))]);
    } catch {
      /* fall back to monospace */
    }

    // ---- terrain: tile codes mapped by name, then painted chunk by chunk
    const table = tileTypeTable(map.tileTypes?.length ? map.tileTypes : config.tileTypes);
    const W = map.width;
    const H = map.height;
    this.tiles = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) this.tiles[i] = table[map.tiles[i]] ?? TT.grass;
    this.terrain = new Terrain(W, H, this.tiles, map.landmarks.map((l) => ({ id: l.id, name: l.nameFr || l.name, kind: l.kind, x: l.x, y: l.y })));
    this.cam = new Camera(W * TS, H * TS);
    this.cam.resize(app.screen.width, app.screen.height);
    this.cam.flyTo((W * TS) / 2, (H * TS) / 2, this.cam.fitZoom(), false);

    this.world.addChild(this.groundLayer, this.shimmerLayer);
    let painted = 0;
    for (let cy = 0; cy < Math.ceil(H / CHUNK); cy++) {
      for (let cx = 0; cx < Math.ceil(W / CHUNK); cx++) {
        const tw = Math.min(CHUNK, W - cx * CHUNK);
        const th = Math.min(CHUNK, H - cy * CHUNK);
        const buf = this.terrain.paintChunk(cx * CHUNK, cy * CHUNK, tw, th);
        const tex = canvasTexture(buf.toCanvas(), { mipmaps: true });
        const s = new Sprite(tex);
        s.position.set(cx * CHUNK * TS, cy * CHUNK * TS);
        this.groundLayer.addChild(s);
        this.chunks.push({ s, x0: s.x, y0: s.y, x1: s.x + tw * TS, y1: s.y + th * TS });
        if (++painted % 6 === 0) {
          this.applyCamera();
          await nextFrame();
          if (this.destroyed) return;
        }
      }
    }

    // ---- animated water highlights (a cheap sprite per water tile, frames swapped ~3 fps)
    this.shimmerTex = makeShimmer();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (this.tiles[y * W + x] !== TT.water || rand2(x, y, 301) > 0.6) continue;
        const v = Math.floor(rand2(x, y, 303) * 4);
        const s = new Sprite(this.shimmerTex[v][0]);
        s.position.set(x * TS, y * TS);
        this.shimmerLayer.addChild(s);
        this.shimmer.push({ s, v, ph: Math.floor(rand2(x, y, 305) * 3) });
      }
    }

    // ---- districts, overlays, sites
    const districts = new Uint16Array(W * H);
    for (let i = 0; i < W * H; i++) districts[i] = map.districts[i] ?? 0;
    const dept = new Map<number, string>();
    for (const d of map.districtList) dept.set(d.idx, d.dept);
    this.grid = new DistrictGrid(W, H, districts, dept);
    this.overlays = new OverlayLayer(this.grid);
    this.world.addChild(this.overlays.container, this.overlays.siteLayer);

    // ---- residents
    const emoteTex = makeEmotes();
    const dotTex = makeDots();
    this.residents = new ResidentLayer(population.residents, this.atlas, emoteTex, dotTex, (x, y) => this.terrain.T(x, y), (x, y) =>
      x < 0 || y < 0 || x >= W || y >= H ? true : this.terrain.occluded[y * W + x] === 1,
    );
    this.atlas.finalize();
    this.residents.build();
    this.computeFallbackAttendees();

    // ---- selection visuals
    const badgeNames = ['car', 'home', 'noise', 'heat', 'job', 'tax', 'water', 'power', 'scooter', 'walk', 'park', 'money', 'construction', 'none'];
    const modes: Record<string, Texture> = {};
    for (const m of ['metro', 'rer', 'bus', 'car', 'bike', 'walk']) modes[m] = makeBadges([m], 0x8fb3d9)[m];
    this.selection = new SelectionLayer(
      {
        ring: makeSelectRing(),
        homePin: makePin('home', 0xd6534a),
        workPin: makePin('briefcase', 0x3d5a8a),
        badges: makeBadges(badgeNames, 0xf29e38),
        modes,
      },
      { w: W, h: H, tiles: this.tiles },
    );
    this.world.addChild(
      this.selection.under,
      this.residents.ghostLayer,
      this.residents.spriteLayer,
      this.residents.dotLayer,
      this.residents.emoteLayer,
      this.selection.over,
    );

    // ---- screen-space labels + bubbles
    const parts = makeBubbleParts();
    this.labels = new LabelLayer({ ...makeSigns(), tag: parts.tag });
    this.labels.set(this.baseLabels());
    this.bubbles = new BubbleLayer(parts);
    app.stage.addChild(this.labels.container, this.bubbles.container);

    // ---- input + resize + render loop
    this.cam.attach(app.canvas, {
      onClick: (sx, sy) => this.handleClick(sx, sy),
      onHover: (sx, sy) => (this.pendingHover = { x: sx, y: sy }),
    });
    this.resizeObs = new ResizeObserver(() => {
      if (!this.app) return;
      this.app.resize();
      this.cam.resize(this.app.screen.width, this.app.screen.height);
    });
    this.resizeObs.observe(el);
    this.applyCamera();
    app.ticker.add(this.tickFn);
    this.mounted = true;
    const queued = this.pending;
    this.pending = [];
    for (const fn of queued) fn();
  }

  destroy(): void {
    this.destroyed = true;
    this.pending = [];
    this.convToken++;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    if (this.cam) this.cam.detach();
    if (this.app) {
      this.app.ticker.remove(this.tickFn);
      this.app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true, texture: true, textureSource: true });
      this.app = null;
    }
    this.atlas.destroy();
    for (const k of Object.keys(this.listeners) as (keyof TownMapEvents)[]) this.listeners[k].clear();
  }

  on<K extends keyof TownMapEvents>(ev: K, cb: TownMapEvents[K]): () => void {
    (this.listeners[ev] as Set<TownMapEvents[K]>).add(cb);
    return () => (this.listeners[ev] as Set<TownMapEvents[K]>).delete(cb);
  }

  private emit<K extends keyof TownMapEvents>(ev: K, ...args: Parameters<TownMapEvents[K]>): void {
    for (const cb of this.listeners[ev]) (cb as (...a: Parameters<TownMapEvents[K]>) => void)(...args);
  }

  private mounted = false;
  private get ready(): boolean {
    return this.mounted && !this.destroyed;
  }

  // =========================================================== frame loop

  private applyCamera(): void {
    if (!this.cam) return;
    const z = this.cam.zoom;
    this.world.scale.set(z);
    this.world.position.set(Math.round(this.cam.viewW / 2 - this.cam.x * z), Math.round(this.cam.viewH / 2 - this.cam.y * z));
  }

  private tick(): void {
    if (!this.app || this.destroyed) return;
    const dt = Math.min(this.app.ticker.deltaMS, 100);
    this.time += dt;
    this.cam.update(dt);
    this.applyCamera();
    // cull ground chunks that are off screen
    const v = this.cam.viewRect(16);
    for (const c of this.chunks) c.s.visible = c.x1 > v.x0 && c.x0 < v.x1 && c.y1 > v.y0 && c.y0 < v.y1;
    // water shimmer ~3 fps
    this.shimmerClock += dt;
    if (this.shimmerClock > 330) {
      this.shimmerClock = 0;
      this.shimmerFrame = (this.shimmerFrame + 1) % 3;
      const showShimmer = this.cam.zoom > 0.6;
      this.shimmerLayer.visible = showShimmer;
      if (showShimmer) {
        for (const s of this.shimmer) {
          const on = s.s.x + TS > v.x0 && s.s.x < v.x1 && s.s.y + TS > v.y0 && s.s.y < v.y1;
          s.s.visible = on;
          if (on) s.s.texture = this.shimmerTex[s.v][(this.shimmerFrame + s.ph) % 3];
        }
      }
    }
    this.residents.update(dt, this.cam);
    this.overlays.update(dt, this.cam.zoom);
    this.selection.update(dt, this.cam);
    this.labels.update(dt, this.cam);
    this.bubbles.update(dt, this.cam);
    this.updateAmbient(dt);
    this.hoverClock += dt;
    if (this.pendingHover && this.hoverClock > 60) {
      this.hoverClock = 0;
      this.handleHover(this.pendingHover.x, this.pendingHover.y);
      this.pendingHover = null;
    }
  }

  // =========================================================== input

  private tileAtScreen(sx: number, sy: number): { x: number; y: number; wx: number; wy: number } {
    const w = this.cam.screenToWorld(sx, sy);
    return { x: Math.floor(w.x / TS), y: Math.floor(w.y / TS), wx: w.x, wy: w.y };
  }

  private pickResidentAt(wx: number, wy: number): number {
    const spriteMode = this.cam.zoom >= 0.85;
    const radius = spriteMode ? 10 : Math.max(5, 7 / this.cam.zoom);
    return this.residents.pick(wx, wy, radius, spriteMode);
  }

  private handleClick(sx: number, sy: number): void {
    if (!this.ready) return;
    const t = this.tileAtScreen(sx, sy);
    const inMap = t.x >= 0 && t.y >= 0 && t.x < this.map.width && t.y < this.map.height;
    if (!inMap) return;
    const d = this.grid.at(t.x, t.y);
    if (this.pickMode === 'site') {
      this.setCustomSite({ x: t.x, y: t.y, ringsTiles: [5, 10, 20] });
      this.emit('tileClick', t.x, t.y);
      return;
    }
    if (this.pickMode === 'districts') {
      if (d) {
        const i = this.picked.indexOf(d);
        this.picked = i >= 0 ? this.picked.filter((x) => x !== d) : [...this.picked, d];
        this.overlays.setPicked(this.picked);
        this.emit('districtClick', d);
      }
      this.emit('tileClick', t.x, t.y);
      return;
    }
    const i = this.pickResidentAt(t.wx, t.wy);
    if (i >= 0) {
      this.emit('residentClick', this.residents.ids[i]);
      return;
    }
    this.emit('tileClick', t.x, t.y);
    if (d) this.emit('districtClick', d);
  }

  private handleHover(sx: number, sy: number): void {
    if (!this.ready || !this.app) return;
    const t = this.tileAtScreen(sx, sy);
    if (this.pickMode === 'districts') {
      this.overlays.setHover(this.grid.at(t.x, t.y));
      this.app.canvas.style.cursor = 'pointer';
      return;
    }
    if (this.pickMode === 'site') {
      this.app.canvas.style.cursor = 'crosshair';
      return;
    }
    const i = this.pickResidentAt(t.wx, t.wy);
    this.app.canvas.style.cursor = i >= 0 ? 'pointer' : '';
  }

  // =========================================================== scenario & views

  private stanceFor(id: number): number | null {
    const o = this.stanceOverride.get(id);
    if (o !== undefined) return o;
    const r = this.results.get(id);
    if (!r) return null;
    if (this.afterTalk && r.stanceAfter !== undefined) return r.stanceAfter;
    return r.stance;
  }

  private refreshStances(pop: boolean): void {
    for (let i = 0; i < this.residents.n; i++) this.residents.setStance(i, this.stanceFor(this.residents.ids[i]), pop);
    this.residents.showEmotes = !!this.scenario || this.stanceOverride.size > 0;
  }

  setScenario(s: Scenario | null): void {
    if (!this.whenReady(() => this.setScenario(s))) return;
    this.scenario = s;
    this.results.clear();
    this.stanceOverride.clear();
    this.residents.clearStances();
    this.convBusy.clear();
    this.ambientPairs = [];
    if (s) for (const r of s.results) this.results.set(r.id, r);
    this.refreshStances(true);
    // site, rings, zone
    if (s?.site) {
      const text = `${s.id} ${s.title} ${s.site.label}`.toLowerCase();
      const isDc = /data|centre|center|datacent/.test(text);
      // site coordinates may be fractional tile positions: snap to the tile that contains them
      const sx = Math.floor(s.site.x);
      const sy = Math.floor(s.site.y);
      this.overlays.setSite('scenario', { x: sx, y: sy, kind: isDc ? 'datacentre' : 'yard' });
      this.overlays.setRings('scenario', { x: sx, y: sy, radii: s.site.ringsTiles ?? [] });
      this.labels.replaceGroup('site:', this.siteLabels('site:', sx, sy, s.site.ringsTiles ?? [], s.site.label));
    } else {
      this.overlays.setSite('scenario', null);
      this.overlays.setRings('scenario', null);
      this.labels.replaceGroup('site:', []);
    }
    this.overlays.setZone(s?.zoneDistricts ?? null);
    this.applyViewMode(false);
    this.applyOverlay();
    if (this.selectedId !== null) this.selectResident(this.selectedId);
  }

  private computeFallbackAttendees(): void {
    // Without a scenario we still need "likely attendees": top 7% of eligible Paris residents by
    // their empirical participation propensity (participationBase, from INSEE gradients).
    const eligible = this.pop.residents.filter((r) => r.eligibleParis).sort((a, b) => b.participationBase - a.participationBase);
    const k = Math.round(eligible.length * 0.07);
    this.fallbackAttendee = new Set(eligible.slice(0, k).map((r) => r.id));
  }

  setViewMode(m: ViewMode): void {
    if (!this.whenReady(() => this.setViewMode(m))) return;
    this.viewMode = m;
    this.applyViewMode(true);
    if (this.overlayMode === 'stance' && !this.overlayValues) this.applyOverlay();
  }

  private applyViewMode(celebrate: boolean): void {
    const target = new Float32Array(this.residents.n);
    for (let i = 0; i < this.residents.n; i++) {
      const id = this.residents.ids[i];
      const r = this.results.get(id);
      const res = this.residentById.get(id);
      let ghost = 0;
      if (this.viewMode === 'eligible') ghost = (r ? r.eligible : !!res?.eligibleParis) ? 0 : 1;
      else if (this.viewMode === 'attendees') ghost = (r ? r.attendee : this.fallbackAttendee.has(id)) ? 0 : 1;
      target[i] = ghost;
      this.residents.setHighlightRing(i, this.viewMode === 'attendees' && ghost === 0);
    }
    this.residents.setGhostTargets(target, this.cam, celebrate && this.viewMode === 'attendees');
  }

  setAfterTalk(on: boolean): void {
    if (!this.whenReady(() => this.setAfterTalk(on))) return;
    this.afterTalk = on;
    // pop only the residents whose stance actually changes
    for (let i = 0; i < this.residents.n; i++) {
      const s = this.stanceFor(this.residents.ids[i]);
      const changed = (s === null ? 99 : s) !== this.residents.stance[i];
      this.residents.setStance(i, s, changed);
      if (changed) this.residents.hop(i, Math.random() * 300);
    }
  }

  setOverlay(o: Overlay, values?: Record<number, number>): void {
    if (!this.whenReady(() => this.setOverlay(o, values))) return;
    this.overlayMode = o;
    this.overlayValues = values;
    this.applyOverlay();
  }

  private applyOverlay(): void {
    const o = this.overlayMode;
    this.overlays.setBorderStrength(o === 'districts' || o !== 'none');
    if (o === 'none' || o === 'districts') {
      this.overlays.setChoropleth(null);
      return;
    }
    let values = this.overlayValues;
    const s = this.scenario;
    if (!values && s) {
      values = {};
      if (o === 'stance') {
        const view = this.viewMode === 'attendees' ? 'attendees' : 'everyone';
        for (const d of s.aggregates.byDistrict) values[d.districtIdx] = d[view].yesShare;
      } else if (o === 'exposure') {
        for (const d of s.aggregates.byDistrict) values[d.districtIdx] = d.meanExposure;
      } else if (s.backtest) {
        for (const sec of s.backtest.bySector) {
          const v = o === 'backtest_actual' ? sec.actualYes : this.viewMode === 'attendees' ? sec.simAttendeesYes : sec.simEveryoneYes;
          for (const d of sec.districtIdxs) values[d] = v;
        }
      }
    }
    if (!values || Object.keys(values).length === 0) {
      this.overlays.setChoropleth(null);
      return;
    }
    const vals = values;
    this.overlays.setChoropleth((d) => {
      const v = vals[d];
      if (v === undefined || v === null || Number.isNaN(v)) return null;
      if (o === 'exposure') return { colour: exposureColour(v), coverage: 0.3 + 0.45 * clamp(v / 3, 0, 1) };
      return { colour: divergingColour(v), coverage: 0.42 + 0.5 * Math.min(1, Math.abs(v - 0.5) * 2) };
    });
  }

  highlightGroup(groupId: string | null): void {
    if (!this.whenReady(() => this.highlightGroup(groupId))) return;
    this.groupId = groupId;
    this.applyDims();
  }

  private applyDims(): void {
    // Scenario-specific groups (e.g. "renters within 2 km of the site") list their members explicitly.
    const extra = this.groupId ? this.scenario?.extraGroups?.find((g) => g.id === this.groupId) : undefined;
    const extraMembers = extra ? new Set(extra.memberIds) : null;
    for (let i = 0; i < this.residents.n; i++) {
      const id = this.residents.ids[i];
      let dim = 0;
      if (this.groupId) {
        const inGroup = extraMembers ? extraMembers.has(id) : Boolean(this.residentById.get(id)?.groupIds.includes(this.groupId));
        if (!inGroup) dim = 1;
      }
      if (this.selectedId !== null && id !== this.selectedId) dim = Math.max(dim, 0.55);
      if (this.convPair.length && !this.convPair.includes(id)) dim = Math.max(dim, 0.6);
      this.residents.dimTarget[i] = dim;
    }
  }

  // =========================================================== selection & speech

  selectResident(id: number | null, opts?: { bubbleText?: string }): void {
    if (!this.whenReady(() => this.selectResident(id, opts))) return;
    this.selectedId = id;
    this.bubbles.hide('sel');
    if (id === null) {
      this.selection.set(null);
      this.residents.forceSolid = -1;
      this.cam.follow(null);
      this.applyDims();
      return;
    }
    const i = this.residents.index(id);
    const res = this.residentById.get(id);
    if (i < 0 || !res) return;
    this.residents.forceSolid = i;
    const r = this.results.get(id);
    this.selection.set({
      home: res.home,
      work: res.work,
      mode: res.commuteMode,
      reasons: r?.exposure.reasons ?? [],
      feet: () => this.residents.pos(id),
    });
    const p = this.residents.pos(id)!;
    this.cam.flyTo(p.x, p.y - 8, Math.max(this.cam.zoom, 2.6));
    this.cam.follow(() => {
      const q = this.residents.pos(id);
      return q ? { x: q.x, y: q.y - 8 } : null;
    });
    this.residents.hop(i, 200);
    this.applyDims();
    if (opts?.bubbleText) this.bubbles.show('sel', opts.bubbleText, () => this.headOf(i), 0, true);
  }

  private headOf(i: number): { x: number; y: number } {
    return { x: this.residents.x[i], y: this.residents.y[i] - 17 };
  }

  say(id: number, text: string, ms = 6000): void {
    if (!this.whenReady(() => this.say(id, text, ms))) return;
    const i = this.residents.index(id);
    if (i < 0) return;
    this.bubbles.show(`say:${id}`, text, () => this.headOf(i), ms, true);
  }

  private wait(ms: number, token: number): Promise<boolean> {
    return new Promise((resolve) => setTimeout(() => resolve(token === this.convToken && !this.destroyed), ms));
  }

  private async waitUntil(cond: () => boolean, maxMs: number, token: number): Promise<boolean> {
    const t0 = this.time;
    while (!cond() && this.time - t0 < maxMs) {
      if (!(await this.wait(50, token))) return false;
    }
    return token === this.convToken && !this.destroyed;
  }

  async playConversation(c: Conversation, opts?: { lang?: 'en' | 'fr'; lineMs?: number }): Promise<void> {
    if (!this.ready) {
      if (this.destroyed) return;
      await new Promise<void>((resolve) => this.pending.push(resolve));
      if (!this.ready) return;
    }
    const token = ++this.convToken;
    const ia = this.residents.index(c.a);
    const ib = this.residents.index(c.b);
    if (ia < 0 || ib < 0) return;
    this.bubbles.hidePrefix('conv:');
    this.ambientPairs = this.ambientPairs.filter((p) => p.a !== ia && p.b !== ia && p.a !== ib && p.b !== ib);
    this.convBusy = new Set([ia, ib]);
    this.convPair = [c.a, c.b];
    this.applyDims();
    const wx = c.where[0] * TS + 8;
    const wy = c.where[1] * TS + 15;
    this.cam.follow(null);
    this.cam.flyTo(wx, wy - 14, Math.max(this.cam.zoom, 2.8));
    for (const [i, dx] of [[ia, -8], [ib, 8]] as const) {
      const far = Math.hypot(this.residents.x[i] - (wx + dx), this.residents.y[i] - wy) > 7 * TS;
      if (far) this.residents.teleport(i, wx + dx * 4, wy);
      this.residents.walkTo(i, wx + dx, wy, 32);
    }
    if (!(await this.waitUntil(() => this.residents.arrived(ia) && this.residents.arrived(ib), 3200, token))) return;
    this.residents.teleport(ia, wx - 8, wy);
    this.residents.teleport(ib, wx + 8, wy);
    this.residents.face(ia, DIR_RIGHT);
    this.residents.face(ib, DIR_LEFT);
    const lang = opts?.lang ?? 'en';
    for (const line of c.lines) {
      const sp = line.speaker === c.b ? ib : ia;
      const text = (lang === 'fr' ? line.fr : line.en) || line.en || line.fr;
      const ms = opts?.lineMs ?? clamp(1300 + text.length * 42, 2200, 6500);
      this.bubbles.show('conv:line', text, () => this.headOf(sp), ms + 250, true, sp === ia ? -1 : 1);
      this.residents.hop(sp, 0);
      if (!(await this.wait(ms, token))) return;
    }
    // resolution: show how each of them feels now; '!' when someone changed their mind
    const emo = (v: number) => clamp(Math.round(v), -2, 2) + 2;
    const changedA = c.stanceAfter.a !== c.stanceBefore.a;
    const changedB = c.stanceAfter.b !== c.stanceBefore.b;
    this.residents.flashEmote(ia, changedA ? 8 : emo(c.stanceAfter.a), 2400);
    this.residents.flashEmote(ib, changedB ? 8 : emo(c.stanceAfter.b), 2400);
    if (changedA) this.residents.hop(ia, 0);
    if (changedB) this.residents.hop(ib, 120);
    if (!(await this.wait(1300, token))) return;
    if (changedA) this.residents.flashEmote(ia, emo(c.stanceAfter.a), 1500);
    if (changedB) this.residents.flashEmote(ib, emo(c.stanceAfter.b), 1500);
    if (!(await this.wait(900, token))) return;
    this.residents.release(ia);
    this.residents.release(ib);
    this.convBusy.clear();
    this.endConversationFocus(token);
  }

  private endConversationFocus(token: number): void {
    if (token !== this.convToken) return;
    this.convPair = [];
    this.applyDims();
  }

  setAmbientConversations(on: boolean): void {
    this.ambient = on;
    if (!on && this.residents) {
      for (const p of this.ambientPairs) {
        this.residents.release(p.a);
        this.residents.release(p.b);
      }
      this.ambientPairs = [];
    }
  }

  private updateAmbient(dt: number): void {
    const now = this.time;
    // advance running chats: alternate the wordless "..." bubbles, then send them home
    this.ambientPairs = this.ambientPairs.filter((p) => {
      if (now > p.until) {
        this.residents.release(p.a);
        this.residents.release(p.b);
        return false;
      }
      if (now > p.next && this.residents.arrived(p.a) && this.residents.arrived(p.b)) {
        p.turn ^= 1;
        p.next = now + 900 + Math.random() * 500;
        this.residents.face(p.a, DIR_RIGHT);
        this.residents.face(p.b, DIR_LEFT);
        this.residents.flashEmote(p.turn ? p.a : p.b, 9, 800);
      }
      return true;
    });
    if (!this.ambient || !this.scenario || !this.scenario.conversations.length || this.cam.zoom < 1) return;
    this.ambientClock += dt;
    if (this.ambientClock < 900 || this.ambientPairs.length >= 6) return;
    this.ambientClock = 0;
    const v = this.cam.viewRect(-20);
    const convs = this.scenario.conversations;
    for (let tries = 0; tries < 24; tries++) {
      const c = convs[Math.floor(Math.random() * convs.length)];
      const ia = this.residents.index(c.a);
      const ib = this.residents.index(c.b);
      if (ia < 0 || ib < 0 || this.convBusy.has(ia) || this.convBusy.has(ib)) continue;
      if (this.ambientPairs.some((p) => p.a === ia || p.b === ia || p.a === ib || p.b === ib)) continue;
      if (this.residents.isScripted(ia) || this.residents.isScripted(ib)) continue;
      const mx = (this.residents.x[ia] + this.residents.x[ib]) / 2;
      const my = Math.max(this.residents.y[ia], this.residents.y[ib]);
      if (mx < v.x0 || mx > v.x1 || my < v.y0 || my > v.y1) continue;
      if (Math.hypot(this.residents.x[ia] - this.residents.x[ib], this.residents.y[ia] - this.residents.y[ib]) > 8 * TS) continue;
      this.residents.walkTo(ia, mx - 7, my, 16);
      this.residents.walkTo(ib, mx + 7, my, 16);
      this.ambientPairs.push({ a: ia, b: ib, until: now + 7000, next: now + 1500, turn: 0 });
      break;
    }
  }

  // =========================================================== camera API

  focus(x: number, y: number, zoom?: number, animate = true): void {
    if (!this.whenReady(() => this.focus(x, y, zoom, false))) return;
    this.cam.follow(null);
    this.cam.flyTo(x * TS + 8, y * TS + 8, zoom, animate);
  }

  focusDistrict(districtIdx: number): void {
    if (!this.whenReady(() => this.focusDistrict(districtIdx))) return;
    const bb = this.grid.bbox.get(districtIdx);
    if (!bb) return;
    const w = (bb.x1 - bb.x0 + 1) * TS;
    const h = (bb.y1 - bb.y0 + 1) * TS;
    const z = clamp(Math.min(this.cam.viewW / (w * 1.4), this.cam.viewH / (h * 1.4)), 0.5, 3);
    this.cam.follow(null);
    this.cam.flyTo((bb.x0 * TS + (bb.x1 + 1) * TS) / 2, (bb.y0 * TS + (bb.y1 + 1) * TS) / 2, z);
  }

  fitAll(): void {
    if (!this.whenReady(() => this.fitAll())) return;
    this.cam.follow(null);
    this.cam.flyTo((this.map.width * TS) / 2, (this.map.height * TS) / 2, this.cam.fitZoom());
  }

  // =========================================================== custom proposals

  setPickMode(mode: 'none' | 'districts' | 'site'): void {
    if (!this.whenReady(() => this.setPickMode(mode)) || !this.app) return;
    this.pickMode = mode;
    this.overlays.setHover(0);
    this.app.canvas.style.cursor = mode === 'site' ? 'crosshair' : mode === 'districts' ? 'pointer' : '';
  }

  setPickedDistricts(idxs: number[]): void {
    if (!this.whenReady(() => this.setPickedDistricts(idxs))) return;
    this.picked = [...idxs];
    this.overlays.setPicked(this.picked);
  }

  setCustomSite(site: { x: number; y: number; ringsTiles: number[]; label?: string } | null): void {
    if (!this.whenReady(() => this.setCustomSite(site))) return;
    if (!site) {
      this.overlays.setSite('custom', null);
      this.overlays.setRings('custom', null);
      this.labels.replaceGroup('custom:', []);
      return;
    }
    const sx = Math.floor(site.x);
    const sy = Math.floor(site.y);
    this.overlays.setSite('custom', { x: sx, y: sy, kind: 'yard' });
    this.overlays.setRings('custom', { x: sx, y: sy, radii: site.ringsTiles });
    this.labels.replaceGroup('custom:', this.siteLabels('custom:', sx, sy, site.ringsTiles, site.label ?? 'Your proposed site'));
  }

  setThinking(ids: number[]): void {
    if (!this.whenReady(() => this.setThinking(ids))) return;
    const set = new Set(ids);
    for (let i = 0; i < this.residents.n; i++) this.residents.setThinking(i, set.has(this.residents.ids[i]));
  }

  revealResult(id: number, stance: number): void {
    if (!this.whenReady(() => this.revealResult(id, stance))) return;
    const i = this.residents.index(id);
    if (i < 0) return;
    this.residents.setThinking(i, false);
    this.stanceOverride.set(id, clamp(Math.round(stance), -2, 2));
    this.residents.showEmotes = true;
    this.residents.setStance(i, this.stanceOverride.get(id)!, false);
    this.residents.pop(i, 0);
    this.residents.hop(i, 0);
  }

  // =========================================================== labels

  private baseLabels(): LabelSpec[] {
    const specs: LabelSpec[] = [];
    for (const d of this.map.districtList) {
      const paris = d.kind === 'arrondissement';
      specs.push({
        id: `d:${d.idx}`,
        text: d.name,
        wx: d.labelPos[0] * TS + 8,
        wy: d.labelPos[1] * TS + 8,
        style: paris ? 'plaque' : 'plank',
        priority: paris ? 1000 + d.population / 1e4 : d.population / 1e3,
        minZoom: paris ? undefined : d.population < 30000 ? 0.62 : d.population < 55000 ? 0.42 : undefined,
      });
    }
    for (const l of this.terrain.landmarks) {
      specs.push({ id: `lm:${l.id}`, text: l.name, wx: l.cx, wy: l.by + 4, style: 'tag', priority: 3000, minZoom: 1.15, below: true });
    }
    return specs;
  }

  private siteLabels(prefix: string, x: number, y: number, rings: number[], label: string): LabelSpec[] {
    const cx = x * TS + 8;
    const cy = y * TS + 8;
    const out: LabelSpec[] = [{ id: `${prefix}label`, text: label, wx: cx, wy: cy - 70, style: 'site', priority: 9000 }];
    rings.forEach((r, k) => {
      const m = r * config.tileMeters;
      const text = m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${m} m`;
      out.push({ id: `${prefix}ring${k}`, text, wx: cx, wy: cy + r * TS + 10, style: 'tag', priority: 8000 - k });
    });
    return out;
  }
}
