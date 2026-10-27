/**
 * "What changes for this resident" for a proposal YOU type in.
 * Computed from geography only (where they live and work), never by the AI.
 *
 * Simple, explainable rules (100 m tiles):
 *   lives inside the area            -> 3
 *   lives within 1 km of the area    -> 2
 *   works inside the area (imputed)  -> 2
 *   otherwise                        -> 0
 */
import type { District, ExposureReason, MapFile, Resident, ResidentResult } from '../types';
import { metres } from './format';
import { hashString, makeRng, shuffle } from './random';

export type CustomArea =
  | { kind: 'districts'; districts: number[] }
  | { kind: 'site'; x: number; y: number; ringsTiles: number[]; label?: string };

/** Precomputed per-tile distance to the area, so each resident is a quick lookup. */
export interface AreaIndex {
  width: number;
  height: number;
  tileMeters: number;
  /** 1 if the tile is inside the area. */
  inside: Uint8Array;
  /** Distance in tiles from each tile to the nearest area tile (0 inside). */
  dist: Float32Array;
  /** Index of the nearest area tile, for drawing "where it touches them" on the map. */
  nearest: Int32Array;
  area: CustomArea;
}

export const NEAR_METRES = 1000;

export function isAreaReady(area: CustomArea | null): area is CustomArea {
  if (!area) return false;
  return area.kind === 'districts' ? area.districts.length > 0 : true;
}

export function buildAreaIndex(map: MapFile, area: CustomArea): AreaIndex {
  const { width: W, height: H } = map;
  const n = W * H;
  const inside = new Uint8Array(n);
  const dist = new Float32Array(n);
  const nearest = new Int32Array(n).fill(-1);

  if (area.kind === 'site') {
    const r0 = area.ringsTiles[0] ?? 5;
    const siteIdx = Math.floor(area.y) * W + Math.floor(area.x);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = Math.hypot(x + 0.5 - area.x, y + 0.5 - area.y);
        inside[i] = d <= r0 ? 1 : 0;
        dist[i] = Math.max(0, d - r0);
        nearest[i] = siteIdx;
      }
    }
    return { width: W, height: H, tileMeters: map.tileMeters, inside, dist, nearest, area };
  }

  // Districts: two-pass chamfer distance transform (fast, about 1% error).
  const picked = new Set(area.districts);
  const INF = 1e9;
  for (let i = 0; i < n; i++) {
    if (picked.has(map.districts[i])) {
      inside[i] = 1;
      dist[i] = 0;
      nearest[i] = i;
    } else dist[i] = INF;
  }
  const D = Math.SQRT2;
  const relax = (i: number, j: number, cost: number) => {
    if (dist[j] + cost < dist[i]) {
      dist[i] = dist[j] + cost;
      nearest[i] = nearest[j];
    }
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - W, 1);
        if (x > 0) relax(i, i - W - 1, D);
        if (x < W - 1) relax(i, i - W + 1, D);
      }
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (x < W - 1) relax(i, i + 1, 1);
      if (y < H - 1) {
        relax(i, i + W, 1);
        if (x < W - 1) relax(i, i + W + 1, D);
        if (x > 0) relax(i, i + W - 1, D);
      }
    }
  }
  return { width: W, height: H, tileMeters: map.tileMeters, inside, dist, nearest, area };
}

function tileIndex(idx: AreaIndex, p: [number, number]): number {
  const x = Math.min(idx.width - 1, Math.max(0, Math.floor(p[0])));
  const y = Math.min(idx.height - 1, Math.max(0, Math.floor(p[1])));
  return y * idx.width + x;
}

function tileOf(idx: AreaIndex, i: number): [number, number] {
  return [i % idx.width, Math.floor(i / idx.width)];
}

/** Distance in metres from a point to the area (0 inside). */
export function metresToArea(idx: AreaIndex, p: [number, number]): number {
  return idx.dist[tileIndex(idx, p)] * idx.tileMeters;
}

export function computeCustomExposure(
  resident: Resident,
  idx: AreaIndex,
  districtsByIdx: Map<number, District>,
): ResidentResult['exposure'] {
  const reasons: ExposureReason[] = [];
  let score: 0 | 1 | 2 | 3 = 0;
  const homeI = tileIndex(idx, resident.home);
  const where = idx.area.kind === 'site' ? `the ${idx.area.label ?? 'proposed site'} zone` : 'the proposal area';

  if (idx.inside[homeI]) {
    score = 3;
    const dName = districtsByIdx.get(resident.districtIdx)?.name;
    reasons.push({
      code: 'home_in_area',
      text: `Lives inside ${where}${dName ? ` (${dName})` : ''}: the change happens on their doorstep.`,
      icon: 'home',
      at: [resident.home],
    });
  } else {
    const m = idx.dist[homeI] * idx.tileMeters;
    if (m <= NEAR_METRES) {
      score = 2;
      const n = idx.nearest[homeI];
      reasons.push({
        code: 'home_near_area',
        text: `Lives about ${metres(m)} from ${where}: close enough to notice it day to day.`,
        icon: 'walk',
        at: n >= 0 ? [tileOf(idx, n)] : undefined,
      });
    }
  }

  if (resident.work) {
    const workI = tileIndex(idx, resident.work);
    if (idx.inside[workI]) {
      if (score < 2) score = 2;
      reasons.push({
        code: 'works_in_area',
        text: `Works inside ${where} (workplace is imputed): they pass through it on work days.`,
        icon: 'job',
        at: [resident.work],
      });
    }
  }

  if (reasons.length === 0) {
    const m = idx.dist[homeI] * idx.tileMeters;
    reasons.push({
      code: 'not_touched',
      text: `Lives ${metres(m)} away and does not work there: no direct change for them.`,
      icon: 'none',
    });
  }
  return { score, reasons };
}

export interface CustomSample {
  /** Sampled residents with the weight each one stands for (mean 1). */
  members: { resident: Resident; weight: number; near: boolean }[];
  nearCount: number;
  farCount: number;
}

/**
 * Sample residents for a live run: about 60% from in or near the area (so we hear the people
 * most touched), the rest from elsewhere. Weights undo this over-sampling, so totals still
 * represent the whole town.
 */
export function sampleForCustom(residents: Resident[], idx: AreaIndex, n = 150, seedText = ''): CustomSample {
  const rng = makeRng(hashString(`custom:${seedText}`));
  const near: Resident[] = [];
  const far: Resident[] = [];
  for (const r of residents) {
    const homeNear = metresToArea(idx, r.home) <= NEAR_METRES;
    const worksIn = r.work ? idx.inside[tileIndex(idx, r.work)] === 1 : false;
    (homeNear || worksIn ? near : far).push(r);
  }
  const wantNear = Math.min(near.length, Math.round(n * 0.6));
  const wantFar = Math.min(far.length, n - wantNear);
  const pickedNear = shuffle(rng, near).slice(0, wantNear);
  const pickedFar = shuffle(rng, far).slice(0, wantFar);

  // Weight = (raking weight) x (pool size / number sampled from the pool), then rescaled to mean 1.
  const poolW = (list: Resident[]) => list.reduce((s, r) => s + r.weight, 0);
  const nearFactor = pickedNear.length ? poolW(near) / poolW(pickedNear) : 0;
  const farFactor = pickedFar.length ? poolW(far) / poolW(pickedFar) : 0;
  const members = [
    ...pickedNear.map((r) => ({ resident: r, weight: r.weight * nearFactor, near: true })),
    ...pickedFar.map((r) => ({ resident: r, weight: r.weight * farFactor, near: false })),
  ];
  const mean = members.reduce((s, m) => s + m.weight, 0) / Math.max(1, members.length);
  for (const m of members) m.weight = mean > 0 ? m.weight / mean : 1;
  return { members, nearCount: pickedNear.length, farCount: pickedFar.length };
}

/** Rings (in tiles) offered when you place a site. First ring = the directly affected zone. */
export const SITE_RING_OPTIONS: { label: string; rings: number[] }[] = [
  { label: '300 m', rings: [3, 10, 20] },
  { label: '500 m', rings: [5, 10, 20] },
  { label: '1 km', rings: [10, 20, 30] },
];
