/**
 * DATA CONTRACT — shared by the Python pipeline (writer) and the web app (reader).
 *
 * Files (all under web/public/data/):
 *   map.json                 -> MapFile          (pipeline/build_map.py)
 *   population.json          -> PopulationFile   (pipeline/build_population.py)
 *   scenarios/index.json     -> ScenarioIndexEntry[]  (pipeline/simulate.py)
 *   scenarios/<id>.json      -> Scenario         (pipeline/simulate.py)
 *
 * Coordinates: tile coordinates (x right, y down) on the grid defined in web/shared/config.json.
 * Projection (equirectangular inside the bbox, same in Python and TS):
 *   x = (lon - lonMin) / (lonMax - lonMin) * gridWidth
 *   y = (latMax - lat) / (latMax - latMin) * gridHeight
 * Integer tile = floor(x), floor(y).
 *
 * Every number that is IMPUTED (not in the NVIDIA dataset) must be flagged as imputed in the UI.
 * Every LLM-generated text is a "simulated voice", never presented as a real person.
 * If a file has mock: true it was produced WITHOUT a real LLM (no API key yet); the UI must show a banner.
 *
 * Changing this file? Update pipeline writers and UI readers together.
 */

// ---------- map.json ----------

/** Index into config.tileTypes. */
export type TileTypeIndex = number;

export interface District {
  /** 1-based index used in MapFile.districts (0 = no district). */
  idx: number;
  /** INSEE code: '75101'..'75120' for Paris arrondissements, commune code (e.g. '93066') for suburbs. */
  code: string;
  /** Short display name: '11e', 'Saint-Denis'. */
  name: string;
  /** Long name: 'Paris 11e Arrondissement', 'Saint-Denis'. Matches the dataset `commune` value where possible. */
  fullName: string;
  kind: 'arrondissement' | 'commune';
  dept: '75' | '92' | '93' | '94';
  /** Votation sector used by official Paris results ('Paris Centre' for 1er–4e, else e.g. '11e'). Paris only. */
  sector?: string;
  /** Official population (INSEE, from geo.api.gouv.fr), used for sampling weights. */
  population: number;
  centroid: [number, number];
  labelPos: [number, number];
  tileCount: number;
}

export interface Landmark {
  id: string;
  name: string;
  nameFr: string;
  kind: string;
  x: number;
  y: number;
}

export interface MapFile {
  version: 1;
  width: number;
  height: number;
  tilePx: number;
  tileMeters: number;
  bbox: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  /** Copy of config.tileTypes, for safety. */
  tileTypes: string[];
  /** Row-major, length width*height, values are TileTypeIndex. */
  tiles: number[];
  /** Row-major, length width*height, values are District.idx (0 = none / outside study area). */
  districts: number[];
  districtList: District[];
  landmarks: Landmark[];
  /** Polyline of the Seine centre line in tile coords (for decoration / bridges). */
  seine?: [number, number][];
  sources: { name: string; url: string; license: string }[];
}

// ---------- population.json ----------

export type OccupationGroup =
  | 'cadres'
  | 'prof_inter'
  | 'employes'
  | 'ouvriers'
  | 'artisans'
  | 'agriculteurs'
  | 'retraites'
  | 'sans_activite';

export type HouseholdKind = 'single' | 'couple_no_kids' | 'couple_kids' | 'single_parent';
export type Tenure = 'owner' | 'private_renter' | 'social_renter';
export type Nationality = 'french' | 'eu' | 'non_eu';
export type CommuteMode = 'metro' | 'rer' | 'bus' | 'car' | 'bike' | 'walk' | 'none';

export interface Look {
  skin: number; // 0..5
  hair: number; // 0..7 colour
  hairStyle: number; // 0..5
  shirt: number; // 0..11
  pants: number; // 0..5
  accessory: number; // 0 none, 1 glasses, 2 hat, 3 cap, 4 scarf
}

export interface Resident {
  id: number; // 0..N-1, stable
  uuid: string; // NVIDIA dataset uuid
  name: string; // parsed from persona text
  sex: 'F' | 'M';
  age: number;
  ageBand: '18-29' | '30-44' | '45-59' | '60-74' | '75+';
  occupation: string; // raw French PCS label from dataset
  occupationGroup: OccupationGroup;
  occupationEn: string;
  education: string; // raw French label
  educationRank: number; // 0 (Sans diplôme) .. 6 (Bac+5 ou plus)
  household: HouseholdKind;
  householdRaw: string;
  maritalStatus: string;
  districtIdx: number;
  /** 'dataset' if the arrondissement/commune came from the NVIDIA row; 'imputed' if we assigned it. */
  districtSource: 'dataset' | 'imputed';
  home: [number, number]; // tile coords of home building
  work: [number, number] | null; // null for retirees / inactive
  workDistrictIdx: number | null;
  commuteMode: CommuteMode;
  /** All of these are IMPUTED from INSEE statistics — the dataset has no such fields. */
  imputed: {
    car: boolean;
    heavyCar: boolean; // thermal/hybrid >= 1.6t or EV >= 2t (Paris SUV-fee definition)
    tenure: Tenure;
    nationality: Nationality;
  };
  /** Can vote in a Paris votation (Paris resident, registered: French or EU national, imputed). */
  eligibleParis: boolean;
  /** Empirical (non-LLM) participation propensity 0..1 from INSEE turnout gradients. 0 for people who cannot vote. */
  participationBase: number;
  /** Same INSEE-based propensity WITHOUT the "cannot vote = 0" rule. Used for open channels
   *  (public meetings, online consultations), which non-EU residents can also attend. */
  participationPropensity?: number;
  /** Raking / post-stratification weight (mean 1). */
  weight: number;
  groupIds: string[];
  /** Short persona text (French) from the dataset `persona` field. */
  personaFr: string;
  /** English one-liner (LLM translation; empty string until generated). */
  personaEn: string;
  look: Look;
}

export interface GroupDef {
  id: string; // e.g. 'young_renters'
  label: string; // English
  description: string; // how membership is defined (mention imputation)
}

/** A group that only makes sense for one scenario, defined by computed exposure or geography
 *  (e.g. "renters within 2 km of the site"). Membership is listed explicitly. */
export interface ScenarioGroup extends GroupDef {
  memberIds: number[];
}

export interface PopulationFile {
  version: 1;
  generatedAt: string;
  count: number;
  residents: Resident[];
  groups: GroupDef[];
  method: {
    sampling: string;
    raking: string;
    imputation: string[];
    knownDatasetIssues: string[];
  };
  sources: { name: string; url: string; license: string }[];
}

// ---------- scenarios ----------

export type ScenarioKind = 'backtest' | 'hypothetical' | 'custom';
export type Channel = 'votation' | 'public_meeting' | 'online_consultation';
export type ViewMode = 'everyone' | 'eligible' | 'attendees';

export interface ScenarioIndexEntry {
  id: string;
  title: string;
  subtitle: string;
  kind: ScenarioKind;
  icon: string; // 'scooter' | 'car' | 'datacenter' | ...
  date?: string;
  mock: boolean;
}

export type ExposureIcon =
  | 'car'
  | 'home'
  | 'noise'
  | 'heat'
  | 'job'
  | 'tax'
  | 'water'
  | 'power'
  | 'scooter'
  | 'walk'
  | 'park'
  | 'money'
  | 'construction'
  | 'none';

export interface ExposureReason {
  code: string;
  text: string; // English, plain language, e.g. "Lives 600 m from the site: construction noise for 2 years"
  icon: ExposureIcon;
  /** Optional tile(s) on the map where this touches the resident (e.g. the site, a parking spot). */
  at?: [number, number][];
}

export interface ResidentResult {
  id: number;
  /** Deterministic, computed from imputed attributes + geography. NOT the LLM. */
  exposure: { score: 0 | 1 | 2 | 3; reasons: ExposureReason[] };
  /** LLM reaction, -2 strongly oppose .. +2 strongly support. */
  stance: -2 | -1 | 0 | 1 | 2;
  /** Stance after the neighbour conversation round (only if they talked). */
  stanceAfter?: -2 | -1 | 0 | 1 | 2;
  /** LLM self-assessed impact 0..3 (shown next to the computed exposure, never instead of it). */
  affectedLLM: 0 | 1 | 2 | 3;
  behaviourEn: string;
  reasonFr: string;
  reasonEn: string;
  /** LLM self-report "would you take part" 0..1 — used only as a rank modifier. */
  wouldParticipateLLM: number;
  /** Calibrated blend of participationBase, issue salience and the LLM self-report. */
  participationScore: number;
  eligible: boolean;
  /** Selected as a likely participant (top-k by participationScore among eligible, k = turnout). */
  attendee: boolean;
  /** Theme id this resident's reason was clustered into. */
  themeId?: string;
  talkedWith?: number[];
  /** Stances across uncertainty runs (paraphrases x models), if run. */
  runStances?: number[];
}

export interface ConversationLine {
  speaker: number; // resident id
  fr: string;
  en: string;
}

export interface Conversation {
  id: string;
  a: number;
  b: number;
  where: [number, number];
  lines: ConversationLine[];
  stanceBefore: { a: number; b: number };
  stanceAfter: { a: number; b: number };
  /** Theme / argument that travelled in this conversation, if any. */
  themeId?: string;
}

export interface ViewAgg {
  n: number; // residents in this view (weighted count rounded)
  support: number; // share with stance >= 1 (0..1, weighted)
  oppose: number; // share with stance <= -1
  neutral: number; // share with stance == 0
  /** support / (support + oppose): comparable with a Yes/"Pour" vote share. */
  yesShare: number;
  meanStance: number;
  /** Uncertainty band for yesShare across runs, if available. */
  yesRange?: [number, number];
}

export interface DistrictAgg {
  districtIdx: number;
  n: number;
  everyone: ViewAgg;
  attendees: ViewAgg;
  meanExposure: number;
}

export interface GroupAgg {
  groupId: string;
  label: string;
  n: number;
  everyone: ViewAgg;
  /** (group share among attendees) / (group share in population). < 1 = under-heard. */
  representationRatio: number;
  meanExposure: number;
}

export interface Theme {
  id: string;
  label: string; // English
  labelFr?: string;
  side: 'support' | 'oppose' | 'mixed';
  share: number; // share of residents whose reason falls here
  /** Share of this theme among NON-attendees minus among attendees (positive = voices you'd miss). */
  missingGap: number;
  quoteIds: number[]; // resident ids with representative reasons
}

export interface ConsultRec {
  groupId: string;
  label: string;
  why: string; // English, cites exposure + representation numbers
  meanExposure: number;
  representationRatio: number;
  /** Stake vs voice: the group's share of all computed exposure (weight x score), 0..1. */
  impactShare?: number;
  /** ...and its share of the likely participants (weight x participation probability), 0..1.
   *  Recommendations are ranked by impactShare - voiceShare. */
  voiceShare?: number;
  districts: number[]; // district idxs where this group concentrates
  channels: string[]; // concrete outreach suggestions
  hypotheses: string[]; // "hypotheses to test with this group" (from simulated themes)
}

export interface BacktestSector {
  sector: string; // 'Paris Centre', '5e', ... '20e'
  districtIdxs: number[];
  actualYes: number; // official share "Pour" (0..1)
  actualTurnout?: number;
  simEveryoneYes: number;
  simAttendeesYes: number;
}

export interface Backtest {
  voteName: string;
  date: string;
  question: string; // official wording (FR)
  sources: { name: string; url: string }[];
  actual: { yesShare: number; turnout: number };
  poll?: { org: string; date: string; n?: number; yesShare: number; url: string; note?: string };
  simulated: { everyoneYes: number; eligibleYes: number; attendeesYes: number };
  bySector: BacktestSector[];
  metrics: {
    sectorMae: number; // mean abs error (attendees view vs actual, by sector)
    sectorCorrelation: number; // Pearson r across sectors
    /** Did the sim get the sign of (voters - everyone) right vs (actual vote - poll)? */
    gapSignCorrect?: boolean;
  };
  baselines: { name: string; description: string; yesShare: number; sectorMae?: number }[];
  leakage: { probed: boolean; bareModelAnswer?: string; verdict?: string; notes: string };
}

export interface Scenario {
  version: 1;
  id: string;
  title: string;
  titleFr: string;
  summary: string; // English, 1-2 sentences
  proposalFr: string; // exact text shown to every simulated resident
  proposalEn: string;
  kind: ScenarioKind;
  date?: string;
  channel: Channel;
  /** Fraction of eligible residents selected as likely participants. */
  turnoutTarget: number;
  voterScope: 'paris_eligible' | 'all_residents';
  site?: { lon: number; lat: number; x: number; y: number; label: string; ringsTiles: number[] };
  zoneDistricts?: number[];
  mock: boolean;
  models: { reaction: string; conversation?: string; synthesis?: string };
  generatedAt: string;
  results: ResidentResult[]; // same ids as population
  conversations: Conversation[];
  aggregates: {
    views: Record<ViewMode, ViewAgg>;
    /** Same three views but using stanceAfter where available. */
    viewsAfterTalk?: Record<ViewMode, ViewAgg>;
    byDistrict: DistrictAgg[];
    byGroup: GroupAgg[];
  };
  themes: Theme[];
  consult: ConsultRec[];
  /** Scenario-specific groups (exposure / geography). aggregates.byGroup and consult may use these ids
   *  as well as the ids of PopulationFile.groups. */
  extraGroups?: ScenarioGroup[];
  backtest?: Backtest;
  /** Backtest recomputed using post-conversation stances ("does talking help?"). */
  backtestAfterTalk?: Pick<Backtest, 'simulated' | 'bySector' | 'metrics'>;
  uncertainty: { method: string; runs: number };
  notes: string[];
}

// ---------- live API (web/api) ----------

export interface ApiHealth {
  ok: boolean;
  mock: boolean; // true when no TOKEN_FACTORY_API_KEY is configured
  models: { reaction: string; conversation: string; synthesis: string };
}

export interface AskRequest {
  scenarioId: string;
  question: string;
  resident: Pick<Resident, 'id' | 'name' | 'age' | 'sex' | 'occupation' | 'household' | 'personaFr' | 'imputed' | 'commuteMode'> & {
    districtName: string;
  };
  proposalFr: string;
  previous: Pick<ResidentResult, 'stance' | 'reasonFr' | 'exposure'>;
}

export interface AskResponse {
  answerFr: string;
  answerEn: string;
  model: string;
  mock: boolean;
}

export interface ReactRequest {
  proposalFr: string;
  residents: (AskRequest['resident'] & { exposure: ResidentResult['exposure'] })[]; // max 5 per call
}

export interface ReactResponse {
  results: Pick<ResidentResult, 'id' | 'stance' | 'affectedLLM' | 'behaviourEn' | 'reasonFr' | 'reasonEn' | 'wouldParticipateLLM'>[];
  model: string;
  mock: boolean;
}
