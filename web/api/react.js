// @ts-check
/**
 * POST /api/react  (ReactRequest -> ReactResponse)
 *
 * Up to 5 simulated residents react to a (custom) proposal, all at the same time.
 * Each prompt contains the resident's profile and their COMPUTED exposure facts (what the
 * proposal changes for them - calculated from geography by the pipeline/UI, never by the AI).
 * Prompts: web/shared/prompts.json -> 'profile' + 'reaction'.
 *
 * Optional body field `channel` ('votation' | 'public_meeting' | 'online_consultation',
 * default 'public_meeting') fills {{channel}} ("would you take part in ...").
 *
 * If one resident's live call fails, that resident gets a clearly flagged mock answer
 * ("[demo]" text, `mock: true` on that result); the top-level `mock` is true only if ALL are mock.
 */
/** @import { Channel, ReactResponse } from '../src/types.js' */
/** @import { ValidReactResident } from './_lib/validate.js' */
import { isMockMode, llmSettings, models } from './_lib/env.js';
import { handle, json, readJsonBody } from './_lib/http.js';
import { asInt, asNumber, asText, callJson } from './_lib/llm.js';
import { MOCK_MODEL, mockReaction } from './_lib/mock.js';
import { RENDERINGS, buildProfileFr, fillTemplate, renderExposureFr } from './_lib/profile.js';
import { rateLimit, takeDailyLive } from './_lib/rateLimit.js';
import { prompts } from './_lib/shared.js';
import { parseReactRequest } from './_lib/validate.js';

const MAX_TOKENS = 500;

/** @typedef {ReactResponse['results'][number] & { mock?: boolean }} ReactionResult */

/**
 * One resident, one live call. Throws if the model cannot give a usable answer.
 * @param {ValidReactResident} r
 * @param {string} proposalFr
 * @param {Channel} channel
 * @param {string} model
 * @returns {Promise<ReactionResult>}
 */
async function liveReaction(r, proposalFr, channel, model) {
  const user = fillTemplate(prompts.reaction.user, {
    profile: buildProfileFr(r),
    exposure: renderExposureFr(r.exposure),
    proposal: proposalFr,
    channel: RENDERINGS.channelFr[channel],
  });
  return callJson({
    model,
    system: prompts.reaction.system,
    user,
    schemaName: 'resident_reaction',
    schema: prompts.reaction.schema,
    temperature: llmSettings().temperatureReaction,
    maxTokens: MAX_TOKENS,
    parse: (d) => ({
      id: r.id,
      stance: /** @type {ReactionResult['stance']} */ (asInt(d.stance, 'stance', -2, 2)),
      affectedLLM: /** @type {ReactionResult['affectedLLM']} */ (asInt(d.affected, 'affected', 0, 3)),
      behaviourEn: asText(d.behaviour_en, 'behaviour_en', 300),
      reasonFr: asText(d.reason_fr, 'reason_fr', 600),
      reasonEn: asText(d.reason_en, 'reason_en', 600),
      wouldParticipateLLM: asNumber(d.would_participate, 'would_participate', 0, 1),
    }),
  });
}

export default {
  /** @param {Request} request */
  async fetch(request) {
    return handle(request, ['POST'], async () => {
      const req = parseReactRequest(await readJsonBody(request));
      let live = !isMockMode();
      rateLimit(request, live ? req.residents.length : 0);
      if (live && !takeDailyLive(req.residents.length)) {
        console.warn('[react] daily live allowance used up: answering with demo text');
        live = false;
      }

      if (!live) {
        /** @type {ReactResponse} */
        const response = { results: req.residents.map((r) => mockReaction(r, req.proposalFr)), model: MOCK_MODEL, mock: true };
        return json(response);
      }

      // All residents at the same time (max 5), each with its own retry.
      const model = models().reaction;
      const settled = await Promise.allSettled(
        req.residents.map((r) => liveReaction(r, req.proposalFr, req.channel, model)),
      );
      const failed = settled.filter((s) => s.status === 'rejected');
      if (failed.length > 0) {
        const reason = /** @type {PromiseRejectedResult} */ (failed[0]).reason;
        console.warn(`[react] ${failed.length}/${settled.length} live calls failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        if (!llmSettings().fallbackToMock) {
          return json({ error: 'The simulated residents could not answer right now. Please try again.' }, 502);
        }
      }
      /** @type {ReactionResult[]} */
      const results = settled.map((s, i) =>
        s.status === 'fulfilled' ? s.value : { ...mockReaction(req.residents[i], req.proposalFr), mock: true },
      );
      const allMock = failed.length === settled.length;
      /** @type {ReactResponse} */
      const response = { results, model: allMock ? MOCK_MODEL : model, mock: allMock };
      return json(response);
    });
  },
};
