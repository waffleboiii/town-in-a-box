// @ts-check
/**
 * How a resident is described to the model ("profile text"), and how prompts are filled.
 *
 * IMPORTANT for the pipeline (pipeline/*.py): batch runs must build EXACTLY the same text,
 * otherwise live answers and precomputed answers are not comparable. Mirror these rules:
 *
 *   Template: web/shared/prompts.json -> profile.template, placeholders {{name}}:
 *     {{name}}         resident.name
 *     {{age}}          resident.age as an integer ("34")
 *     {{sexFr}}        F -> "femme", M -> "homme"
 *     {{occupation}}   raw French PCS label from the dataset (resident.occupation)
 *     {{householdRaw}} raw dataset label. The API receives the code and maps it back 1:1:
 *                        single -> "Personne seule", couple_no_kids -> "Couple sans enfant",
 *                        couple_kids -> "Couple avec enfant(s)", single_parent -> "Famille monoparentale"
 *     {{districtName}} display name of the home district (e.g. "Paris 11e Arrondissement", "Saint-Denis")
 *     {{tenureFr}}     owner -> "propriétaire", private_renter -> "locataire du parc privé",
 *                        social_renter -> "locataire d'un logement social"
 *     {{carFr}}        no car -> "non"; car -> "oui"; heavy car -> "oui, un véhicule lourd (SUV ou plus de 1,6 t)"
 *     {{commuteFr}}    metro -> "métro", rer -> "RER ou train de banlieue", bus -> "bus", car -> "voiture",
 *                        bike -> "vélo", walk -> "à pied", none -> "aucun trajet domicile-travail"
 *     {{personaFr}}    resident.personaFr (dataset `persona` text)
 *     {{extra}}        "" in the API (the pipeline may append longer dataset text)
 *
 *   Exposure facts for the 'reaction' prompt ({{exposure}}), see renderExposureFr():
 *     line 1: "Niveau d'exposition calculé : <score>/3 (<label>)"
 *       labels: 0 "rien de concret ne change pour toi", 1 "un peu concerné·e",
 *               2 "concerné·e", 3 "très concerné·e"
 *     then one line per reason: "- <reason.text>"
 *     or, with no reasons: "- Aucun effet direct identifié sur ton logement, tes trajets ou ton budget."
 *
 *   Channel ({{channel}}): votation -> "à la votation citoyenne",
 *     public_meeting -> "à une réunion publique de concertation",
 *     online_consultation -> "à la consultation en ligne"
 *
 *   Placeholders are replaced in ONE pass (a value containing "{{x}}" is not re-expanded);
 *   unknown placeholders become "".
 *
 * If the engine engineer adds `"renderings": { "sexFr": {...}, "tenureFr": {...}, ... }` to
 * prompts.json -> profile, those values override the defaults below (same keys), so Python and
 * JavaScript can read the mapping from one file.
 */
/** @import { Channel, CommuteMode, HouseholdKind, ResidentResult, Tenure } from '../../src/types.js' */
/** @import { ValidResident } from './validate.js' */
import { prompts } from './shared.js';

/**
 * @typedef {{
 *   sexFr: Record<'F' | 'M', string>,
 *   householdRaw: Record<HouseholdKind, string>,
 *   tenureFr: Record<Tenure, string>,
 *   carFr: { none: string, car: string, heavyCar: string },
 *   commuteFr: Record<CommuteMode, string>,
 *   channelFr: Record<Channel, string>,
 *   exposureLabelFr: [string, string, string, string],
 *   exposureNoneFr: string,
 * }} Renderings
 */

/** @type {Renderings} */
const DEFAULT_RENDERINGS = {
  sexFr: { F: 'femme', M: 'homme' },
  householdRaw: {
    single: 'Personne seule',
    couple_no_kids: 'Couple sans enfant',
    couple_kids: 'Couple avec enfant(s)',
    single_parent: 'Famille monoparentale',
  },
  tenureFr: {
    owner: 'propriétaire',
    private_renter: 'locataire du parc privé',
    social_renter: "locataire d'un logement social",
  },
  carFr: { none: 'non', car: 'oui', heavyCar: 'oui, un véhicule lourd (SUV ou plus de 1,6 t)' },
  commuteFr: {
    metro: 'métro',
    rer: 'RER ou train de banlieue',
    bus: 'bus',
    car: 'voiture',
    bike: 'vélo',
    walk: 'à pied',
    none: 'aucun trajet domicile-travail',
  },
  channelFr: {
    votation: 'à la votation citoyenne',
    public_meeting: 'à une réunion publique de concertation',
    online_consultation: 'à la consultation en ligne',
  },
  exposureLabelFr: ['rien de concret ne change pour toi', 'un peu concerné·e', 'concerné·e', 'très concerné·e'],
  exposureNoneFr: 'Aucun effet direct identifié sur ton logement, tes trajets ou ton budget.',
};

/** Defaults, overridden key by key by prompts.json -> profile.renderings (if present). @type {Renderings} */
export const RENDERINGS = { ...DEFAULT_RENDERINGS, ...(/** @type {Partial<Renderings>} */ (prompts.profile.renderings ?? {})) };

/**
 * Replace {{name}} placeholders in one pass. Unknown names become "".
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, /** @type {string} */ key) => values[key] ?? '');
}

/** @param {ValidResident['imputed']} imputed */
export function carFr(imputed) {
  if (!imputed.car) return RENDERINGS.carFr.none;
  return imputed.heavyCar ? RENDERINGS.carFr.heavyCar : RENDERINGS.carFr.car;
}

/**
 * The profile paragraph shown to the model (same text as the pipeline).
 * @param {ValidResident} r
 * @param {string} [extra]
 */
export function buildProfileFr(r, extra = '') {
  return fillTemplate(prompts.profile.template, {
    name: r.name,
    age: String(r.age),
    sexFr: RENDERINGS.sexFr[r.sex],
    occupation: r.occupation,
    householdRaw: RENDERINGS.householdRaw[r.household],
    districtName: r.districtName,
    tenureFr: RENDERINGS.tenureFr[r.imputed.tenure],
    carFr: carFr(r.imputed),
    commuteFr: RENDERINGS.commuteFr[r.commuteMode],
    personaFr: r.personaFr,
    extra,
  });
}

/**
 * The computed exposure facts, as French text for the 'reaction' prompt.
 * @param {ResidentResult['exposure']} exposure
 */
export function renderExposureFr(exposure) {
  const header = `Niveau d'exposition calculé : ${exposure.score}/3 (${RENDERINGS.exposureLabelFr[exposure.score]})`;
  const lines = exposure.reasons.length
    ? exposure.reasons.map((r) => `- ${r.text}`)
    : [`- ${RENDERINGS.exposureNoneFr}`];
  return [header, ...lines].join('\n');
}
