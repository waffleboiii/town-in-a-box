// @ts-check
/**
 * POST /api/ask  (AskRequest -> AskResponse)
 *
 * The planner asks ONE simulated resident a follow-up question. The model answers in that
 * resident's voice, consistent with their profile and earlier reaction.
 * Prompts: web/shared/prompts.json -> 'profile' + 'ask'.
 *
 * Flow: validate input -> rate limit -> mock answer (no key / DISABLE_LIVE) or live Nemotron call.
 * Every answer is a SIMULATED voice, never a real person.
 */
/** @import { AskRequest, AskResponse } from '../src/types.js' */
import { isMockMode, llmSettings, models } from './_lib/env.js';
import { handle, json, readJsonBody } from './_lib/http.js';
import { asText, callJson } from './_lib/llm.js';
import { MOCK_MODEL, mockAnswer } from './_lib/mock.js';
import { buildProfileFr, fillTemplate } from './_lib/profile.js';
import { rateLimit, takeDailyLive } from './_lib/rateLimit.js';
import { prompts } from './_lib/shared.js';
import { parseAskRequest } from './_lib/validate.js';

const MAX_TOKENS = 450;

/**
 * Ask the live model. Throws if it cannot give a usable answer.
 * @param {AskRequest} req
 * @param {string} model
 */
async function liveAnswer(req, model) {
  const user = fillTemplate(prompts.ask.user, {
    profile: buildProfileFr(req.resident),
    proposal: req.proposalFr,
    stance: String(req.previous.stance),
    previousReason: req.previous.reasonFr || '(aucune raison donnée)',
    question: req.question,
  });
  return callJson({
    model,
    system: prompts.ask.system,
    user,
    schemaName: 'resident_answer',
    schema: prompts.ask.schema,
    temperature: llmSettings().temperatureAsk,
    maxTokens: MAX_TOKENS,
    parse: (d) => ({
      answerFr: asText(d.answer_fr, 'answer_fr', 1_200),
      answerEn: asText(d.answer_en, 'answer_en', 1_200),
    }),
  });
}

export default {
  /** @param {Request} request */
  async fetch(request) {
    return handle(request, ['POST'], async () => {
      const req = parseAskRequest(await readJsonBody(request));
      let live = !isMockMode();
      rateLimit(request, live ? 1 : 0);
      if (live && !takeDailyLive(1)) {
        console.warn('[ask] daily live allowance used up: answering with demo text');
        live = false;
      }

      if (live) {
        const model = models().ask;
        try {
          /** @type {AskResponse} */
          const response = { ...(await liveAnswer(req, model)), model, mock: false };
          return json(response);
        } catch (err) {
          console.warn(`[ask] live call failed: ${err instanceof Error ? err.message : String(err)}`);
          if (!llmSettings().fallbackToMock) {
            return json({ error: 'The simulated resident could not answer right now. Please try again.' }, 502);
          }
          // Otherwise fall through to a clearly flagged mock answer so the demo keeps working.
        }
      }
      /** @type {AskResponse} */
      const response = { ...mockAnswer(req), model: MOCK_MODEL, mock: true };
      return json(response);
    });
  },
};
