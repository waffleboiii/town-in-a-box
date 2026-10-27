// @ts-check
/**
 * Server-side settings, read from environment variables.
 *
 * - On Vercel: set them in Project -> Settings -> Environment Variables.
 * - Locally: put them in the repo-root .env file (web/server/devApi.ts loads it for `vite dev`).
 *
 * SECURITY: this file runs ONLY on the server. Never import it from web/src (browser code).
 * The API key is read only inside llm.js / health.js at call time and is never returned or logged.
 */
import { config } from './shared.js';

/**
 * Read an env var; empty strings count as "not set".
 * @param {string} name
 * @returns {string | undefined}
 */
export function readEnv(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * True for "1", "true", "yes", "on" (any case).
 * @param {string} name
 * @param {boolean} defaultValue
 */
export function envFlag(name, defaultValue) {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * A positive number from env, or the default when missing/invalid.
 * @param {string} name
 * @param {number} defaultValue
 */
export function envNumber(name, defaultValue) {
  const value = Number(readEnv(name));
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

/** Is a Token Factory key configured? (Returns a boolean only, never the key.) */
export function hasApiKey() {
  return readEnv('TOKEN_FACTORY_API_KEY') !== undefined;
}

/**
 * Mock mode = no real LLM calls. True when there is no API key, or when the
 * kill-switch DISABLE_LIVE=1 is set (e.g. when credits run low).
 */
export function isMockMode() {
  return !hasApiKey() || envFlag('DISABLE_LIVE', false);
}

/** Token Factory base URL, without a trailing slash. */
export function baseUrl() {
  const url = readEnv('TOKEN_FACTORY_BASE_URL') ?? config.llmDefaults.baseUrl;
  return url.replace(/\/+$/, '');
}

/** Model IDs (public information, safe to show in /api/health). */
export function models() {
  const reaction = readEnv('MODEL_REACTION') ?? config.llmDefaults.modelReaction;
  return {
    reaction,
    conversation: readEnv('MODEL_CONVERSATION') ?? config.llmDefaults.modelConversation,
    synthesis: readEnv('MODEL_SYNTHESIS') ?? config.llmDefaults.modelSynthesis,
    // The "ask a resident" chat uses the fast reaction model unless MODEL_ASK is set.
    ask: readEnv('MODEL_ASK') ?? reaction,
  };
}

/** LLM call settings (all optional; defaults are tuned for a fast live demo). */
export function llmSettings() {
  return {
    /** Send chat_template_kwargs {enable_thinking:false} so Nemotron answers directly (faster, cheaper). */
    disableThinking: envFlag('LLM_DISABLE_THINKING', true),
    /** Per-attempt timeout for one HTTP call to Token Factory. */
    timeoutMs: envNumber('LLM_TIMEOUT_MS', 25_000),
    temperatureReaction: envNumber('LLM_TEMPERATURE_REACTION', 0.7),
    temperatureAsk: envNumber('LLM_TEMPERATURE_ASK', 0.6),
    /** If a live call fails, answer with a clearly flagged mock (mock: true, "[demo]") instead of an error. */
    fallbackToMock: envFlag('LIVE_FALLBACK_TO_MOCK', true),
  };
}
