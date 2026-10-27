// Smoke test for the live API. Works against the local dev server or a Vercel deployment.
//
//   node server/smokeApi.mjs                         (default: http://localhost:5173)
//   node server/smokeApi.mjs http://localhost:5183
//   node server/smokeApi.mjs https://your-app.vercel.app
//
// It sends a few good and bad requests and prints PASS/FAIL for each. It never prints secrets
// (it does not know any: it only talks to the public endpoints).
// Note: in live mode each run makes 1 /ask call + 2 /react calls (a few cents at most).

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/+$/, '');

const resident = {
  id: 42,
  name: 'Camille Martin',
  age: 34,
  sex: 'F',
  occupation: 'Professions intermédiaires',
  household: 'single_parent',
  personaFr: "Camille Martin, infirmière à Saint-Denis, élève seule sa fille et prend le RER B tous les jours.",
  imputed: { car: false, heavyCar: false, tenure: 'social_renter', nationality: 'french' },
  commuteMode: 'rer',
  districtName: 'Saint-Denis',
};
const exposure = {
  score: 3,
  reasons: [
    { code: 'near_site', text: 'Lives 600 m from the site: construction noise for 2 years', icon: 'construction', at: [[150, 40]] },
    { code: 'heat', text: 'Waste heat could raise summer night temperatures in her block', icon: 'heat' },
  ],
};
const proposalFr =
  "Construction d'un grand centre de données pour l'intelligence artificielle (250 MW) à Saint-Denis, près du Stade de France.";

const askBody = {
  scenarioId: 'datacenter_93',
  question: 'Et si le centre chauffait gratuitement les logements sociaux du quartier ?',
  resident,
  proposalFr,
  previous: { stance: -1, reasonFr: "J'ai peur du bruit pendant les travaux.", exposure },
};
const reactBody = {
  proposalFr,
  channel: 'public_meeting',
  residents: [
    { ...resident, exposure },
    { ...resident, id: 43, name: 'Karim Benali', age: 61, sex: 'M', occupation: 'Retraités', household: 'couple_no_kids',
      imputed: { car: true, heavyCar: true, tenure: 'owner', nationality: 'french' }, commuteMode: 'none',
      exposure: { score: 1, reasons: [] } },
  ],
};

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status, data };
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const health = await call('GET', '/api/health');
check('GET /api/health is 200 with ok:true', health.status === 200 && health.data?.ok === true, JSON.stringify(health.data));
const mock = health.data?.mock === true;
console.log(`      mode: ${mock ? 'MOCK (no key or DISABLE_LIVE=1)' : 'LIVE'}`);

const ask = await call('POST', '/api/ask', askBody);
check(
  'POST /api/ask returns answerFr/answerEn',
  ask.status === 200 && typeof ask.data?.answerFr === 'string' && typeof ask.data?.answerEn === 'string',
  `status=${ask.status} mock=${ask.data?.mock} model=${ask.data?.model}`,
);
if (ask.data?.answerEn) console.log(`      "${ask.data.answerEn.slice(0, 140)}"`);
if (mock) check('mock /api/ask is flagged', ask.data?.mock === true && ask.data?.answerFr.startsWith('[demo]'));

const react = await call('POST', '/api/react', reactBody);
const results = react.data?.results ?? [];
check(
  'POST /api/react returns one result per resident',
  react.status === 200 && results.length === 2 && results.every((r) => r.stance >= -2 && r.stance <= 2),
  `status=${react.status} mock=${react.data?.mock} stances=${results.map((r) => r.stance).join(',')}`,
);
if (mock) check('mock /api/react is flagged', react.data?.mock === true && results.every((r) => r.reasonFr.startsWith('[demo]')));

// ---- bad requests: all must be refused without calling the model ----
const longQuestion = { ...askBody, question: 'x'.repeat(301) };
check('question > 300 chars -> 400', (await call('POST', '/api/ask', longQuestion)).status === 400);
check('proposal > 2000 chars -> 400', (await call('POST', '/api/react', { ...reactBody, proposalFr: 'x'.repeat(2001) })).status === 400);
const six = { ...reactBody, residents: Array.from({ length: 6 }, (_, i) => ({ ...resident, id: i, exposure })) };
check('6 residents -> 400', (await call('POST', '/api/react', six)).status === 400);
check('missing resident -> 400', (await call('POST', '/api/ask', { ...askBody, resident: undefined })).status === 400);
check('stance out of range -> 400', (await call('POST', '/api/ask', { ...askBody, previous: { ...askBody.previous, stance: 5 } })).status === 400);
check('broken JSON -> 400', (await call('POST', '/api/ask', '{"question": ')).status === 400);
check('not JSON content-type -> 415', (await call('POST', '/api/ask', 'hello', { 'content-type': 'text/plain' })).status === 415);
check('GET on /api/ask -> 405', (await call('GET', '/api/ask')).status === 405);
check('cross-origin POST -> 403', (await call('POST', '/api/ask', askBody, { origin: 'https://evil.example' })).status === 403);
check('body > 64 KB -> 413', (await call('POST', '/api/react', { ...reactBody, pad: 'x'.repeat(70_000) })).status === 413);
check('unknown route -> 404', (await call('GET', '/api/does-not-exist')).status === 404);
check('helper files are not routes -> 404', (await call('GET', '/api/_lib/env')).status === 404);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
