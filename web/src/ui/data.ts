/**
 * Loading the data files written by the pipeline (web/public/data/...).
 * If a file is missing, we generate built-in demo data instead (web/src/ui/dev/fixtures.ts)
 * and remember that, so the UI can say so.
 */
import type { MapFile, PopulationFile, Scenario, ScenarioIndexEntry } from '../types';

export type DataSource = 'pipeline' | 'demo';

export interface AppData {
  map: MapFile;
  population: PopulationFile;
  index: ScenarioIndexEntry[];
  /** Where each part came from. */
  sources: { map: DataSource; population: DataSource; scenarios: DataSource };
}

type Progress = (fraction: number, label: string) => void;

/** Fetch JSON, reporting download progress. Returns null if the file is missing or not JSON. */
async function fetchJson<T>(url: string, onBytes?: (loaded: number, total: number) => void): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    // The dev server answers unknown paths with index.html; treat that as "missing".
    if (type.includes('text/html')) return null;
    const total = Number(res.headers.get('content-length') ?? 0);
    if (!res.body || !onBytes) return (await res.json()) as T;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onBytes(loaded, total);
    }
    const all = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    return JSON.parse(new TextDecoder().decode(all)) as T;
  } catch {
    return null;
  }
}

let demoScenarios: Record<string, Scenario> | null = null;

/** ?data=demo forces the built-in demo data (handy to test the UI without pipeline files). */
function forceDemo(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('data') === 'demo';
  } catch {
    return false;
  }
}

export async function loadAppData(onProgress: Progress): Promise<AppData> {
  const demo = forceDemo();
  const get = <T>(url: string, onBytes?: (loaded: number, total: number) => void) => (demo ? Promise.resolve(null) : fetchJson<T>(url, onBytes));
  onProgress(0.02, 'Unrolling the map');
  let map = await get<MapFile>('/data/map.json', (l, t) => onProgress(0.02 + 0.25 * (t ? l / t : 0.5), 'Unrolling the map'));
  const sources: AppData['sources'] = { map: 'pipeline', population: 'pipeline', scenarios: 'pipeline' };
  const fixtures = await (map ? Promise.resolve(null) : import('./dev/fixtures'));
  if (!map && fixtures) {
    map = fixtures.makeFixtureMap();
    sources.map = 'demo';
  }

  onProgress(0.3, 'Waking up the residents');
  let population = await get<PopulationFile>('/data/population.json', (l, t) =>
    onProgress(0.3 + 0.3 * (t ? l / t : 0.5), 'Waking up the residents'),
  );
  if (!population) {
    const fx = fixtures ?? (await import('./dev/fixtures'));
    population = fx.makeFixturePopulation(map!);
    sources.population = 'demo';
  }

  onProgress(0.62, 'Reading the proposals');
  let index = await get<ScenarioIndexEntry[]>('/data/scenarios/index.json');
  // Demo population ids do not match real scenario files, so regenerate scenarios too.
  if (!index || !Array.isArray(index) || index.length === 0 || sources.population === 'demo') {
    const fx = fixtures ?? (await import('./dev/fixtures'));
    const bundle = fx.makeFixtureScenarios(map!, population);
    demoScenarios = bundle.scenarios;
    index = bundle.index;
    sources.scenarios = 'demo';
  }
  onProgress(0.7, 'Painting the town');
  return { map: map!, population, index, sources };
}

const cache = new Map<string, Scenario>();

export async function loadScenario(id: string, source: DataSource): Promise<Scenario> {
  const hit = cache.get(id);
  if (hit) return hit;
  let s: Scenario | null = null;
  if (source === 'demo' && demoScenarios) s = demoScenarios[id] ?? null;
  else s = await fetchJson<Scenario>(`/data/scenarios/${encodeURIComponent(id)}.json`);
  if (!s) throw new Error(`Scenario “${id}” could not be loaded.`);
  cache.set(id, s);
  return s;
}

/** Order for the top bar: hypothetical first (the headline), then real votes (newest first). */
export function sortIndex(index: ScenarioIndexEntry[]): ScenarioIndexEntry[] {
  const rank = { hypothetical: 0, backtest: 1, custom: 2 } as const;
  return index
    .filter((e) => e.kind !== 'custom')
    .slice()
    .sort((a, b) => rank[a.kind] - rank[b.kind] || (b.date ?? '').localeCompare(a.date ?? ''));
}
