/** Everything the panels need, shared through React context (so we don't pass 20 props around). */
import { createContext, useContext } from 'react';
import type { ITownMap } from '../mapApi';
import type { District, GroupDef, Resident, ResidentResult, Scenario, ViewAgg, ViewMode } from '../types';
import type { AggContext } from './aggregate';
import type { AppData } from './data';

export type TabId = 'overview' | 'consult' | 'themes' | 'districts' | 'backtest' | 'talk';
export type OverlayChoice = 'none' | 'stance' | 'exposure' | 'backtest_actual' | 'backtest_sim';

export interface AppCtxValue {
  data: AppData;
  scenario: Scenario | null;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  afterTalk: boolean;
  setAfterTalk: (on: boolean) => void;
  /** The three views for the current scenario (after-talk aware). */
  views: Record<ViewMode, ViewAgg> | null;
  residentsById: Map<number, Resident>;
  resultsById: Map<number, ResidentResult>;
  districtsByIdx: Map<number, District>;
  groupsById: Map<string, GroupDef>;
  map: ITownMap | null;
  selectResident: (id: number | null) => void;
  focusDistrict: (idx: number) => void;
  openTab: (t: TabId) => void;
  overlay: OverlayChoice;
  setOverlay: (o: OverlayChoice) => void;
  highlightGroup: string | null;
  setHighlightGroup: (g: string | null) => void;
  /** True when the scenario is a small live sample (your proposal). */
  isLiveSample: boolean;
  /** How to weight residents when recomputing numbers (raking weights, or the live-sample weights). */
  aggCtx: AggContext;
}

export const AppCtx = createContext<AppCtxValue | null>(null);

export function useApp(): AppCtxValue {
  const v = useContext(AppCtx);
  if (!v) throw new Error('useApp() used outside <AppCtx.Provider>');
  return v;
}

/** Display name of a district: '11e' or 'Saint-Denis'. */
export function districtName(districtsByIdx: Map<number, District>, idx: number | null | undefined): string {
  if (idx === null || idx === undefined) return '–';
  const d = districtsByIdx.get(idx);
  if (!d) return '–';
  return d.kind === 'arrondissement' ? `Paris ${d.name}` : d.name;
}
