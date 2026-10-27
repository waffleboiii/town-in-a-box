// @ts-check
/**
 * Small HTTP helpers shared by every endpoint (web-standard Request/Response).
 *
 * Every endpoint is written as:
 *     export default { fetch(request) { return handle(request, ['POST'], async () => { ... }) } }
 * `handle` takes care of: allowed methods, same-origin check, security headers,
 * and turning any error into a short, generic JSON message.
 */
import { readEnv } from './env.js';

/** Biggest request body we accept (bytes). 5 residents with exposure facts fit in ~20 KB. */
export const MAX_BODY_BYTES = 64 * 1024;

/** An error whose message is safe to show to the browser. */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} publicMessage short, generic text for the browser
   */
  constructor(status, publicMessage) {
    super(publicMessage);
    this.name = 'HttpError';
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/** @type {Record<string, string>} */
const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * JSON response with security headers.
 * @param {unknown} data
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...headers } });
}

/**
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function errorJson(status, message, headers = {}) {
  return json({ error: message }, status, headers);
}

/** @param {string} url */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * The host the browser thinks it is talking to (e.g. "town.vercel.app" or "localhost:5173").
 * @param {Request} request
 */
function requestHost(request) {
  return request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? safeHost(request.url);
}

/**
 * CORS policy = same-origin only. We never send Access-Control-Allow-Origin, so browsers
 * block other websites from reading our answers. On top of that we refuse requests whose
 * Origin header names another site, so other sites cannot spend our credits either.
 * Requests without an Origin header (curl, server-to-server) are allowed; the rate limit covers them.
 * Extra allowed origins (e.g. a custom domain behind a proxy): ALLOWED_ORIGINS="https://a.com,https://b.org".
 * @param {Request} request
 */
function isAllowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin === null) return true; // no Origin header: not a cross-site browser call
  const extra = (readEnv('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  // The literal origin "null" (sandboxed iframes, file://) is not a URL -> null -> refused.
  const originHost = safeHost(origin);
  return originHost !== null && originHost === requestHost(request);
}

/**
 * Best-effort client IP. On Vercel, x-real-ip / x-forwarded-for are set by the platform.
 * @param {Request} request
 */
export function clientIp(request) {
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

/**
 * Read and parse a JSON body, refusing anything larger than MAX_BODY_BYTES.
 * Reads the stream chunk by chunk so a huge body is rejected early.
 * @param {Request} request
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'Send the body as JSON (Content-Type: application/json).');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
  if (!request.body) throw new HttpError(400, 'Request body is empty.');

  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (text.trim() === '') throw new HttpError(400, 'Request body is empty.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

/**
 * Wrap an endpoint: method check, same-origin check, and safe error handling.
 * Unexpected errors are logged on the server (name + message only) and the browser
 * only ever sees a generic sentence.
 * @param {Request} request
 * @param {string[]} methods allowed HTTP methods, e.g. ['POST']
 * @param {() => Promise<Response>} run the endpoint logic
 * @returns {Promise<Response>}
 */
export async function handle(request, methods, run) {
  const allow = methods.join(', ');
  if (request.method === 'OPTIONS') {
    // No CORS headers on purpose: cross-origin preflights fail, same-origin calls never preflight.
    return new Response(null, { status: 204, headers: { allow, 'cache-control': 'no-store' } });
  }
  if (!methods.includes(request.method)) {
    return errorJson(405, 'Method not allowed.', { allow });
  }
  if (!isAllowedOrigin(request)) {
    return errorJson(403, 'Cross-origin requests are not allowed.');
  }
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) {
      return errorJson(err.status, err.publicMessage, err.status === 429 ? { 'retry-after': '30' } : {});
    }
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`[api] unexpected error on ${new URL(request.url).pathname}: ${e.name}: ${e.message}`);
    return errorJson(500, 'Something went wrong on the server. Please try again.');
  }
}
