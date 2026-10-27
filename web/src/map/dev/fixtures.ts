/**
 * TEST FIXTURES for the renderer harness (map-test.html) -- NOT real data.
 *
 * Builds a synthetic MapFile / PopulationFile / Scenario that conform to src/types.ts, using a rough
 * hand-made sketch of Paris (approximate periph, Seine with the two islands, the two woods, parks,
 * canals, rail corridors, motorways) so the art can be reviewed before the real pipeline output exists.
 * All numbers here are invented for testing (mock: true).
 */
import config from '../../../shared/config.json';
import type {
  Conversation, District, GroupAgg, Landmark, MapFile, PopulationFile, Resident, ResidentResult, Scenario, ViewAgg,
} from '../../types';
import { makeRng, valueNoise } from '../util';

const W = config.gridWidth;
const H = config.gridHeight;
const { lonMin, lonMax, latMin, latMax } = config.bbox;
const T: Record<string, number> = Object.fromEntries(config.tileTypes.map((n, i) => [n, i]));

type LL = [number, number];
const xy = ([lon, lat]: LL): [number, number] => [((lon - lonMin) / (lonMax - lonMin)) * W, ((latMax - lat) / (latMax - latMin)) * H];

// ---------------------------------------------------------------- geography sketch (lon, lat)

const PARIS: LL[] = [
  [2.2797, 48.8784], [2.2918, 48.8862], [2.3036, 48.8907], [2.3133, 48.8946], [2.33, 48.899], [2.3447, 48.9006], [2.3594, 48.8998],
  [2.37, 48.899], [2.3856, 48.8972], [2.3925, 48.8875], [2.406, 48.8765], [2.41, 48.864], [2.411, 48.847], [2.4055, 48.8355],
  [2.396, 48.827], [2.383, 48.8235], [2.36, 48.817], [2.342, 48.8165], [2.325, 48.8225], [2.305, 48.8275], [2.288, 48.832],
  [2.272, 48.837], [2.257, 48.838], [2.253, 48.847], [2.256, 48.856], [2.262, 48.864], [2.2745, 48.8715],
];
const BOULOGNE_WOOD: LL[] = [[2.224, 48.864], [2.247, 48.878], [2.264, 48.877], [2.2745, 48.8715], [2.262, 48.864], [2.256, 48.856], [2.253, 48.847], [2.247, 48.845], [2.242, 48.853], [2.23, 48.856], [2.221, 48.861]];
const VINCENNES_WOOD: LL[] = [[2.411, 48.847], [2.433, 48.844], [2.457, 48.843], [2.47, 48.838], [2.47, 48.826], [2.455, 48.822], [2.435, 48.824], [2.415, 48.83], [2.4055, 48.8355]];
const STUDY: LL[] = [[2.19, 48.94], [2.3, 48.946], [2.4, 48.948], [2.5, 48.936], [2.522, 48.88], [2.516, 48.8], [2.47, 48.776], [2.35, 48.773], [2.24, 48.779], [2.186, 48.8], [2.176, 48.86], [2.18, 48.91]];

const SEINE: LL[] = [
  [2.41, 48.765], [2.412, 48.79], [2.411, 48.808], [2.399, 48.826], [2.378, 48.838], [2.368, 48.846], [2.3615, 48.851], [2.354, 48.855],
  [2.346, 48.8575], [2.338, 48.8585], [2.325, 48.862], [2.312, 48.8645], [2.3, 48.8628], [2.2935, 48.8608], [2.285, 48.856], [2.278, 48.85],
  [2.274, 48.846], [2.269, 48.841], [2.253, 48.8305], [2.235, 48.825], [2.218, 48.832], [2.215, 48.848], [2.224, 48.865], [2.236, 48.88],
  [2.25, 48.892], [2.27, 48.903], [2.29, 48.913], [2.305, 48.923], [2.32, 48.93], [2.338, 48.94], [2.35, 48.951],
];
const SEINE_SOUTH_ARM: LL[] = [[2.3405, 48.8552], [2.348, 48.852], [2.356, 48.8497], [2.3635, 48.8492]];
const MARNE: LL[] = [[2.53, 48.826], [2.49, 48.816], [2.46, 48.815], [2.44, 48.82], [2.42, 48.814], [2.41, 48.812]];
const CANALS: LL[][] = [
  [[2.369, 48.853], [2.368, 48.866], [2.37, 48.876], [2.373, 48.884]],
  [[2.373, 48.884], [2.39, 48.889], [2.42, 48.894], [2.46, 48.905], [2.5, 48.915]],
  [[2.373, 48.884], [2.366, 48.9], [2.362, 48.92], [2.358, 48.94]],
];
const RAILS: [LL[], number][] = [
  [[[2.3553, 48.8809], [2.357, 48.892], [2.36, 48.905], [2.357, 48.92], [2.36, 48.935], [2.37, 48.95]], 1.6],
  [[[2.359, 48.8765], [2.365, 48.888], [2.38, 48.9], [2.41, 48.91], [2.45, 48.92], [2.53, 48.93]], 1.1],
  [[[2.373, 48.8443], [2.39, 48.835], [2.41, 48.824], [2.435, 48.81], [2.47, 48.79], [2.5, 48.77]], 1.3],
  [[[2.366, 48.842], [2.38, 48.83], [2.395, 48.815], [2.405, 48.795], [2.41, 48.77]], 0.8],
  [[[2.32, 48.841], [2.308, 48.835], [2.29, 48.825], [2.26, 48.815], [2.23, 48.81], [2.17, 48.805]], 1.0],
  [[[2.325, 48.876], [2.317, 48.885], [2.305, 48.895], [2.285, 48.905], [2.25, 48.915], [2.2, 48.93], [2.17, 48.94]], 1.0],
];
const MOTORWAYS: LL[][] = [
  [[2.359, 48.899], [2.363, 48.915], [2.37, 48.93], [2.39, 48.95]],
  [[2.406, 48.8765], [2.44, 48.89], [2.48, 48.905], [2.53, 48.92]],
  [[2.411, 48.835], [2.44, 48.823], [2.47, 48.82], [2.53, 48.815]],
  [[2.342, 48.8165], [2.348, 48.8], [2.353, 48.77]],
  [[2.256, 48.845], [2.23, 48.84], [2.2, 48.838], [2.17, 48.835]],
  [[2.19, 48.86], [2.2, 48.9], [2.25, 48.93], [2.3, 48.938], [2.36, 48.935], [2.41, 48.92], [2.45, 48.905], [2.48, 48.87], [2.49, 48.84], [2.47, 48.8], [2.43, 48.78], [2.38, 48.772], [2.32, 48.77]],
];
const FERMIERS: LL[] = [
  [2.295, 48.8738], [2.32, 48.884], [2.337, 48.882], [2.35, 48.884], [2.36, 48.884], [2.369, 48.884], [2.377, 48.872], [2.384, 48.866],
  [2.396, 48.8484], [2.38, 48.84], [2.355, 48.831], [2.332, 48.834], [2.32, 48.842], [2.302, 48.848], [2.289, 48.854], [2.2875, 48.862], [2.295, 48.8738],
];
const STREETS: LL[][] = [
  [[2.325, 48.87], [2.333, 48.871], [2.349, 48.871], [2.3635, 48.8675], [2.369, 48.853]],
  [[2.295, 48.8738], [2.321, 48.8656], [2.336, 48.861], [2.352, 48.8572], [2.369, 48.853], [2.396, 48.8484], [2.411, 48.847], [2.435, 48.847], [2.476, 48.851]],
  [[2.359, 48.876], [2.347, 48.8585], [2.344, 48.853], [2.337, 48.84], [2.332, 48.834], [2.325, 48.823], [2.317, 48.815], [2.307, 48.796], [2.3, 48.77]],
  [[2.321, 48.861], [2.333, 48.853], [2.348, 48.851], [2.362, 48.849]],
  [[2.31, 48.874], [2.335, 48.873]],
  [[2.295, 48.8738], [2.2797, 48.8784], [2.25, 48.888], [2.2389, 48.8918], [2.206, 48.892], [2.17, 48.89]],
  [[2.295, 48.8738], [2.2745, 48.8715]],
  [[2.295, 48.8738], [2.31, 48.885], [2.3133, 48.8946], [2.306, 48.904], [2.285, 48.914], [2.252, 48.923]],
  [[2.321, 48.868], [2.305, 48.888]],
  [[2.32, 48.842], [2.288, 48.832], [2.27, 48.823], [2.235, 48.81]],
  [[2.355, 48.831], [2.36, 48.817], [2.364, 48.792], [2.37, 48.77]],
  [[2.337, 48.873], [2.369, 48.884], [2.3856, 48.8972], [2.383, 48.914], [2.396, 48.928], [2.42, 48.95]],
  [[2.377, 48.872], [2.406, 48.8765], [2.44, 48.908]],
  [[2.369, 48.884], [2.3925, 48.8875], [2.404, 48.894]],
  [[2.3635, 48.8675], [2.355, 48.881], [2.359, 48.899], [2.358, 48.936]],
  [[2.3635, 48.8675], [2.396, 48.8615], [2.41, 48.864], [2.441, 48.861], [2.48, 48.86]],
  [[2.257, 48.838], [2.24, 48.835], [2.225, 48.825]],
  [[2.33, 48.899], [2.334, 48.912], [2.358, 48.936]],
  [[2.396, 48.827], [2.414, 48.822], [2.438, 48.806], [2.455, 48.79]],
  [[2.383, 48.8235], [2.392, 48.787], [2.4, 48.77]],
  [[2.2875, 48.862], [2.3, 48.8628], [2.312, 48.8645]],
  // bridges over the Seine in Paris (short north-south links)
  [[2.3375, 48.8625], [2.3375, 48.854]], [[2.3125, 48.868], [2.3125, 48.86]], [[2.2935, 48.864], [2.2935, 48.857]], [[2.3525, 48.859], [2.3525, 48.848]],
  [[2.369, 48.8505], [2.366, 48.842]], [[2.3825, 48.842], [2.3765, 48.834]], [[2.3, 48.866], [2.3, 48.859]], [[2.2795, 48.8545], [2.2745, 48.851]],
  [[2.325, 48.8655], [2.325, 48.858]], [[2.3455, 48.8605], [2.3455, 48.8565]],
];
const PLAZAS: [LL, number][] = [
  [[2.321, 48.8656], 1.6], [[2.369, 48.853], 1.1], [[2.3635, 48.8675], 1.1], [[2.396, 48.8484], 1.5], [[2.355, 48.831], 1.1],
  [[2.2875, 48.862], 1.2], [[2.332, 48.834], 1], [[2.3522, 48.8572], 1.2],
];
const PARKS: [LL, number, number, 'park' | 'forest' | 'grass'][] = [
  [[2.3372, 48.8462], 3.6, 3], [[2.327, 48.8638], 5, 1.4], [[2.2985, 48.8556], 2, 4.2], [[2.3828, 48.8809], 3, 2.4], [[2.3088, 48.8797], 2, 1.8],
  [[2.3597, 48.844], 2.5, 1.8], [[2.3388, 48.8221], 2.6, 1.8], [[2.3963, 48.8614], 4, 2.8], [[2.3906, 48.8938], 3, 3.3], [[2.2747, 48.8412], 2, 1.8],
  [[2.383, 48.8355], 3, 1.2], [[2.384, 48.871], 1.4, 1.4], [[2.29, 48.93], 4, 2], [[2.4, 48.885], 2, 2], [[2.3655, 48.8556], 0.8, 0.8],
].map(([c, rx, ry]) => [c as LL, rx as number, ry as number, 'park' as const]);
PARKS.push(
  [[2.212, 48.837], 5, 6, 'forest'], [[2.415, 48.94], 7, 5, 'park'], [[2.225, 48.8], 7, 5, 'forest'], [[2.2355, 48.859], 2.6, 2, 'grass'],
  [[2.49, 48.83], 3, 2, 'park'], [[2.455, 48.79], 4, 2.5, 'park'], [[2.18, 48.87], 4, 3, 'park'],
);

const ARRONDISSEMENTS: [string, LL, number][] = [
  ['1er', [2.3365, 48.8625], 15900], ['2e', [2.3428, 48.8683], 21000], ['3e', [2.36, 48.863], 33000], ['4e', [2.3576, 48.8543], 28000],
  ['5e', [2.35, 48.8445], 57000], ['6e', [2.3327, 48.8491], 40000], ['7e', [2.3121, 48.8562], 49000], ['8e', [2.3125, 48.8727], 35000],
  ['9e', [2.3375, 48.877], 59000], ['10e', [2.3608, 48.8762], 83000], ['11e', [2.38, 48.8591], 142000], ['12e', [2.395, 48.8405], 140000],
  ['13e', [2.3622, 48.8283], 178000], ['14e', [2.3265, 48.8292], 135000], ['15e', [2.2922, 48.8405], 230000], ['16e', [2.2735, 48.8604], 162000],
  ['17e', [2.3067, 48.8873], 165000], ['18e', [2.3482, 48.8925], 192000], ['19e', [2.3848, 48.8871], 182000], ['20e', [2.4011, 48.8634], 192000],
];
const COMMUNES: [string, string, LL, '92' | '93' | '94', number][] = [
  ['92012', 'Boulogne-Billancourt', [2.24, 48.835], '92', 121000], ['92040', 'Issy-les-Moulineaux', [2.27, 48.823], '92', 69000],
  ['92075', 'Vanves', [2.29, 48.821], '92', 27000], ['92046', 'Malakoff', [2.3, 48.815], '92', 30000], ['92049', 'Montrouge', [2.317, 48.815], '92', 49000],
  ['92051', 'Neuilly-sur-Seine', [2.267, 48.886], '92', 59000], ['92044', 'Levallois-Perret', [2.288, 48.895], '92', 66000], ['92024', 'Clichy', [2.306, 48.904], '92', 63000],
  ['92026', 'Courbevoie', [2.256, 48.897], '92', 82000], ['92062', 'Puteaux', [2.238, 48.884], '92', 44000], ['92050', 'Nanterre', [2.206, 48.892], '92', 96000],
  ['92073', 'Suresnes', [2.219, 48.871], '92', 49000], ['92064', 'Saint-Cloud', [2.205, 48.846], '92', 30000], ['92004', 'Asnières-sur-Seine', [2.285, 48.914], '92', 87000],
  ['92036', 'Gennevilliers', [2.293, 48.933], '92', 48000], ['92025', 'Colombes', [2.252, 48.923], '92', 86000], ['92048', 'Meudon', [2.235, 48.81], '92', 46000],
  ['92020', 'Châtillon', [2.29, 48.804], '92', 38000], ['92023', 'Clamart', [2.265, 48.8], '92', 54000], ['92007', 'Bagneux', [2.307, 48.796], '92', 41000],
  ['93066', 'Saint-Denis', [2.358, 48.936], '93', 113000], ['93070', 'Saint-Ouen-sur-Seine', [2.334, 48.912], '93', 51000], ['93001', 'Aubervilliers', [2.383, 48.914], '93', 88000],
  ['93055', 'Pantin', [2.404, 48.894], '93', 60000], ['93006', 'Bagnolet', [2.418, 48.869], '93', 36000], ['93048', 'Montreuil', [2.441, 48.861], '93', 111000],
  ['93008', 'Bobigny', [2.44, 48.908], '93', 53000], ['93027', 'La Courneuve', [2.396, 48.928], '93', 44000], ['93029', 'Drancy', [2.445, 48.928], '93', 71000],
  ['93063', 'Romainville', [2.436, 48.885], '93', 30000], ['93064', 'Rosny-sous-Bois', [2.485, 48.873], '93', 46000], ['93053', 'Noisy-le-Sec', [2.46, 48.891], '93', 44000],
  ['94080', 'Vincennes', [2.435, 48.847], '94', 49000], ['94067', 'Saint-Mandé', [2.419, 48.842], '94', 22000], ['94018', 'Charenton-le-Pont', [2.414, 48.822], '94', 30000],
  ['94041', 'Ivry-sur-Seine', [2.388, 48.813], '94', 63000], ['94081', 'Vitry-sur-Seine', [2.392, 48.787], '94', 95000], ['94076', 'Villejuif', [2.364, 48.792], '94', 56000],
  ['94043', 'Le Kremlin-Bicêtre', [2.358, 48.81], '94', 26000], ['94037', 'Gentilly', [2.343, 48.813], '94', 17000], ['94003', 'Arcueil', [2.335, 48.803], '94', 22000],
  ['94046', 'Maisons-Alfort', [2.438, 48.806], '94', 56000], ['94033', 'Fontenay-sous-Bois', [2.476, 48.851], '94', 53000], ['94052', 'Nogent-sur-Marne', [2.482, 48.836], '94', 33000],
  ['94028', 'Créteil', [2.455, 48.79], '94', 92000], ['94002', 'Alfortville', [2.42, 48.798], '94', 44000],
];

// ---------------------------------------------------------------- raster helpers

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeLine(grid: number[], pts: [number, number][], width: number, value: number, onlyIf?: (old: number) => boolean): void {
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const x0 = Math.floor(Math.min(ax, bx) - width - 1);
    const x1 = Math.ceil(Math.max(ax, bx) + width + 1);
    const y0 = Math.floor(Math.min(ay, by) - width - 1);
    const y1 = Math.ceil(Math.max(ay, by) + width + 1);
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        if (distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by) <= width / 2 + 0.2) {
          const i = y * W + x;
          if (!onlyIf || onlyIf(grid[i])) grid[i] = value;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- map

export function makeFixtureMap(): MapFile {
  const parisPoly = PARIS.map(xy);
  const bw = BOULOGNE_WOOD.map(xy);
  const vw = VINCENNES_WOOD.map(xy);
  const study = STUDY.map(xy);
  const tiles = new Array<number>(W * H).fill(T.outside);
  const districts = new Array<number>(W * H).fill(0);

  const districtList: District[] = [];
  ARRONDISSEMENTS.forEach(([name, ll, pop], i) => {
    const [cx, cy] = xy(ll);
    const n = i + 1;
    districtList.push({
      idx: i + 1, code: `751${String(n).padStart(2, '0')}`, name,
      fullName: n === 1 ? 'Paris 1er Arrondissement' : `Paris ${n}e Arrondissement`, kind: 'arrondissement', dept: '75',
      sector: n <= 4 ? 'Paris Centre' : name, population: pop, centroid: [cx, cy], labelPos: [cx, cy], tileCount: 0,
    });
  });
  COMMUNES.forEach(([code, name, ll, dept, pop], i) => {
    const [cx, cy] = xy(ll);
    districtList.push({ idx: 21 + i, code, name, fullName: name, kind: 'commune', dept, population: pop, centroid: [cx, cy], labelPos: [cx, cy], tileCount: 0 });
  });
  const arrSeeds = districtList.filter((d) => d.kind === 'arrondissement');
  const comSeeds = districtList.filter((d) => d.kind === 'commune');
  const nearest = (x: number, y: number, seeds: District[]) => {
    let best = seeds[0];
    let bd = Infinity;
    for (const s of seeds) {
      const d = Math.hypot(x - s.centroid[0], y - s.centroid[1]);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best.idx;
  };

  // base land use + districts
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = y * W + x;
      const inParis = pointInPoly(px, py, parisPoly);
      const inBw = pointInPoly(px, py, bw);
      const inVw = pointInPoly(px, py, vw);
      if (inParis || inBw || inVw) {
        districts[i] = inBw ? 16 : inVw ? 12 : nearest(px, py, arrSeeds);
        tiles[i] = inBw || inVw ? T.forest : T.haussmann;
        continue;
      }
      if (!pointInPoly(px, py, study)) continue;
      districts[i] = nearest(px, py, comSeeds);
      const n = valueNoise(x, y, 9, 7);
      const n2 = valueNoise(x, y, 5, 11);
      const dParis = Math.min(...parisPoly.map(([qx, qy]) => Math.hypot(px - qx, py - qy)));
      const dept = districtList[districts[i] - 1].dept;
      let t = T.suburb_house;
      if (dParis < 6 && (dept === '92' || dept === '94') && n2 > 0.3) t = T.haussmann;
      else if (n > 0.66 || (dept === '93' && n > 0.56)) t = T.suburb_tower;
      else if (n2 < 0.16) t = T.grass;
      tiles[i] = t;
    }
  }
  // industrial zones
  const ind: [LL, number][] = [[[2.29, 48.94], 7], [[2.36, 48.915], 5], [[2.405, 48.8], 6], [[2.42, 48.9], 4], [[2.21, 48.905], 4]];
  for (const [ll, r] of ind) {
    const [cx, cy] = xy(ll);
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (tiles[i] !== T.outside && Math.hypot(x - cx, y - cy) < r * (0.75 + 0.5 * valueNoise(x, y, 3, 5))) tiles[i] = T.industrial;
      }
  }
  // parks & woods
  for (const [ll, rx, ry, kind] of PARKS) {
    const [cx, cy] = xy(ll);
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++)
      for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 && tiles[y * W + x] !== T.outside) tiles[y * W + x] = T[kind];
      }
  }
  // clearings in the woods
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (tiles[i] === T.forest && valueNoise(x, y, 4, 3) < 0.22) tiles[i] = T.grass;
    }
  // suburban street grid (warped) + city streets
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = tiles[i];
      if (t !== T.suburb_house && t !== T.suburb_tower && t !== T.industrial) continue;
      const gx = (x + Math.floor(4 * Math.sin(y / 13))) % 9 === 0;
      const gy = (y + Math.floor(3 * Math.sin(x / 17))) % 10 === 0;
      if ((gx || gy) && valueNoise(x, y, 6, 21) > 0.25) tiles[i] = T.street;
    }
  const notOutside = (old: number) => old !== T.outside;
  strokeLine(tiles, FERMIERS.map(xy), 1, T.street);
  const shrink = parisPoly.map(([x, y]) => {
    const [cx, cy] = xy([2.3488, 48.8534]);
    return [cx + (x - cx) * 0.94, cy + (y - cy) * 0.94] as [number, number];
  });
  strokeLine(tiles, [...shrink, shrink[0]], 1, T.street);
  for (const s of STREETS) strokeLine(tiles, s.map(xy), 1, T.street, notOutside);
  for (const [ll, r] of PLAZAS) {
    const [cx, cy] = xy(ll);
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) tiles[y * W + x] = T.plaza;
  }
  // rails, motorways, periph
  for (const [r, w] of RAILS) strokeLine(tiles, r.map(xy), w, T.rail, notOutside);
  for (const m of MOTORWAYS) strokeLine(tiles, m.map(xy), 1, T.ring_road, notOutside);
  strokeLine(tiles, [...parisPoly, parisPoly[0]], 1.2, T.ring_road);
  // water last (bridges are re-added as streets afterwards)
  const isBridge = new Set<number>();
  for (const s of STREETS.slice(-10)) {
    const tmp = new Array<number>(W * H).fill(0);
    strokeLine(tmp, s.map(xy), 1, 1);
    tmp.forEach((v, i) => v && isBridge.add(i));
  }
  strokeLine(tiles, SEINE.map(xy), 1.9, T.water);
  strokeLine(tiles, SEINE_SOUTH_ARM.map(xy), 1.3, T.water);
  strokeLine(tiles, MARNE.map(xy), 1.1, T.water, notOutside);
  for (const c of CANALS) strokeLine(tiles, c.map(xy), 0.8, T.water);
  const lakes: [LL, number, number][] = [[[2.258, 48.8625], 1.2, 2.5], [[2.4155, 48.834], 1.6, 1.2], [[2.456, 48.838], 1.4, 1], [[2.415, 48.94], 2.5, 1.6]];
  for (const [ll, rx, ry] of lakes) {
    const [cx, cy] = xy(ll);
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++)
      for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) tiles[y * W + x] = T.water;
  }
  for (const i of isBridge) if (tiles[i] === T.water) tiles[i] = T.street;
  // districts on water/roads keep their nearest district; outside stays 0
  for (const d of districtList) d.tileCount = 0;
  districts.forEach((d) => d && districtList[d - 1].tileCount++);
  // label position = centroid of tiles
  const sx = new Float64Array(districtList.length + 1);
  const sy = new Float64Array(districtList.length + 1);
  districts.forEach((d, i) => {
    if (!d) return;
    sx[d] += i % W;
    sy[d] += Math.floor(i / W);
  });
  for (const d of districtList) if (d.tileCount) d.labelPos = [sx[d.idx] / d.tileCount, sy[d.idx] / d.tileCount];

  const landmarks: Landmark[] = config.landmarks.map((l) => {
    const [x, y] = xy([l.lon, l.lat]);
    return { id: l.id, name: l.name, nameFr: l.nameFr, kind: l.kind, x, y };
  });
  return {
    version: 1, width: W, height: H, tilePx: config.tilePx, tileMeters: config.tileMeters, bbox: config.bbox, tileTypes: config.tileTypes,
    tiles, districts, districtList, landmarks, seine: SEINE.map(xy),
    sources: [{ name: 'Renderer test fixture (hand-drawn sketch, not real data)', url: '', license: 'n/a' }],
  };
}

// ---------------------------------------------------------------- population

const FIRST_F = ['Camille', 'Léa', 'Chloé', 'Manon', 'Inès', 'Sarah', 'Fatou', 'Amina', 'Julie', 'Claire', 'Nathalie', 'Sophie', 'Yasmine', 'Lucie', 'Marie', 'Aïcha'];
const FIRST_M = ['Lucas', 'Hugo', 'Karim', 'Thomas', 'Mamadou', 'Julien', 'Nicolas', 'Mehdi', 'Antoine', 'Pierre', 'Yanis', 'Paul', 'Omar', 'Louis', 'David', 'Jean'];
const LAST = ['Martin', 'Bernard', 'Dubois', 'Diallo', 'Nguyen', 'Petit', 'Moreau', 'Benali', 'Garcia', 'Lefèvre', 'Traoré', 'Roux', 'Fontaine', 'Mercier', 'Haddad', 'Lambert'];
const OCC: [string, Resident['occupationGroup'], string, number][] = [
  ['Cadres et professions intellectuelles supérieures', 'cadres', 'Managers & professionals', 0.22],
  ['Professions intermédiaires', 'prof_inter', 'Intermediate professions', 0.17],
  ['Employés', 'employes', 'Clerical & service workers', 0.16],
  ['Ouvriers', 'ouvriers', 'Manual workers', 0.08],
  ['Artisans, commerçants, chefs d\'entreprise', 'artisans', 'Craftspeople & shopkeepers', 0.04],
  ['Retraités', 'retraites', 'Retired', 0.2],
  ['Autres sans activité professionnelle', 'sans_activite', 'Not in work', 0.13],
];
const EDU = ['Sans diplôme ou CEP', 'Brevet', 'CAP ou BEP', 'Baccalauréat', 'Bac+2', 'Bac+3 ou Bac+4', 'Bac+5 ou plus'];
const HH: [Resident['household'], string][] = [['single', 'Personne seule'], ['couple_no_kids', 'Couple sans enfant'], ['couple_kids', 'Couple avec enfant(s)'], ['single_parent', 'Famille monoparentale']];

export function makeFixturePopulation(map: MapFile, n = 2000): PopulationFile {
  const rng = makeRng(42);
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
  const built = new Map<number, number[]>();
  map.tiles.forEach((t, i) => {
    const name = map.tileTypes[t];
    if (name !== 'haussmann' && name !== 'suburb_house' && name !== 'suburb_tower') return;
    const d = map.districts[i];
    if (!d) return;
    if (!built.has(d)) built.set(d, []);
    built.get(d)!.push(i);
  });
  const dl = map.districtList.filter((d) => built.has(d.idx));
  const totalPop = dl.reduce((s, d) => s + d.population, 0);
  const business = ['8e', '2e', '9e', '1er', 'Courbevoie', 'Puteaux', '15e', '13e'].map((nm) => map.districtList.find((d) => d.name === nm)!.idx);
  const residents: Resident[] = [];
  for (let id = 0; id < n; id++) {
    let r = rng() * totalPop;
    let d = dl[0];
    for (const c of dl) {
      r -= c.population;
      if (r <= 0) {
        d = c;
        break;
      }
    }
    const homeI = pick(built.get(d.idx)!);
    const home: [number, number] = [homeI % map.width, Math.floor(homeI / map.width)];
    const sex = rng() < 0.52 ? 'F' : 'M';
    const age = Math.round(18 + Math.pow(rng(), 1.25) * 72);
    let occ = OCC[0];
    let acc = rng();
    for (const o of OCC) {
      acc -= o[3];
      if (acc <= 0) {
        occ = o;
        break;
      }
    }
    if (age >= 66) occ = OCC[5];
    const working = occ[1] !== 'retraites' && occ[1] !== 'sans_activite';
    let work: [number, number] | null = null;
    let workD: number | null = null;
    if (working) {
      const wr = rng();
      const wd = wr < 0.4 ? d.idx : wr < 0.75 ? pick(business) : pick(dl).idx;
      const wi = pick(built.get(wd) ?? built.get(d.idx)!);
      work = [wi % map.width, Math.floor(wi / map.width)];
      workD = wd;
    }
    const paris = d.dept === '75';
    const car = rng() < (paris ? 0.33 : 0.62);
    const dist = work ? Math.hypot(work[0] - home[0], work[1] - home[1]) : 0;
    let mode: Resident['commuteMode'] = 'none';
    if (work) {
      const m = rng();
      if (dist < 8) mode = m < 0.45 ? 'walk' : m < 0.7 ? 'bike' : 'bus';
      else if (car && m < (paris ? 0.2 : 0.55)) mode = 'car';
      else mode = paris ? (m < 0.8 ? 'metro' : 'rer') : m < 0.6 ? 'rer' : m < 0.85 ? 'metro' : 'bus';
    }
    const nat = rng() < 0.82 ? 'french' : rng() < 0.35 ? 'eu' : 'non_eu';
    const tenureR = rng();
    const tenure = tenureR < 0.33 ? 'owner' : tenureR < 0.75 ? 'private_renter' : 'social_renter';
    const eduRank = Math.min(6, Math.max(0, Math.round(rng() * 4 + (occ[1] === 'cadres' ? 2.5 : 0.5))));
    const [household, householdRaw] = pick(HH);
    const name = `${sex === 'F' ? pick(FIRST_F) : pick(FIRST_M)} ${pick(LAST)}`;
    const groupIds: string[] = [];
    if (age < 30 && tenure !== 'owner') groupIds.push('young_renters');
    if (car) groupIds.push('car_owners');
    if (occ[1] === 'retraites') groupIds.push('retirees');
    if (household === 'couple_kids' || household === 'single_parent') groupIds.push('families');
    if (nat === 'non_eu') groupIds.push('non_eu_residents');
    if (occ[1] === 'ouvriers' || occ[1] === 'employes') groupIds.push('workers');
    if (tenure === 'social_renter') groupIds.push('social_housing');
    residents.push({
      id, uuid: `fixture-${id}`, name, sex, age,
      ageBand: age < 30 ? '18-29' : age < 45 ? '30-44' : age < 60 ? '45-59' : age < 75 ? '60-74' : '75+',
      occupation: occ[0], occupationGroup: occ[1], occupationEn: occ[2], education: EDU[eduRank], educationRank: eduRank,
      household, householdRaw, maritalStatus: 'Célibataire', districtIdx: d.idx, districtSource: rng() < 0.5 ? 'dataset' : 'imputed',
      home, work, workDistrictIdx: workD, commuteMode: mode,
      imputed: { car, heavyCar: car && rng() < 0.25, tenure, nationality: nat },
      eligibleParis: paris && nat !== 'non_eu',
      participationBase: Math.min(0.6, 0.02 + (age / 90) * 0.16 + eduRank * 0.02 + rng() * 0.04),
      weight: 1, groupIds,
      personaFr: `${name}, ${age} ans, vit à ${d.fullName}.`, personaEn: '',
      look: {
        skin: Math.floor(rng() * 6), hair: age > 62 && rng() < 0.6 ? 6 : Math.floor(rng() * 8), hairStyle: Math.floor(rng() * 6),
        shirt: Math.floor(rng() * 12), pants: Math.floor(rng() * 6), accessory: rng() < 0.5 ? 0 : 1 + Math.floor(rng() * 4),
      },
    });
  }
  return {
    version: 1, generatedAt: new Date(0).toISOString(), count: n, residents,
    groups: [
      { id: 'young_renters', label: 'Young renters', description: 'Age < 30 and renting (tenure imputed)' },
      { id: 'car_owners', label: 'Car owners', description: 'Has a car (imputed)' },
      { id: 'retirees', label: 'Retirees', description: 'Occupation: retired' },
      { id: 'families', label: 'Families with children', description: 'Household with children' },
      { id: 'non_eu_residents', label: 'Non-EU residents', description: 'Nationality outside the EU (imputed) -- cannot vote' },
      { id: 'workers', label: 'Workers & employees', description: 'Manual and clerical workers' },
      { id: 'social_housing', label: 'Social housing tenants', description: 'Social renter (imputed)' },
    ],
    method: { sampling: 'fixture', raking: 'fixture', imputation: ['fixture'], knownDatasetIssues: ['fixture'] },
    sources: [{ name: 'Renderer test fixture', url: '', license: 'n/a' }],
  };
}

// ---------------------------------------------------------------- scenario (hypothetical data centre)

function viewAgg(rs: { stance: number }[]): ViewAgg {
  const n = rs.length || 1;
  const support = rs.filter((r) => r.stance >= 1).length / n;
  const oppose = rs.filter((r) => r.stance <= -1).length / n;
  return { n: rs.length, support, oppose, neutral: 1 - support - oppose, yesShare: support / Math.max(1e-9, support + oppose), meanStance: rs.reduce((s, r) => s + r.stance, 0) / n };
}

export function makeFixtureScenario(map: MapFile, pop: PopulationFile): Scenario {
  const rng = makeRng(7);
  const site = { lon: 2.392, lat: 48.9265, x: 0, y: 0, label: 'Proposed AI data centre', ringsTiles: [5, 10, 20] };
  const [sxf, syf] = xy([site.lon, site.lat]);
  site.x = Math.floor(sxf);
  site.y = Math.floor(syf);
  const zone = ['La Courneuve', 'Aubervilliers', 'Saint-Denis'].map((n) => map.districtList.find((d) => d.name === n)!.idx);
  const results: ResidentResult[] = pop.residents.map((r) => {
    const d = Math.hypot(r.home[0] - site.x, r.home[1] - site.y);
    const score = (d <= 5 ? 3 : d <= 10 ? 2 : d <= 20 ? 1 : 0) as 0 | 1 | 2 | 3;
    const reasons: ResidentResult['exposure']['reasons'] = [];
    if (d <= 10) reasons.push({ code: 'construction', text: `Lives ${Math.round(d * 100)} m from the site: about two years of construction trucks and noise`, icon: 'construction', at: [[site.x, site.y]] });
    if (d <= 6) reasons.push({ code: 'heat', text: 'Rooftop cooling fans and waste heat a few streets away', icon: 'noise', at: [[site.x + 1, site.y - 1]] });
    const job = !!r.work && (r.occupationGroup === 'ouvriers' || r.occupationGroup === 'employes' || r.occupationGroup === 'prof_inter') && d <= 20;
    if (job) reasons.push({ code: 'jobs', text: 'Could apply for one of the ~150 operations and security jobs', icon: 'job', at: [[site.x - 1, site.y + 1]] });
    if (score >= 1) reasons.push({ code: 'power', text: 'The site would draw about 100 MW from the local grid', icon: 'power', at: [[site.x + 4, site.y - 3]] });
    if (score >= 2 && r.imputed.tenure !== 'owner') reasons.push({ code: 'rent', text: 'Renter (imputed): nearby rents could rise', icon: 'home', at: [r.home] });
    if (r.commuteMode === 'car' && r.work && Math.hypot(r.work[0] - site.x, r.work[1] - site.y) < 12) reasons.push({ code: 'traffic', text: 'Drives (imputed car) past the works every day', icon: 'car', at: [[Math.round((r.home[0] + site.x) / 2), Math.round((r.home[1] + site.y) / 2)]] });
    let s = -0.55 * score + (job ? 1.1 : 0) + (r.occupationGroup === 'cadres' ? 0.35 : 0) + (rng() - 0.5) * 1.9;
    s = Math.max(-2, Math.min(2, Math.round(s)));
    const wouldParticipateLLM = Math.min(1, 0.15 + score * 0.18 + rng() * 0.3);
    return {
      id: r.id, exposure: { score, reasons }, stance: s as ResidentResult['stance'], affectedLLM: score,
      behaviourEn: 'Simulated voice (fixture).', reasonFr: 'Texte de test.', reasonEn: 'Fixture text.',
      wouldParticipateLLM, participationScore: r.participationBase * 0.6 + score * 0.08 + wouldParticipateLLM * 0.1,
      eligible: true, attendee: false, themeId: score >= 2 ? 'noise' : job ? 'jobs' : 'energy',
    };
  });
  const k = Math.round(results.length * 0.06);
  [...results].sort((a, b) => b.participationScore - a.participationScore).slice(0, k).forEach((r) => (r.attendee = true));
  // neighbour conversations: pair residents who live close to each other
  const conversations: Conversation[] = [];
  const res = pop.residents;
  for (let c = 0; c < 300; c++) {
    const a = res[Math.floor(rng() * res.length)];
    let b: Resident | null = null;
    for (let t = 0; t < 40; t++) {
      const cand = res[Math.floor(rng() * res.length)];
      if (cand.id !== a.id && Math.hypot(cand.home[0] - a.home[0], cand.home[1] - a.home[1]) < 4) {
        b = cand;
        break;
      }
    }
    if (!b) continue;
    const ra = results[a.id];
    const rb = results[b.id];
    const after = { a: ra.stance, b: rb.stance };
    if (rng() < 0.3 && ra.stance !== rb.stance) after.a = (ra.stance + Math.sign(rb.stance - ra.stance)) as ResidentResult['stance'];
    ra.stanceAfter = after.a as ResidentResult['stanceAfter'];
    rb.stanceAfter = (rb.stanceAfter ?? rb.stance) as ResidentResult['stanceAfter'];
    ra.talkedWith = [...(ra.talkedWith ?? []), b.id];
    rb.talkedWith = [...(rb.talkedWith ?? []), a.id];
    conversations.push({
      id: `c${c}`, a: a.id, b: b.id,
      where: [Math.round((a.home[0] + b.home[0]) / 2), Math.round((a.home[1] + b.home[1]) / 2)],
      lines: [
        { speaker: a.id, fr: 'Tu as entendu parler du data centre ?', en: 'Have you heard about the data centre they want to build?' },
        { speaker: b.id, fr: 'Oui... deux ans de camions, non merci.', en: 'Yes... two years of trucks outside my window, no thanks.' },
        { speaker: a.id, fr: 'Mais il y aurait des emplois pour le quartier.', en: 'But it could bring jobs to the neighbourhood.' },
        { speaker: b.id, fr: 'Peut-être. Il faudrait des garanties.', en: 'Maybe. We would need real guarantees first.' },
      ],
      stanceBefore: { a: ra.stance, b: rb.stance }, stanceAfter: after, themeId: 'jobs',
    });
  }
  const byDistrict = map.districtList.map((d) => {
    const rs = results.filter((r) => pop.residents[r.id].districtIdx === d.idx);
    return { districtIdx: d.idx, n: rs.length, everyone: viewAgg(rs), attendees: viewAgg(rs.filter((r) => r.attendee)), meanExposure: rs.reduce((s, r) => s + r.exposure.score, 0) / (rs.length || 1) };
  }).filter((d) => d.n > 0);
  const byGroup: GroupAgg[] = pop.groups.map((g) => {
    const rs = results.filter((r) => pop.residents[r.id].groupIds.includes(g.id));
    const shareAll = rs.length / results.length;
    const shareAtt = rs.filter((r) => r.attendee).length / Math.max(1, results.filter((r) => r.attendee).length);
    return { groupId: g.id, label: g.label, n: rs.length, everyone: viewAgg(rs), representationRatio: shareAtt / Math.max(1e-9, shareAll), meanExposure: rs.reduce((s, r) => s + r.exposure.score, 0) / (rs.length || 1) };
  });
  return {
    version: 1, id: 'fixture_datacentre_93', title: 'An AI data centre in Seine-Saint-Denis (fixture)', titleFr: 'Un data centre IA en Seine-Saint-Denis',
    summary: 'Renderer test fixture: invented reactions, not a simulation output.', proposalFr: 'Construction d\'un grand data centre IA à La Courneuve.',
    proposalEn: 'Construction of a large AI data centre in La Courneuve.', kind: 'hypothetical', channel: 'public_meeting', turnoutTarget: 0.06,
    voterScope: 'all_residents', site, zoneDistricts: zone, mock: true, models: { reaction: 'fixture' }, generatedAt: new Date(0).toISOString(),
    results, conversations,
    aggregates: {
      views: { everyone: viewAgg(results), eligible: viewAgg(results.filter((r) => r.eligible)), attendees: viewAgg(results.filter((r) => r.attendee)) },
      byDistrict, byGroup,
    },
    themes: [], consult: [], uncertainty: { method: 'none', runs: 1 }, notes: ['Fixture for renderer tests only.'],
  };
}
