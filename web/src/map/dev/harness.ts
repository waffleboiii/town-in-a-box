/**
 * Renderer test harness (map-test.html). Loads the real data from /data/*.json when present
 * (?data=real) and otherwise uses the synthetic fixtures. A small control panel exercises every
 * ITownMap method; URL parameters drive the same actions for headless screenshots:
 *
 *   ?data=real  &view=x,y,zoom  &fit=1  &scenario=0|1|<id>  &mode=everyone|eligible|attendees&modeAt=ms
 *   &select=<id>|auto&bubble=text  &conv=<index>&convAt=ms&lang=fr  &overlay=stance|exposure|districts|backtest_actual
 *   &group=<id>  &pick=districts|site&picked=1,2  &ambient=1  &think=1  &after=1  &panel=0
 */
import { createTownMap, renderPortrait } from '../index';
import type { ITownMap, Overlay } from '../../mapApi';
import type { MapFile, PopulationFile, Scenario, ScenarioIndexEntry, ViewMode } from '../../types';
import { makeFixtureMap, makeFixturePopulation, makeFixtureScenario } from './fixtures';

const params = new URLSearchParams(location.search);

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function loadData(): Promise<{ map: MapFile; pop: PopulationFile; scenarios: Scenario[]; source: string }> {
  if (params.get('data') === 'real') {
    const map = await fetchJson<MapFile>('/data/map.json');
    const pop = await fetchJson<PopulationFile>('/data/population.json');
    if (map && pop) {
      const scenarios: Scenario[] = [];
      const index = await fetchJson<ScenarioIndexEntry[]>('/data/scenarios/index.json');
      for (const e of index ?? []) {
        const s = await fetchJson<Scenario>(`/data/scenarios/${e.id}.json`);
        if (s) scenarios.push(s);
      }
      if (!scenarios.length) scenarios.push(makeFixtureScenario(map, pop));
      return { map, pop, scenarios, source: `real data (${scenarios.length} scenario${scenarios.length > 1 ? 's' : ''})` };
    }
  }
  const map = makeFixtureMap();
  const pop = makeFixturePopulation(map, Number(params.get('n') ?? 2000));
  return { map, pop, scenarios: [makeFixtureScenario(map, pop)], source: 'fixtures' };
}

function button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = onClick;
  parent.appendChild(b);
  return b;
}

async function main(): Promise<void> {
  const el = document.getElementById('map')!;
  const panel = document.getElementById('panel')!;
  const status = document.getElementById('status')!;
  const t0 = performance.now();
  document.title = 'stage=load';
  const { map, pop, scenarios, source } = await loadData();
  const tData = performance.now();
  document.title = `stage=mount data=${Math.round(tData - t0)}ms`;
  const town: ITownMap = createTownMap();
  (window as unknown as { __town: ITownMap }).__town = town;
  await town.mount(el, map, pop);
  const mountMs = Math.round(performance.now() - tData);
  document.title = `stage=ready data=${Math.round(tData - t0)}ms mount=${mountMs}ms`;
  let scenario: Scenario | null = null;
  const log = (m: string) => {
    const line = document.createElement('div');
    line.textContent = m;
    document.getElementById('log')!.prepend(line);
  };
  town.on('residentClick', (id) => {
    log(`residentClick ${id}`);
    const r = pop.residents.find((x) => x.id === id);
    const res = scenario?.results.find((x) => x.id === id);
    town.selectResident(id, { bubbleText: res ? `(simulated voice) ${res.reasonEn}` : `Hi, I'm ${r?.name ?? id}!` });
    const portrait = document.getElementById('portrait')!;
    portrait.replaceChildren();
    if (r) portrait.appendChild(renderPortrait(r.look, 4));
  });
  town.on('districtClick', (d) => log(`districtClick ${d} ${map.districtList.find((x) => x.idx === d)?.name ?? ''}`));
  town.on('tileClick', (x, y) => log(`tileClick ${x},${y}`));

  // ---- control panel
  const row = (title: string) => {
    const r = document.createElement('div');
    r.className = 'row';
    const t = document.createElement('span');
    t.textContent = title;
    r.appendChild(t);
    panel.appendChild(r);
    return r;
  };
  const r1 = row('scenario');
  button(r1, 'none', () => {
    scenario = null;
    town.setScenario(null);
  });
  scenarios.forEach((s, i) =>
    button(r1, `#${i} ${s.id.slice(0, 18)}`, () => {
      scenario = s;
      town.setScenario(s);
    }),
  );
  const r2 = row('view');
  for (const m of ['everyone', 'eligible', 'attendees'] as ViewMode[]) button(r2, m, () => town.setViewMode(m));
  button(r2, 'after talk', () => town.setAfterTalk(true));
  button(r2, 'before', () => town.setAfterTalk(false));
  const r3 = row('overlay');
  for (const o of ['none', 'stance', 'exposure', 'districts', 'backtest_actual', 'backtest_sim'] as Overlay[]) button(r3, o, () => town.setOverlay(o));
  const r4 = row('camera');
  button(r4, 'fit', () => town.fitAll());
  button(r4, 'Paris', () => town.focus(131, 105, 1.2));
  button(r4, 'site', () => scenario?.site && town.focus(scenario.site.x, scenario.site.y, 2.2));
  button(r4, '11e', () => town.focusDistrict(11));
  const r5 = row('people');
  button(r5, 'select random', () => {
    const id = Math.floor(Math.random() * pop.residents.length);
    town.selectResident(id, { bubbleText: 'Simulated voice: this is what changes for me.' });
  });
  button(r5, 'deselect', () => town.selectResident(null));
  button(r5, 'conversation', () => scenario?.conversations[0] && town.playConversation(scenario.conversations[Math.floor(Math.random() * scenario.conversations.length)]));
  button(r5, 'ambient on', () => town.setAmbientConversations(true));
  button(r5, 'group: car owners', () => town.highlightGroup('car_owners'));
  button(r5, 'group off', () => town.highlightGroup(null));
  const r6 = row('live');
  button(r6, 'thinking x40', () => {
    const ids = pop.residents.slice(0, 400).filter((_, i) => i % 10 === 0).map((r) => r.id);
    town.setThinking(ids);
    ids.forEach((id, k) => setTimeout(() => town.revealResult(id, Math.round(Math.random() * 4 - 2)), 1500 + k * 120));
  });
  button(r6, 'pick districts', () => town.setPickMode('districts'));
  button(r6, 'pick site', () => town.setPickMode('site'));
  button(r6, 'pick off', () => town.setPickMode('none'));

  // ---- URL-driven actions (for headless screenshots)
  const sc = params.get('scenario');
  if (sc !== null && sc !== '0' && sc !== 'none') {
    scenario = scenarios.find((s) => s.id === sc) ?? scenarios[0];
    town.setScenario(scenario);
  }
  if (params.get('after') === '1') town.setAfterTalk(true);
  const view = params.get('view');
  if (view) {
    const [x, y, z] = view.split(',').map(Number);
    town.focus(x, y, z, false);
  } else if (params.get('fit') === '1') town.fitAll();
  const ov = params.get('overlay') as Overlay | null;
  if (ov) town.setOverlay(ov);
  const group = params.get('group');
  if (group) town.highlightGroup(group);
  const mode = params.get('mode') as ViewMode | null;
  if (mode) setTimeout(() => town.setViewMode(mode), Number(params.get('modeAt') ?? 0));
  const pick = params.get('pick') as 'districts' | 'site' | null;
  if (pick) town.setPickMode(pick);
  const picked = params.get('picked');
  if (picked) town.setPickedDistricts(picked.split(',').map(Number));
  if (params.get('custom')) {
    const [x, y] = params.get('custom')!.split(',').map(Number);
    town.setCustomSite({ x, y, ringsTiles: [5, 10], label: 'Your proposed site' });
  }
  if (params.get('ambient') === '1') town.setAmbientConversations(true);
  if (params.get('think') === '1') {
    const ids = pop.residents.filter((r) => Math.abs(r.home[0] - 131) < 14 && Math.abs(r.home[1] - 102) < 9).map((r) => r.id);
    town.setThinking(ids);
    ids.slice(0, Math.floor(ids.length / 2)).forEach((id, k) => setTimeout(() => town.revealResult(id, (k % 5) - 2), 600 + k * 40));
  }
  const sel = params.get('select');
  if (sel) {
    let id = Number(sel);
    if (sel === 'auto' && scenario) {
      const best = scenario.results.filter((r) => r.exposure.reasons.length >= 3 && pop.residents[r.id]?.work).sort((a, b) => b.exposure.reasons.length - a.exposure.reasons.length)[0];
      id = best?.id ?? 0;
    }
    setTimeout(() => town.selectResident(id, { bubbleText: params.get('bubble') ?? undefined }), Number(params.get('selectAt') ?? 0));
    const r = pop.residents.find((x) => x.id === id);
    if (r) document.getElementById('portrait')!.appendChild(renderPortrait(r.look, 4));
  }
  const conv = params.get('conv');
  if (conv !== null && scenario) {
    const c = scenario.conversations[Number(conv) % scenario.conversations.length];
    setTimeout(() => void town.playConversation(c, { lang: (params.get('lang') as 'en' | 'fr') ?? 'en' }), Number(params.get('convAt') ?? 0));
  }
  if (params.get('panel') === '0') {
    panel.style.display = 'none';
    status.style.display = 'none';
    document.getElementById('log')!.style.display = 'none';
  }

  // ---- FPS meter
  let frames = 0;
  let last = performance.now();
  const loop = () => {
    frames++;
    const now = performance.now();
    if (now - last > 1000) {
      status.textContent = `${source} | ${pop.residents.length} residents | data ${Math.round(tData - t0)} ms | mount ${mountMs} ms | ${Math.round((frames * 1000) / (now - last))} fps`;
      document.title = `fps=${Math.round((frames * 1000) / (now - last))} data=${Math.round(tData - t0)} mount=${mountMs}`;
      frames = 0;
      last = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e) => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#fff;position:fixed;bottom:0;left:0;white-space:pre-wrap';
  pre.textContent = String(e?.stack ?? e);
  document.body.appendChild(pre);
  throw e;
});
