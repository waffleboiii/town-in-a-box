/**
 * Interface between the UI (web/src/ui, App.tsx) and the PixiJS town renderer (web/src/map).
 * The renderer implements this in web/src/map/index.ts as `export function createTownMap(): ITownMap`
 * and `export function renderPortrait(look: Look, scale?: number): HTMLCanvasElement`.
 * The UI must only talk to the map through this interface.
 */
import type { Conversation, Look, MapFile, PopulationFile, Scenario, ViewMode } from './types';

export type Overlay =
  | 'none'
  | 'stance' // district tint by mean stance (current view mode)
  | 'exposure' // district tint by mean computed exposure
  | 'backtest_actual' // district tint by official vote share (needs data)
  | 'backtest_sim' // district tint by simulated vote share (needs data)
  | 'districts'; // show district borders + labels only

export interface TownMapEvents {
  residentClick: (id: number) => void;
  districtClick: (districtIdx: number) => void;
  tileClick: (x: number, y: number) => void;
}

export interface ITownMap {
  /** Mount into a DOM element (fills it). Resolves once textures are generated and the static map is drawn. */
  mount(el: HTMLElement, map: MapFile, population: PopulationFile): Promise<void>;
  destroy(): void;

  /** Show a scenario: per-resident emotes/tints, site sprite + rings, zone outline. null = neutral villagers. */
  setScenario(s: Scenario | null): void;
  /** 'everyone': all solid. 'eligible': ineligible residents fade. 'attendees': non-attendees fade to ghosts (animated). */
  setViewMode(m: ViewMode): void;
  /** Use stanceAfter (after neighbour conversations) where present. */
  setAfterTalk(on: boolean): void;
  /** District choropleth. `values` maps districtIdx -> value; stance/backtest overlays use 0..1 yes-share, exposure uses 0..3. */
  setOverlay(o: Overlay, values?: Record<number, number>): void;
  /** Emphasise members of a population group (others dim). null clears. */
  highlightGroup(groupId: string | null): void;

  /** Select a resident: camera glides/follows, draws home + work markers, the commute path,
   *  exposure markers (ResidentResult.exposure.reasons[].at) and an optional speech bubble. null clears. */
  selectResident(id: number | null, opts?: { bubbleText?: string }): void;
  /** Speech bubble over a resident for `ms` milliseconds (default 6000). */
  say(id: number, text: string, ms?: number): void;
  /** Two residents walk to `where`, face each other and exchange bubbles line by line. Resolves when finished. */
  playConversation(c: Conversation, opts?: { lang?: 'en' | 'fr'; lineMs?: number }): Promise<void>;
  /** Ambient life: occasionally show short wordless "chat" animations for the current scenario's conversations. */
  setAmbientConversations(on: boolean): void;

  focus(x: number, y: number, zoom?: number, animate?: boolean): void;
  focusDistrict(districtIdx: number): void;
  fitAll(): void;

  /** Custom proposals: let the user click districts (toggle) or place a site. */
  setPickMode(mode: 'none' | 'districts' | 'site'): void;
  setPickedDistricts(idxs: number[]): void;
  setCustomSite(site: { x: number; y: number; ringsTiles: number[]; label?: string } | null): void;

  /** Live runs: show "…" thinking bubbles over residents, then reveal each result as it arrives. */
  setThinking(ids: number[]): void;
  revealResult(id: number, stance: number): void;

  on<K extends keyof TownMapEvents>(ev: K, cb: TownMapEvents[K]): () => void;
}

export type CreateTownMap = () => ITownMap;
export type RenderPortrait = (look: Look, scale?: number) => HTMLCanvasElement;
