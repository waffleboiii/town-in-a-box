// @ts-check
/**
 * Calls NVIDIA Nemotron models on Nebius Token Factory (OpenAI-compatible Chat Completions API)
 * and returns a validated JSON object.
 *
 *   POST {TOKEN_FACTORY_BASE_URL}/chat/completions
 *   Authorization: Bearer {TOKEN_FACTORY_API_KEY}
 *
 * Robustness, in plain words:
 *  1. We ask for "structured output": response_format json_schema (strict). If the server says
 *     400 "I don't support that", we fall back to json_object, and finally drop the optional
 *     chat_template_kwargs. The first format that works is remembered for later calls.
 *  2. Each HTTP attempt has a timeout (LLM_TIMEOUT_MS, default 25 s) and the whole call has a
 *     40 s budget: the Vercel function may run 60 s and the browser gives up after 45 s.
 *  3. On 429 (rate limited), 5xx, a timeout, a network error, or an unreadable answer we retry ONCE.
 *  4. The answer text is parsed as JSON (tolerating markdown code fences and <think> blocks), then the
 *     caller's `parse` function checks and clamps every field.
 *
 * SECURITY: the API key is read here, sent only to Token Factory, and never logged or returned.
 */
import { baseUrl, llmSettings, readEnv } from './env.js';

/**
 * @template T
 * @typedef {object} JsonCallOptions
 * @property {string} model
 * @property {string} system
 * @property {string} user
 * @property {string} schemaName short name for the schema, e.g. "resident_reaction"
 * @property {Record<string, unknown>} schema JSON Schema, from web/shared/prompts.json
 * @property {number} temperature
 * @property {number} maxTokens cap on generated tokens (keeps cost and latency predictable)
 * @property {(data: Record<string, unknown>) => T} parse check and clean the parsed object;
 *   throw to reject it (triggers the one retry)
 */

/**
 * @typedef {{ format: 'json_schema' | 'json_object', thinkingOff: boolean }} Variant
 * @typedef {'bad_request' | 'transient' | 'bad_output' | 'fatal'} FailureKind
 */

/** Thrown when the live model could not give a usable answer. Message is for server logs only. */
export class LlmError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LlmError';
  }
}

const TOTAL_BUDGET_MS = 40_000;

/** Index of the first request variant that worked (remembered while this server instance lives). */
let preferredVariant = 0;

/**
 * @param {boolean} disableThinking
 * @returns {Variant[]}
 */
function requestVariants(disableThinking) {
  /** @type {Variant[]} */
  const list = [
    { format: 'json_schema', thinkingOff: disableThinking },
    { format: 'json_object', thinkingOff: disableThinking },
  ];
  if (disableThinking) list.push({ format: 'json_object', thinkingOff: false });
  return list;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the model and return the parsed, validated answer. Throws LlmError on failure.
 * @template T
 * @param {JsonCallOptions<T>} opts
 * @returns {Promise<T>}
 */
export async function callJson(opts) {
  const apiKey = readEnv('TOKEN_FACTORY_API_KEY');
  if (!apiKey) throw new LlmError('No TOKEN_FACTORY_API_KEY configured');

  const settings = llmSettings();
  const variants = requestVariants(settings.disableThinking);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let v = Math.min(preferredVariant, variants.length - 1);
  let retriesLeft = 1;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) throw new LlmError('Time budget exhausted');

    const started = Date.now();
    const attempt = await attemptOnce(apiKey, opts, variants[v], Math.min(settings.timeoutMs, remaining));
    if (attempt.ok) {
      preferredVariant = v;
      console.info(`[llm] ok model=${opts.model} format=${variants[v].format} ms=${Date.now() - started}`);
      return attempt.value;
    }

    console.warn(`[llm] model=${opts.model} format=${variants[v].format} failed (${attempt.kind}): ${attempt.message}`);
    if (attempt.kind === 'bad_request' && v < variants.length - 1) {
      v += 1; // try a simpler request format
      continue;
    }
    if ((attempt.kind === 'transient' || attempt.kind === 'bad_output') && retriesLeft > 0) {
      retriesLeft -= 1;
      await sleep(Math.min(attempt.retryAfterMs ?? 700 + Math.random() * 500, 3_000));
      continue;
    }
    throw new LlmError(`${attempt.kind}: ${attempt.message}`);
  }
}

/**
 * One HTTP call. Never throws: returns either the value or a classified failure.
 * @template T
 * @param {string} apiKey
 * @param {JsonCallOptions<T>} opts
 * @param {Variant} variant
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: true, value: T } | { ok: false, kind: FailureKind, message: string, retryAfterMs?: number }>}
 */
async function attemptOnce(apiKey, opts, variant, timeoutMs) {
  // In json_object mode the server no longer enforces the schema, so we also show it in the prompt.
  const system =
    variant.format === 'json_schema'
      ? opts.system
      : `${opts.system}\n\nSchéma JSON attendu : ${JSON.stringify(opts.schema)}`;

  /** @type {Record<string, unknown>} */
  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: opts.user },
    ],
    temperature: opts.temperature,
    // With "thinking" on, the model writes a hidden reasoning first: give it more room.
    max_tokens: variant.thinkingOff ? opts.maxTokens : opts.maxTokens + 2_000,
    response_format:
      variant.format === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: opts.schemaName, schema: opts.schema, strict: true } }
        : { type: 'json_object' },
  };
  if (variant.thinkingOff) body.chat_template_kwargs = { enable_thinking: false };

  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const message = name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : `network error (${name})`;
    return { ok: false, kind: 'transient', message };
  }

  if (!res.ok) {
    // Read a short piece of the error for the server log, with the key redacted just in case.
    const detail = (await res.text().catch(() => '')).slice(0, 300).split(apiKey).join('[redacted]');
    const message = `HTTP ${res.status} ${detail}`;
    if (res.status === 429 || res.status >= 500) {
      const retryAfterSec = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined;
      return { ok: false, kind: 'transient', message, retryAfterMs };
    }
    if (res.status === 400 || res.status === 422) return { ok: false, kind: 'bad_request', message };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'fatal', message: `${message} (check TOKEN_FACTORY_API_KEY)` };
    }
    if (res.status === 404) {
      return { ok: false, kind: 'fatal', message: `${message} (check the MODEL_* ids and TOKEN_FACTORY_BASE_URL)` };
    }
    return { ok: false, kind: 'fatal', message };
  }

  /** @typedef {{ choices?: { message?: { content?: unknown }, finish_reason?: string }[] }} ChatPayload */
  /** @type {ChatPayload} */
  let payload;
  try {
    payload = /** @type {ChatPayload} */ (await res.json());
  } catch {
    return { ok: false, kind: 'bad_output', message: 'response was not JSON' };
  }

  const choice = payload.choices?.[0];
  const text = contentToText(choice?.message?.content);
  if (!text) {
    return { ok: false, kind: 'bad_output', message: `empty answer (finish_reason=${choice?.finish_reason ?? '?'})` };
  }
  const parsed = extractJsonObject(text);
  if (!parsed) {
    const hint = choice?.finish_reason === 'length' ? ' (cut off by max_tokens)' : '';
    return { ok: false, kind: 'bad_output', message: `answer was not a JSON object${hint}` };
  }
  try {
    return { ok: true, value: opts.parse(parsed) };
  } catch (err) {
    return { ok: false, kind: 'bad_output', message: err instanceof Error ? err.message : 'invalid fields' };
  }
}

/**
 * message.content is normally a string; some servers send an array of {type, text} parts.
 * @param {unknown} content
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/**
 * Find the JSON object in a model answer (tolerates <think>...</think> and markdown code fences).
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
export function extractJsonObject(text) {
  let t = text;
  const thinkEnd = t.lastIndexOf('</think>');
  if (thinkEnd >= 0) t = t.slice(thinkEnd + '</think>'.length);
  t = t.replace(/```(?:json)?/gi, '').trim();
  const candidates = [t];
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------- helpers to check and clamp model output ----------

/**
 * A number (or numeric string) rounded and clamped to [min, max]; throws if missing.
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
export function asInt(value, field, min, max) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`field ${field} is not a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * A number clamped to [min, max]; throws if missing.
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
export function asNumber(value, field, min, max) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`field ${field} is not a number`);
  return Math.min(max, Math.max(min, n));
}

/**
 * A non-empty string, trimmed and cut to `max` characters; throws if missing.
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 */
export function asText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`field ${field} is empty`);
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
