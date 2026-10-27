/**
 * "Your proposal": sample 150 residents, compute what changes for each one (no AI),
 * ask the live API for their reactions in small batches, then summarise exactly like the pipeline.
 */
import type { ITownMap } from '../mapApi';
import type { AskRequest, Channel, District, ReactRequest, Resident, ResidentResult, Scenario } from '../types';
import {
  attendanceProbabilities,
  buildConsultRecs,
  computeAggregates,
  participationScore,
  pickAttendees,
  themeStats,
  type AggContext,
} from './aggregate';
import { reactBatch, runPool } from './api';
import type { AppData } from './data';
import { buildAreaIndex, computeCustomExposure, sampleForCustom, SITE_RING_OPTIONS, type CustomArea } from './exposure';
import { hashString } from './random';

export const SAMPLE_SIZE = 150;
const BATCH = 5;
const CONCURRENCY = 3;

export interface CustomDraft {
  text: string;
  areaKind: 'districts' | 'site';
  districts: number[];
  site: { x: number; y: number } | null;
  ringOption: number;
  channel: Channel;
  turnout: number;
}

export interface RunProgress {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  done: number;
  total: number;
  failed: number;
  message?: string;
}

export interface CustomRunResult {
  scenario: Scenario;
  aggCtx: AggContext;
}

export function draftArea(d: CustomDraft): CustomArea | null {
  if (d.areaKind === 'districts') return d.districts.length ? { kind: 'districts', districts: d.districts } : null;
  if (!d.site) return null;
  return { kind: 'site', x: d.site.x + 0.5, y: d.site.y + 0.5, ringsTiles: SITE_RING_OPTIONS[d.ringOption]?.rings ?? [5, 10, 20], label: 'your site' };
}

export function draftProblems(d: CustomDraft): string[] {
  const out: string[] = [];
  if (d.text.trim().length < 15) out.push('Describe the proposal in a sentence or two.');
  if (!draftArea(d)) out.push(d.areaKind === 'districts' ? 'Click at least one district on the map.' : 'Click the map to place the site.');
  return out;
}

function districtLabel(d: District | undefined): string {
  if (!d) return 'Île-de-France';
  return d.kind === 'arrondissement' ? `Paris ${d.name}` : d.name;
}

export async function runCustomProposal(opts: {
  draft: CustomDraft;
  data: AppData;
  map: ITownMap | null;
  signal: AbortSignal;
  onProgress: (p: RunProgress) => void;
}): Promise<CustomRunResult> {
  const { draft, data, map, signal, onProgress } = opts;
  const area = draftArea(draft);
  if (!area) throw new Error('Pick an area first.');
  const districtsByIdx = new Map(data.map.districtList.map((d) => [d.idx, d]));
  const idx = buildAreaIndex(data.map, area);
  const sample = sampleForCustom(data.population.residents, idx, SAMPLE_SIZE, draft.text);
  const members = sample.members.map((m) => ({ ...m, exposure: computeCustomExposure(m.resident, idx, districtsByIdx) }));
  const weightById = new Map(members.map((m) => [m.resident.id, m.weight]));

  // Show who is being asked: everyone in the sample starts "thinking".
  const total = members.length;
  let done = 0;
  let failed = 0;
  let mock = false;
  let model = '';
  let lastError = '';
  const answers = new Map<number, ReactRequestResult>();
  onProgress({ status: 'running', done, total, failed });

  const batches: (typeof members)[] = [];
  for (let i = 0; i < members.length; i += BATCH) batches.push(members.slice(i, i + BATCH));

  const jobs = batches.map((batch) => async () => {
    if (signal.aborted) return;
    const ids = batch.map((m) => m.resident.id);
    map?.setThinking(ids);
    const req: ReactRequest = {
      proposalFr: draft.text.trim(),
      residents: batch.map((m) => ({ ...residentForApi(m.resident, districtLabel(districtsByIdx.get(m.resident.districtIdx))), exposure: m.exposure })),
    };
    try {
      const res = await reactBatch(req, signal);
      mock = mock || res.mock;
      model = res.model;
      for (const r of res.results) {
        if (!ids.includes(r.id)) continue;
        answers.set(r.id, r);
        map?.revealResult(r.id, r.stance);
      }
      const missing = ids.filter((id) => !answers.has(id));
      failed += missing.length;
      for (const id of missing) map?.revealResult(id, 0);
    } catch (err) {
      if (signal.aborted) return;
      failed += ids.length;
      lastError = (err as Error).message;
      for (const id of ids) map?.revealResult(id, 0);
    }
    done += ids.length;
    onProgress({ status: 'running', done, total, failed, message: lastError || undefined });
  });

  await runPool(jobs, CONCURRENCY);
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
  if (answers.size === 0) throw new Error(lastError || 'No resident answered. Check that the API is running, then try again.');

  // Build results exactly like the pipeline does.
  const voterScope: Scenario['voterScope'] = draft.channel === 'votation' ? 'paris_eligible' : 'all_residents';
  const results: ResidentResult[] = [];
  for (const m of members) {
    const a = answers.get(m.resident.id);
    if (!a) continue;
    const eligible = voterScope === 'paris_eligible' ? m.resident.eligibleParis : true;
    const side = a.stance >= 1 ? 'support' : a.stance <= -1 ? 'oppose' : 'neutral';
    results.push({
      id: m.resident.id,
      exposure: m.exposure,
      stance: a.stance,
      affectedLLM: a.affectedLLM,
      behaviourEn: a.behaviourEn,
      reasonFr: a.reasonFr,
      reasonEn: a.reasonEn,
      wouldParticipateLLM: a.wouldParticipateLLM,
      // Votes: only registered voters (participationBase is 0 for everyone else).
      // Meetings and online consultations are open to all residents, so we use the propensity
      // without the "cannot vote" zero, like the pipeline does.
      participationScore: participationScore(
        draft.channel === 'votation' ? m.resident.participationBase : m.resident.participationPropensity ?? m.resident.participationBase,
        m.exposure.score,
        a.wouldParticipateLLM,
      ),
      eligible,
      attendee: false,
      themeId: `side_${side}`,
    });
  }
  const rows = results.map((r) => ({ id: r.id, eligible: r.eligible, score: r.participationScore, weight: weightById.get(r.id) ?? 1 }));
  const attendees = pickAttendees(rows, draft.turnout);
  for (const r of results) r.attendee = attendees.has(r.id);
  const attendProb = attendanceProbabilities(rows, draft.turnout);
  const aggCtx: AggContext = { weightOf: (id) => weightById.get(id) ?? 0, attendProb };

  const residentsById = new Map(data.population.residents.map((r) => [r.id, r]));
  const aggregates = computeAggregates(results, residentsById, data.population.groups, aggCtx);
  // No AI clustering in live runs: themes are simply the three sides, with real quotes.
  const themes = themeStats(
    [
      { id: 'side_oppose', label: 'Reasons against', labelFr: 'Raisons contre', side: 'oppose' },
      { id: 'side_support', label: 'Reasons in favour', labelFr: 'Raisons pour', side: 'support' },
      { id: 'side_neutral', label: 'Undecided or not concerned', labelFr: 'Indécis ou pas concernés', side: 'mixed' },
    ],
    results,
    aggCtx,
  );
  const consult = buildConsultRecs(aggregates.byGroup, results, residentsById, themes, aggCtx);

  const lonlat = (x: number, y: number) => ({
    lon: data.map.bbox.lonMin + (x / data.map.width) * (data.map.bbox.lonMax - data.map.bbox.lonMin),
    lat: data.map.bbox.latMax - (y / data.map.height) * (data.map.bbox.latMax - data.map.bbox.latMin),
  });
  const title = draft.text.trim().split(/[.!?\n]/)[0].slice(0, 70) || 'Your proposal';
  const scenario: Scenario = {
    version: 1,
    id: `custom-${hashString(draft.text + JSON.stringify(area)).toString(16)}`,
    title: title.length < draft.text.trim().length ? `${title}…` : title,
    titleFr: title,
    summary: `Your proposal, tested live on ${results.length} residents (${sample.nearCount} in or near the area, the rest elsewhere, re-weighted to represent the whole town).`,
    proposalFr: draft.text.trim(),
    proposalEn: draft.text.trim(),
    kind: 'custom',
    channel: draft.channel,
    turnoutTarget: draft.turnout,
    voterScope,
    site:
      area.kind === 'site'
        ? { ...lonlat(area.x, area.y), x: Math.floor(area.x), y: Math.floor(area.y), label: 'Your site', ringsTiles: area.ringsTiles }
        : undefined,
    zoneDistricts: area.kind === 'districts' ? area.districts : undefined,
    mock,
    models: { reaction: model || 'unknown' },
    generatedAt: new Date().toISOString(),
    results,
    conversations: [],
    aggregates,
    themes,
    consult,
    uncertainty: { method: `Bootstrap over the ${results.length} sampled residents (90% range).`, runs: 1 },
    notes: [
      'Live run on a small sample: ranges are wide. Run the batch pipeline for the full 2,000 residents and neighbour conversations.',
      '“Likely to show up” counts each resident in proportion to their calibrated chance of taking part.',
      ...(failed ? [`${failed} residents did not answer and are left out.`] : []),
    ],
  };
  onProgress({ status: 'done', done: total, total, failed, message: lastError || undefined });
  return { scenario, aggCtx };
}

type ReactRequestResult = Awaited<ReturnType<typeof reactBatch>>['results'][number];

/** The resident fields the API is allowed to see (same shape for /api/ask and /api/react). */
export function residentForApi(r: Resident, districtName: string): AskRequest['resident'] {
  return {
    id: r.id,
    name: r.name,
    age: r.age,
    sex: r.sex,
    occupation: r.occupation,
    household: r.household,
    personaFr: r.personaFr,
    imputed: r.imputed,
    commuteMode: r.commuteMode,
    districtName,
  };
}
