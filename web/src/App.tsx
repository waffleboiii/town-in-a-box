/**
 * Town-in-a-Box: the app shell.
 * Loads the data, mounts the town map (through ITownMap only), keeps the UI state
 * (scenario, view, selected resident, tabs) and pushes that state to the map.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Overlay } from './mapApi';
import type { ApiHealth, AskRequest, Resident, ResidentResult, Scenario, ScenarioIndexEntry, ViewMode } from './types';
import { rowsForView, viewAgg, type AggContext } from './ui/aggregate';
import { askResident, getHealth, isApiOffline } from './ui/api';
import { CustomComposer } from './ui/components/CustomComposer';
import { InsightPanel, availableTabs } from './ui/components/InsightPanel';
import { LoadingScreen } from './ui/components/LoadingScreen';
import { MethodologyModal } from './ui/components/MethodologyModal';
import { Onboarding } from './ui/components/Onboarding';
import { ProposalPanel } from './ui/components/ProposalPanel';
import { ResidentCard, type AskEntry } from './ui/components/ResidentCard';
import { TopBar } from './ui/components/TopBar';
import { ViewDock } from './ui/components/ViewDock';
import { AppCtx, districtName, type AppCtxValue, type OverlayChoice, type TabId } from './ui/context';
import { residentForApi, runCustomProposal, type CustomDraft, type CustomRunResult, type RunProgress } from './ui/customRun';
import { loadAppData, loadScenario, sortIndex, type AppData } from './ui/data';
import { SITE_RING_OPTIONS } from './ui/exposure';
import { firstSentence } from './ui/format';
import { safeStorage, useLatest, useMediaQuery } from './ui/hooks';
import { Icon } from './ui/icons';
import { CHANNEL_TURNOUT } from './ui/labels';
import { createAndMountTownMap, type TownMapHandle } from './ui/townMapFactory';

const ONBOARD_KEY = 'tib.onboarded.v1';

const EMPTY_DRAFT: CustomDraft = {
  text: '',
  areaKind: 'districts',
  districts: [],
  site: null,
  ringOption: 1,
  channel: 'public_meeting',
  turnout: CHANNEL_TURNOUT.public_meeting,
};

/** District colours for the map overlay, from the current scenario and view. */
function overlayValues(
  overlay: OverlayChoice,
  scenario: Scenario | null,
  view: ViewMode,
  afterTalk: boolean,
  residentsById: Map<number, Resident>,
  ctx: AggContext,
  minN: number,
): Record<number, number> | undefined {
  if (!scenario || overlay === 'none') return undefined;
  const out: Record<number, number> = {};
  if (overlay === 'backtest_actual' || overlay === 'backtest_sim') {
    const sectors = afterTalk && scenario.backtestAfterTalk ? scenario.backtestAfterTalk.bySector : scenario.backtest?.bySector ?? [];
    for (const s of sectors) for (const d of s.districtIdxs) out[d] = overlay === 'backtest_actual' ? s.actualYes : s.simAttendeesYes;
    return out;
  }
  const byDistrict = new Map<number, ResidentResult[]>();
  for (const r of scenario.results) {
    const d = residentsById.get(r.id)?.districtIdx;
    if (!d) continue;
    const list = byDistrict.get(d) ?? [];
    list.push(r);
    byDistrict.set(d, list);
  }
  for (const [d, list] of byDistrict) {
    if (overlay === 'exposure') {
      let w = 0;
      let e = 0;
      for (const r of list) {
        const rw = ctx.weightOf(r.id);
        w += rw;
        e += rw * r.exposure.score;
      }
      if (w > 0) out[d] = e / w;
    } else {
      const agg = viewAgg(rowsForView(view, list, { ...ctx, afterTalk }));
      if (agg.n >= minN || (view === 'attendees' && agg.n > 0)) out[d] = agg.yesShare;
    }
  }
  return out;
}

export default function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<AppData | null>(null);
  const [load, setLoad] = useState<{ progress: number; label: string; done: boolean; error: string | null }>({
    progress: 0,
    label: 'Starting',
    done: false,
    error: null,
  });
  const [handle, setHandle] = useState<TownMapHandle | null>(null);
  const [entries, setEntries] = useState<ScenarioIndexEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ id: string; scenario: Scenario } | null>(null);
  const [custom, setCustom] = useState<CustomRunResult | null>(null);
  const [view, setView] = useState<ViewMode>('everyone');
  const [afterTalk, setAfterTalk] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');
  const [selected, setSelected] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<OverlayChoice>('none');
  const [group, setGroup] = useState<string | null>(null);
  const [showMethod, setShowMethod] = useState(false);
  const [showOnboard, setShowOnboard] = useState(false);
  const [proposalCollapsed, setProposalCollapsed] = useState(false);
  const [insightsCollapsed, setInsightsCollapsed] = useState(false);
  const autoCollapsed = useRef(false);
  const [sheet, setSheet] = useState<'proposal' | 'insights' | null>(null);
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [apiOffline, setApiOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asks, setAsks] = useState<Record<string, AskEntry[]>>({});
  const [draft, setDraft] = useState<CustomDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(true);
  const [runProgress, setRunProgress] = useState<RunProgress>({ status: 'idle', done: 0, total: 0, failed: 0 });
  const runAbort = useRef<AbortController | null>(null);
  const narrow = useMediaQuery('(max-width: 820px)');

  // ---------- start-up: data, then the map ----------
  useEffect(() => {
    let cancelled = false;
    let mounted: TownMapHandle | null = null;
    (async () => {
      try {
        const d = await loadAppData((progress, label) => {
          if (!cancelled) setLoad((l) => ({ ...l, progress, label }));
        });
        if (cancelled) return;
        setData(d);
        const sorted = sortIndex(d.index);
        setEntries(sorted);
        setLoad((l) => ({ ...l, progress: 0.72, label: 'Painting the town' }));
        const creep = window.setInterval(() => setLoad((l) => ({ ...l, progress: Math.min(0.97, l.progress + 0.015) })), 120);
        try {
          mounted = await createAndMountTownMap(mapEl.current!, d.map, d.population);
        } finally {
          window.clearInterval(creep);
        }
        if (cancelled) {
          mounted.map.destroy();
          return;
        }
        setHandle(mounted);
        setActiveId(sorted[0]?.id ?? 'custom');
        setLoad({ progress: 1, label: 'Ready', done: true, error: null });
        if (!safeStorage.get(ONBOARD_KEY)) setShowOnboard(true);
      } catch (e) {
        console.error(e);
        if (!cancelled) setLoad((l) => ({ ...l, error: `The town could not be built: ${(e as Error).message}` }));
      }
    })();
    getHealth().then((h) => !cancelled && setHealth(h));
    return () => {
      cancelled = true;
      mounted?.map.destroy();
    };
  }, []);

  // ---------- scenario loading ----------
  useEffect(() => {
    if (!data || !activeId || activeId === 'custom') return;
    let cancelled = false;
    loadScenario(activeId, data.sources.scenarios)
      .then((s) => !cancelled && setLoaded({ id: activeId, scenario: s }))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [data, activeId]);

  const scenario: Scenario | null = activeId === 'custom' ? custom?.scenario ?? null : loaded && loaded.id === activeId ? loaded.scenario : null;
  const isLiveSample = activeId === 'custom' && Boolean(custom);
  const map = handle?.map ?? null;

  // ---------- lookups ----------
  const residentsById = useMemo(() => new Map((data?.population.residents ?? []).map((r) => [r.id, r])), [data]);
  const districtsByIdx = useMemo(() => new Map((data?.map.districtList ?? []).map((d) => [d.idx, d])), [data]);
  // Population groups plus the current scenario's own groups (e.g. "renters within 2 km of the site").
  const groupsById = useMemo(
    () => new Map([...(data?.population.groups ?? []), ...(scenario?.extraGroups ?? [])].map((g) => [g.id, g])),
    [data, scenario],
  );
  const resultsById = useMemo(() => new Map((scenario?.results ?? []).map((r) => [r.id, r])), [scenario]);
  const aggCtx = useMemo<AggContext>(
    () => (isLiveSample && custom ? custom.aggCtx : { weightOf: (id: number) => residentsById.get(id)?.weight ?? 1 }),
    [isLiveSample, custom, residentsById],
  );
  const hasTalk = Boolean(scenario?.aggregates.viewsAfterTalk) && (scenario?.conversations.length ?? 0) > 0;
  const talkOn = afterTalk && hasTalk;
  const views = scenario ? (talkOn && scenario.aggregates.viewsAfterTalk ? scenario.aggregates.viewsAfterTalk : scenario.aggregates.views) : null;

  // ---------- reset some state when the scenario changes ----------
  const lastScenarioId = useRef<string | null>(null);
  useEffect(() => {
    const id = scenario?.id ?? null;
    if (id === lastScenarioId.current) return;
    lastScenarioId.current = id;
    setOverlay('none');
    setGroup(null);
    if (!hasTalk) setAfterTalk(false);
    if (!availableTabs(scenario).includes(tab)) setTab('overview');
    if (selected !== null && scenario && !scenario.results.some((r) => r.id === selected)) setSelected(null);
  }, [scenario]);

  // ---------- push state to the map (order matters: scenario first) ----------
  useEffect(() => {
    if (!map) return;
    map.setScenario(scenario);
    map.setAmbientConversations(Boolean(scenario?.conversations.length));
  }, [map, scenario]);

  // A scenario with a site (the data centre) opens on that site, so its rings are not hidden
  // under the top bar. The point is shifted a little south so the site sits in the visible
  // middle of the map, between the top bar and the bottom chalkboard.
  const framedScenario = useRef<string | null>(null);
  useEffect(() => {
    if (!map || !scenario || narrow) return;
    if (framedScenario.current === scenario.id) return;
    framedScenario.current = scenario.id;
    if (scenario.site && scenario.kind !== 'custom') map.focus(scenario.site.x, scenario.site.y + 8, 0.62, true);
  }, [map, scenario, narrow]);
  useEffect(() => map?.setViewMode(view), [map, view, scenario]);
  useEffect(() => map?.setAfterTalk(talkOn), [map, talkOn, scenario]);
  useEffect(() => map?.highlightGroup(group), [map, group, scenario]);
  const values = useMemo(
    () => overlayValues(overlay, scenario, view, talkOn, residentsById, aggCtx, isLiveSample ? 3 : 8),
    [overlay, scenario, view, talkOn, residentsById, aggCtx, isLiveSample],
  );
  useEffect(() => map?.setOverlay(overlay as Overlay, values), [map, overlay, values]);

  // Custom proposal: pick districts or a site on the map while editing.
  const pickActive = activeId === 'custom' && editing && runProgress.status !== 'running';
  useEffect(() => {
    if (!map) return;
    if (!pickActive) {
      map.setPickMode('none');
      map.setPickedDistricts([]);
      map.setCustomSite(null);
      return;
    }
    map.setPickMode(draft.areaKind);
    map.setPickedDistricts(draft.areaKind === 'districts' ? draft.districts : []);
    map.setCustomSite(
      draft.areaKind === 'site' && draft.site
        ? { x: draft.site.x, y: draft.site.y, ringsTiles: SITE_RING_OPTIONS[draft.ringOption]?.rings ?? [5, 10, 20], label: 'Your site' }
        : null,
    );
  }, [map, pickActive, draft]);

  // Selected resident -> camera, markers and a speech bubble with their reaction.
  useEffect(() => {
    if (!map) return;
    if (selected === null) {
      map.selectResident(null);
      return;
    }
    const r = resultsById.get(selected);
    map.selectResident(selected, r ? { bubbleText: firstSentence(r.reasonEn, 80) } : undefined);
  }, [map, selected, resultsById]);

  // ---------- actions ----------
  const openCard = useCallback((id: number | null, fromMap = false) => {
    setSelected(id);
    if (id !== null && fromMap) {
      setInsightsCollapsed((c) => {
        if (!c) autoCollapsed.current = true;
        return true;
      });
    }
  }, []);

  const closeCard = useCallback(() => {
    setSelected(null);
    if (autoCollapsed.current) {
      autoCollapsed.current = false;
      setInsightsCollapsed(false);
    }
  }, []);

  const focusDistrict = useCallback((idx: number) => map?.focusDistrict(idx), [map]);
  const openTab = useCallback((t: TabId) => {
    setTab(t);
    setInsightsCollapsed(false);
    autoCollapsed.current = false;
  }, []);

  const pickScenario = (id: string) => {
    if (id === activeId) return;
    runAbort.current?.abort();
    setActiveId(id);
    setSelected(null);
    setSheet(null);
    setProposalCollapsed(false);
    if (id === 'custom') setEditing(!custom);
    framedScenario.current = null;
    map?.fitAll();
  };

  const finishOnboarding = useCallback(() => {
    setShowOnboard(false);
    safeStorage.set(ONBOARD_KEY, '1');
  }, []);

  // Map events, registered once; read the latest state through a ref.
  const live = useLatest({ pickActive, draft });
  useEffect(() => {
    if (!map) return;
    const offs = [
      map.on('residentClick', (id) => {
        if (live.current.pickActive) return;
        openCard(id, true);
      }),
      map.on('districtClick', (idx) => {
        const s = live.current;
        if (!s.pickActive || s.draft.areaKind !== 'districts') return;
        setDraft((d) => ({ ...d, districts: d.districts.includes(idx) ? d.districts.filter((x) => x !== idx) : [...d.districts, idx] }));
      }),
      map.on('tileClick', (x, y) => {
        const s = live.current;
        if (!s.pickActive || s.draft.areaKind !== 'site') return;
        setDraft((d) => ({ ...d, site: { x, y } }));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [map, live, openCard]);

  // Esc closes the top-most thing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showMethod) setShowMethod(false);
      else if (showOnboard) finishOnboarding();
      else if (selected !== null) closeCard();
      else if (sheet) setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showMethod, showOnboard, selected, sheet, closeCard, finishOnboarding]);

  const runCustom = async () => {
    if (!data) return;
    runAbort.current?.abort();
    const ctrl = new AbortController();
    runAbort.current = ctrl;
    setSelected(null);
    setEditing(false);
    setCustom(null);
    try {
      const result = await runCustomProposal({ draft, data, map, signal: ctrl.signal, onProgress: (p) => !ctrl.signal.aborted && setRunProgress(p) });
      if (ctrl.signal.aborted) return;
      setCustom(result);
      setView('everyone');
      setTab('overview');
      setInsightsCollapsed(false);
    } catch (e) {
      if (ctrl.signal.aborted) setRunProgress((p) => ({ ...p, status: 'cancelled' }));
      else setRunProgress((p) => ({ ...p, status: 'error', message: (e as Error).message }));
      setEditing(true);
    } finally {
      setApiOffline(isApiOffline());
    }
  };

  const cancelRun = () => {
    runAbort.current?.abort();
    setRunProgress((p) => ({ ...p, status: 'cancelled' }));
    setEditing(true);
  };

  const askKey = scenario && selected !== null ? `${scenario.id}:${selected}` : '';
  const onAsk = async (question: string) => {
    if (!scenario || selected === null) return;
    const id = selected;
    const r = residentsById.get(id);
    const res = resultsById.get(id);
    if (!r || !res) return;
    const key = `${scenario.id}:${id}`;
    const entryId = Date.now() + Math.random();
    setAsks((a) => ({ ...a, [key]: [...(a[key] ?? []), { id: entryId, q: question, pending: true }] }));
    const update = (patch: Partial<AskEntry>) =>
      setAsks((a) => ({ ...a, [key]: (a[key] ?? []).map((x) => (x.id === entryId ? { ...x, ...patch, pending: false } : x)) }));
    const req: AskRequest = {
      scenarioId: scenario.id,
      question,
      resident: residentForApi(r, districtName(districtsByIdx, r.districtIdx)),
      proposalFr: scenario.proposalFr,
      previous: { stance: res.stance, reasonFr: res.reasonFr, exposure: res.exposure },
    };
    try {
      const ans = await askResident(req);
      update({ answerEn: ans.answerEn, answerFr: ans.answerFr, mock: ans.mock });
      map?.say(id, firstSentence(ans.answerEn, 90), 8000);
    } catch (e) {
      update({ error: `No answer: ${(e as Error).message}` });
    } finally {
      setApiOffline(isApiOffline());
    }
  };

  // Development only: a handle for automated UI checks (never in production builds).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __tib?: unknown }).__tib = { map, openCard, setView, setActiveId: pickScenario, scenario };
  });

  // ---------- render ----------
  const ctx: AppCtxValue | null = data
    ? {
        data,
        scenario,
        view,
        setView,
        afterTalk: talkOn,
        setAfterTalk,
        views,
        residentsById,
        resultsById,
        districtsByIdx,
        groupsById,
        map,
        selectResident: (id) => openCard(id, false),
        focusDistrict,
        openTab,
        overlay,
        setOverlay,
        highlightGroup: group,
        setHighlightGroup: setGroup,
        isLiveSample,
        aggCtx,
      }
    : null;

  const demoParts = data ? Object.entries(data.sources).filter(([, v]) => v === 'demo').map(([k]) => k) : [];
  const mobileButtons = narrow ? (
    <div className="mobile-sheet-btns">
      <button type="button" className="btn btn-small" onClick={() => setSheet('proposal')}>
        <Icon name="info" size={14} /> Proposal
      </button>
      <button type="button" className="btn btn-small" onClick={() => setSheet('insights')}>
        <Icon name="eye" size={14} /> Analysis
      </button>
    </div>
  ) : null;
  const sheetClose = narrow ? (
    <div className="mobile-sheet-btns">
      <button type="button" className="btn btn-small" onClick={() => setSheet(null)}>
        <Icon name="map" size={14} /> Back to the map
      </button>
    </div>
  ) : null;

  return (
    <div className={`app ${selected !== null ? 'card-open' : ''}`}>
      <div className="map-host" ref={mapEl} aria-label="Town map. Click a resident to see what changes for them." />

      {ctx ? (
        <AppCtx.Provider value={ctx}>
          <div className="overlay-layer">
            <TopBar
              entries={entries}
              activeId={activeId}
              onPick={pickScenario}
              onHowItWorks={() => setShowMethod(true)}
              demo={Boolean(scenario?.mock)}
            />

            {error || demoParts.length || handle?.kind === 'stub' ? (
              <div className="banner-stack" aria-live="polite">
                {error ? (
                  <div className="banner banner-error">
                    {error}
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => setError(null)} aria-label="Dismiss">
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ) : null}
                {demoParts.length ? <div className="banner banner-demo">Built-in placeholder {demoParts.join(', ')} (pipeline files not found)</div> : null}
                {handle?.kind === 'stub' ? <div className="banner banner-demo">Simple preview map (pixel-art renderer not loaded)</div> : null}
              </div>
            ) : null}

            <div className={`left-col ${sheet === 'proposal' || (narrow && selected !== null) ? 'sheet-open' : ''}`}>
              {sheetClose}
              {selected !== null ? (
                <ResidentCard
                  residentId={selected}
                  renderPortrait={handle?.renderPortrait ?? null}
                  onClose={closeCard}
                  onNavigate={(id) => openCard(id, false)}
                  asks={asks[askKey] ?? []}
                  onAsk={onAsk}
                />
              ) : activeId === 'custom' ? (
                editing || !custom ? (
                  <CustomComposer
                    draft={draft}
                    setDraft={setDraft}
                    progress={runProgress}
                    onRun={runCustom}
                    onCancel={cancelRun}
                    hasResult={Boolean(custom)}
                    health={health}
                    apiOffline={apiOffline}
                  />
                ) : scenario ? (
                  <ProposalPanel
                    scenario={scenario}
                    collapsed={proposalCollapsed}
                    onToggle={() => setProposalCollapsed(!proposalCollapsed)}
                    footer={
                      <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
                        <Icon name="pencil" size={14} /> Edit and run again
                      </button>
                    }
                  />
                ) : null
              ) : scenario ? (
                <ProposalPanel scenario={scenario} collapsed={proposalCollapsed} onToggle={() => setProposalCollapsed(!proposalCollapsed)} />
              ) : null}
            </div>

            <div className={`right-col ${sheet === 'insights' ? 'sheet-open' : ''}`}>
              {sheetClose}
              <InsightPanel
                tab={tab}
                onTab={openTab}
                collapsed={insightsCollapsed && !narrow}
                onToggle={() => {
                  autoCollapsed.current = false;
                  setInsightsCollapsed(!insightsCollapsed);
                }}
              />
            </div>

            <div className={`dock ${sheet ? 'sheet-open' : ''}`}>
              <ViewDock mobile={mobileButtons} />
            </div>
          </div>

          {showMethod ? <MethodologyModal onClose={() => setShowMethod(false)} health={health} /> : null}
          {showOnboard && !showMethod ? <Onboarding onDone={finishOnboarding} /> : null}
        </AppCtx.Provider>
      ) : null}

      <LoadingScreen progress={load.progress} label={load.label} done={load.done} error={load.error} />
    </div>
  );
}
