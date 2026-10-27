# Runbook: from demo data to real Nemotron results

These are the exact commands to run once you have a Nebius Token Factory API key. They are written for **Windows PowerShell**; Git Bash versions are at the end. Run them from the repo root:

```powershell
cd "C:\Users\Alexander\IdeaProjects\Hackathon Project"
$PY = "C:\Users\Alexander\IdeaProjects\Hackathon Project\pipeline\.venv\Scripts\python.exe"
$env:PYTHONIOENCODING = "utf-8"   # so accented names print correctly
```

Total time is about 3.5 hours at 60 requests per minute (less if your account allows more), most of it unattended. The estimated cost is about $3.50, using prices that are **not verified**; check your console.

---

## Step 0. Put the key in `.env` (2 minutes)

1. Open the file `.env` in the repo root (`notepad .env`).
2. Paste your key after `TOKEN_FACTORY_API_KEY=`, with no spaces and no quotes.
3. From your Token Factory console, copy your rate limits into `LLM_RPM` (requests per minute) and `LLM_TPM` (tokens per minute). For `LLM_CONCURRENCY`, start with `8`.
4. Save the file.

Never paste the key anywhere else: not in code, not in a chat, and never in a variable whose name starts with `VITE_`. `.env` is git-ignored.

## Step 1. Check the key and the model names (1 minute, almost free)

```powershell
& $PY pipeline\verify_models.py --ping
```

Expected: the three model IDs are listed as found, and each ping answers in JSON.
- **A model is "not found"**: copy the exact ID from the Token Factory model list into `MODEL_REACTION`, `MODEL_CONVERSATION` or `MODEL_SYNTHESIS` in `.env`, then run the command again.
- **It says a JSON format or "thinking" setting was rejected**: nothing to do. The client switches to a fallback automatically. If it recommends a setting such as `LLM_EXTRA_BODY` or `LLM_SYSTEM_SUFFIX`, add that line to `.env`.

## Step 2. Leakage probe (2 minutes, 12 calls)

This asks each model, without any persona, what the official result of each vote was: once directly, once disguised as a hypothetical vote.

```powershell
& $PY pipeline\leakage_probe.py
```

It writes `pipeline\out\leakage.json`. The next simulation run copies it into the Backtest tab ("leakage check") and into the "bare model" baseline. **Run this before Step 4.**

## Step 3. Small live test (3 minutes, about $0.05)

This uses 60 residents and writes to `pipeline\out\dev\`, so the published files are not touched.

```powershell
& $PY pipeline\simulate.py --scenario paris_suv_2024 --live --n 60 --pairs 10 --uncertainty-n 20
```

The first line it prints must say `LIVE` (not `MOCK`), and the run should report 0 failed calls. Then open `pipeline\out\dev\scenarios_subsample\paris_suv_2024.json` in a text editor and search for `reasonEn`. Read a few: they should not start with `[demo]`, and they should make sense for the resident (do not run the validator on this test folder; it expects all 2,000 residents).

## Step 4. Full live runs (about 65 minutes and $1.10 each, at 60 RPM)

Run one scenario at a time, so you can check each before starting the next:

```powershell
& $PY pipeline\simulate.py --scenario saint_denis_datacenter --live
& $PY pipeline\simulate.py --scenario paris_suv_2024 --live
& $PY pipeline\simulate.py --scenario paris_scooters_2023 --live
```

Or run all three in one go (about 3.2 hours, about $3.30):

```powershell
& $PY pipeline\simulate.py --scenario all --live
```

- **Interrupted?** Run the same command again. Every answer is cached in `pipeline\out\cache\`, so a re-run only pays for the calls that are missing.
- **Short on time?** Add `--uncertainty-n 150 --pairs 200` to save about 40 minutes. The ranges get a little wider.
- **Your RPM limit is higher than 60?** Raise `LLM_RPM`, `LLM_TPM` and `LLM_CONCURRENCY` in `.env`. At 300 RPM a scenario takes about 15 minutes.
- The real token counts, cost and latency for each scenario are written to `pipeline\out\run_stats_<scenario>.json`. Put them in the README ("Where Token Factory speeds up the work").

## Step 5. English persona lines (5 minutes, about 200 calls)

```powershell
& $PY pipeline\translate_personas.py
```

This fills `personaEn` in `web\public\data\population.json`. Translations are also saved in `pipeline\out\cache\persona_en.json`. If you ever rebuild the population, re-apply them for free with `& $PY pipeline\translate_personas.py --apply-cache`.

## Step 6. Validate (seconds)

```powershell
& $PY pipeline\validate_outputs.py
```

It must end with `ALL OK`. It also checks that live files have no `[demo]` text and contain no key.

## Step 7. Look at it locally, then build

```powershell
cd web
npm run dev
```

Open http://localhost:5173. The ribbon "Demo data — real Nemotron results pending" should be gone. Click around: the data centre, the SUV backtest (Backtest tab, leakage check), a resident card, "Ask them a question" (now a real answer) and "Test your own idea". Stop the server with Ctrl+C, then:

```powershell
npm run typecheck
npm run build
cd ..
```

Both must finish without errors.

## Step 8. Fill in the README results

In `README.md`, replace every *pending live run* with the numbers from the app's Backtest tab or from the scenario files:
- `web\public\data\scenarios\paris_suv_2024.json` → `backtest.simulated`, `backtest.metrics`, `backtestAfterTalk.metrics`, `backtest.leakage.verdict`
- same for `paris_scooters_2023.json`
- for the data centre, `aggregates.views` and the first entries of `consult`

Keep the honest caveats (leakage, the optimistic demographic baseline).

## Step 9. Deploy

Follow `docs\DEPLOY.md`: GitHub (public repo, check that `.env` is **not** committed), Vercel import with Root Directory = `web`, add `TOKEN_FACTORY_API_KEY` as a server-side environment variable, Redeploy, then open `/api/health` (expect `"mock":false`) and `/api/health?check=1`.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| `HTTP 401` | The key is wrong or expired. Paste it again in `.env` (no spaces or quotes). |
| `HTTP 404` or "model not found" | Wrong model ID. Run Step 1 and copy the exact IDs into `MODEL_*` in `.env`. |
| Many `429` / "rate limited" lines | Lower `LLM_RPM` and `LLM_CONCURRENCY` in `.env`, then run the same command again. The cache keeps what is already done. |
| Answers are cut off, or JSON errors | The client retries with more tokens and falls back to simpler JSON mode by itself. If a scenario still reports failed calls, run the same command again. |
| The output still says `MOCK` | The key was not found: check that the line is exactly `TOKEN_FACTORY_API_KEY=...` in the repo-root `.env`. |
| `validate_outputs.py` reports errors | Copy the first error lines and ask Claude to fix them. Do not edit the JSON by hand. |
| Accented names print as `?` | Run `$env:PYTHONIOENCODING = "utf-8"` first. |
| You changed `.env` while `npm run dev` was running | Stop it (Ctrl+C) and start it again. |
| You want to redo a scenario from scratch | Delete `pipeline\out\cache\` (this costs the calls again), then re-run Step 4. |
| Live costs run high on the website | On Vercel, set `DISABLE_LIVE=1` and Redeploy. The site keeps working with the precomputed results (see DEPLOY.md, section 5). |

## Git Bash versions

```bash
cd "/c/Users/Alexander/IdeaProjects/Hackathon Project"
PY="pipeline/.venv/Scripts/python.exe"; export PYTHONIOENCODING=utf-8
$PY pipeline/verify_models.py --ping
$PY pipeline/leakage_probe.py
$PY pipeline/simulate.py --scenario paris_suv_2024 --live --n 60 --pairs 10 --uncertainty-n 20
$PY pipeline/simulate.py --scenario all --live
$PY pipeline/translate_personas.py
$PY pipeline/validate_outputs.py
cd web && npm run typecheck && npm run build
```

## Rebuilding everything without a key (for reference)

```bash
$PY pipeline/build_map.py            # map (cached downloads)
$PY pipeline/build_population.py     # population + placement (cached downloads)
$PY pipeline/fetch_ground_truth.py --offline
$PY pipeline/simulate.py --scenario all --mock
$PY pipeline/validate_outputs.py
```
