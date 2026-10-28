# Town-in-a-Box

**Test a city proposal on 2,000 simulated Paris residents before the public consultation, and see who it touches, who would object and why, and whose voices the consultation would miss.**

Built for the Nebius x NVIDIA Global AI Hackathon (track: Best Apps and Agents) with **NVIDIA Nemotron 3** models on **Nebius Token Factory** and the **NVIDIA Nemotron-Personas-France** dataset.

> Every resident is synthetic and every text is a *simulated voice*. Results are hypotheses to check with real people, **not evidence of public opinion**.

---

## The problem: consultations hear the few

Public meetings and local votes are answered by a small, unrepresentative slice of the people they affect.

- **Meetings.** Einstein, Palmer & Glick (*Perspectives on Politics*, 2019) matched 3,327 speakers at planning meetings in 97 Massachusetts towns to voter files. Speakers were older, more often homeowners and more than twice as likely to vote as other residents. 63% of them opposed the housing proposals.
- **Paris votations.** Turnout was **7.46%** for the rental e-scooter vote (2 April 2023: 89.03% "contre") and **5.68%** for the SUV parking-fee vote (4 February 2024: 54.55% "pour").
- **Polls vs votes.** For the scooter vote, an Ifop-Fiducial poll asking the ballot question found 30% "pour". The vote gave 10.97%, a gap of **−19 points**. A consultation that listens only to the people who show up can hear a different town.

A planner cannot fix that after the fact. Town-in-a-Box rehearses the consultation first: who is affected, what they would say, who would turn up, and **whom to go and consult on purpose**.

## What it does

| Screen | What you see |
|---|---|
| **Cozy pixel-art map** | Real geography on a 264×200 grid of 100 m tiles: Paris arrondissements and the ring of suburbs (départements 75/92/93/94), the Seine and Marne, the two big woods, railways, the périphérique and landmarks. All art is original and drawn in code. |
| **The gap** (bottom chalkboard) | "If only likely participants are heard: X% support. Everyone: Y%. Gap: Z points." A toggle switches between **Everyone / Can vote / Likely to show up**; non-participants fade to ghosts on the map. |
| **One citizen's view** | Click any resident to see their home, their commute (animated path), **exactly where and how the proposal touches them** (computed, with map markers), their simulated reaction, their participation score, and what a neighbour told them. You can also ask them a follow-up question. Imputed attributes carry an "imputed" chip. |
| **Who to consult** | Groups that carry more of the computed impact than they would have voices in the room, with where they live, how to reach them, and hypotheses to test. Example: suburban drivers who work in Paris pay the SUV fee but cannot vote. |
| **Themes** | Arguments grouped into themes, with a "voices you'd miss" tag for themes that are stronger among non-participants. |
| **Backtest** | Simulated vs official result, sector by sector (17 Paris sectors), against baselines and the leakage probe. |
| **Talk** | One round of neighbour conversations (280 pairs): watch a pair talk on the map, see which arguments spread, and check whether talking makes the backtest better or worse. |
| **Your proposal** | Write any proposal (English or French), click districts or place a site, pick the channel, and run 150 residents live. |

Three ready scenarios:
1. **Hypothetical: a 200 MW AI data centre in Seine-Saint-Denis** (Rateau industrial zone, La Courneuve). Its facts are sourced from real comparable projects (Dugny, Le Bourget) and shown as rings at 500 m, 1 km and 2 km.
2. **Backtest: Paris SUV parking-fee votation** (4 Feb 2024).
3. **Backtest: Paris rental e-scooter votation** (2 Apr 2023).

## How NVIDIA and Nebius are used

| Part | What it does here |
|---|---|
| **Nemotron-Personas-France** (CC BY 4.0) | The 125,211 rows for départements 75/92/93/94 are the sampling frame. Each resident keeps its dataset persona text, age, sex, education, occupation, household and commune. |
| **Nemotron 3 Nano** (`NVIDIA-Nemotron-3-Nano-30B-A3B`) | One reaction per resident (stance −2..+2, reason in French and English, behaviour, self-rated impact, "would you take part"). Also theme assignment, persona translation, live "Ask them a question" and live custom runs. |
| **Nemotron 3 Super** (`nemotron-3-super-120b-a12b`) | The neighbour conversations, plus a second model for the uncertainty runs. |
| **Nemotron 3 Ultra** (`Nemotron-3-Ultra-550b-a55b`) | Theme discovery across all reasons, with low-participation voices weighted double. |
| **Nebius Token Factory** | All calls go to its OpenAI-compatible endpoint, from the Python pipeline (batch) and from the Vercel functions (live). Structured JSON output (strict `json_schema`, with automatic `json_object` fallback) and thinking switched off for short answers. |

**Where Token Factory speeds up the work:** about 3,900 calls per scenario run concurrently through one async client, with an RPM/TPM limiter, retries and a disk cache. Interrupted runs resume for free, and three model sizes are matched to three jobs (Nano for volume, Super for dialogue, Ultra for one synthesis call). **Measured (28 Oct 2026):** each scenario took about 3,900 calls in about 41 minutes at 95 requests per minute (the account's Nano limit is 100), with a mean latency of 1.6–1.7 s for Nano and 2.1–2.3 s for Super, 0 failed calls and 9 retries out of 11,694. Cost: $0.87–0.91 per scenario, $2.65 for all three, $2.78 including tests, the leakage probe and the persona translations. The pipeline keeps a spending ledger with a hard cap (`LLM_BUDGET_USD`); its total matched the Token Factory balance within $0.05. Per-scenario numbers: `pipeline/out/run_stats_<id>.json`.

## Architecture

```
  OFFLINE PIPELINE (Python, pipeline/)                                  WEB APP (web/)
  ───────────────────────────────────────────────────                  ─────────────────────────────────────
  geo.api.gouv.fr + OpenStreetMap ─► build_map.py ──────► map.json ──┐
                                                                      │   React UI (src/ui)  ◄─► ITownMap
  Nemotron-Personas-France (HF) ─┐                                    ├─►      │              (src/mapApi.ts)
  INSEE census 2022 ────────────┴► build_population.py               │      │                    │
      rake to INSEE, impute car/tenure/nationality,                   │      │         PixiJS pixel-art renderer
      place on building tiles ──► place_residents.py ► population.json┤      │              (src/map)
                                                                      │      │
  paris.fr open data ─► fetch_ground_truth.py ─► votations.json       │      ▼
                                                                      │   /api/react, /api/ask, /api/health
  simulate.py (per scenario):                                         │   (web/api, Vercel functions;
    1 exposure.py        COMPUTED: geography + imputed attributes     │    dev: server/devApi.ts)
    2 reactions          Nemotron 3 Nano  ─┐                          │          │
    3 participation.py   calibrated turnout │  Nebius Token Factory   │          ▼
    4 conversations.py   Nemotron 3 Super  ─┤  (OpenAI-compatible,    │   Nebius Token Factory (live runs)
    5 themes.py          Ultra + Nano      ─┘   llm.py: cache, RPM)   │   key stays server-side only
    6 uncertainty        3 paraphrases x 2 models                     │
    7 aggregate.py       views, districts, groups, who to consult     │
    8 backtest.py        sectors, baselines, leakage ───► scenarios/*.json ┘
  leakage_probe.py, verify_models.py, translate_personas.py, validate_outputs.py (contract check)
```

The data contract between Python and TypeScript is `web/src/types.ts`. `validate_outputs.py` checks every output field against it.

## Method (short)

1. **Sampling and raking.** 1,400 residents in Paris, allocated to the 20 arrondissements by INSEE adult population, and 600 in the inner-suburb communes inside the map. Communes around the data-centre site are oversampled and reweighted. Within each district, dataset rows are raked by IPF to INSEE 2022 margins (sex×occupation, sex×age, education), then drawn by systematic PPS. Paris "cadres" go from **9.7% in the dataset to 33.0%** weighted, against 32.9% in INSEE. Half of the dataset's Paris rows (30,693) have no arrondissement. They are assigned one **jointly** with occupation, age and education (P(arr)·P(occ|arr)·P(age|arr)·P(edu|arr)), never uniformly at random. Details: `pipeline/out/population_report.md`, `docs/DATASET_FEEDBACK.md`.
2. **Three kinds of facts, always labelled:**
   - **dataset**: from the NVIDIA row.
   - **imputed**: car, heavy car, housing tenure, nationality, registration, workplace and commute mode. The dataset has none of these, so they are drawn per district to match INSEE shares exactly. They carry an "imputed" chip everywhere.
   - **computed exposure**: what changes for this resident, from deterministic rules on geography and imputed attributes (`exposure.py`). Examples: distance to the site, parking zone versus workplace, heat-network radius. **The LLM never decides exposure.** It only writes the reaction, given the computed facts.
3. **Calibrated participation.** `logit(p) = logit(base) + 0.35·exposure + 0.5·(LLM self-report − 0.5) + c`. The base comes from INSEE turnout gradients (age, diploma, tenure). For public meetings, attendance also decays with distance from the site. The constant `c` is solved so that the weighted turnout matches the real one (5.68% or 7.46%) or the assumed one. The LLM's "would you take part" is only a weak rank modifier.
4. **Neighbour conversations.** 280 random pairs, not cherry-picked: homes within 300 m, otherwise the same district. Each pair has a short exchange (Super) that records stances before and after and the argument that travelled. The backtest is recomputed after talk ("does talking help?").
5. **Themes.** Ultra proposes themes from a stratified sample that double-weights low-participation residents; Nano assigns every reason to one. `missingGap` = the theme's share among non-participants minus its share among participants.
6. **Who to consult (stake vs voice).** For each group, *impact share* = its share of all computed exposure, and *voice share* = its share of the likely participants. Groups are ranked by impact share minus voice share. They include population groups and the proposal's own groups (for example, renters within 2 km of the site). Outreach channels come from a fixed rule table, and hypotheses come from the group's over-represented themes.
7. **Backtest.** Simulated "likely voters" against the official result in the 17 sectors: MAE, Pearson r, and the sign of the poll-versus-vote gap (only where the poll asked the ballot question).
   - **Baselines:** uniform poll; a pre-registered demographic rule with no LLM; the same simulation without the turnout model; and the bare model with no personas, taken from the leakage probe.
   - **Leakage probe:** Nemotron 3 pre-training runs to June–Sept 2025, after both votes. Each model is asked directly and in disguise for the result, and the verdict is shown in the Backtest tab.
8. **Uncertainty.** 3 French paraphrases × 2 models on 300 residents give a range for every headline share.

## Results

All published scenario files are live Nemotron runs on Nebius Token Factory (2,000 residents each, 28 Oct 2026).

| | SUV fee (4 Feb 2024) | E-scooters (2 Apr 2023) |
|---|---|---|
| Official result ("pour") / turnout | 54.55% / 5.68% | 10.97% / 7.46% |
| Pre-vote poll | OpinionWay 61% (different question; not comparable) | Ifop-Fiducial 30% (same question) |
| Simulated, everyone in Paris | 25.6% | 33.1% |
| Simulated, likely voters | 27.4% | 28.5% |
| Sector MAE / Pearson r (likely voters) | 27.9 pts / +0.09 | 17.2 pts / −0.27 |
| Gap sign correct (poll vs vote) | n/a (poll not comparable) | yes |
| After neighbour talk: MAE | 28.8 pts | 15.8 pts |
| Baseline: uniform poll, sector MAE | n/a | 18.8 pts |
| Baseline: bare model (Nano, no personas) | 55.0%, MAE 15.5 pts | 55.0%, MAE 43.8 pts |
| Baseline: demographic rule without LLM, sector MAE | 12.1 pts | 1.3 pts* |
| Leakage probe verdict | possible leakage | possible leakage |

\*The demographic-rule coefficients were fixed by someone who knew the city-wide results (though not the sector results), so this baseline is optimistic. It is the bar the simulation has to beat.

**What this says.** The simulation does **not** beat the demographic baseline on either vote. On the scooters it gets the direction of the turnout effect right (likely voters are less favourable than everyone, as in reality: 30% poll, 11% vote), beats the uniform poll and the bare model, and talking helps a little (MAE 17.2 → 15.8). But the level is far off: Nano, answering without "thinking", leans mildly against every proposal. The leakage probe found that Super and Ultra recall both results when asked directly; Nano, which writes the reactions, answered 55% for both votes, so it does not seem to recall them.

**How the settings were chosen (in the open).** Two choices were made after a 60-resident test on the **SUV** vote: (1) a bug fix, so the model writes its reason before its stance and "it doesn't affect me" means 0 rather than −2, and (2) keeping thinking off, as planned. Thinking on moved the same 60 residents from 32% to 100% in favour, so model settings matter more than personas, and we did not pick the setting that matched the result. The **scooter** vote was never used for any choice, so it is the cleaner test.

**Data centre (hypothetical).** 14.7% of residents in favour (range 9–64% across 3 paraphrases × 2 models), 15.4% among likely participants: on the yes/no question, the people likely to come think much like the town as a whole. The gap is in who carries the impact:

| Group | Share of computed impact | Share of likely participants |
|---|---|---|
| Young renters (18–34) | 28.1% | 9.1% |
| Neighbours within 2 km of the site | 14.4% | 7.5% |
| Renters within 2 km of the site | 10.1% | 3.9% |

The arguments that came up most were the strain on the power grid (34% of reasons) and construction nuisances (22%). Both shares above come from computed exposure and the calibrated turnout model, not from the LLM's stance; the model's own "would you take part" answer only nudges the second column.

## Limitations and responsible use

- **Synthetic people, simulated voices.** No real person is quoted or profiled. The LLM can stereotype, and the reactions are hypotheses for designing outreach, not a substitute for it.
- **Imputed attributes.** Car, tenure, nationality, registration and commute are not in the dataset. They are imputed to match INSEE shares at district level, so an individual's combination can be implausible. Nationality is never inferred from names or cultural background.
- **Dataset issues.** We found and documented several (`docs/DATASET_FEEDBACK.md`): Paris is double-sampled, arrondissements are invented in persona texts, and occupation is flat across départements.
- **Small suburban samples.** Suburban communes have 1–40 residents each; département totals are calibrated but single communes are noisy.
- **The reaction model leans.** Nano with thinking off is mildly sceptical of every proposal, and its stance barely varies with computed exposure (people next to the data-centre site are no more opposed than people far away). Treat the yes/no shares as weak; the impact-versus-voice comparison does not depend on them.
- **Leakage.** Both backtest votes predate the models' pre-training cutoff, so the backtest may be contaminated. The probe and the bare-model baseline make that visible; an out-of-sample check is future work.
- **Exposure rules are simplified** and documented in `pipeline/exposure.py`. For example, the scooter-usage probability, the 2 km heat-network radius and the unknown 225 kV route are assumptions.
- **Hypothetical site.** The data-centre site is hypothetical, only inspired by real projects, and labelled so everywhere.

## Prior work and what is new

- **CivicSim** (UC Berkeley School of Information, 2026): census-grounded personas with Pew opinion priors, stance by demographic group, validated against held-out survey data. It names "who shows up" as motivation but does not model participation, has no map and no vote backtest.
- **AGORA** (Cho & Wu, arXiv, May 2026): LLM stakeholders with profile-dependent participation rates in transit hearings. A controlled sensitivity study on benchmark networks, without real-world validation.
- **NVIDIA NeMo UserSim** (2026): population-grounded simulated users from Nemotron-Personas, built for evaluating AI agents rather than civic consultation.
- **Ask Singapore** (2026): ask a Nemotron-Personas-Singapore cohort a question and map the sentiment by planning area.

**What is new here** is the combination:
1. the **participation gap**: everyone vs likely attendees, with calibrated, empirical turnout rather than LLM self-reports;
2. a **who-to-consult** outreach plan ranked by stake vs voice;
3. a **backtest against real low-turnout votes**, with baselines and a leakage probe;
4. **seeing each citizen's computed exposure on a real map**, separated from the AI's words.

## Setup

Requirements: Python 3.11+ (built with 3.14) and Node 20.19+ or 22.12+ (tested with Node 24). Windows, macOS or Linux.

```bash
# 1. Python pipeline
python -m venv pipeline/.venv
pipeline/.venv/Scripts/python -m pip install -r pipeline/requirements.txt   # macOS/Linux: pipeline/.venv/bin/python

# 2. Rebuild the data (all steps work without an API key; mock mode)
PY=pipeline/.venv/Scripts/python
$PY pipeline/build_map.py              # uses cached downloads; --refresh to re-download
$PY pipeline/build_population.py       # downloads personas + INSEE on first run, then places residents
$PY pipeline/fetch_ground_truth.py     # --offline to use the cache
$PY pipeline/simulate.py --scenario all --mock
$PY pipeline/validate_outputs.py       # exit code 0 = contract OK

# 3. Web app
cd web
npm install
npm run dev          # http://localhost:5173 (API runs in mock mode without a key)
npm run typecheck
npm run build
```

To run with real Nemotron models, copy `.env.example` to `.env`, set `TOKEN_FACTORY_API_KEY`, and follow **[docs/RUNBOOK.md](docs/RUNBOOK.md)**. Deployment to Vercel is described in **[docs/DEPLOY.md](docs/DEPLOY.md)**. The key is only ever read server-side; never create a `VITE_`-prefixed key variable.

More docs: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) (plain English), [docs/SOURCES_GROUND_TRUTH.md](docs/SOURCES_GROUND_TRUTH.md) (votes, polls, data-centre facts), [docs/DATASET_FEEDBACK.md](docs/DATASET_FEEDBACK.md) (findings on the persona dataset).

## License and data attribution

Code: **MIT** (see `LICENSE`).

Data:
- **NVIDIA Nemotron-Personas-France**, © NVIDIA, licensed under **CC BY 4.0**: https://huggingface.co/datasets/nvidia/Nemotron-Personas-France. Persona texts are shown as they appear in the dataset (French).
- **OpenStreetMap** contributors, **ODbL**: rivers, woods, roads, railways, land use.
- **INSEE** (census 2022, IRIS files; Insee Première n°1928 and n°1929) and **geo.api.gouv.fr** (boundaries, populations), **Licence Ouverte / Etalab 2.0**.
- **Ville de Paris** (paris.fr and opendata.paris.fr): official votation results by polling station and sector, under the City's open-data licence.
- Poll figures: Ifop-Fiducial (2023), OpinionWay (2024), as cited in `docs/SOURCES_GROUND_TRUTH.md`.

All map art and character sprites are original, drawn pixel by pixel in code.
