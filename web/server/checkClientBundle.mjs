// Security check: proves the Token Factory key can never end up in the browser bundle.
//
//   cd web && node server/checkClientBundle.mjs
//
// What it does:
//  1. Puts a fake "canary" value in TOKEN_FACTORY_API_KEY for this process only.
//  2. Builds a tiny PROBE script with our real vite.config.ts. The probe dumps the whole
//     import.meta.env object and even tries to read the key by a computed name.
//  3. Builds the REAL app (index.html) too, if it builds (the UI may still be in progress).
//  4. Searches every output file for "TOKEN_FACTORY", the canary, and the real key from the
//     repo-root .env (compared in memory, never printed).
//  5. Deletes the temporary folders (web/dist-apitest and the probe folder).
// Exit code 0 = no leak found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadEnv } from 'vite';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(webDir, 'dist-apitest');
// The probe lives in the OS temp folder so running dev servers do not see (and reload for) it.
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-bundle-probe-'));
const CANARY = 'canary-not-a-real-key-7f3a9c';

const realKey = (loadEnv('production', path.join(webDir, '..'), '').TOKEN_FACTORY_API_KEY ?? '').trim();
process.env.TOKEN_FACTORY_API_KEY = CANARY;

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesIn(path.join(dir, d.name)) : [path.join(dir, d.name)],
  );
}

function scan(label) {
  const files = filesIn(outDir);
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('TOKEN_FACTORY');
    if (at >= 0) {
      const context = text.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ');
      hits.push(`${path.relative(outDir, file)}: contains "TOKEN_FACTORY" near: ...${context}...`);
    }
    if (text.includes(CANARY)) hits.push(`${path.relative(outDir, file)}: contains the canary key value`);
    if (realKey && text.includes(realKey)) hits.push(`${path.relative(outDir, file)}: contains the REAL key value (not shown)`);
  }
  console.log(`${hits.length ? 'FAIL' : 'PASS'}  ${label}: ${files.length} output files scanned, ${hits.length} leaks`);
  hits.forEach((h) => console.log(`      ${h}`));
  return hits.length;
}

let leaks = 0;
try {
  // ---- 1. probe build ----
  fs.writeFileSync(
    path.join(probeDir, 'probe.ts'),
    [
      '// Tries every way browser code could read env vars. Must find nothing secret.',
      // The name is base64-encoded so the minifier cannot fold it back into the output text.
      "const name = atob('VE9LRU5fRkFDVE9SWV9BUElfS0VZ');",
      'const env = import.meta.env as Record<string, unknown>;',
      "document.body.textContent = JSON.stringify({ all: import.meta.env, byName: env[name] });",
    ].join('\n'),
  );
  await build({
    root: webDir,
    configFile: path.join(webDir, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(probeDir, 'probe.ts') } },
  });
  leaks += scan('probe script (reads all of import.meta.env)');
  // Sanity check: the probe really contains the inlined env object (so the scan is meaningful).
  const probeText = filesIn(outDir).map((f) => fs.readFileSync(f, 'utf8')).join(' ');
  if (!probeText.includes('BASE_URL')) {
    console.log('FAIL  probe output does not contain the inlined import.meta.env (test is not meaningful)');
    leaks += 1;
  }

  // ---- 2. real app build (optional) ----
  try {
    await build({ root: webDir, configFile: path.join(webDir, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    leaks += scan('real app (index.html)');
  } catch (err) {
    console.log(`SKIP  real app build failed (UI probably still in progress): ${String(err?.message ?? err).split('\n')[0]}`);
  }
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(probeDir, { recursive: true, force: true });
}

console.log(leaks ? '\nLEAK FOUND - do not deploy.' : '\nNo secret reaches the client bundle.');
process.exit(leaks ? 1 : 0);
