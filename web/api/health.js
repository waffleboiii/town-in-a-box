// @ts-check
/**
 * GET /api/health  ->  ApiHealth  { ok, mock, models }
 *
 * "mock: true" means no live AI calls (no TOKEN_FACTORY_API_KEY, or DISABLE_LIVE=1).
 *
 * GET /api/health?check=1 additionally asks Token Factory for its model list (free, no tokens used)
 * and reports whether the key works and whether our model IDs exist:
 *   { ..., check: { reachable: true, keyAccepted: true, modelsFound: { reaction: true, ... } } }
 * Handy right after adding the key on Vercel. It never returns the key itself.
 */
/** @import { ApiHealth } from '../src/types.js' */
import { baseUrl, envFlag, isMockMode, models, readEnv } from './_lib/env.js';
import { handle, json } from './_lib/http.js';
import { rateLimit } from './_lib/rateLimit.js';

/**
 * @typedef {{
 *   reachable: boolean,
 *   keyAccepted: boolean | null,
 *   modelsFound: Record<string, boolean> | null,
 *   note: string,
 * }} HealthCheck
 */

/** @returns {Promise<HealthCheck>} */
async function checkTokenFactory() {
  const apiKey = readEnv('TOKEN_FACTORY_API_KEY');
  if (!apiKey) {
    return { reachable: false, keyAccepted: null, modelsFound: null, note: 'No API key configured: mock mode.' };
  }
  try {
    const res = await fetch(`${baseUrl()}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, keyAccepted: false, modelsFound: null, note: 'Token Factory refused the API key.' };
    }
    if (!res.ok) {
      return { reachable: true, keyAccepted: null, modelsFound: null, note: `Model list returned HTTP ${res.status}.` };
    }
    const body = /** @type {{ data?: { id?: string }[] }} */ (await res.json());
    const ids = new Set((body.data ?? []).map((m) => m.id));
    const m = models();
    const modelsFound = {
      reaction: ids.has(m.reaction),
      conversation: ids.has(m.conversation),
      synthesis: ids.has(m.synthesis),
      ask: ids.has(m.ask),
    };
    const allFound = Object.values(modelsFound).every(Boolean);
    return {
      reachable: true,
      keyAccepted: true,
      modelsFound,
      note: allFound ? 'All model IDs found.' : 'Some model IDs were not found: fix MODEL_* env vars (see /v1/models).',
    };
  } catch {
    return { reachable: false, keyAccepted: null, modelsFound: null, note: 'Could not reach Token Factory.' };
  }
}

export default {
  /** @param {Request} request */
  async fetch(request) {
    return handle(request, ['GET'], async () => {
      const m = models();
      /** @type {ApiHealth} */
      const health = {
        ok: true,
        mock: isMockMode(),
        models: { reaction: m.reaction, conversation: m.conversation, synthesis: m.synthesis },
      };
      const wantsCheck = new URL(request.url).searchParams.get('check') === '1';
      if (!wantsCheck) return json(health);

      rateLimit(request, 0); // the check is free, but limit it anyway
      const check = await checkTokenFactory();
      // liveDisabled = the kill-switch DISABLE_LIVE=1 is on (answers are mock even with a key).
      return json({ ...health, check: { ...check, liveDisabled: envFlag('DISABLE_LIVE', false) } });
    });
  },
};
