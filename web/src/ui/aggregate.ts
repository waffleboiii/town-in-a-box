/**
 * Turning individual simulated reactions into the numbers on screen.
 * Mirrors the batch pipeline (pipeline/simulate.py), so a live "Your proposal" run is
 * summarised the same way as the precomputed scenarios.
 *
 * Words used here:
 *  - view: who we listen to. 'everyone' = all residents, 'eligible' = those allowed to take part,
 *    'attendees' = those likely to actually show up.
 *  - weight: how many real residents a simulated resident stands for (mean 1, from raking).
 *  - yesShare: support / (support + oppose), comparable with a "Pour" vote share.
 */
import type {
  Backtest,
  BacktestSector,
  ConsultRec,
  District,
  DistrictAgg,
  GroupAgg,
  GroupDef,
  Resident,
  ResidentResult,
  Scenario,
  Theme,
  ViewAgg,
  ViewMode,
} from '../types';
import { clamp, makeRng } from './random';

export const VIEWS: ViewMode[] = ['everyone', 'eligible', 'attendees'];

export interface AggContext {
  /** Weight of each resident (raking weight, or the sampling weight in a live run). */
  weightOf: (id: number) => number;
  /** Use the stance after the neighbour conversations, where there is one. */
  afterTalk?: boolean;
  /**
   * Live runs only (small samples): count each eligible resident in the "likely to show up"
   * view in proportion to their chance of taking part, instead of a yes/no pick.
   */
  attendProb?: Map<number, number>;
}

export interface WeightedStance {
  stance: number;
  weight: number;
}

export function stanceOf(r: ResidentResult, afterTalk = false): number {
  return afterTalk && r.stanceAfter !== undefined ? r.stanceAfter : r.stance;
}

export function emptyView(): ViewAgg {
  return { n: 0, support: 0, oppose: 0, neutral: 0, yesShare: 0.5, meanStance: 0 };
}

/** Weighted support / oppose / neutral shares for a list of answers. */
export function viewAgg(rows: WeightedStance[]): ViewAgg {
  let total = 0;
  let sup = 0;
  let opp = 0;
  let neu = 0;
  let sum = 0;
  for (const r of rows) {
    if (r.weight <= 0) continue;
    total += r.weight;
    sum += r.stance * r.weight;
    if (r.stance >= 1) sup += r.weight;
    else if (r.stance <= -1) opp += r.weight;
    else neu += r.weight;
  }
  if (total <= 0) return emptyView();
  return {
    n: Math.round(total),
    support: sup / total,
    oppose: opp / total,
    neutral: neu / total,
    yesShare: sup + opp > 0 ? sup / (sup + opp) : 0.5,
    meanStance: sum / total,
  };
}

/** The answers that count in one view, each with its weight. */
export function rowsForView(view: ViewMode, results: ResidentResult[], ctx: AggContext): WeightedStance[] {
  const rows: WeightedStance[] = [];
  for (const r of results) {
    const w = ctx.weightOf(r.id);
    if (view === 'everyone') rows.push({ stance: stanceOf(r, ctx.afterTalk), weight: w });
    else if (view === 'eligible') {
      if (r.eligible) rows.push({ stance: stanceOf(r, ctx.afterTalk), weight: w });
    } else if (ctx.attendProb) {
      const p = r.eligible ? ctx.attendProb.get(r.id) ?? 0 : 0;
      if (p > 0) rows.push({ stance: stanceOf(r, ctx.afterTalk), weight: w * p });
    } else if (r.attendee) rows.push({ stance: stanceOf(r, ctx.afterTalk), weight: w });
  }
  return rows;
}

export function computeViews(results: ResidentResult[], ctx: AggContext): Record<ViewMode, ViewAgg> {
  return {
    everyone: viewAgg(rowsForView('everyone', results, ctx)),
    eligible: viewAgg(rowsForView('eligible', results, ctx)),
    attendees: viewAgg(rowsForView('attendees', results, ctx)),
  };
}

// ---------- participation ----------

/**
 * Calibrated participation score (same recipe as the pipeline):
 * empirical propensity (INSEE turnout gradients, not the AI) x issue salience (computed exposure),
 * with the AI's own "would you take part" answer as a weak nudge (±15%) only.
 */
export function participationScore(base: number, exposureScore: number, llmSelfReport: number): number {
  const salience = 0.6 + 0.4 * (exposureScore / 3); // 0.6 (not touched) .. 1.0 (touched a lot)
  const nudge = 0.85 + 0.3 * clamp(llmSelfReport, 0, 1); // 0.85 .. 1.15
  return clamp(base * salience * nudge, 0, 1);
}

interface ParticipationRow {
  id: number;
  eligible: boolean;
  score: number;
  weight: number;
}

/**
 * Likely participants = the highest scores among those who can take part, until their total
 * weight reaches turnout x (weight of everyone who can take part). So the attendee share
 * always matches the real (or assumed) turnout.
 */
export function pickAttendees(rows: ParticipationRow[], turnout: number): Set<number> {
  const eligible = rows.filter((r) => r.eligible).sort((a, b) => b.score - a.score || a.id - b.id);
  const target = turnout * eligible.reduce((s, r) => s + r.weight, 0);
  const picked = new Set<number>();
  let acc = 0;
  for (const r of eligible) {
    if (acc >= target) break;
    picked.add(r.id);
    acc += r.weight;
  }
  return picked;
}

/**
 * For small live samples: turn scores into probabilities p = min(1, c x score), choosing c so
 * that the weighted mean of p over those who can take part equals the turnout.
 */
export function attendanceProbabilities(rows: ParticipationRow[], turnout: number): Map<number, number> {
  const eligible = rows.filter((r) => r.eligible);
  const totalW = eligible.reduce((s, r) => s + r.weight, 0);
  const out = new Map<number, number>();
  if (totalW <= 0) return out;
  const meanFor = (c: number) => eligible.reduce((s, r) => s + r.weight * Math.min(1, c * r.score), 0) / totalW;
  let lo = 0;
  let hi = 1;
  while (meanFor(hi) < turnout && hi < 1e6) hi *= 2;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (meanFor(mid) < turnout) lo = mid;
    else hi = mid;
  }
  for (const r of eligible) out.set(r.id, Math.min(1, hi * r.score));
  return out;
}

// ---------- breakdowns ----------

export function aggregateByDistrict(
  results: ResidentResult[],
  residentsById: Map<number, Resident>,
  ctx: AggContext,
): DistrictAgg[] {
  const groups = new Map<number, ResidentResult[]>();
  for (const r of results) {
    const res = residentsById.get(r.id);
    if (!res) continue;
    const list = groups.get(res.districtIdx) ?? [];
    list.push(r);
    groups.set(res.districtIdx, list);
  }
  const out: DistrictAgg[] = [];
  for (const [districtIdx, list] of groups) {
    let wSum = 0;
    let eSum = 0;
    for (const r of list) {
      const w = ctx.weightOf(r.id);
      wSum += w;
      eSum += w * r.exposure.score;
    }
    out.push({
      districtIdx,
      n: Math.round(wSum),
      everyone: viewAgg(rowsForView('everyone', list, ctx)),
      attendees: viewAgg(rowsForView('attendees', list, ctx)),
      meanExposure: wSum > 0 ? eSum / wSum : 0,
    });
  }
  return out.sort((a, b) => a.districtIdx - b.districtIdx);
}

/** Weight of each result in the "likely to show up" view (1 = fully counted). */
function attendWeight(r: ResidentResult, ctx: AggContext): number {
  if (ctx.attendProb) return r.eligible ? ctx.attendProb.get(r.id) ?? 0 : 0;
  return r.attendee ? 1 : 0;
}

export function aggregateByGroup(
  results: ResidentResult[],
  residentsById: Map<number, Resident>,
  groups: GroupDef[],
  ctx: AggContext,
): GroupAgg[] {
  let totalW = 0;
  let totalAttW = 0;
  for (const r of results) {
    const w = ctx.weightOf(r.id);
    totalW += w;
    totalAttW += w * attendWeight(r, ctx);
  }
  const out: GroupAgg[] = [];
  for (const g of groups) {
    const members = results.filter((r) => residentsById.get(r.id)?.groupIds.includes(g.id));
    if (members.length === 0) continue;
    let w = 0;
    let attW = 0;
    let eSum = 0;
    for (const r of members) {
      const rw = ctx.weightOf(r.id);
      w += rw;
      attW += rw * attendWeight(r, ctx);
      eSum += rw * r.exposure.score;
    }
    const popShare = totalW > 0 ? w / totalW : 0;
    const attShare = totalAttW > 0 ? attW / totalAttW : 0;
    out.push({
      groupId: g.id,
      label: g.label,
      n: Math.round(w),
      everyone: viewAgg(rowsForView('everyone', members, ctx)),
      representationRatio: popShare > 0 ? attShare / popShare : 0,
      meanExposure: w > 0 ? eSum / w : 0,
    });
  }
  return out;
}

/** Fill in share, missingGap and example quotes for a list of themes (needs themeId on results). */
export function themeStats(
  themes: Pick<Theme, 'id' | 'label' | 'labelFr' | 'side'>[],
  results: ResidentResult[],
  ctx: AggContext,
): Theme[] {
  let totalW = 0;
  let attW = 0;
  let nonAttW = 0;
  for (const r of results) {
    const w = ctx.weightOf(r.id);
    const a = attendWeight(r, ctx);
    totalW += w;
    attW += w * a;
    nonAttW += w * (1 - a);
  }
  return themes.map((t) => {
    let w = 0;
    let wa = 0;
    let wn = 0;
    const members: ResidentResult[] = [];
    for (const r of results) {
      if (r.themeId !== t.id) continue;
      const rw = ctx.weightOf(r.id);
      const a = attendWeight(r, ctx);
      w += rw;
      wa += rw * a;
      wn += rw * (1 - a);
      members.push(r);
    }
    // Example quotes: prefer the most exposed residents, then the strongest opinions.
    const quoteIds = members
      .slice()
      .sort((a, b) => b.exposure.score - a.exposure.score || Math.abs(b.stance) - Math.abs(a.stance) || a.id - b.id)
      .slice(0, 4)
      .map((r) => r.id);
    return {
      ...t,
      share: totalW > 0 ? w / totalW : 0,
      missingGap: (nonAttW > 0 ? wn / nonAttW : 0) - (attW > 0 ? wa / attW : 0),
      quoteIds,
    };
  });
}

/** Generic outreach ideas per group (used for live runs and the built-in demo data). */
const CHANNEL_IDEAS: Record<string, string[]> = {
  young_renters: ['Instagram and TikTok posts from the mairie', 'Pop-up stand at a metro exit at 8 am', 'Student union and coworking newsletters'],
  families: ['Stands at school gates at pick-up time', 'Short online survey shared by parents’ associations', 'Saturday-morning session with childcare'],
  retirees: ['Senior clubs and the CCAS', 'Paper questionnaire at the mairie annexe'],
  car_owners: ['Leaflets on parked cars', 'Survey with residential-parking permit renewals'],
  heavy_car_owners: ['Letter to holders of residential-parking permits for heavy vehicles', 'Session with local garages and delivery firms'],
  non_eu: ['Multilingual leaflets (Arabic, Chinese, Tamil, Bambara)', 'Partner with community associations and places of worship', 'Make clear that everyone can attend, not only voters'],
  social_housing: ['Door-to-door with social landlords (bailleurs)', 'Meetings in tenants’ association rooms', 'Posters in building halls'],
  workers: ['Evening or weekend sessions (after work hours)', 'Stands at markets and transport hubs', 'Works-council and union channels'],
  cadres: ['Online consultation', 'Business-district newsletters'],
  suburb_residents: ['Joint session with the neighbouring commune', 'Ads in the RER and on suburban bus lines'],
  students: ['University and lycée channels', 'Short-form video explainer'],
  // group ids used by the pipeline (pipeline/build_population.py)
  families_with_kids: ['Stands at school gates at pick-up time', 'Saturday-morning session with childcare'],
  single_parents: ['Short online survey shared by schools and crèches', 'Evening session with childcare provided'],
  retired_owners: ['Senior clubs and the CCAS', 'Paper questionnaire at the mairie annexe'],
  seniors_75: ['Home visits with social services', 'Paper questionnaire with a prepaid envelope'],
  professionals: ['Online consultation', 'Business-district newsletters'],
  service_workers: ['Evening or weekend sessions (after work hours)', 'Stands at markets and transport hubs'],
  manual_workers: ['Works-council and union channels', 'Early-morning stands at transport hubs'],
  shopkeepers_artisans: ['Visits to shops with the local chamber of commerce', 'Session with traders’ associations'],
  no_car: ['Posters at bus stops and metro stations', 'Cycling and pedestrian associations'],
  cannot_vote: ['Multilingual leaflets (Arabic, Chinese, Tamil, Bambara)', 'Partner with community associations', 'Make clear that everyone can attend, not only voters'],
};

/**
 * "Who to consult": groups that are strongly touched by the proposal but under-represented
 * among likely participants. Scores = exposure x how much they are under-heard.
 */
export function buildConsultRecs(
  groupAggs: GroupAgg[],
  results: ResidentResult[],
  residentsById: Map<number, Resident>,
  themes: Theme[],
  ctx: AggContext,
  max = 4,
): ConsultRec[] {
  // Prefer groups that are clearly touched (exposure >= 0.5); fall back to the most touched ones.
  const candidates = groupAggs.filter((g) => g.n >= 5 && g.representationRatio < 0.9);
  const touched = candidates.filter((g) => g.meanExposure >= 0.5);
  const pool = touched.length ? touched : candidates;
  const scored = pool
    .map((g) => ({ g, score: (g.meanExposure + 0.1) * Math.max(0, 1 - g.representationRatio) }))
    .filter((x) => x.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored.map(({ g }) => {
    const members = results.filter((r) => residentsById.get(r.id)?.groupIds.includes(g.groupId));
    // Where they live: the districts with the most (weighted) members.
    const byDistrict = new Map<number, number>();
    for (const r of members) {
      const d = residentsById.get(r.id)?.districtIdx ?? 0;
      if (d) byDistrict.set(d, (byDistrict.get(d) ?? 0) + ctx.weightOf(r.id));
    }
    const districts = [...byDistrict.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
    // What they talk about: their most common themes.
    const themeCount = new Map<string, number>();
    for (const r of members) if (r.themeId) themeCount.set(r.themeId, (themeCount.get(r.themeId) ?? 0) + ctx.weightOf(r.id));
    const topThemes = [...themeCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([id]) => themes.find((t) => t.id === id))
      .filter((t): t is Theme => Boolean(t));
    const ratio = g.representationRatio;
    const why =
      `Computed exposure ${g.meanExposure.toFixed(1)} / 3, but they make up ` +
      `${ratio < 0.05 ? 'almost none' : `${ratio.toFixed(1)}×`} of their fair share among likely participants. ` +
      `${g.everyone.yesShare >= 0.5 ? 'Mostly in favour' : 'Mostly against'} (${Math.round(g.everyone.yesShare * 100)}% in favour).`;
    return {
      groupId: g.groupId,
      label: g.label,
      why,
      meanExposure: g.meanExposure,
      representationRatio: ratio,
      districts,
      channels: CHANNEL_IDEAS[g.groupId] ?? ['Targeted outreach through local associations', 'Session at a time and place this group can reach'],
      hypotheses: topThemes.length
        ? topThemes.map((t) => `Check whether “${t.label.toLowerCase()}” really matters to them, and how much.`)
        : ['Check whether they know about the proposal at all.'],
    };
  });
}

// ---------- uncertainty ----------

/** Bootstrap 90% interval for yesShare (resampling residents with replacement). */
export function bootstrapYesRange(rows: WeightedStance[], iterations = 200, seed = 7): [number, number] | undefined {
  if (rows.length < 5) return undefined;
  const rng = makeRng(seed);
  const values: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sup = 0;
    let opp = 0;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[Math.floor(rng() * rows.length)];
      if (r.stance >= 1) sup += r.weight;
      else if (r.stance <= -1) opp += r.weight;
    }
    values.push(sup + opp > 0 ? sup / (sup + opp) : 0.5);
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(iterations * 0.05)], values[Math.floor(iterations * 0.95) - 1]];
}

// ---------- backtest ----------

export function meanAbsError(a: number[], b: number[]): number {
  if (a.length === 0) return 0;
  return a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length;
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Simulated yes share per votation sector, compared with the official one. */
export function backtestBySector(
  sectors: { sector: string; actualYes: number; actualTurnout?: number }[],
  districts: District[],
  results: ResidentResult[],
  residentsById: Map<number, Resident>,
  ctx: AggContext,
): Pick<Backtest, 'bySector' | 'metrics'> {
  const bySector: BacktestSector[] = sectors.map((s) => {
    const idxs = districts.filter((d) => d.sector === s.sector).map((d) => d.idx);
    const members = results.filter((r) => idxs.includes(residentsById.get(r.id)?.districtIdx ?? -1));
    return {
      sector: s.sector,
      districtIdxs: idxs,
      actualYes: s.actualYes,
      actualTurnout: s.actualTurnout,
      simEveryoneYes: viewAgg(rowsForView('everyone', members, ctx)).yesShare,
      simAttendeesYes: viewAgg(rowsForView('attendees', members, ctx)).yesShare,
    };
  });
  const actual = bySector.map((s) => s.actualYes);
  const sim = bySector.map((s) => s.simAttendeesYes);
  return { bySector, metrics: { sectorMae: meanAbsError(sim, actual), sectorCorrelation: pearson(sim, actual) } };
}

/** All the aggregates a Scenario carries (views, after-talk views, districts, groups). */
export function computeAggregates(
  results: ResidentResult[],
  residentsById: Map<number, Resident>,
  groups: GroupDef[],
  ctx: AggContext,
  withRanges = true,
): Scenario['aggregates'] {
  const views = computeViews(results, ctx);
  if (withRanges) {
    for (const v of VIEWS) views[v].yesRange = bootstrapYesRange(rowsForView(v, results, ctx), 200, 11);
  }
  const hasTalk = results.some((r) => r.stanceAfter !== undefined);
  const viewsAfterTalk = hasTalk ? computeViews(results, { ...ctx, afterTalk: true }) : undefined;
  return {
    views,
    viewsAfterTalk,
    byDistrict: aggregateByDistrict(results, residentsById, ctx),
    byGroup: aggregateByGroup(results, residentsById, groups, ctx),
  };
}
