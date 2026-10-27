/**
 * Creates the town map the UI talks to (always through the ITownMap interface in mapApi.ts).
 *
 * - Normally this is the PixiJS pixel-art renderer in web/src/map (loaded as its own chunk,
 *   so the panels can appear while the map code downloads).
 * - Fallback: if the renderer cannot start (for example the browser has no WebGL), we use the
 *   very simple canvas map in web/src/ui/dev/StubTownMap.ts so the app still works.
 * - In development only, ?map=stub in the URL forces the simple map (handy for UI testing).
 */
import type { ITownMap, RenderPortrait } from '../mapApi';
import type { MapFile, PopulationFile } from '../types';

export interface TownMapHandle {
  map: ITownMap;
  renderPortrait: RenderPortrait | null;
  kind: 'pixel' | 'stub';
}

function wantStub(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return new URLSearchParams(window.location.search).get('map') === 'stub';
  } catch {
    return false;
  }
}

async function loadStub(): Promise<TownMapHandle> {
  const { StubTownMap } = await import('./dev/StubTownMap');
  return { map: new StubTownMap(), renderPortrait: null, kind: 'stub' };
}

async function loadReal(): Promise<TownMapHandle | null> {
  if (wantStub()) return null;
  try {
    const mod = await import('../map/index');
    return { map: mod.createTownMap(), renderPortrait: mod.renderPortrait, kind: 'pixel' };
  } catch (err) {
    console.warn('[ui] Town renderer failed to load, using the simple map instead.', err);
    return null;
  }
}

/** Create a town map and mount it. Falls back to the simple map if the renderer cannot start. */
export async function createAndMountTownMap(el: HTMLElement, map: MapFile, population: PopulationFile): Promise<TownMapHandle> {
  const real = await loadReal();
  if (real) {
    try {
      await real.map.mount(el, map, population);
      return real;
    } catch (err) {
      console.warn('[ui] Town renderer could not start (WebGL?), using the simple map instead.', err);
      try {
        real.map.destroy();
      } catch {
        /* ignore */
      }
      el.replaceChildren();
    }
  }
  const stub = await loadStub();
  await stub.map.mount(el, map, population);
  return stub;
}
