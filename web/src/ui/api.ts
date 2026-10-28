/**
 * Browser side of the live API (web/api). The API key never reaches the browser:
 * these calls go to our own /api endpoints, which talk to Nebius Token Factory.
 *
 * If the API cannot be reached at all (for example a static preview without the server),
 * we answer with simple in-browser demo heuristics, clearly flagged mock: true.
 */
import type { ApiHealth, AskRequest, AskResponse, ReactRequest, ReactResponse } from '../types';
import { clamp, hashString, makeRng } from './random';

export class ApiError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    /** Set on a 429: how long the server asked us to wait (Retry-After). */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True once we have fallen back to in-browser demo answers. */
let apiOffline = false;

export function isApiOffline(): boolean {
  return apiOffline;
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T | 'offline'> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 404 || res.status === 405 || type.includes('text/html')) return 'offline';
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* empty or broken body */
    }
    if (!res.ok) {
      const body = data as { error?: unknown } | null;
      const msg = typeof body?.error === 'string' && body.error ? body.error : `Server answered ${res.status}`;
      const retryAfterSec = Number(res.headers.get('retry-after'));
      const retryAfterMs = res.status === 429 && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined;
      throw new ApiError(msg, res.status === 429 || res.status >= 500, retryAfterMs);
    }
    return data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal?.aborted) throw new ApiError('Cancelled', false);
    if (ctrl.signal.aborted) throw new ApiError('The AI took too long to answer (timeout).', true);
    // Network error: the API is not running here.
    return 'offline';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function getHealth(): Promise<ApiHealth | null> {
  try {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null;
    return (await res.json()) as ApiHealth;
  } catch {
    return null;
  }
}

export async function askResident(req: AskRequest, signal?: AbortSignal): Promise<AskResponse> {
  const out = await postJson<AskResponse>('/api/ask', req, 45_000, signal);
  if (out === 'offline') {
    apiOffline = true;
    return mockAsk(req);
  }
  return out;
}

/** Longest we wait in total for the server's rate limit before giving up on a batch. */
const MAX_RATE_WAIT_MS = 120_000;

/** Wait `ms`, or stop early (and throw) if the run is cancelled. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError('Cancelled', false));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError('Cancelled', false));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One batch (max 5 residents). On a rate limit (429) it waits as long as the server asks
 * and tries again, for up to 2 minutes: the server paces live calls under the account limit.
 * Retries once on a timeout or server error.
 */
export async function reactBatch(req: ReactRequest, signal?: AbortSignal): Promise<ReactResponse> {
  let errorRetries = 0;
  let waited = 0;
  for (;;) {
    try {
      const out = await postJson<ReactResponse>('/api/react', req, 60_000, signal);
      if (out === 'offline') {
        apiOffline = true;
        return mockReact(req);
      }
      return out;
    } catch (err) {
      if (!(err instanceof ApiError) || !err.retryable) throw err;
      if (err.retryAfterMs !== undefined) {
        // A little jitter so parallel batches do not all come back at the same moment.
        const ms = clamp(err.retryAfterMs, 1000, 30_000) + Math.random() * 400;
        if (waited + ms > MAX_RATE_WAIT_MS) throw err;
        waited += ms;
        await pause(ms, signal);
        continue;
      }
      if (errorRetries++ > 0) throw err;
      await pause(1500, signal);
    }
  }
}

/** Run async jobs with at most `limit` in flight. */
export async function runPool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

// ---------- in-browser demo answers (no AI) ----------

const MOCK_MODEL = 'in-browser demo heuristic (no AI)';

function mockReact(req: ReactRequest): ReactResponse {
  const results = req.residents.map((r) => {
    const rng = makeRng(hashString(`${req.proposalFr}|${r.id}`));
    const e = r.exposure.score;
    // Demo rule of thumb: people touched a lot are more often against; others lean mildly for.
    let s = (rng() - 0.45) * 3 - (e >= 3 ? 1.1 : e === 2 ? 0.4 : 0) + (r.age < 35 ? 0.4 : r.age > 65 ? -0.4 : 0);
    s = clamp(Math.round(s), -2, 2);
    const stance = s as -2 | -1 | 0 | 1 | 2;
    const near = e >= 2;
    const fr =
      stance > 0
        ? near
          ? 'Ça va changer mon quartier, mais plutôt en bien si c’est bien fait.'
          : 'Sur le principe, je trouve que c’est une bonne idée.'
        : stance < 0
          ? near
            ? 'C’est juste à côté de chez moi : je crains le bruit et les travaux.'
            : 'Je ne vois pas à qui ça profite vraiment.'
          : 'Je n’ai pas vraiment d’avis, ça ne me concerne pas beaucoup.';
    const en =
      stance > 0
        ? near
          ? 'It will change my area, but for the better if it’s done well.'
          : 'In principle I think it’s a good idea.'
        : stance < 0
          ? near
            ? 'It’s right next to my home: I worry about noise and works.'
            : 'I don’t see who really benefits.'
          : 'I don’t really have an opinion; it doesn’t concern me much.';
    return {
      id: r.id,
      stance,
      affectedLLM: clamp(e + (rng() < 0.3 ? -1 : 0), 0, 3) as 0 | 1 | 2 | 3,
      behaviourEn: stance < 0 && near ? 'Would go to the public meeting to object.' : stance > 0 ? 'Would say yes if asked, but not go out of their way.' : 'Would probably not take part.',
      reasonFr: fr,
      reasonEn: en,
      wouldParticipateLLM: Math.round(clamp(0.15 + 0.15 * Math.abs(stance) + 0.12 * e + (rng() - 0.5) * 0.2, 0, 1) * 100) / 100,
    };
  });
  return { results, model: MOCK_MODEL, mock: true };
}

function mockAsk(req: AskRequest): AskResponse {
  const s = req.previous.stance;
  const fr =
    s > 0
      ? `Je reste plutôt favorable. Ce qui compte pour moi, c’est la vie de tous les jours à ${req.resident.districtName}.`
      : s < 0
        ? `Honnêtement, ça ne me ferait pas changer d’avis. Il faudrait des garanties concrètes pour ${req.resident.districtName}.`
        : 'Je ne sais pas trop. Il me faudrait plus d’informations pour me décider.';
  const en =
    s > 0
      ? `I’m still rather in favour. What matters to me is everyday life in ${req.resident.districtName}.`
      : s < 0
        ? `Honestly, that wouldn’t change my mind. I’d need concrete guarantees for ${req.resident.districtName}.`
        : 'I’m not sure. I would need more information to decide.';
  return { answerFr: fr, answerEn: en, model: MOCK_MODEL, mock: true };
}
