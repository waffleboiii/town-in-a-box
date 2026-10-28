// @ts-check
/**
 * Best-effort rate limiting with "token buckets" kept in memory.
 *
 * How a token bucket works: each visitor (IP address) has a bucket that holds up to N tokens
 * and refills at N tokens per minute. Every request spends tokens (1 per LLM call it causes,
 * 0.25 for a mock answer). An empty bucket means "429 Too Many Requests, wait a bit".
 *
 * Why "best-effort": the buckets live in the memory of ONE server instance. Vercel may run
 * several instances (or restart them), each with its own buckets. That is fine for a demo:
 * it stops a single person (or a runaway script) from burning the credits, but it is not a
 * hard guarantee. The real safety net is DISABLE_LIVE=1 plus the spending limit you set in
 * the Token Factory console.
 *
 * Settings (env vars, optional):
 *   RATE_LIMIT_PER_MIN  tokens per IP per minute (default 20)
 *   LLM_RPM             live LLM calls per minute for the whole instance (default 60)
 *   LIVE_DAILY_CALLS    live LLM calls per instance per day (default 250, see takeDailyLive)
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
 * 250 Nano calls cost roughly $0.05-0.20. Returns false when today's allowance is used up:
 * the caller then answers with a clearly flagged mock answer instead of calling the model.
 * @param {number} llmCalls
 */
export function takeDailyLive(llmCalls) {
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) {
    daily.day = today;
    daily.used = 0;
  }
  if (daily.used + llmCalls > envNumber('LIVE_DAILY_CALLS', 250)) return false;
  daily.used += llmCalls;
  return true;
}

/**
 * Refill a bucket for the time that passed, then try to spend `cost` tokens.
 * @param {Bucket} bucket
 * @param {number} capacityPerMin
 * @param {number} cost
 * @param {number} now
 */
function trySpend(bucket, capacityPerMin, cost, now) {
  const refill = ((now - bucket.updatedAt) / 60_000) * capacityPerMin;
  bucket.tokens = Math.min(capacityPerMin, bucket.tokens + refill);
  bucket.updatedAt = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

/**
 * Forget idle visitors so the map cannot grow forever.
 * @param {number} capacityPerMin
 * @param {number} now
 */
function cleanup(capacityPerMin, now) {
  if (perIp.size < 5_000) return;
  for (const [ip, bucket] of perIp) {
    const idleMinutes = (now - bucket.updatedAt) / 60_000;
    if (bucket.tokens + idleMinutes * capacityPerMin >= capacityPerMin) perIp.delete(ip);
  }
}

/**
 * Spend tokens for this request or throw a 429.
 * @param {Request} request
 * @param {number} llmCalls how many live LLM calls this request will make (0 in mock mode)
 */
export function rateLimit(request, llmCalls) {
  const now = Date.now();
  const perIpPerMin = envNumber('RATE_LIMIT_PER_MIN', 20);
  // Live: 1 token per LLM call (capped at the bucket size, or it could never be paid).
  // Mock answers are free to produce, so they cost only a quarter token (80 per minute by default):
  // enough for clicking around, still stops a flood.
  const cost = llmCalls > 0 ? Math.min(llmCalls, perIpPerMin) : 0.25;

  const ip = clientIp(request);
  let bucket = perIp.get(ip);
  if (!bucket) {
    bucket = { tokens: perIpPerMin, updatedAt: now };
    perIp.set(ip, bucket);
  }
  if (!trySpend(bucket, perIpPerMin, cost, now)) {
    throw new HttpError(429, 'Too many requests from your connection. Please wait a minute and try again.');
  }

  if (llmCalls > 0) {
    const globalPerMin = envNumber('LLM_RPM', 60);
    globalBucket ??= { tokens: globalPerMin, updatedAt: now };
    if (!trySpend(globalBucket, globalPerMin, Math.min(llmCalls, globalPerMin), now)) {
      // Give the visitor their tokens back: it was not their fault.
      bucket.tokens = Math.min(perIpPerMin, bucket.tokens + cost);
      throw new HttpError(429, 'The live demo is busy right now. Please try again in a minute.');
    }
  }
  cleanup(perIpPerMin, now);
}
