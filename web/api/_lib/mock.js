// @ts-check
/**
 * MOCK MODE: deterministic, plausible answers WITHOUT any AI model.
 * Used when no TOKEN_FACTORY_API_KEY is set, when DISABLE_LIVE=1, or as a fallback if a live call fails.
 *
 * Every text starts with "[demo]" and every response carries mock: true, so the UI can show a banner.
 * The same input always gives the same output (a small hash replaces randomness), which keeps
 * screenshots and demo videos reproducible. The rules are simple keyword heuristics, NOT a model
 * of public opinion.
 */
/** @import { AskRequest, ReactResponse } from '../../src/types.js' */
/** @import { ValidReactResident } from './validate.js' */

export const MOCK_MODEL = 'mock-heuristic-v1';

/**
 * @typedef {-2 | -1 | 0 | 1 | 2} Stance
 * @typedef {'datacenter' | 'scooter' | 'car' | 'generic'} Topic
 */

/**
 * FNV-1a string hash -> a number in [0, 1). Deterministic stand-in for Math.random().
 * @param {string} text
 */
function hash01(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4_294_967_296;
}

/**
 * Lower case without accents, for keyword matching.
 * @param {string} text
 */
function plain(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * @param {string} proposalFr
 * @returns {Topic}
 */
function detectTopic(proposalFr) {
  const p = plain(proposalFr);
  if (/data ?cent(er|re)|centre de donnees|datacenter|intelligence artificielle/.test(p)) return 'datacenter';
  if (/trottinette/.test(p)) return 'scooter';
  if (/suv|vehicule|voiture|stationnement/.test(p)) return 'car';
  return 'generic';
}

/**
 * @param {number} x
 * @returns {Stance}
 */
function clampStance(x) {
  return /** @type {Stance} */ (Math.max(-2, Math.min(2, Math.round(x))));
}

/**
 * Heuristic stance: who is exposed, who owns a car, how old... plus a little deterministic noise.
 * @param {ValidReactResident} r
 * @param {Topic} topic
 * @param {number} noise 0..1
 */
function mockStance(r, topic, noise) {
  const harmIcons = r.exposure.reasons.filter((x) => ['noise', 'heat', 'water', 'construction', 'power'].includes(x.icon)).length;
  let s = (noise - 0.5) * 1.2;
  switch (topic) {
    case 'datacenter':
      s -= 0.6 * harmIcons + 0.3 * r.exposure.score;
      if (r.exposure.reasons.some((x) => x.icon === 'job')) s += 0.8;
      if (/Cadres|interm/.test(r.occupation)) s += 0.4;
      break;
    case 'scooter': // "Pour" = keep rental e-scooters
      s += r.age < 30 ? 0.8 : r.age >= 60 ? -1.6 : -0.6;
      break;
    case 'car': // "Pour" = special parking fee for heavy cars
      s += r.imputed.heavyCar ? -1.7 : r.imputed.car ? -0.6 : 0.9;
      break;
    default:
      s -= 0.4 * (r.exposure.score - 1);
  }
  return clampStance(s);
}

/** @type {Record<Stance, string>} */
const OPENERS_FR = {
  [-2]: 'Je suis franchement contre.',
  [-1]: 'Je suis plutôt contre.',
  0: "Honnêtement, ça m'est un peu égal.",
  1: 'Je suis plutôt pour.',
  2: 'Je suis tout à fait pour.',
};
/** @type {Record<Stance, string>} */
const OPENERS_EN = {
  [-2]: "I'm strongly against it.",
  [-1]: "I'm rather against it.",
  0: "Honestly, I don't feel strongly either way.",
  1: "I'm rather in favour.",
  2: "I'm fully in favour.",
};

/** [French, English] detail sentence per topic and side. @type {Record<Topic, Record<'oppose' | 'neutral' | 'support', [string, string]>>} */
const DETAILS = {
  datacenter: {
    oppose: ['Un chantier pareil près de chez moi, avec le bruit, la chaleur et l’eau consommée, ça m’inquiète.', 'A site like that near my home, with the noise, the heat and the water it uses, worries me.'],
    neutral: ['Je ne vois pas bien ce que ça change pour mon quotidien.', "I don't really see what it changes in my daily life."],
    support: ['Si ça crée de vrais emplois dans le coin, pourquoi pas.', 'If it brings real jobs to the area, why not.'],
  },
  scooter: {
    oppose: ['Les trottinettes sur les trottoirs, c’est dangereux, surtout pour les plus âgés.', 'Scooters on the pavements are dangerous, especially for older people.'],
    neutral: ['Je ne les utilise pas, mais elles ne me gênent pas trop.', "I don't use them, but they don't bother me much."],
    support: ['C’est pratique pour mes trajets courts, je les utilise souvent.', 'They are handy for my short trips; I use them often.'],
  },
  car: {
    oppose: ['Ma voiture, j’en ai besoin, et payer plus pour se garer, c’est injuste.', 'I need my car, and paying more to park is unfair.'],
    neutral: ['Je n’ai pas de grosse voiture, donc ça ne me concerne pas vraiment.', "I don't have a big car, so it doesn't really concern me."],
    support: ['Les gros SUV prennent trop de place en ville, c’est normal qu’ils paient plus.', "Big SUVs take up too much space in the city; it's fair they pay more."],
  },
  generic: {
    oppose: ['Ça risque de compliquer ma vie de tous les jours.', 'It could make my everyday life harder.'],
    neutral: ['Je n’ai pas d’avis tranché, il faudrait voir les détails.', "I don't have a firm view; I'd need to see the details."],
    support: ['Ça me paraît plutôt une bonne idée pour le quartier.', 'It seems like a rather good idea for the neighbourhood.'],
  },
};

/** @type {Record<Stance, string>} */
const BEHAVIOUR = {
  [-2]: 'Would sign a petition and argue against it with neighbours.',
  [-1]: 'Would grumble about it but probably not take action.',
  0: 'Would carry on as usual.',
  1: 'Would mention support if asked, without campaigning.',
  2: 'Would speak up in favour and encourage others to support it.',
};

/**
 * Mock /api/react: one deterministic reaction per resident.
 * @param {ValidReactResident} r
 * @param {string} proposalFr
 * @returns {ReactResponse['results'][number]}
 */
export function mockReaction(r, proposalFr) {
  const topic = detectTopic(proposalFr);
  const seed = `${r.id}|${proposalFr}`;
  const stance = mockStance(r, topic, hash01(seed));
  const side = stance < 0 ? 'oppose' : stance > 0 ? 'support' : 'neutral';
  const [detailFr, detailEn] = DETAILS[topic][side];
  const nudge = hash01(`${seed}|affected`);
  const affected = Math.max(0, Math.min(3, r.exposure.score + (nudge < 0.15 ? -1 : nudge > 0.85 ? 1 : 0)));
  const participate = 0.08 + 0.12 * r.exposure.score + 0.004 * Math.max(0, r.age - 18) + 0.15 * hash01(`${seed}|go`);
  return {
    id: r.id,
    stance,
    affectedLLM: /** @type {0 | 1 | 2 | 3} */ (affected),
    behaviourEn: `[demo] ${BEHAVIOUR[stance]}`,
    reasonFr: `[demo] ${OPENERS_FR[stance]} ${detailFr}`,
    reasonEn: `[demo] ${OPENERS_EN[stance]} ${detailEn}`,
    wouldParticipateLLM: Math.round(Math.min(0.9, Math.max(0.02, participate)) * 100) / 100,
  };
}

/** [French, English] follow-up sentences for mock answers. @type {[string, string][]} */
const ASK_FOLLOWUPS = [
  ['si on me garantissait un vrai suivi des nuisances, je pourrais nuancer mon avis.', 'if I were promised real monitoring of the nuisances, I could soften my view.'],
  ['ce qui compte pour moi, c’est mon quotidien : mes trajets, mon logement et le calme du quartier.', 'what matters to me is my daily life: my commute, my home and a quiet neighbourhood.'],
  ['honnêtement, je n’y avais pas beaucoup réfléchi, mais ça ne me fait pas changer d’avis.', "honestly, I hadn't thought about it much, but it doesn't change my mind."],
  ['j’aimerais surtout qu’on demande l’avis des gens du quartier avant de décider.', "above all I'd like people in the neighbourhood to be asked before anything is decided."],
];

/**
 * Remove a leading "[demo]" so we do not print it twice.
 * @param {string} text
 */
function stripDemo(text) {
  return text.replace(/^\s*\[demo\]\s*/i, '');
}

/**
 * Mock /api/ask: a short answer consistent with the resident's previous stance.
 * @param {AskRequest} req
 */
export function mockAnswer(req) {
  const stance = req.previous.stance;
  const pick = Math.floor(hash01(`${req.resident.id}|${req.question}`) * ASK_FOLLOWUPS.length);
  const [followFr, followEn] = ASK_FOLLOWUPS[pick];
  const previousFr = stripDemo(req.previous.reasonFr).slice(0, 200);
  return {
    answerFr: `[demo] ${OPENERS_FR[stance]} ${previousFr ? `${previousFr} ` : ''}Pour répondre à votre question : ${followFr}`,
    answerEn: `[demo] ${OPENERS_EN[stance]} To answer your question: ${followEn}`,
  };
}
