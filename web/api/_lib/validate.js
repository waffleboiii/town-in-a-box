// @ts-check
/**
 * Input validation for the public API. Everything coming from the browser is untrusted:
 * we check types, ranges and lengths, strip control characters, and rebuild clean objects
 * (unknown fields are dropped). Any problem -> HTTP 400 with a short message naming the field
 * (we never echo the submitted value back).
 */
/** @import { AskRequest, Channel, CommuteMode, ExposureIcon, ExposureReason, HouseholdKind, Nationality, ReactRequest, ResidentResult, Tenure } from '../../src/types.js' */
import { HttpError } from './http.js';

/**
 * @typedef {AskRequest['resident']} ValidResident
 * @typedef {ReactRequest['residents'][number]} ValidReactResident
 * @typedef {ReactRequest & { channel: Channel }} ValidReactRequest
 */

/** Limits promised in the API docs. */
export const LIMITS = {
  question: 300,
  proposal: 2_000,
  residentsPerReact: 5,
  personaFr: 1_500,
  previousReason: 1_000,
  shortText: 120,
  exposureReasons: 12,
  exposureText: 400,
  exposurePoints: 200,
};

/** @type {HouseholdKind[]} */
const HOUSEHOLDS = ['single', 'couple_no_kids', 'couple_kids', 'single_parent'];
/** @type {Tenure[]} */
const TENURES = ['owner', 'private_renter', 'social_renter'];
/** @type {Nationality[]} */
const NATIONALITIES = ['french', 'eu', 'non_eu'];
/** @type {CommuteMode[]} */
const COMMUTES = ['metro', 'rer', 'bus', 'car', 'bike', 'walk', 'none'];
/** @type {Channel[]} */
const CHANNELS = ['votation', 'public_meeting', 'online_consultation'];
/** @type {ExposureIcon[]} */
const ICONS = [
  'car', 'home', 'noise', 'heat', 'job', 'tax', 'water', 'power',
  'scooter', 'walk', 'park', 'money', 'construction', 'none',
];
/** @type {('F' | 'M')[]} */
const SEXES = ['F', 'M'];

/**
 * @param {string} field
 * @param {string} problem
 * @returns {never}
 */
function fail(field, problem) {
  throw new HttpError(400, `Invalid request: ${field} ${problem}.`);
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
function obj(v, field) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(field, 'must be an object');
  return /** @type {Record<string, unknown>} */ (v);
}

/**
 * Remove invisible control characters (keeps newlines and tabs) and trim.
 * @param {string} text
 */
function clean(text) {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

/**
 * @param {unknown} v
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
function str(v, field, min, max) {
  if (typeof v !== 'string') fail(field, 'must be a string');
  const s = clean(v);
  if (s.length < min) fail(field, min === 1 ? 'must not be empty' : `must have at least ${min} characters`);
  if (s.length > max) fail(field, `must be at most ${max} characters`);
  return s;
}

/**
 * @param {unknown} v
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
function int(v, field, min, max) {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(field, 'must be an integer');
  if (v < min || v > max) fail(field, `must be between ${min} and ${max}`);
  return v;
}

/**
 * @param {unknown} v
 * @param {string} field
 */
function bool(v, field) {
  if (typeof v !== 'boolean') fail(field, 'must be true or false');
  return v;
}

/**
 * @template {string} T
 * @param {unknown} v
 * @param {string} field
 * @param {readonly T[]} allowed
 * @returns {T}
 */
function oneOf(v, field, allowed) {
  if (typeof v !== 'string' || !(/** @type {readonly string[]} */ (allowed)).includes(v)) {
    fail(field, `must be one of: ${allowed.join(', ')}`);
  }
  return /** @type {T} */ (v);
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {ValidResident}
 */
function resident(v, field) {
  const r = obj(v, field);
  const imputed = obj(r.imputed, `${field}.imputed`);
  return {
    id: int(r.id, `${field}.id`, 0, 10_000_000),
    name: str(r.name, `${field}.name`, 1, 80),
    age: int(r.age, `${field}.age`, 0, 120),
    sex: oneOf(r.sex, `${field}.sex`, SEXES),
    occupation: str(r.occupation, `${field}.occupation`, 1, LIMITS.shortText),
    household: oneOf(r.household, `${field}.household`, HOUSEHOLDS),
    personaFr: str(r.personaFr ?? '', `${field}.personaFr`, 0, LIMITS.personaFr),
    imputed: {
      car: bool(imputed.car, `${field}.imputed.car`),
      heavyCar: bool(imputed.heavyCar, `${field}.imputed.heavyCar`),
      tenure: oneOf(imputed.tenure, `${field}.imputed.tenure`, TENURES),
      nationality: oneOf(imputed.nationality, `${field}.imputed.nationality`, NATIONALITIES),
    },
    commuteMode: oneOf(r.commuteMode, `${field}.commuteMode`, COMMUTES),
    districtName: str(r.districtName, `${field}.districtName`, 1, 80),
  };
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {[number, number]}
 */
function point(v, field) {
  if (!Array.isArray(v) || v.length !== 2) fail(field, 'must be [x, y]');
  const [x, y] = v;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    fail(field, 'must contain two numbers');
  }
  return [x, y];
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {ResidentResult['exposure']}
 */
function exposure(v, field) {
  const e = obj(v, field);
  const reasons = e.reasons ?? [];
  if (!Array.isArray(reasons)) fail(`${field}.reasons`, 'must be an array');
  if (reasons.length > LIMITS.exposureReasons) fail(`${field}.reasons`, `must have at most ${LIMITS.exposureReasons} items`);
  return {
    score: /** @type {0 | 1 | 2 | 3} */ (int(e.score, `${field}.score`, 0, 3)),
    reasons: reasons.map((item, i) => {
      const f = `${field}.reasons[${i}]`;
      const r = obj(item, f);
      /** @type {ExposureReason} */
      const out = {
        code: str(r.code, `${f}.code`, 1, 60),
        text: str(r.text, `${f}.text`, 1, LIMITS.exposureText),
        icon: oneOf(r.icon, `${f}.icon`, ICONS),
      };
      if (r.at !== undefined) {
        if (!Array.isArray(r.at) || r.at.length > LIMITS.exposurePoints) fail(`${f}.at`, 'must be a short array of points');
        out.at = r.at.map((p, j) => point(p, `${f}.at[${j}]`));
      }
      return out;
    }),
  };
}

/**
 * POST /api/ask body.
 * @param {unknown} body
 * @returns {AskRequest}
 */
export function parseAskRequest(body) {
  const b = obj(body, 'body');
  const scenarioId = str(b.scenarioId, 'scenarioId', 1, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(scenarioId)) fail('scenarioId', 'may only contain letters, digits, - and _');
  const previous = obj(b.previous, 'previous');
  return {
    scenarioId,
    question: str(b.question, 'question', 1, LIMITS.question),
    resident: resident(b.resident, 'resident'),
    proposalFr: str(b.proposalFr, 'proposalFr', 1, LIMITS.proposal),
    previous: {
      stance: /** @type {-2 | -1 | 0 | 1 | 2} */ (int(previous.stance, 'previous.stance', -2, 2)),
      reasonFr: str(previous.reasonFr ?? '', 'previous.reasonFr', 0, LIMITS.previousReason),
      exposure: exposure(previous.exposure, 'previous.exposure'),
    },
  };
}

/**
 * POST /api/react body. `channel` is optional (defaults to a public meeting).
 * @param {unknown} body
 * @returns {ValidReactRequest}
 */
export function parseReactRequest(body) {
  const b = obj(body, 'body');
  if (!Array.isArray(b.residents) || b.residents.length === 0) fail('residents', 'must be a non-empty array');
  if (b.residents.length > LIMITS.residentsPerReact) {
    fail('residents', `must have at most ${LIMITS.residentsPerReact} items per call`);
  }
  const residents = b.residents.map((r, i) => ({
    ...resident(r, `residents[${i}]`),
    exposure: exposure(obj(r, `residents[${i}]`).exposure, `residents[${i}].exposure`),
  }));
  const ids = new Set(residents.map((r) => r.id));
  if (ids.size !== residents.length) fail('residents', 'must not contain the same id twice');
  return {
    proposalFr: str(b.proposalFr, 'proposalFr', 1, LIMITS.proposal),
    residents,
    channel: b.channel === undefined ? 'public_meeting' : oneOf(b.channel, 'channel', CHANNELS),
  };
}
