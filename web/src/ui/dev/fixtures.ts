/**
 * BUILT-IN DEMO DATA for developing the UI before the pipeline has produced real files.
 * Everything here is synthetic and generated deterministically in the browser:
 *  - a rough Paris + inner-suburbs map (Voronoi cells around real centroids, not real borders),
 *  - 2,000 made-up residents (NOT from the NVIDIA dataset),
 *  - three scenarios with heuristic reactions (mock: true), conversations, themes, consult cards,
 *    and a backtest whose SECTOR results are rough placeholders (only the city-wide totals are real).
 * The UI shows a banner whenever this data is in use.
 */
import config from '../../../shared/config.json';
import type {
  CommuteMode,
  Conversation,
  District,
  ExposureReason,
  GroupDef,
  HouseholdKind,
  Look,
  MapFile,
  Nationality,
  OccupationGroup,
  PopulationFile,
  Resident,
  ResidentResult,
  Scenario,
  ScenarioIndexEntry,
  Tenure,
  Theme,
} from '../../types';
import {
  backtestBySector,
  buildConsultRecs,
  computeAggregates,
  participationScore,
  pickAttendees,
  themeStats,
  type AggContext,
} from '../aggregate';
import { OCCUPATION_LABEL } from '../labels';
import { clamp, makeRng, pick, pickWeighted } from '../random';

const W = config.gridWidth;
const H = config.gridHeight;
const B = config.bbox;
const TT = Object.fromEntries(config.tileTypes.map((t, i) => [t, i])) as Record<string, number>;

/** lon/lat -> continuous tile coordinates (same projection as types.ts). */
function ll(lon: number, lat: number): [number, number] {
  return [((lon - B.lonMin) / (B.lonMax - B.lonMin)) * W, ((B.latMax - lat) / (B.latMax - B.latMin)) * H];
}

function pointInPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToPolyline(p: [number, number], line: [number, number][], closed = false): number {
  let best = Infinity;
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, distToSegment(p, line[i], line[(i + 1) % line.length]));
  return best;
}

// ---------- geography (approximate, for the demo only) ----------

const ARR: [string, number, number, number][] = [
  // name, lon, lat, population
  ['1er', 2.3364, 48.8626, 15900],
  ['2e', 2.3428, 48.8683, 21000],
  ['3e', 2.36, 48.863, 33000],
  ['4e', 2.3576, 48.8543, 28000],
  ['5e', 2.3507, 48.8445, 57000],
  ['6e', 2.3327, 48.8491, 40000],
  ['7e', 2.3122, 48.8562, 49000],
  ['8e', 2.3125, 48.8727, 35000],
  ['9e', 2.3375, 48.8771, 59000],
  ['10e', 2.3608, 48.8762, 83000],
  ['11e', 2.38, 48.8591, 142000],
  ['12e', 2.4, 48.838, 140000],
  ['13e', 2.3621, 48.8283, 178000],
  ['14e', 2.3265, 48.8292, 134000],
  ['15e', 2.2928, 48.8401, 228000],
  ['16e', 2.265, 48.858, 162000],
  ['17e', 2.3067, 48.8873, 166000],
  ['18e', 2.3482, 48.8925, 191000],
  ['19e', 2.3848, 48.8871, 183000],
  ['20e', 2.4012, 48.8634, 192000],
];

const SUBURBS: [string, string, '92' | '93' | '94', number, number, number][] = [
  // name, INSEE code, dept, lon, lat, population
  ['Boulogne-Billancourt', '92012', '92', 2.2399, 48.8352, 121000],
  ['Issy-les-Moulineaux', '92040', '92', 2.262, 48.824, 68000],
  ['Neuilly-sur-Seine', '92051', '92', 2.2685, 48.8846, 59000],
  ['Levallois-Perret', '92044', '92', 2.2875, 48.895, 66000],
  ['Clichy', '92024', '92', 2.306, 48.904, 62000],
  ['Courbevoie', '92026', '92', 2.256, 48.897, 82000],
  ['Puteaux', '92062', '92', 2.238, 48.884, 45000],
  ['Nanterre', '92050', '92', 2.207, 48.892, 96000],
  ['Asnières-sur-Seine', '92004', '92', 2.285, 48.915, 87000],
  ['Gennevilliers', '92036', '92', 2.294, 48.933, 48000],
  ['Colombes', '92025', '92', 2.254, 48.923, 86000],
  ['Suresnes', '92073', '92', 2.229, 48.871, 49000],
  ['Saint-Cloud', '92064', '92', 2.207, 48.844, 30000],
  ['Meudon', '92048', '92', 2.235, 48.813, 46000],
  ['Clamart', '92023', '92', 2.266, 48.796, 53000],
  ['Vanves', '92075', '92', 2.29, 48.822, 28000],
  ['Malakoff', '92046', '92', 2.299, 48.817, 31000],
  ['Montrouge', '92049', '92', 2.319, 48.816, 50000],
  ['Châtillon', '92020', '92', 2.288, 48.803, 38000],
  ['Bagneux', '92007', '92', 2.308, 48.796, 41000],
  ['Saint-Ouen-sur-Seine', '93070', '93', 2.334, 48.911, 50000],
  ['Saint-Denis', '93066', '93', 2.358, 48.936, 113000],
  ['Aubervilliers', '93001', '93', 2.383, 48.914, 88000],
  ['La Courneuve', '93027', '93', 2.396, 48.928, 44000],
  ['Pantin', '93055', '93', 2.405, 48.894, 59000],
  ['Le Pré-Saint-Gervais', '93061', '93', 2.405, 48.885, 17000],
  ['Les Lilas', '93045', '93', 2.419, 48.88, 23000],
  ['Bagnolet', '93006', '93', 2.417, 48.869, 37000],
  ['Montreuil', '93048', '93', 2.441, 48.863, 111000],
  ['Romainville', '93063', '93', 2.435, 48.885, 30000],
  ['Bobigny', '93008', '93', 2.44, 48.908, 55000],
  ['Noisy-le-Sec', '93053', '93', 2.46, 48.89, 45000],
  ['Drancy', '93029', '93', 2.445, 48.923, 72000],
  ['Rosny-sous-Bois', '93064', '93', 2.484, 48.874, 46000],
  ['Bondy', '93010', '93', 2.483, 48.902, 54000],
  ['Vincennes', '94080', '94', 2.439, 48.847, 49000],
  ['Saint-Mandé', '94067', '94', 2.418, 48.842, 23000],
  ['Fontenay-sous-Bois', '94033', '94', 2.476, 48.851, 53000],
  ['Charenton-le-Pont', '94018', '94', 2.415, 48.822, 31000],
  ['Ivry-sur-Seine', '94041', '94', 2.388, 48.813, 62000],
  ['Vitry-sur-Seine', '94081', '94', 2.393, 48.788, 95000],
  ['Le Kremlin-Bicêtre', '94043', '94', 2.359, 48.81, 26000],
  ['Gentilly', '94037', '94', 2.344, 48.813, 17000],
  ['Arcueil', '94003', '94', 2.336, 48.805, 21000],
  ['Villejuif', '94076', '94', 2.364, 48.792, 55000],
  ['Maisons-Alfort', '94046', '94', 2.438, 48.806, 56000],
  ['Alfortville', '94002', '94', 2.42, 48.796, 45000],
  ['Nogent-sur-Marne', '94052', '94', 2.482, 48.837, 32000],
  ['Joinville-le-Pont', '94042', '94', 2.472, 48.821, 20000],
  ['Saint-Maur-des-Fossés', '94068', '94', 2.499, 48.8, 75000],
];

const PARIS_OUTLINE: [number, number][] = (
  [
    [2.2242, 48.8536], [2.2318, 48.8692], [2.2539, 48.8739], [2.28, 48.88], [2.2915, 48.8885], [2.32, 48.9005],
    [2.344, 48.9015], [2.37, 48.9015], [2.3895, 48.901], [2.399, 48.887], [2.41, 48.878], [2.413, 48.865],
    [2.413, 48.849], [2.416, 48.846], [2.44, 48.845], [2.46, 48.843], [2.469, 48.834], [2.463, 48.82],
    [2.44, 48.818], [2.415, 48.824], [2.399, 48.827], [2.39, 48.825], [2.364, 48.816], [2.344, 48.816],
    [2.327, 48.817], [2.302, 48.827], [2.285, 48.831], [2.267, 48.834], [2.255, 48.835], [2.24, 48.846],
  ] as [number, number][]
).map(([lon, lat]) => ll(lon, lat));

const SEINE: [number, number][] = (
  [
    [2.43, 48.772], [2.415, 48.795], [2.405, 48.81], [2.395, 48.822], [2.38, 48.834], [2.366, 48.845],
    [2.353, 48.852], [2.34, 48.857], [2.326, 48.862], [2.31, 48.863], [2.297, 48.859], [2.285, 48.852],
    [2.275, 48.846], [2.265, 48.838], [2.252, 48.832], [2.24, 48.828], [2.228, 48.835], [2.222, 48.848],
    [2.223, 48.862], [2.232, 48.877], [2.245, 48.889], [2.258, 48.899], [2.275, 48.908], [2.295, 48.918],
    [2.315, 48.926], [2.335, 48.932], [2.35, 48.938], [2.36, 48.946], [2.365, 48.952],
  ] as [number, number][]
).map(([lon, lat]) => ll(lon, lat));

const MARNE: [number, number][] = (
  [[2.53, 48.826], [2.5, 48.814], [2.47, 48.81], [2.44, 48.812], [2.415, 48.818]] as [number, number][]
).map(([lon, lat]) => ll(lon, lat));

const RAILS: [number, number][][] = (
  [
    [[2.355, 48.881], [2.358, 48.91], [2.362, 48.95]],
    [[2.373, 48.845], [2.41, 48.825], [2.45, 48.8], [2.48, 48.775]],
    [[2.325, 48.876], [2.29, 48.9], [2.25, 48.925], [2.2, 48.95]],
    [[2.32, 48.841], [2.29, 48.82], [2.25, 48.795], [2.21, 48.775]],
    [[2.359, 48.877], [2.4, 48.9], [2.45, 48.925], [2.53, 48.94]],
  ] as [number, number][][]
).map((line) => line.map(([lon, lat]) => ll(lon, lat)));

const WOODS: { c: [number, number]; rx: number; ry: number; forest: boolean }[] = [
  { c: ll(2.249, 48.8625), rx: 7.5, ry: 8.2, forest: true }, // Bois de Boulogne
  { c: ll(2.438, 48.8325), rx: 9.5, ry: 5.2, forest: true }, // Bois de Vincennes
  { c: ll(2.22, 48.802), rx: 7, ry: 6, forest: true }, // Meudon woods
  { c: ll(2.214, 48.838), rx: 3, ry: 3.5, forest: true }, // Saint-Cloud park
  { c: ll(2.418, 48.932), rx: 5, ry: 3.5, forest: false }, // big park north-east
  { c: ll(2.3828, 48.8809), rx: 2.2, ry: 1.8, forest: false },
  { c: ll(2.3372, 48.8462), rx: 1.7, ry: 2.2, forest: false },
  { c: ll(2.327, 48.8635), rx: 2.6, ry: 1, forest: false },
  { c: ll(2.2984, 48.8556), rx: 1.2, ry: 2.4, forest: false },
  { c: ll(2.338, 48.822), rx: 1.8, ry: 1.4, forest: false },
  { c: ll(2.309, 48.8797), rx: 1.2, ry: 1.2, forest: false },
  { c: ll(2.39, 48.894), rx: 2.5, ry: 2, forest: false },
];

const PLAZAS = [ll(2.3212, 48.8656), ll(2.3631, 48.8674), ll(2.3691, 48.8532), ll(2.3959, 48.8483), ll(2.295, 48.8738)];

export function makeFixtureMap(): MapFile {
  const defs: Omit<District, 'idx' | 'centroid' | 'labelPos' | 'tileCount'>[] = [];
  const centres: [number, number][] = [];
  for (const [name, lon, lat, population] of ARR) {
    const n = parseInt(name, 10);
    defs.push({
      code: `751${String(n).padStart(2, '0')}`,
      name,
      fullName: `Paris ${name} Arrondissement`,
      kind: 'arrondissement',
      dept: '75',
      sector: n <= 4 ? 'Paris Centre' : name,
      population,
    });
    centres.push(ll(lon, lat));
  }
  for (const [name, code, dept, lon, lat, population] of SUBURBS) {
    defs.push({ code, name, fullName: name, kind: 'commune', dept, population });
    centres.push(ll(lon, lat));
  }
  const nArr = ARR.length;

  const tiles = new Array<number>(W * H).fill(TT.outside);
  const districts = new Array<number>(W * H).fill(0);
  const rng = makeRng(42);
  const idx16 = 16;
  const idx12 = 12;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p: [number, number] = [x + 0.5, y + 0.5];
      const i = y * W + x;
      const inParis = pointInPolygon(p, PARIS_OUTLINE);
      let d = 0;
      if (inParis) {
        let best = Infinity;
        for (let k = 0; k < nArr; k++) {
          const dd = Math.hypot(p[0] - centres[k][0], p[1] - centres[k][1]);
          if (dd < best) {
            best = dd;
            d = k + 1;
          }
        }
      } else {
        let best = Infinity;
        for (let k = nArr; k < centres.length; k++) {
          const dd = Math.hypot(p[0] - centres[k][0], p[1] - centres[k][1]);
          if (dd < best) {
            best = dd;
            d = k + 1;
          }
        }
        if (best > 26) d = 0; // ~2.6 km from any commune centre: outside the study area
      }

      // Tile type
      let t = TT.outside;
      const wood = WOODS.find((w) => ((p[0] - w.c[0]) / w.rx) ** 2 + ((p[1] - w.c[1]) / w.ry) ** 2 <= 1);
      if (inParis && wood?.forest) d = wood.c[0] < W / 2 ? idx16 : idx12;
      if (d > 0) {
        t = inParis ? TT.haussmann : TT.suburb_house;
        if (!inParis) {
          const dept = defs[d - 1].dept;
          const r = rng();
          if (dept === '93' && r < 0.35) t = TT.suburb_tower;
          else if (r < 0.15) t = TT.suburb_tower;
          const nearIndustry =
            Math.hypot(p[0] - ll(2.365, 48.915)[0], p[1] - ll(2.365, 48.915)[1]) < 9 ||
            Math.hypot(p[0] - ll(2.3, 48.94)[0], p[1] - ll(2.3, 48.94)[1]) < 8 ||
            Math.hypot(p[0] - ll(2.4, 48.808)[0], p[1] - ll(2.4, 48.808)[1]) < 6;
          if (nearIndustry && rng() < 0.6) t = TT.industrial;
          if (x % 6 === 0 || y % 6 === 0) t = TT.street;
        } else if (x % 4 === 0 || y % 4 === 0) t = TT.street;
        if (wood) t = wood.forest ? TT.forest : TT.park;
        if (PLAZAS.some((c) => Math.hypot(p[0] - c[0], p[1] - c[1]) < 1.4)) t = TT.plaza;
      }
      if (RAILS.some((line) => distToPolyline(p, line) < 0.55) && t !== TT.outside) t = TT.rail;
      if (inParis && distToPolyline(p, PARIS_OUTLINE, true) < 0.8 && !wood) t = TT.ring_road;
      if (distToPolyline(p, SEINE) < 0.85 || distToPolyline(p, MARNE) < 0.6) t = TT.water;
      tiles[i] = t;
      districts[i] = d;
    }
  }

  // Centroids, label positions and tile counts from the grid
  const sums = defs.map(() => ({ x: 0, y: 0, n: 0 }));
  for (let i = 0; i < W * H; i++) {
    const d = districts[i];
    if (!d) continue;
    sums[d - 1].x += (i % W) + 0.5;
    sums[d - 1].y += Math.floor(i / W) + 0.5;
    sums[d - 1].n++;
  }
  const districtList: District[] = defs.map((def, k) => {
    const s = sums[k];
    const c: [number, number] = s.n ? [s.x / s.n, s.y / s.n] : centres[k];
    return { ...def, idx: k + 1, centroid: c, labelPos: [Math.round(c[0]), Math.round(c[1])], tileCount: s.n };
  });

  return {
    version: 1,
    width: W,
    height: H,
    tilePx: config.tilePx,
    tileMeters: config.tileMeters,
    bbox: { ...B },
    tileTypes: [...config.tileTypes],
    tiles,
    districts,
    districtList: districtList.filter((d) => d.tileCount > 0 || d.kind === 'arrondissement'),
    landmarks: config.landmarks.map((l) => {
      const [x, y] = ll(l.lon, l.lat);
      return { id: l.id, name: l.name, nameFr: l.nameFr, kind: l.kind, x: Math.floor(x), y: Math.floor(y) };
    }),
    seine: SEINE.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as [number, number]),
    sources: [{ name: 'Built-in demo geometry (approximate, not real borders)', url: '', license: 'n/a' }],
  };
}

// ---------- population ----------

const FIRST_F = ['Camille', 'Léa', 'Manon', 'Inès', 'Fatou', 'Amina', 'Sarah', 'Chloé', 'Nadia', 'Mei', 'Sofia', 'Julie', 'Claire', 'Hélène', 'Monique', 'Yasmina', 'Aïcha', 'Lucie', 'Emma', 'Jade', 'Nathalie', 'Sylvie', 'Khadija', 'Anaïs'];
const FIRST_M = ['Lucas', 'Hugo', 'Karim', 'Mamadou', 'Thomas', 'Nicolas', 'Julien', 'Mehdi', 'Antoine', 'Pierre', 'Jean-Pierre', 'Bernard', 'Rayan', 'Yanis', 'Wei', 'Samuel', 'Moussa', 'Olivier', 'Louis', 'Adam', 'Patrick', 'Gérard', 'Sofiane', 'Théo'];
const LAST = ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'Benali', 'Diallo', 'Traoré', 'Nguyen', 'Haddad', 'Rossi', 'Da Silva', 'Mendy', 'Chen', 'Kaci', 'Fontaine', 'Rousseau', 'Blanc', 'Girard', 'Mercier', 'Bonnet'];

const OCC_FR: Record<OccupationGroup, string> = {
  agriculteurs: 'Agriculteurs exploitants',
  artisans: "Artisans, commerçants, chefs d'entreprise",
  cadres: 'Cadres et professions intellectuelles supérieures',
  prof_inter: 'Professions intermédiaires',
  employes: 'Employés',
  ouvriers: 'Ouvriers',
  retraites: 'Retraités',
  sans_activite: 'Autres sans activité professionnelle',
};
const JOB_FR: Record<OccupationGroup, string[]> = {
  agriculteurs: ['maraîcher'],
  artisans: ['boulangère', 'plombier', 'gérante de café', 'électricien'],
  cadres: ['ingénieure logiciel', 'avocat', 'cheffe de projet', 'médecin', 'professeur de lycée'],
  prof_inter: ['infirmière', 'technicien de maintenance', 'éducatrice', 'comptable'],
  employes: ['aide-soignante', 'caissier', 'agente d’accueil', 'livreur', 'assistante administrative'],
  ouvriers: ['cariste', 'ouvrier du bâtiment', 'agent d’entretien', 'chauffeur'],
  retraites: ['retraitée de la poste', 'ancien cheminot', 'retraitée de l’enseignement', 'ancien commerçant'],
  sans_activite: ['étudiante', 'en recherche d’emploi', 'parent au foyer', 'étudiant en master'],
};
const EDU = ['Sans diplôme ou CEP', 'Brevet', 'CAP ou BEP', 'Baccalauréat', 'Bac+2', 'Bac+3 ou Bac+4', 'Bac+5 ou plus'];
const HH_RAW: Record<HouseholdKind, string> = {
  single: 'Personne seule',
  couple_no_kids: 'Couple sans enfant',
  couple_kids: 'Couple avec enfant(s)',
  single_parent: 'Famille monoparentale',
};

const BUILDING = new Set([TT.haussmann, TT.suburb_house, TT.suburb_tower]);

export const FIXTURE_GROUPS: GroupDef[] = [
  { id: 'young_renters', label: 'Young renters (18–29)', description: 'Aged 18–29 and renting. Tenure is imputed from INSEE statistics.' },
  { id: 'families', label: 'Families with children', description: 'Couples with children and single parents (from the dataset household field).' },
  { id: 'retirees', label: 'Retirees', description: 'Occupation “Retraités” in the dataset.' },
  { id: 'workers', label: 'Manual and service workers', description: 'Occupations “Employés” and “Ouvriers”.' },
  { id: 'car_owners', label: 'Car owners', description: 'Household has a car. Imputed from INSEE car-ownership rates.' },
  { id: 'heavy_car_owners', label: 'Heavy-car owners', description: 'Car of 1.6 t or more (2 t for electric). Imputed.' },
  { id: 'social_housing', label: 'Social-housing tenants', description: 'Rents social housing (HLM). Imputed from INSEE tenure rates.' },
  { id: 'non_eu', label: 'Non-EU residents', description: 'Cannot vote in Paris votations. Nationality imputed from INSEE statistics.' },
  { id: 'suburb_residents', label: 'Suburban residents', description: 'Lives outside Paris (Hauts-de-Seine, Seine-Saint-Denis, Val-de-Marne).' },
];

function ageBand(age: number): Resident['ageBand'] {
  if (age < 30) return '18-29';
  if (age < 45) return '30-44';
  if (age < 60) return '45-59';
  if (age < 75) return '60-74';
  return '75+';
}

export function makeFixturePopulation(map: MapFile, count = 2000): PopulationFile {
  const rng = makeRng(2024);
  const tilesByDistrict = new Map<number, number[]>();
  for (let i = 0; i < map.tiles.length; i++) {
    const d = map.districts[i];
    if (!d || !BUILDING.has(map.tiles[i])) continue;
    const list = tilesByDistrict.get(d) ?? [];
    list.push(i);
    tilesByDistrict.set(d, list);
  }
  const districts = map.districtList.filter((d) => (tilesByDistrict.get(d.idx)?.length ?? 0) > 0);
  const byName = new Map(map.districtList.map((d) => [d.name, d]));
  const jobHubs = ['8e', '9e', '2e', '1er', '15e', '13e', 'Courbevoie', 'Puteaux', 'Saint-Denis', '12e']
    .map((n) => byName.get(n))
    .filter((d): d is District => Boolean(d && tilesByDistrict.get(d.idx)));
  const tileXY = (i: number): [number, number] => [i % map.width, Math.floor(i / map.width)];

  const residents: Resident[] = [];
  for (let id = 0; id < count; id++) {
    const district = pickWeighted(rng, districts, (d) => d.population);
    const paris = district.dept === '75';
    const sex: 'F' | 'M' = rng() < 0.53 ? 'F' : 'M';
    const age = Math.round(18 + Math.pow(rng(), 1.25) * 72);
    // Occupation by age (rough Paris-area shares)
    let occ: OccupationGroup;
    if (age >= 65 && rng() < 0.85) occ = 'retraites';
    else if (age < 25 && rng() < 0.55) occ = 'sans_activite';
    else
      occ = pickWeighted(
        rng,
        ['cadres', 'prof_inter', 'employes', 'ouvriers', 'artisans', 'sans_activite'] as OccupationGroup[],
        (o) =>
          ({
            cadres: paris ? 34 : district.dept === '92' ? 28 : 12,
            prof_inter: 24,
            employes: paris ? 18 : 27,
            ouvriers: paris ? 6 : district.dept === '93' ? 17 : 11,
            artisans: 6,
            sans_activite: 10,
            agriculteurs: 0,
            retraites: 0,
          })[o],
      );
    const eduRank = clamp(
      Math.round(
        ({ cadres: 5.6, prof_inter: 4.2, employes: 2.8, ouvriers: 1.8, artisans: 3, agriculteurs: 2, retraites: 2.8, sans_activite: 3.4 })[occ] +
          (rng() - 0.5) * 2.2,
      ),
      0,
      6,
    );
    const household = pickWeighted(rng, ['single', 'couple_no_kids', 'couple_kids', 'single_parent'] as HouseholdKind[], (h) =>
      ({ single: age > 70 || age < 28 ? 50 : 30, couple_no_kids: 25, couple_kids: age > 28 && age < 60 ? 35 : 5, single_parent: age > 25 && age < 60 ? 9 : 1 })[h],
    );
    const homeTiles = tilesByDistrict.get(district.idx)!;
    const home = tileXY(pick(rng, homeTiles));

    let work: [number, number] | null = null;
    let workDistrictIdx: number | null = null;
    if (occ !== 'retraites' && !(occ === 'sans_activite' && rng() < 0.8)) {
      const r = rng();
      const wd = r < 0.35 ? district : r < 0.8 && jobHubs.length ? pick(rng, jobHubs) : pick(rng, districts);
      work = tileXY(pick(rng, tilesByDistrict.get(wd.idx)!));
      workDistrictIdx = wd.idx;
    }

    // Imputed attributes (not in the dataset)
    const carP = (paris ? 0.33 : 0.6) + (household === 'couple_kids' ? 0.15 : 0) + (age < 30 ? -0.15 : 0);
    const car = rng() < carP;
    const richWest = ['7e', '8e', '16e', '17e', 'Neuilly-sur-Seine', 'Boulogne-Billancourt'].includes(district.name);
    const heavyCar = car && rng() < 0.28 + (occ === 'cadres' ? 0.12 : 0) + (richWest ? 0.2 : 0);
    const tenureW: Record<Tenure, number> = paris
      ? { owner: 33 + (age > 55 ? 20 : 0) + (richWest ? 15 : 0), private_renter: 47 + (age < 35 ? 20 : 0), social_renter: richWest ? 6 : 22 }
      : district.dept === '93'
        ? { owner: 36 + (age > 55 ? 15 : 0), private_renter: 28, social_renter: 36 }
        : { owner: 45 + (age > 55 ? 15 : 0), private_renter: 30, social_renter: 25 };
    const tenure = pickWeighted(rng, ['owner', 'private_renter', 'social_renter'] as Tenure[], (t) => tenureW[t]);
    const nonEuP = district.dept === '93' ? 0.22 : paris ? 0.11 : 0.1;
    const nationality: Nationality = rng() < nonEuP ? 'non_eu' : rng() < 0.06 ? 'eu' : 'french';

    let commuteMode: CommuteMode = 'none';
    if (work) {
      const dist = Math.hypot(work[0] - home[0], work[1] - home[1]);
      if (dist < 12) commuteMode = rng() < 0.5 ? 'walk' : rng() < 0.5 ? 'bike' : 'metro';
      else if (car && (!paris || rng() < 0.25) && rng() < 0.55) commuteMode = 'car';
      else commuteMode = paris ? (rng() < 0.75 ? 'metro' : 'bus') : rng() < 0.6 ? 'rer' : 'bus';
    }

    const participationBase = clamp(
      0.08 + 0.006 * (age - 18) + 0.045 * eduRank + (tenure === 'owner' ? 0.08 : tenure === 'social_renter' ? -0.06 : 0) + (rng() - 0.5) * 0.08,
      0.02,
      0.95,
    );
    const first = pick(rng, sex === 'F' ? FIRST_F : FIRST_M);
    const name = `${first} ${pick(rng, LAST)}`;
    const job = pick(rng, JOB_FR[occ]);
    const commune = paris ? `Paris ${district.name}` : district.name;
    const personaFr = `${name}, ${age} ans, ${job}, vit à ${commune}. ${
      household === 'couple_kids' ? 'Parent de deux enfants, ' : household === 'single' ? 'Vit seul·e, ' : ''
    }${pick(rng, ['aime les marchés du dimanche', 'fait du vélo le week-end', 's’investit dans une association de quartier', 'lit beaucoup', 'joue au football avec des amis', 'cuisine pour ses voisins'])}.`;
    const groupIds: string[] = [];
    if (age < 30 && tenure !== 'owner') groupIds.push('young_renters');
    if (household === 'couple_kids' || household === 'single_parent') groupIds.push('families');
    if (occ === 'retraites') groupIds.push('retirees');
    if (occ === 'employes' || occ === 'ouvriers') groupIds.push('workers');
    if (car) groupIds.push('car_owners');
    if (heavyCar) groupIds.push('heavy_car_owners');
    if (tenure === 'social_renter') groupIds.push('social_housing');
    if (nationality === 'non_eu') groupIds.push('non_eu');
    if (!paris) groupIds.push('suburb_residents');
    const look: Look = {
      skin: Math.floor(rng() * 6),
      hair: age > 62 && rng() < 0.6 ? 7 : Math.floor(rng() * 7),
      hairStyle: Math.floor(rng() * 6),
      shirt: Math.floor(rng() * 12),
      pants: Math.floor(rng() * 6),
      accessory: rng() < 0.55 ? 0 : 1 + Math.floor(rng() * 4),
    };
    residents.push({
      id,
      uuid: `fixture-${id.toString(16).padStart(6, '0')}`,
      name,
      sex,
      age,
      ageBand: ageBand(age),
      occupation: OCC_FR[occ],
      occupationGroup: occ,
      occupationEn: OCCUPATION_LABEL[occ],
      education: EDU[eduRank],
      educationRank: eduRank,
      household,
      householdRaw: HH_RAW[household],
      maritalStatus: household.startsWith('couple') ? 'Marié·e' : 'Célibataire',
      districtIdx: district.idx,
      districtSource: paris && rng() < 0.5 ? 'imputed' : 'dataset',
      home,
      work,
      workDistrictIdx,
      commuteMode,
      imputed: { car, heavyCar, tenure, nationality },
      eligibleParis: paris && nationality !== 'non_eu',
      participationBase,
      weight: 0.7 + rng() * 0.6,
      groupIds,
      personaFr,
      personaEn: `${name}, ${age}, ${OCCUPATION_LABEL[occ].toLowerCase()} living in ${commune}.`,
      look,
    });
  }
  const meanW = residents.reduce((s, r) => s + r.weight, 0) / residents.length;
  for (const r of residents) r.weight = Math.round((r.weight / meanW) * 1000) / 1000;

  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    count: residents.length,
    residents,
    groups: FIXTURE_GROUPS,
    method: {
      sampling: 'Built-in demo population: random residents spread by district population (NOT the NVIDIA dataset).',
      raking: 'Not raked (demo data).',
      imputation: ['Car, heavy car, tenure, nationality and commute are random draws from rough rates (demo data).'],
      knownDatasetIssues: [
        'Real pipeline: NVIDIA France personas follow the national occupation mix (about 9.7% managers vs about 31.9% in Paris), so the sample is raked to INSEE.',
        'Real pipeline: about half of the Paris rows have no arrondissement; it is assigned jointly with occupation and education, never at random.',
      ],
    },
    sources: [{ name: 'Built-in demo residents (synthetic)', url: '', license: 'n/a' }],
  };
}

// ---------- scenarios ----------

interface ThemeText {
  id: string;
  label: string;
  labelFr: string;
  side: Theme['side'];
  fr: string[];
  en: string[];
  behaviour: string;
}

interface ScenarioRecipe {
  entry: ScenarioIndexEntry;
  base: Omit<Scenario, 'results' | 'conversations' | 'aggregates' | 'themes' | 'consult' | 'backtest' | 'backtestAfterTalk'>;
  themes: ThemeText[];
  short: { fr: string; en: string };
  exposure: (r: Resident) => ResidentResult['exposure'];
  stance: (r: Resident, e: ResidentResult['exposure'], rng: () => number) => -2 | -1 | 0 | 1 | 2;
  theme: (r: Resident, stance: number, e: ResidentResult['exposure'], rng: () => number) => string;
  backtest?: { sectors: Record<string, number>; actualYes: number; turnout: number; voteName: string; date: string; question: string; poll?: NonNullable<Scenario['backtest']>['poll'] };
}

function stanceFrom(rng: () => number, probs: [number, number, number, number, number]): -2 | -1 | 0 | 1 | 2 {
  const r = rng() * probs.reduce((s, p) => s + p, 0);
  let acc = 0;
  for (let k = 0; k < 5; k++) {
    acc += probs[k];
    if (r <= acc) return (k - 2) as -2 | -1 | 0 | 1 | 2;
  }
  return 0;
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** True if the district is a Paris arrondissement (works for the real map and the demo map). */
function parisChecker(map: MapFile): (districtIdx: number | null) => boolean {
  const paris = new Set(map.districtList.filter((d) => d.dept === '75').map((d) => d.idx));
  return (idx) => idx !== null && paris.has(idx);
}

function suvRecipe(map: MapFile): ScenarioRecipe {
  const isParis = parisChecker(map);
  const proposalFr =
    "Pour ou contre la création d'un tarif spécifique pour le stationnement des voitures individuelles lourdes, encombrantes, polluantes ? " +
    'Concrètement : le stationnement visiteur des voitures thermiques ou hybrides de 1,6 tonne ou plus (2 tonnes pour les électriques) coûterait 18 € de l’heure dans les arrondissements 1 à 11 et 12 € de l’heure dans les arrondissements 12 à 20. ' +
    'Les résidents stationnés dans leur quartier, les artisans, les taxis et les personnes handicapées ne seraient pas concernés.';
  const proposalEn =
    'For or against a specific parking rate for heavy, bulky, polluting individual cars? ' +
    'In practice: visitor parking for petrol or hybrid cars of 1.6 tonnes or more (2 tonnes for electric) would cost €18 an hour in the 1st–11th arrondissements and €12 an hour in the 12th–20th. ' +
    'Residents parked in their own area, tradespeople, taxis and disabled people would be exempt.';
  return {
    entry: { id: 'suv-2024', title: 'Parking fee for heavy cars', subtitle: 'Paris vote, 4 Feb 2024', kind: 'backtest', icon: 'car', date: '2024-02-04', mock: true },
    base: {
      version: 1,
      id: 'suv-2024',
      title: 'Parking fee for heavy cars (SUVs)',
      titleFr: 'Tarif de stationnement pour les voitures lourdes (SUV)',
      summary: 'Paris asked residents whether visitors should pay three times more to park heavy cars. We replay the vote on the simulated town and compare with the official result.',
      proposalFr,
      proposalEn,
      kind: 'backtest',
      date: '2024-02-04',
      channel: 'votation',
      turnoutTarget: 0.0568,
      voterScope: 'paris_eligible',
      mock: true,
      models: { reaction: 'demo-heuristic (no AI)', conversation: 'demo-template (no AI)' },
      generatedAt: new Date(0).toISOString(),
      uncertainty: { method: 'Bootstrap over residents (demo data has a single run).', runs: 1 },
      notes: ['Built-in demo data: sector-level “official” results are rough placeholders, not the published figures. Only the city-wide result and turnout are real.'],
    },
    short: { fr: 'tarif SUV', en: 'SUV parking fee' },
    themes: [
      { id: 'space_safety', label: 'Big cars take space and endanger walkers', labelFr: 'Encombrement et sécurité', side: 'support', fr: ['Ces gros SUV prennent toute la place sur le trottoir et je ne vois plus les enfants qui traversent.', 'Dans ma rue étroite, les voitures énormes bloquent tout. C’est normal qu’elles paient plus.'], en: ['These big SUVs take up the whole pavement and I can’t see children crossing anymore.', 'On my narrow street, huge cars block everything. It’s fair they pay more.'], behaviour: 'Would vote “pour” and tell friends it is about safety.' },
      { id: 'pollution', label: 'Cleaner air and climate', labelFr: 'Pollution et climat', side: 'support', fr: ['Plus la voiture est lourde, plus elle pollue. Il faut envoyer un signal.', 'Je respire les gaz d’échappement tous les jours en allant au travail.'], en: ['The heavier the car, the more it pollutes. We need to send a signal.', 'I breathe exhaust fumes every day on my way to work.'], behaviour: 'Would vote “pour” if reminded of the date.' },
      { id: 'need_car', label: '“I need a big car for my family or work”', labelFr: 'Besoin d’une grande voiture', side: 'oppose', fr: ['Avec trois enfants, je n’ai pas le choix d’avoir une grande voiture.', 'J’ai besoin de ma voiture pour mon travail, je ne roule pas en SUV pour frimer.'], en: ['With three kids I have no choice but to have a big car.', 'I need my car for work; I don’t drive an SUV to show off.'], behaviour: 'Would vote “contre” and complain to their local councillor.' },
      { id: 'another_tax', label: 'Just another tax on drivers', labelFr: 'Encore une taxe', side: 'oppose', fr: ['Encore une taxe déguisée sur les automobilistes.', 'La mairie cherche juste de l’argent, ça ne changera rien à la pollution.'], en: ['Yet another disguised tax on drivers.', 'City hall just wants money; it won’t change pollution.'], behaviour: 'Would vote “contre” if they bother to vote.' },
      { id: 'punishes_suburbs', label: 'Punishes suburban people who must drive in', labelFr: 'Pénalise la banlieue', side: 'oppose', fr: ['Je viens de banlieue, il n’y a pas de transports pratiques pour moi. On paie pour les Parisiens.', 'On ne nous demande même pas notre avis alors que c’est nous qui payons.'], en: ['I come in from the suburbs and there is no practical transport for me. We pay for Parisians.', 'Nobody even asks our opinion, yet we are the ones paying.'], behaviour: 'Cannot vote in Paris; would park outside Paris and take the metro, grudgingly.' },
      { id: 'not_my_issue', label: 'Doesn’t concern me', labelFr: 'Pas concerné·e', side: 'mixed', fr: ['Je n’ai pas de voiture, honnêtement ça ne me concerne pas beaucoup.', 'Je ne savais même pas qu’il y avait un vote.'], en: ['I don’t have a car; honestly it doesn’t concern me much.', 'I didn’t even know there was a vote.'], behaviour: 'Would probably not vote.' },
    ],
    exposure: (r) => {
      const reasons: ExposureReason[] = [];
      let score: 0 | 1 | 2 | 3 = 0;
      const paris = isParis(r.districtIdx);
      if (r.imputed.heavyCar && !paris && r.work && isParis(r.workDistrictIdx)) {
        score = 3;
        reasons.push({ code: 'heavy_car_drives_in', text: 'Has a heavy car (imputed) and drives into Paris for work: visitor parking would cost €12–18 an hour.', icon: 'money', at: [r.work] });
      } else if (r.imputed.heavyCar && paris) {
        score = 2;
        reasons.push({ code: 'heavy_car_paris', text: 'Has a heavy car (imputed): parking at home is unchanged, but €12–18 an hour in other arrondissements.', icon: 'car', at: [r.home] });
      } else if (r.imputed.car) {
        score = 1;
        reasons.push({ code: 'light_car', text: 'Has a lighter car (imputed): not charged today, but the rule would matter when replacing it.', icon: 'car' });
      } else if (paris) {
        score = 1;
        reasons.push({ code: 'no_car_paris', text: 'No car (imputed): may see fewer very large cars parked on their street.', icon: 'walk', at: [r.home] });
      } else {
        reasons.push({ code: 'not_touched', text: 'No car and lives outside Paris: no direct change.', icon: 'none' });
      }
      return { score, reasons };
    },
    stance: (r, _e, rng) => {
      const paris = isParis(r.districtIdx);
      if (r.imputed.heavyCar) return stanceFrom(rng, [62, 25, 8, 4, 1]);
      if (r.imputed.car) return stanceFrom(rng, paris ? [18, 30, 22, 22, 8] : [30, 32, 20, 14, 4]);
      if (!paris) return stanceFrom(rng, [8, 14, 40, 28, 10]);
      return r.age < 45 || r.occupationGroup === 'cadres' ? stanceFrom(rng, [5, 10, 18, 37, 30]) : stanceFrom(rng, [8, 14, 30, 33, 15]);
    },
    theme: (r, s, _e, rng) => {
      if (s === 0) return 'not_my_issue';
      if (s > 0) return rng() < 0.55 ? 'space_safety' : 'pollution';
      if (!isParis(r.districtIdx) && r.imputed.car) return 'punishes_suburbs';
      return r.imputed.heavyCar && (r.household === 'couple_kids' || r.occupationGroup === 'artisans') ? 'need_car' : rng() < 0.5 ? 'another_tax' : 'need_car';
    },
    backtest: {
      voteName: 'Paris votation on parking for heavy cars',
      date: '2024-02-04',
      question: "Pour ou contre la création d'un tarif spécifique pour le stationnement des voitures individuelles lourdes, encombrantes, polluantes ?",
      actualYes: 0.5455,
      turnout: 0.0568,
      sectors: { 'Paris Centre': 0.62, '5e': 0.6, '6e': 0.5, '7e': 0.38, '8e': 0.4, '9e': 0.58, '10e': 0.66, '11e': 0.66, '12e': 0.57, '13e': 0.56, '14e': 0.58, '15e': 0.47, '16e': 0.33, '17e': 0.45, '18e': 0.62, '19e': 0.57, '20e': 0.64 },
    },
  };
}

function scooterRecipe(map: MapFile): ScenarioRecipe {
  const isParis = parisChecker(map);
  const proposalFr =
    'Pour ou contre les trottinettes en libre-service ? La Ville doit décider si elle renouvelle les contrats des trois opérateurs qui proposent environ 15 000 trottinettes électriques en libre-service dans Paris.';
  const proposalEn =
    'For or against rental e-scooters? The city must decide whether to renew the contracts of the three operators that run about 15,000 shared electric scooters in Paris.';
  return {
    entry: { id: 'scooters-2023', title: 'Rental e-scooters', subtitle: 'Paris vote, 2 Apr 2023', kind: 'backtest', icon: 'scooter', date: '2023-04-02', mock: true },
    base: {
      version: 1,
      id: 'scooters-2023',
      title: 'Keep rental e-scooters?',
      titleFr: 'Trottinettes en libre-service',
      summary: 'In 2023 Paris voted on whether to keep shared e-scooters. Few people voted, and those who did were much older than the scooter riders.',
      proposalFr,
      proposalEn,
      kind: 'backtest',
      date: '2023-04-02',
      channel: 'votation',
      turnoutTarget: 0.0746,
      voterScope: 'paris_eligible',
      mock: true,
      models: { reaction: 'demo-heuristic (no AI)', conversation: 'demo-template (no AI)' },
      generatedAt: new Date(0).toISOString(),
      uncertainty: { method: 'Bootstrap over residents (demo data has a single run).', runs: 1 },
      notes: ['Built-in demo data: sector-level “official” results and the poll are placeholders. Only the city-wide result and turnout are real.'],
    },
    short: { fr: 'trottinettes', en: 'e-scooter' },
    themes: [
      { id: 'pavement_clutter', label: 'Scooters clutter the pavements', labelFr: 'Trottoirs encombrés', side: 'oppose', fr: ['Il y en a partout sur les trottoirs, je dois les enjamber avec ma poussette.', 'Elles sont abandonnées n’importe où, c’est l’anarchie.'], en: ['They’re all over the pavements; I have to step over them with my pushchair.', 'They’re dumped anywhere; it’s chaos.'], behaviour: 'Would vote “contre” and report blocked pavements.' },
      { id: 'accidents', label: 'Accidents and fear on the pavement', labelFr: 'Accidents et insécurité', side: 'oppose', fr: ['J’ai failli me faire renverser deux fois cette année. À mon âge, une chute c’est grave.', 'Les jeunes roulent trop vite, à deux dessus, sur les trottoirs.'], en: ['I nearly got knocked over twice this year. At my age a fall is serious.', 'Young people ride too fast, two at a time, on the pavements.'], behaviour: 'Would make a point of voting “contre”.' },
      { id: 'quick_cheap', label: 'Quick and handy for short trips', labelFr: 'Pratique et rapide', side: 'support', fr: ['Je les utilise tous les jours pour aller au boulot, c’est plus rapide que le bus.', 'C’est pratique le soir quand il n’y a plus de métro.'], en: ['I use them every day to get to work; it’s faster than the bus.', 'It’s handy at night when the metro has stopped.'], behaviour: 'Would vote “pour” only if a friend reminded them.' },
      { id: 'last_mile', label: 'Last mile from the station', labelFr: 'Dernier kilomètre', side: 'support', fr: ['Depuis la gare, la trottinette m’évite vingt minutes de marche.', 'Sans voiture, c’est ce qui me relie au RER.'], en: ['From the station, the scooter saves me a twenty-minute walk.', 'Without a car, it’s what connects me to the RER.'], behaviour: 'Would use them more; unlikely to vote.' },
      { id: 'dont_care', label: 'Doesn’t really care', labelFr: 'Indifférent·e', side: 'mixed', fr: ['Je n’en utilise pas, mais ça ne me gêne pas plus que ça.', 'Franchement, il y a des sujets plus importants.'], en: ['I don’t use them, but they don’t bother me that much.', 'Honestly, there are more important issues.'], behaviour: 'Would not vote.' },
    ],
    exposure: (r) => {
      const reasons: ExposureReason[] = [];
      let score: 0 | 1 | 2 | 3 = 0;
      const paris = isParis(r.districtIdx);
      if (paris && r.age < 35 && ['metro', 'bus', 'walk', 'bike'].includes(r.commuteMode)) {
        score = 2;
        reasons.push({ code: 'likely_rider', text: 'Under 35 and gets around without a car: a typical shared-scooter rider (usage is imputed).', icon: 'scooter', at: r.work ? [r.work] : undefined });
      } else if (r.age >= 70) {
        score = 2;
        reasons.push({ code: 'vulnerable_pedestrian', text: 'Aged 70 or over: more at risk from scooters ridden or parked on the pavement.', icon: 'walk', at: [r.home] });
      } else if (paris) {
        score = 1;
        reasons.push({ code: 'paris_streets', text: 'Lives in Paris: scooters are parked and ridden in their street.', icon: 'scooter', at: [r.home] });
      } else if (isParis(r.workDistrictIdx)) {
        score = 1;
        reasons.push({ code: 'commuter', text: 'Works in Paris: could use a scooter for the last mile.', icon: 'job', at: r.work ? [r.work] : undefined });
      } else reasons.push({ code: 'not_touched', text: 'Lives and works outside Paris: no direct change.', icon: 'none' });
      return { score, reasons };
    },
    stance: (r, _e, rng) => {
      if (r.age < 30) return stanceFrom(rng, [12, 14, 16, 36, 22]);
      if (r.age < 45) return stanceFrom(rng, [22, 22, 20, 26, 10]);
      if (r.age < 60) return stanceFrom(rng, [38, 26, 18, 14, 4]);
      return stanceFrom(rng, [62, 22, 9, 5, 2]);
    },
    theme: (r, s, _e, rng) => {
      if (s === 0) return 'dont_care';
      if (s > 0) return !isParis(r.districtIdx) || rng() < 0.3 ? 'last_mile' : 'quick_cheap';
      return r.age >= 60 || rng() < 0.4 ? 'accidents' : 'pavement_clutter';
    },
    backtest: {
      voteName: 'Paris votation on rental e-scooters',
      date: '2023-04-02',
      question: 'Pour ou contre les trottinettes en libre-service ?',
      actualYes: 0.1097,
      turnout: 0.0746,
      sectors: { 'Paris Centre': 0.12, '5e': 0.1, '6e': 0.08, '7e': 0.07, '8e': 0.08, '9e': 0.12, '10e': 0.14, '11e': 0.13, '12e': 0.1, '13e': 0.11, '14e': 0.1, '15e': 0.09, '16e': 0.06, '17e': 0.09, '18e': 0.13, '19e': 0.13, '20e': 0.13 },
      poll: { org: 'Placeholder poll (demo data)', date: '2023-03', yesShare: 0.32, url: '', note: 'Placeholder until the pipeline adds a sourced poll.' },
    },
  };
}

function dataCentreRecipe(map: MapFile): ScenarioRecipe {
  const deptOf = new Map(map.districtList.map((d) => [d.idx, d.dept]));
  const [sx, sy] = ll(2.3465, 48.9205);
  const site = { lon: 2.3465, lat: 48.9205, x: Math.round(sx), y: Math.round(sy), label: 'AI data centre site (Pleyel)', ringsTiles: [5, 10, 20] };
  const nearDistricts = map.districtList.filter((d) => ['Saint-Denis', 'Saint-Ouen-sur-Seine', 'Aubervilliers', 'L’Île-Saint-Denis'].includes(d.name)).map((d) => d.idx);
  const proposalFr =
    'Construction d’un grand centre de données pour l’intelligence artificielle (200 MW) sur une friche industrielle à Saint-Denis, près de Pleyel. ' +
    'Le projet promet 1 500 emplois pendant les 3 ans de chantier et 300 emplois permanents, et la chaleur des serveurs chaufferait environ 10 000 logements voisins. ' +
    'En échange, il consommerait autant d’électricité qu’une ville de 300 000 habitants, utiliserait de l’eau pour le refroidissement et ferait fonctionner des groupes de froid jour et nuit.';
  const proposalEn =
    'Build a large artificial-intelligence data centre (200 MW) on former industrial land in Saint-Denis, near Pleyel. ' +
    'It promises 1,500 jobs during 3 years of construction and 300 permanent jobs, and heat from the servers would warm about 10,000 nearby homes. ' +
    'In return it would use as much electricity as a city of 300,000 people, use water for cooling and run cooling units day and night.';
  return {
    entry: { id: 'datacentre-93', title: 'AI data centre in Saint-Denis', subtitle: 'Hypothetical 200 MW campus', kind: 'hypothetical', icon: 'datacenter', mock: true },
    base: {
      version: 1,
      id: 'datacentre-93',
      title: 'A big AI data centre in Saint-Denis',
      titleFr: 'Un grand centre de données IA à Saint-Denis',
      summary: 'A hypothetical 200 MW AI campus north of Paris: jobs and free heat for neighbours, against power, water and years of construction. Who would come to the public meeting, and who would be missing?',
      proposalFr,
      proposalEn,
      kind: 'hypothetical',
      channel: 'public_meeting',
      turnoutTarget: 0.02,
      voterScope: 'all_residents',
      site,
      zoneDistricts: nearDistricts,
      mock: true,
      models: { reaction: 'demo-heuristic (no AI)', conversation: 'demo-template (no AI)' },
      generatedAt: new Date(0).toISOString(),
      uncertainty: { method: 'Bootstrap over residents (demo data has a single run).', runs: 1 },
      notes: ['Hypothetical proposal. Figures in the proposal text are illustrative.'],
    },
    short: { fr: 'centre de données', en: 'data centre' },
    themes: [
      { id: 'jobs', label: 'Jobs for local people', labelFr: 'Des emplois locaux', side: 'support', fr: ['Je cherche du travail depuis un an. Si les emplois sont pour les gens d’ici, je suis pour.', 'Mon fils pourrait travailler sur le chantier, ça compte.'], en: ['I’ve been looking for work for a year. If the jobs go to local people, I’m for it.', 'My son could work on the building site; that matters.'], behaviour: 'Would sign up for the jobs programme; unlikely to attend a meeting.' },
      { id: 'cheaper_heat', label: 'Cheaper heating from waste heat', labelFr: 'Chauffage moins cher', side: 'support', fr: ['Si ça baisse ma facture de chauffage, je dis oui.', 'Récupérer la chaleur, c’est malin, à condition que ce soit garanti.'], en: ['If it lowers my heating bill, I say yes.', 'Reusing the heat is smart, as long as it’s guaranteed.'], behaviour: 'Would ask their landlord whether the building can connect.' },
      { id: 'power_water', label: 'Too much electricity and water', labelFr: 'Électricité et eau', side: 'oppose', fr: ['Autant d’électricité qu’une ville entière, pour des chatbots ? En pleine crise climatique ?', 'On nous demande de baisser le chauffage et on construit ça ?'], en: ['As much electricity as a whole city, for chatbots? In a climate crisis?', 'We’re asked to turn down the heating and they build this?'], behaviour: 'Would sign a petition and attend the public meeting.' },
      { id: 'construction_noise', label: 'Construction trucks and night-time noise', labelFr: 'Chantier et bruit', side: 'oppose', fr: ['Trois ans de camions sous mes fenêtres, puis des ventilateurs jour et nuit. Non merci.', 'On a déjà eu les travaux du Grand Paris Express, ça suffit.'], en: ['Three years of trucks under my windows, then fans day and night. No thanks.', 'We already had the Grand Paris Express works; enough is enough.'], behaviour: 'Would attend the meeting and join a residents’ association.' },
      { id: 'not_for_us', label: '“Built for big companies, not for us”', labelFr: 'Pas pour nous', side: 'oppose', fr: ['Encore un projet pour les grandes entreprises, pas pour les habitants du 93.', 'Les profits partiront ailleurs, nous on garde les nuisances.'], en: ['Another project for big companies, not for the people of the 93.', 'The profits go elsewhere; we keep the nuisance.'], behaviour: 'Would complain to neighbours; would not go to a meeting.' },
      { id: 'no_opinion', label: 'No strong opinion', labelFr: 'Sans avis', side: 'mixed', fr: ['Je ne sais pas trop ce qu’est un centre de données, en fait.', 'C’est loin de chez moi, je n’ai pas d’avis.'], en: ['I’m not really sure what a data centre is, actually.', 'It’s far from where I live; I don’t have an opinion.'], behaviour: 'Would not take part.' },
    ],
    exposure: (r) => {
      const reasons: ExposureReason[] = [];
      let score: 0 | 1 | 2 | 3 = 0;
      const d = dist(r.home, [site.x, site.y]);
      const m = Math.round((d * map.tileMeters) / 50) * 50;
      if (d <= 5) {
        score = 3;
        reasons.push({ code: 'construction_near', text: `Lives about ${m} m from the site: 3 years of construction trucks, then cooling units running day and night.`, icon: 'construction', at: [[site.x, site.y]] });
        reasons.push({ code: 'heat_network', text: 'Inside the planned heat-network zone: heating could get cheaper.', icon: 'heat', at: [r.home] });
      } else if (d <= 10) {
        score = 2;
        reasons.push({ code: 'construction_traffic', text: `Lives about ${m} m from the site: construction traffic on nearby streets.`, icon: 'noise', at: [[site.x, site.y]] });
        reasons.push({ code: 'heat_network', text: 'Inside the planned heat-network zone: heating could get cheaper.', icon: 'heat', at: [r.home] });
      } else if (d <= 20) {
        score = 1;
        reasons.push({ code: 'nearby', text: `Lives ${(m / 1000).toFixed(1)} km from the site: may see trucks, outside the heat network.`, icon: 'construction', at: [[site.x, site.y]] });
      }
      const jobSeeker = r.occupationGroup === 'sans_activite' && r.age < 60 && deptOf.get(r.districtIdx) === '93';
      const worksNear = r.work !== null && dist(r.work, [site.x, site.y]) <= 10;
      if (jobSeeker || worksNear) {
        if (score < 2) score = 2;
        reasons.push({
          code: 'jobs',
          text: jobSeeker ? 'Looking for work in Seine-Saint-Denis: 1,500 construction jobs and 300 permanent jobs are promised.' : 'Works near the site (imputed workplace): daily commute passes the works.',
          icon: 'job',
          at: [[site.x, site.y]],
        });
      }
      if (reasons.length === 0) reasons.push({ code: 'far', text: 'Lives far from the site: only indirect effects, such as demand on the regional power grid.', icon: 'power' });
      return { score, reasons };
    },
    stance: (r, e, rng) => {
      const jobs = e.reasons.some((x) => x.code === 'jobs');
      if (e.score === 3) {
        if (jobs || r.age < 30) return stanceFrom(rng, [10, 18, 17, 40, 15]);
        if (r.imputed.tenure === 'owner' || r.occupationGroup === 'retraites') return stanceFrom(rng, [55, 28, 9, 6, 2]);
        return stanceFrom(rng, [28, 30, 15, 20, 7]);
      }
      if (e.score === 2) return jobs ? stanceFrom(rng, [6, 12, 20, 42, 20]) : stanceFrom(rng, [18, 22, 20, 30, 10]);
      if (r.occupationGroup === 'cadres') return stanceFrom(rng, [10, 18, 30, 32, 10]);
      return stanceFrom(rng, [10, 20, 45, 20, 5]);
    },
    theme: (r, s, e, rng) => {
      if (s === 0) return 'no_opinion';
      if (s > 0) return e.reasons.some((x) => x.code === 'jobs') || rng() < 0.4 ? 'jobs' : 'cheaper_heat';
      if (e.score >= 2) return rng() < 0.65 ? 'construction_noise' : 'not_for_us';
      return r.educationRank >= 5 || rng() < 0.5 ? 'power_water' : 'not_for_us';
    },
  };
}

function buildScenario(recipe: ScenarioRecipe, map: MapFile, pop: PopulationFile, seed: number): Scenario {
  const rng = makeRng(seed);
  const byId = new Map(pop.residents.map((r) => [r.id, r]));
  const themeById = new Map(recipe.themes.map((t) => [t.id, t]));
  const results: ResidentResult[] = pop.residents.map((r) => {
    const exposure = recipe.exposure(r);
    const stance = recipe.stance(r, exposure, rng);
    const themeId = recipe.theme(r, stance, exposure, rng);
    const t = themeById.get(themeId)!;
    const k = Math.floor(rng() * t.fr.length);
    const llm = clamp(0.15 + 0.12 * Math.abs(stance) + 0.12 * exposure.score + (rng() - 0.5) * 0.3, 0, 1);
    const eligible = recipe.base.voterScope === 'paris_eligible' ? r.eligibleParis : true;
    return {
      id: r.id,
      exposure,
      stance,
      affectedLLM: clamp(exposure.score + Math.round((rng() - 0.5) * 1.4), 0, 3) as 0 | 1 | 2 | 3,
      behaviourEn: t.behaviour,
      reasonFr: t.fr[k],
      reasonEn: t.en[k],
      wouldParticipateLLM: Math.round(llm * 100) / 100,
      participationScore: participationScore(r.participationBase, exposure.score, llm),
      eligible,
      attendee: false,
      themeId,
      runStances: [stance, clamp(stance + (rng() < 0.2 ? (rng() < 0.5 ? -1 : 1) : 0), -2, 2), clamp(stance + (rng() < 0.2 ? (rng() < 0.5 ? -1 : 1) : 0), -2, 2)],
    };
  });
  const attendees = pickAttendees(
    results.map((x) => ({ id: x.id, eligible: x.eligible, score: x.participationScore, weight: byId.get(x.id)!.weight })),
    recipe.base.turnoutTarget,
  );
  for (const x of results) x.attendee = attendees.has(x.id);
  const resultById = new Map(results.map((x) => [x.id, x]));

  // Neighbour conversations: pairs living close to each other.
  const conversations: Conversation[] = [];
  const buckets = new Map<string, number[]>();
  for (const r of pop.residents) {
    const key = `${Math.floor(r.home[0] / 8)},${Math.floor(r.home[1] / 8)}`;
    const list = buckets.get(key) ?? [];
    list.push(r.id);
    buckets.set(key, list);
  }
  const used = new Set<number>();
  const order = pop.residents.map((r) => r.id).sort((a, b) => ((a * 7919) % 2003) - ((b * 7919) % 2003));
  for (const aId of order) {
    if (conversations.length >= 240) break;
    if (used.has(aId)) continue;
    const a = byId.get(aId)!;
    const key = `${Math.floor(a.home[0] / 8)},${Math.floor(a.home[1] / 8)}`;
    const candidates = (buckets.get(key) ?? []).filter((id) => id !== aId && !used.has(id));
    if (!candidates.length) continue;
    const bId = candidates[Math.floor(rng() * candidates.length)];
    const b = byId.get(bId)!;
    used.add(aId);
    used.add(bId);
    const ra = resultById.get(aId)!;
    const rb = resultById.get(bId)!;
    let aAfter = ra.stance;
    let bAfter = rb.stance;
    let travelled = ra.themeId;
    if (Math.sign(ra.stance) !== Math.sign(rb.stance) && rng() < 0.3) {
      // The less exposed person moves one step towards the other.
      if (ra.exposure.score <= rb.exposure.score) {
        aAfter = clamp(ra.stance + Math.sign(rb.stance - ra.stance), -2, 2) as typeof aAfter;
        travelled = rb.themeId;
      } else {
        bAfter = clamp(rb.stance + Math.sign(ra.stance - rb.stance), -2, 2) as typeof bAfter;
        travelled = ra.themeId;
      }
    }
    const moved = aAfter !== ra.stance || bAfter !== rb.stance;
    ra.stanceAfter = aAfter;
    rb.stanceAfter = bAfter;
    ra.talkedWith = [bId];
    rb.talkedWith = [aId];
    conversations.push({
      id: `${recipe.entry.id}-c${conversations.length}`,
      a: aId,
      b: bId,
      where: [Math.round((a.home[0] + b.home[0]) / 2), Math.round((a.home[1] + b.home[1]) / 2)],
      lines: [
        { speaker: aId, fr: `Tu as entendu parler du projet de ${recipe.short.fr} ?`, en: `Have you heard about the ${recipe.short.en} plan?` },
        { speaker: bId, fr: rb.reasonFr, en: rb.reasonEn },
        { speaker: aId, fr: ra.reasonFr, en: ra.reasonEn },
        moved
          ? { speaker: aAfter !== ra.stance ? aId : bId, fr: 'Bon… vu comme ça, je comprends mieux.', en: 'Well… put like that, I see your point.' }
          : { speaker: bId, fr: 'On ne sera pas d’accord, mais c’est bien d’en parler.', en: 'We won’t agree, but it’s good to talk about it.' },
      ],
      stanceBefore: { a: ra.stance, b: rb.stance },
      stanceAfter: { a: aAfter, b: bAfter },
      themeId: travelled,
    });
  }

  const ctx: AggContext = { weightOf: (id) => byId.get(id)?.weight ?? 1 };
  const aggregates = computeAggregates(results, byId, pop.groups, ctx);
  const themes = themeStats(
    recipe.themes.map((t) => ({ id: t.id, label: t.label, labelFr: t.labelFr, side: t.side })),
    results,
    ctx,
  ).sort((a, b) => b.share - a.share);
  const consult = buildConsultRecs(aggregates.byGroup, results, byId, themes, ctx);

  const scenario: Scenario = { ...recipe.base, results, conversations, aggregates, themes, consult };

  if (recipe.backtest) {
    const bt = recipe.backtest;
    const sectors = Object.entries(bt.sectors).map(([sector, actualYes]) => ({ sector, actualYes }));
    const now = backtestBySector(sectors, map.districtList, results, byId, ctx);
    const after = backtestBySector(sectors, map.districtList, results, byId, { ...ctx, afterTalk: true });
    const v = aggregates.views;
    const gapSim = v.attendees.yesShare - v.everyone.yesShare;
    scenario.backtest = {
      voteName: bt.voteName,
      date: bt.date,
      question: bt.question,
      sources: [{ name: 'Ville de Paris, official results', url: 'https://www.paris.fr' }],
      actual: { yesShare: bt.actualYes, turnout: bt.turnout },
      poll: bt.poll,
      simulated: { everyoneYes: v.everyone.yesShare, eligibleYes: v.eligible.yesShare, attendeesYes: v.attendees.yesShare },
      bySector: now.bySector,
      metrics: { ...now.metrics, gapSignCorrect: bt.poll ? Math.sign(gapSim) === Math.sign(bt.actualYes - bt.poll.yesShare) : undefined },
      baselines: [
        { name: 'Coin flip', description: 'Assume 50% in favour everywhere.', yesShare: 0.5, sectorMae: sectors.reduce((s, x) => s + Math.abs(0.5 - x.actualYes), 0) / sectors.length },
        { name: 'Everyone, no turnout model', description: 'Simulated residents, but counting everyone instead of likely voters.', yesShare: v.everyone.yesShare, sectorMae: now.bySector.reduce((s, x) => s + Math.abs(x.simEveryoneYes - x.actualYes), 0) / sectors.length },
        { name: 'Bare model, no personas', description: 'Ask the model the question with no persona (needs the API key).', yesShare: Number.NaN },
      ],
      leakage: {
        probed: false,
        notes: 'Nemotron 3 was trained on data up to about June 2025, after this vote. The probe asks the bare model for the result; it runs once the API key is set.',
      },
    };
    const va = aggregates.viewsAfterTalk ?? v;
    scenario.backtestAfterTalk = {
      simulated: { everyoneYes: va.everyone.yesShare, eligibleYes: va.eligible.yesShare, attendeesYes: va.attendees.yesShare },
      bySector: after.bySector,
      metrics: after.metrics,
    };
  }
  return scenario;
}

export interface FixtureBundle {
  index: ScenarioIndexEntry[];
  scenarios: Record<string, Scenario>;
}

/** Build the three demo scenarios for whatever map + population we have (real or built-in). */
export function makeFixtureScenarios(map: MapFile, pop: PopulationFile): FixtureBundle {
  const recipes = [dataCentreRecipe(map), suvRecipe(map), scooterRecipe(map)];
  const scenarios: Record<string, Scenario> = {};
  recipes.forEach((r, i) => {
    scenarios[r.entry.id] = buildScenario(r, map, pop, 100 + i);
  });
  return { index: recipes.map((r) => r.entry), scenarios };
}
