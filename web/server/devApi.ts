/**
 * Local development only: makes `npm run dev` (vite) serve the same /api endpoints that Vercel
 * serves in production, using the SAME files in web/api/*.js.
 *
 *   browser -> http://localhost:5173/api/health -> this plugin -> web/api/health.js -> Response
 *
 * How it works:
 *  1. On startup we read the repo-root .env (Vite `envDir: '..'`) and copy the server-side
 *     variables (everything NOT starting with VITE_) into process.env of the dev server.
 *     They never reach the browser: Vite only exposes VITE_* variables to client code.
 *  2. For each /api/<name> request we load web/api/<name>.js through Vite (ssrLoadModule, so
 *     edits are picked up without restarting the server), turn the Node request
 *     into a web-standard Request, call the module's `default.fetch(request)` (or its named
 *     GET/POST export), and copy the Response back.
 *
 * Only plain route names are served (/api/health, /api/ask, /api/react). Helper files in
 * web/api/_lib/ are never reachable, exactly like on Vercel.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin, type ViteDevServer } from 'vite';

/** Dev-side cap on request bodies; the endpoints themselves enforce the real (smaller) limit. */
const DEV_MAX_BODY_BYTES = 1024 * 1024;

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * Names of the variables WE copied from .env into process.env. Kept on globalThis because Vite
 * re-creates this plugin when it restarts (e.g. after a config change) but the process stays.
 */
const INJECTED = Symbol.for('town-in-a-box.devApi.injectedEnvKeys');
const store = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const injectedKeys: Set<string> = (store[INJECTED] ??= new Set<string>());

/** Copy non-VITE_ variables from the .env file(s) into process.env (values are never printed). */
function loadServerEnv(mode: string, envDir: string | false): { loaded: number; hasKey: boolean } {
  // Forget what we injected last time, so edits to .env are picked up on every (re)start.
  for (const key of injectedKeys) delete process.env[key];
  injectedKeys.clear();
  if (envDir !== false) {
    const fileEnv = loadEnv(mode, envDir, ''); // '' = all variables, server side only
    for (const [key, value] of Object.entries(fileEnv)) {
      if (key.startsWith('VITE_')) continue; // browser variables are Vite's business
      if (process.env[key] !== undefined) continue; // a real environment variable wins
      process.env[key] = value;
      injectedKeys.add(key);
    }
  }
  const hasKey = (process.env.TOKEN_FACTORY_API_KEY ?? '').trim() !== '';
  return { loaded: injectedKeys.size, hasKey };
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
}

/** Read the raw request body (or null if it is too large). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > DEV_MAX_BODY_BYTES) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Node IncomingMessage -> web-standard Request (what Vercel gives our handlers). */
async function toWebRequest(req: IncomingMessage, originalUrl: string): Promise<Request | null> {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(originalUrl, `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }
  // Like Vercel: the platform (not the client) says who the caller is.
  headers.set('x-real-ip', req.socket.remoteAddress ?? 'unknown');

  const method = (req.method ?? 'GET').toUpperCase();
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readBody(req);
    if (raw === null) return null;
    body = new Uint8Array(raw); // plain bytes, accepted by both Node and DOM typings
  }
  return new Request(url, { method, headers, body });
}

/** web-standard Response -> Node ServerResponse. */
async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function handleApi(server: ViteDevServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Connect strips the "/api" mount prefix from req.url; originalUrl keeps the full path.
  const originalUrl = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const pathname = new URL(req.url ?? '/', 'http://x').pathname; // e.g. "/health"
  const name = pathname.replace(/^\/+|\/+$/g, '');

  // Only simple names: no "_lib", no "..", no sub-folders. Like Vercel, api/<name>.js or .ts.
  const ext = /^[a-z][a-z0-9-]*$/.test(name)
    ? ['.js', '.ts'].find((e) => fs.existsSync(path.join(server.config.root, 'api', `${name}${e}`)))
    : undefined;
  if (!ext) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  const mod = await server.ssrLoadModule(`/api/${name}${ext}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const handler: Handler | undefined =
    typeof mod.default?.fetch === 'function'
      ? (r) => mod.default.fetch(r)
      : typeof mod[method] === 'function'
        ? (mod[method] as Handler)
        : undefined;
  if (!handler) {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const request = await toWebRequest(req, originalUrl);
  if (request === null) {
    sendJson(res, 413, { error: 'Request body is too large.' });
    return;
  }
  await sendWebResponse(res, await handler(request));
}

/** The Vite plugin. Added in web/vite.config.ts. Active only for `vite` / `vite dev`. */
export function devApi(): Plugin {
  return {
    name: 'town-in-a-box-dev-api',
    apply: 'serve',
    configureServer(server) {
      const { loaded, hasKey } = loadServerEnv(server.config.mode, server.config.envDir);
      server.config.logger.info(
        `[dev-api] /api/* -> web/api/*.js | ${loaded} server-side env vars loaded (values hidden) | ` +
          (hasKey ? 'TOKEN_FACTORY_API_KEY is set: live mode (unless DISABLE_LIVE=1)' : 'no TOKEN_FACTORY_API_KEY: mock mode'),
      );

      server.middlewares.use('/api', (req, res) => {
        handleApi(server, req, res).catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          server.ssrFixStacktrace(e);
          server.config.logger.error(`[dev-api] ${req.url}: ${e.stack ?? e.message}`);
          if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server. Please try again.' });
          else res.end();
        });
      });
    },
  };
}
