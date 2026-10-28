// @ts-check
/**
 * Best-effort rate limiting with "token buckets" kept in memory.
 *
 * How a token bucket works: a bucket holds up to `burst` tokens and refills at `perMin` tokens
 * per minute. Every request spends tokens (1 per LLM call it causes, 0.25 for a mock answer).
 * Not enough tokens means "429 Too Many Requests", with a Retry-After header that says how many
 * seconds until there will be enough. The browser waits that long and tries again.
 *
 * Two buckets:
 *   - one per visitor (IP address), big enough for a whole "Test your own idea" run (150 calls),
 *     so one person cannot take the whole daily allowance in a minute;
 *   - one for the whole instance, which paces live calls under the account's limit
 *     (Nano: 100 requests per minute). LLM_BURST + LLM_RPM is the most it sends in any minute.
 *
 * Why "best-effort": the buckets live in the memory of ONE server instance. Vercel may run
 * several instances (or restart them), each with its own buckets. That is fine for a demo:
 * it stops a single person (or a runaway script) from burning the credits, but it is not a
 * hard guarantee. The real safety net is DISABLE_LIVE=1 plus the prepaid balance in the
 * Token Factory console.
 *
 * Settings (env vars, optional):
 *   RATE_LIMIT_BURST    tokens per IP at once (default 320: two runs of 150 residents)
 *   RATE_LIMIT_PER_MIN  tokens per IP refilled per minute (default 32: full again in 10 minutes)
 *   LLM_BURST           live LLM calls the instance may send at once (default 20)
 *   LLM_RPM             live LLM calls per minute for the whole instance after that (default 80)
 *   LIVE_DAILY_CALLS    live LLM calls per instance per day (default 1000, see takeDailyLive)
 */
import { envNumber } from './env.js';
import { HttpError, clientIp } from './http.js';

/** @typedef {{ tokens: number, updatedAt: number }} Bucket  updatedAt = ms timestamp of the last refill */

/** @type {Map<string, Bucket>} */
const perIp = new Map();
/** @type {Bucket | null} */
let globalBucket = null;
/** Live calls made today (UTC) by this instance. */
const daily = { day: '', used: 0 };

/**
 * Daily allowance of live LLM calls, so a public demo cannot drain a small prepaid balance.
 * One Nano call costs about $0.0001, so 1000 calls are about $0.10. Returns false when today's
 * allowance is used up: the caller then answers with a clearly flagged mock answer instead.
 * @param {number} llmCalls
 */
export function takeDailyLive(llmCalls) {
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) {
    daily.day = today;
    daily.used = 0;
  }
  if (daily.used + llmCalls > envNumber('LIVE_DAILY_CALLS', 1000)) return false;
  daily.used += llmCalls;
  return true;
}

/**
 * Refill a bucket for the time that passed, then try to spend `cost` tokens.
 * Returns 0 if the tokens were spent, otherwise the seconds until there will be enough.
 * @param {Bucket} bucket
 * @param {number} burst bucket size
 * @param {number} perMin refill per minute
 * @param {number} cost
 * @param {number} now
 */
function trySpend(bucket, burst, perMin, cost, now) {
  const refill = ((now - bucket.updatedAt) / 60_000) * perMin;
  bucket.tokens = Math.min(burst, bucket.tokens + refill);
  bucket.updatedAt = now;
  if (bucket.tokens < cost) return Math.ceil(((cost - bucket.tokens) / perMin) * 60);
  bucket.tokens -= cost;
  return 0;
}

/**
 * Forget idle visitors so the map cannot grow forever.
 * @param {number} burst
 * @param {number} perMin
 * @param {number} now
 */
function cleanup(burst, perMin, now) {
  if (perIp.size < 5_000) return;
  for (const [ip, bucket] of perIp) {
    const idleMinutes = (now - bucket.updatedAt) / 60_000;
    if (bucket.tokens + idleMinutes * perMin >= burst) perIp.delete(ip);
  }
}

/**
 * Spend tokens for this request or throw a 429.
 * @param {Request} request
 * @param {number} llmCalls how many live LLM calls this request will make (0 in mock mode)
 */
export function rateLimit(request, llmCalls) {
  const now = Date.now();
  const ipBurst = envNumber('RATE_LIMIT_BURST', 320);
  const ipPerMin = envNumber('RATE_LIMIT_PER_MIN', 32);
  // Live: 1 token per LLM call (capped at the bucket size, or it could never be paid).
  // Mock answers are free to produce, so they cost only a quarter token: enough for clicking
  // around, still stops a flood.
  const cost = llmCalls > 0 ? Math.min(llmCalls, ipBurst) : 0.25;

  const ip = clientIp(request);
  let bucket = perIp.get(ip);
  if (!bucket) {
    bucket = { tokens: ipBurst, updatedAt: now };
    perIp.set(ip, bucket);
  }
  const ipWait = trySpend(bucket, ipBurst, ipPerMin, cost, now);
  if (ipWait > 0) {
    throw new HttpError(429, 'Too many requests from your connection. Please wait a few minutes and try again.', ipWait);
  }

  if (llmCalls > 0) {
    const burst = envNumber('LLM_BURST', 20);
    const perMin = envNumber('LLM_RPM', 80);
    globalBucket ??= { tokens: burst, updatedAt: now };
    const wait = trySpend(globalBucket, burst, perMin, Math.min(llmCalls, burst), now);
    if (wait > 0) {
      // Give the visitor their tokens back: it was not their fault.
      bucket.tokens = Math.min(ipBurst, bucket.tokens + cost);
      throw new HttpError(429, 'The live demo is busy right now. Please try again in a minute.', wait);
    }
  }
  cleanup(ipBurst, ipPerMin, now);
}
