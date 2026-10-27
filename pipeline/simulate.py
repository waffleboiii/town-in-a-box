"""Run the Town-in-a-Box simulation for one or all scenarios.

    python pipeline/simulate.py --scenario all --mock          # no API key needed (deterministic demo outputs)
    python pipeline/simulate.py --scenario paris_suv_2024 --live
    python pipeline/simulate.py --scenario all --dev --mock     # on the dev fixtures in pipeline/out/dev/
    python pipeline/simulate.py --estimate --n 2000             # time/cost estimate for a live run

Steps for each scenario:
  1. exposure      computed rules (exposure.py) — not the LLM
  2. reactions     one LLM call per resident (reaction model, Nano), using prompts.json 'profile' + 'reaction'
  3. participation calibrated turnout model (participation.py)
  4. conversations one round of neighbour pairs (conversation model, Super) (conversations.py)
  5. themes        discovered by the synthesis model (Ultra), assigned by Nano (themes.py)
  6. uncertainty   K=3 proposal paraphrases x 2 models on a subsample -> yesRange (runs alongside 4-5)
  7. aggregates    views, districts, groups, who-to-consult (aggregate.py), backtest (backtest.py)
Outputs: web/public/data/scenarios/<id>.json + index.json (or pipeline/out/dev/scenarios/ for dev runs),
pipeline/out/run_stats_<id>.json. Every LLM answer is cached (pipeline/out/cache/), so re-runs resume for free.
"""
from __future__ import annotations

import argparse
import asyncio
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from aggregate import (by_district, by_group, compute_views, consult_recs, scenario_groups, uncertainty_ranges,
                       with_scenario_groups)
from backtest import compute_backtest, compute_backtest_after_talk
from common import OUT, SHARED, WEB_DATA, read_json, write_json
from conversations import DEFAULT_PAIRS, conversation_summary, run_conversations
from exposure import GeoContext, compute_exposure, exposure_prompt_text, place, public_exposure, template_words
from llm import LLMClient, fill, gather_progress, load_settings, stable_seed
from participation import in_scope, method_note, run_participation
from scenarios import CHANNEL_FR, OFFICIAL_FALLBACK, ScenarioDef, build_scenarios, mock_reaction
from themes import assign_themes, discover_themes, theme_stats

DEV = OUT / "dev"
ORDER = ["saint_denis_datacenter", "paris_suv_2024", "paris_scooters_2023"]
REACTION_TEMPERATURE = 0.8
REACTION_MAX_TOKENS = 500
UNCERTAINTY_K = 3  # proposal paraphrases
DISCLAIMER = ("Every text is a simulated voice generated for a synthetic resident, never a real person. Results are "
              "hypotheses to test, not evidence of public opinion.")


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def load_inputs(dev: bool):
    real_pop, real_map = WEB_DATA / "population.json", WEB_DATA / "map.json"
    if not dev and not (real_pop.exists() and real_map.exists()):
        print("  real inputs (web/public/data/population.json + map.json) not found -> using dev fixtures")
        dev = True
    if dev:
        if not (DEV / "population.json").exists():
            import importlib.util
            spec = importlib.util.spec_from_file_location("make_fixtures", DEV / "make_fixtures.py")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod.main()
        return read_json(DEV / "population.json"), read_json(DEV / "map.json"), DEV / "votations.json", True
    return read_json(real_pop), read_json(real_map), None, False


def load_extras(dev: bool, pop: dict) -> dict:
    """Optional fields from pipeline/out/population_full.json (pipeline only):
    longer dataset text per resident (returned) and participationPropensity (attached to the
    in-memory resident as '_propensity'; never written to outputs)."""
    p = OUT / "population_full.json"
    if dev or not p.exists():
        return {}
    try:
        full = read_json(p)
    except Exception:
        return {}
    rows = full.get("residents", full) if isinstance(full, dict) else full
    by_uuid = {r["uuid"]: r for r in pop["residents"]}
    out = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        target = by_uuid.get(row.get("uuid"))
        if target is not None and row.get("participationPropensity") is not None:
            target["_propensity"] = float(row["participationPropensity"])
        prof = (row.get("professionalPersonaFr") or row.get("professional_persona")
                or row.get("professionalPersona") or "")
        cult = (row.get("culturalBackgroundFr") or row.get("cultural_background")
                or row.get("culturalBackground") or "")
        text = " ".join(x.strip() for x in (prof, cult) if x).strip()
        if not text:
            continue
        if len(text) > 600:
            text = text[:600].rsplit(" ", 1)[0] + "…"
        key = row.get("id", row.get("uuid"))
        out[key] = text
        if row.get("uuid"):
            out[row["uuid"]] = text
    return out


# ---------------------------------------------------------------------------
# Profiles (prompts.json 'profile')
# ---------------------------------------------------------------------------

def build_profile(r: dict, ctx: GeoContext, prompts: dict, extras: dict) -> str:
    vals = prompts["profile"]["values"]
    d = ctx.districts.get(r["districtIdx"], {})
    n = ctx.arr_number(r["districtIdx"])
    district_name = (f"Paris {'1er' if n == 1 else f'{n}e'}" if n
                     else f"{d.get('name', '?')}, {vals['deptFr'].get(d.get('dept', ''), '')}")
    imp = r["imputed"]
    car = "heavy" if imp["heavyCar"] else "light" if imp["car"] else "none"
    commute = vals["commuteFr"].get(r["commuteMode"], r["commuteMode"])
    if r.get("workDistrictIdx") and r["commuteMode"] != "none":
        wd = ctx.districts.get(r["workDistrictIdx"], {})
        wn = ctx.arr_number(r["workDistrictIdx"])
        commute += f" vers {('Paris ' + ('1er' if wn == 1 else f'{wn}e')) if wn else wd.get('name', '')}"
    occ = vals["occupationFr"].get(r["occupation"], {}).get(r["sex"], r["occupation"])
    extra = extras.get(r["id"]) or extras.get(r.get("uuid")) or ""
    return fill(prompts["profile"]["template"], {
        "name": r["name"], "age": r["age"], "sexFr": vals["sexFr"].get(r["sex"], ""), "occupation": occ,
        "householdRaw": r["householdRaw"], "districtName": district_name,
        "tenureFr": vals["tenureFr"].get(imp["tenure"], ""), "carFr": vals["carFr"][car], "commuteFr": commute,
        "personaFr": r["personaFr"], "extra": ("\nPlus de détails : " + extra) if extra else "",
    })


# ---------------------------------------------------------------------------
# Reactions
# ---------------------------------------------------------------------------

def _normalise_reaction(d: dict) -> dict:
    return {
        "stance": int(max(-2, min(2, int(d["stance"])))),
        "affectedLLM": int(max(0, min(3, int(d["affected"])))),
        "behaviourEn": str(d["behaviour_en"]).strip(),
        "reasonFr": str(d["reason_fr"]).strip(),
        "reasonEn": str(d["reason_en"]).strip(),
        "wouldParticipateLLM": round(float(max(0.0, min(1.0, float(d["would_participate"])))), 3),
    }


async def run_reactions(llm, sdef: ScenarioDef, residents, exposures, profiles, prompts, ctx, *, paraphrase: int,
                        model: str, model_tag: str, label: str) -> tuple[dict, int]:
    tpl = prompts["reaction"]
    channel = CHANNEL_FR[sdef.channel]

    async def one(r):
        exp = exposures[r["id"]]
        user = fill(tpl["user"], {"profile": profiles[r["id"]],
                                  "exposure": exposure_prompt_text(exp, in_scope(r, sdef), sdef, ctx.is_paris(r["districtIdx"])),
                                  "proposal": sdef.paraphrasesFr[paraphrase], "channel": channel})
        words = template_words(r, ctx, sdef)
        data = await llm.chat_json(
            model=model, messages=[{"role": "system", "content": tpl["system"]}, {"role": "user", "content": user}],
            schema=tpl["schema"], schema_name="reaction", temperature=REACTION_TEMPERATURE,
            max_tokens=REACTION_MAX_TOKENS, seed=stable_seed("react", sdef.id, r["id"], paraphrase),
            task="reaction" if label == "reactions" else "uncertainty",
            mock=lambda: mock_reaction(sdef, r, exp, words, paraphrase, model_tag))
        return _normalise_reaction(data)

    res = await gather_progress([one(r) for r in residents], label)
    out, failed = {}, 0
    for r, x in zip(residents, res):
        if isinstance(x, Exception):
            failed += 1
            out[r["id"]] = {"stance": 0, "affectedLLM": 0, "behaviourEn": "", "reasonFr": "(pas de réponse du modèle)",
                            "reasonEn": "(no answer from the model)", "wouldParticipateLLM": 0.5, "_failed": True}
        else:
            out[r["id"]] = x
    if failed:
        print(f"    {label}: {failed} failed (kept as neutral, flagged in notes)")
    return out, failed


# ---------------------------------------------------------------------------
# One scenario
# ---------------------------------------------------------------------------

async def run_scenario(sdef: ScenarioDef, pop: dict, ctx: GeoContext, args, extras: dict, prompts: dict,
                       out_dir: Path, leakage: dict | None, stats_suffix: str) -> dict:
    t0 = time.time()
    residents = pop["residents"]
    if args.n and args.n < len(residents):
        rng = random.Random(f"subsample-{args.n}")
        residents = sorted(rng.sample(residents, args.n), key=lambda r: r["id"])
    by_id = {r["id"]: r for r in residents}
    notes: list[str] = [DISCLAIMER]

    async with LLMClient(mock=args.mock) as llm:
        s = llm.settings
        mock = llm.mock
        print(f"\n== {sdef.id} ({'MOCK' if mock else 'LIVE'}) — {len(residents)} residents")

        # 1. exposure (deterministic)
        exposures = {r["id"]: compute_exposure(r, ctx, sdef) for r in residents}
        profiles = {r["id"]: build_profile(r, ctx, prompts, extras) for r in residents}

        # 2. reactions
        reactions, failed = await run_reactions(llm, sdef, residents, exposures, profiles, prompts, ctx, paraphrase=0,
                                                model=s.model_reaction, model_tag="main", label="reactions")
        if failed:
            notes.append(f"{failed} reaction calls failed and were kept as neutral with no reason.")

        # 3. participation
        part_all = run_participation(residents, exposures, reactions, sdef)
        part = part_all["byId"]
        notes.append(method_note(part_all["info"], sdef))

        # 4-6. conversations + themes, and uncertainty runs in parallel
        async def talk_and_themes():
            convs = []
            if not args.skip_conversations:
                convs = await run_conversations(llm, sdef, by_id, reactions, profiles, lambda i: place(ctx, i), prompts,
                                                s.model_conversation, n_pairs=min(args.pairs, len(residents) // 3))
            themes = await discover_themes(llm, sdef, residents, reactions, part, prompts, s.model_synthesis)
            items = [(f"r{r['id']}", reactions[r["id"]]["reasonEn"]) for r in residents]
            items += [(f"c{c['id']}", c["keyArgumentEn"]) for c in convs]
            assigned = await assign_themes(llm, themes, items, prompts, s.model_reaction)
            return convs, themes, assigned

        async def uncertainty():
            if args.skip_uncertainty:
                return {}
            rng = random.Random(f"uncertainty-{sdef.id}")
            sub = sorted(rng.sample(residents, min(args.uncertainty_n, len(residents))), key=lambda r: r["id"])
            runs: dict[int, list[int]] = {r["id"]: [] for r in sub}
            for k in range(UNCERTAINTY_K):
                for model, tag in ((s.model_reaction, "main"), (s.model_conversation, "alt")):
                    if k == 0 and tag == "main":
                        got = {r["id"]: reactions[r["id"]] for r in sub}  # the main run itself
                    else:
                        got, _ = await run_reactions(llm, sdef, sub, exposures, profiles, prompts, ctx, paraphrase=k,
                                                     model=model, model_tag=tag, label=f"uncertainty p{k}/{tag}")
                    for r in sub:
                        runs[r["id"]].append(got[r["id"]]["stance"])
            return runs

        (convs, themes_def, assigned), run_stances = await asyncio.gather(talk_and_themes(), uncertainty())

        # stances after talk
        stance = {i: reactions[i]["stance"] for i in by_id}
        stance_after = dict(stance)
        talked: dict[int, list[int]] = {}
        for c in convs:
            stance_after[c["a"]] = c["stanceAfter"]["a"]
            stance_after[c["b"]] = c["stanceAfter"]["b"]
            talked.setdefault(c["a"], []).append(c["b"])
            talked.setdefault(c["b"], []).append(c["a"])
        res_theme = {int(k[1:]): v for k, v in assigned.items() if k.startswith("r")}
        conv_theme = {k[1:]: v for k, v in assigned.items() if k.startswith("c")}

        # 7. aggregates
        views = compute_views(residents, stance, part)
        if run_stances:
            ranges = uncertainty_ranges(residents, run_stances, stance, part, views)
            views = compute_views(residents, stance, part, ranges)
        # Population groups + scenario groups (computed exposure / geography, e.g. renters near the site).
        extra_groups = scenario_groups(sdef, residents, exposures, ctx)
        group_defs = pop.get("groups", []) + [{k: g[k] for k in ("id", "label", "description")} for g in extra_groups]
        residents_g = with_scenario_groups(residents, extra_groups)
        group_aggs = by_group(residents_g, stance, part, exposures, group_defs)
        themes = theme_stats(themes_def, residents, reactions, part, res_theme)
        consult = consult_recs(residents_g, stance, part, exposures, group_aggs, group_defs, res_theme,
                               themes, ctx, scenario_group_ids={g["id"] for g in extra_groups})
        aggregates = {"views": views, "byDistrict": by_district(residents, stance, part, exposures), "byGroup": group_aggs}
        if convs:
            aggregates["viewsAfterTalk"] = compute_views(residents, stance_after, part)
            cs = conversation_summary(convs)
            spread = {}
            for c in convs:
                t = conv_theme.get(c["id"])
                if t:
                    spread[t] = spread.get(t, 0) + 1
            top = sorted(spread.items(), key=lambda x: -x[1])[:3]
            label = {t["id"]: t["label"] for t in themes}
            notes.append(f"Neighbour talk: {cs['pairs']} random pairs ({cs['neighbourPairs']} within 300 m, the rest in the "
                         f"same district); {cs['residentsChanged']} of {cs['residentsTalked']} residents changed stance. "
                         f"Arguments that travelled most: " + "; ".join(f"{label.get(t, t)} ({n})" for t, n in top) + ".")

        scenario = {
            "version": 1, "id": sdef.id, "title": sdef.title, "titleFr": sdef.titleFr, "summary": sdef.summary,
            "proposalFr": sdef.proposalFr, "proposalEn": sdef.proposalEn, "kind": sdef.kind,
            **({"date": sdef.date} if sdef.date else {}),
            "channel": sdef.channel, "turnoutTarget": sdef.turnoutTarget, "voterScope": sdef.voterScope,
        }
        if sdef.site:
            scenario["site"] = sdef.site
        if sdef.zone == "paris":
            scenario["zoneDistricts"] = ctx.paris_idxs
        elif sdef.zone == "host" and sdef.site:
            host = ctx.district_at(sdef.site["x"], sdef.site["y"])
            if host:
                scenario["zoneDistricts"] = [host]
        models = {"reaction": s.model_reaction, "conversation": s.model_conversation, "synthesis": s.model_synthesis}
        if mock:
            models = {k: f"mock (would use {v})" for k, v in models.items()}
        if args.skip_conversations:
            models.pop("conversation")
        scenario.update({"mock": mock, "models": models, "generatedAt": datetime.now(timezone.utc).isoformat()})

        # Results, in population order
        results = []
        for r in residents:
            i = r["id"]
            x = reactions[i]
            rr = {"id": i, "exposure": public_exposure(exposures[i]), "stance": x["stance"]}
            if i in talked:
                rr["stanceAfter"] = stance_after[i]
            rr.update({"affectedLLM": x["affectedLLM"], "behaviourEn": x["behaviourEn"], "reasonFr": x["reasonFr"],
                       "reasonEn": x["reasonEn"], "wouldParticipateLLM": x["wouldParticipateLLM"],
                       "participationScore": part[i]["participationScore"], "eligible": part[i]["eligible"],
                       "attendee": part[i]["attendee"]})
            if i in res_theme:
                rr["themeId"] = res_theme[i]
            if i in talked:
                rr["talkedWith"] = talked[i]
            if i in run_stances:
                rr["runStances"] = run_stances[i]
            results.append(rr)
        public_convs = []
        for c in convs:
            pc = {k: c[k] for k in ("id", "a", "b", "where", "lines", "stanceBefore", "stanceAfter")}
            if conv_theme.get(c["id"]):
                pc["themeId"] = conv_theme[c["id"]]
            public_convs.append(pc)
        scenario.update({"results": results, "conversations": public_convs, "aggregates": aggregates,
                         "themes": themes, "consult": consult})
        if extra_groups:
            scenario["extraGroups"] = extra_groups

        if sdef.kind == "backtest":
            bt, bt_notes = compute_backtest(sdef, residents, stance, part, ctx, leakage, OFFICIAL_FALLBACK[sdef.id])
            scenario["backtest"] = bt
            notes += bt_notes
            if convs:
                scenario["backtestAfterTalk"] = compute_backtest_after_talk(sdef, residents, stance_after, part, ctx,
                                                                           OFFICIAL_FALLBACK[sdef.id])
                before, after = bt["metrics"]["sectorMae"], scenario["backtestAfterTalk"]["metrics"]["sectorMae"]
                notes.append(f"Does talking help? Sector MAE {before:.3f} before talk vs {after:.3f} after "
                             f"({'more' if after < before else 'less' if after > before else 'equally'} accurate).")
            notes.append("Backtest rules: participation coefficients, turnout target (= official turnout) and the "
                         "demographic baseline were fixed before comparing with sector results; nothing is tuned on the "
                         "vote being predicted.")
        unc_method = ("none (skipped)" if not run_stances else
                      f"K={UNCERTAINTY_K} proposal paraphrases × 2 models ({s.model_reaction.split('/')[-1]}, "
                      f"{s.model_conversation.split('/')[-1]}) on a random {len(run_stances)}-resident subsample; yesRange = "
                      f"full-sample yes share shifted by the min/max deviation of the runs from the main run on that subsample"
                      + (" (MOCK: seeded noise, not real model variation)" if mock else ""))
        scenario["uncertainty"] = {"method": unc_method, "runs": (UNCERTAINTY_K * 2) if run_stances else 1}
        notes += sdef.notes
        notes.append("Imputed attributes (car, heavy car, tenure, nationality, workplace) come from INSEE statistics, "
                     "not from the NVIDIA dataset, and are labelled as imputed.")
        if mock:
            notes.insert(0, "MOCK RUN: no language model was called (no API key). Stances and texts come from simple "
                            "deterministic heuristics and templates marked [demo]/[démo].")
        if args.n and args.n < len(pop["residents"]):
            notes.append(f"Run on a random subsample of {len(residents)} of {len(pop['residents'])} residents.")
        scenario["notes"] = notes

        write_json(out_dir / f"{sdef.id}.json", scenario)
        # Runs with --out keep their stats next to their outputs, so test runs never overwrite the real ones.
        stats_dir = out_dir if args.out else OUT
        stats = llm.write_stats(stats_dir / f"run_stats_{sdef.id}{stats_suffix}.json")

    summary = {"id": sdef.id, "views": views, "wall_s": round(time.time() - t0, 1), "stats": stats,
               "attendeesDisplayed": part_all["info"]["displayedAttendees"], "conversations": len(convs),
               "themes": len(themes), "backtest": scenario.get("backtest"), "after": scenario.get("backtestAfterTalk")}
    return summary


def index_entry(sdef: ScenarioDef, mock: bool) -> dict:
    e = {"id": sdef.id, "title": sdef.title, "subtitle": sdef.subtitle, "kind": sdef.kind, "icon": sdef.icon}
    if sdef.date:
        e["date"] = sdef.date
    e["mock"] = mock
    return e


def write_index(out_dir: Path, scen: dict[str, ScenarioDef]):
    entries = []
    for sid in ORDER:
        p = out_dir / f"{sid}.json"
        if p.exists():
            mock = read_json(p).get("mock", True)
            entries.append(index_entry(scen[sid], mock))
    write_json(out_dir / "index.json", entries, compact=False)
    return entries


def print_summary(s: dict):
    v = s["views"]
    st = s["stats"]
    print(f"  views yes-share: everyone {v['everyone']['yesShare']:.1%} | eligible {v['eligible']['yesShare']:.1%} | "
          f"attendees {v['attendees']['yesShare']:.1%}  (gap attendees-everyone {v['attendees']['yesShare'] - v['everyone']['yesShare']:+.1%})")
    if "yesRange" in v["everyone"]:
        print(f"  yesRange everyone {v['everyone']['yesRange']}, attendees {v['attendees'].get('yesRange')}")
    print(f"  attendees shown on map: {s['attendeesDisplayed']}, conversations: {s['conversations']}, themes: {s['themes']}")
    bt = s.get("backtest")
    if bt:
        m = bt["metrics"]
        print(f"  backtest: actual {bt['actual']['yesShare']:.1%} vs sim attendees {bt['simulated']['attendeesYes']:.1%} "
              f"(everyone {bt['simulated']['everyoneYes']:.1%}); sector MAE {m['sectorMae']:.3f}, r {m['sectorCorrelation']:+.2f}"
              + (f", gap sign {'OK' if m.get('gapSignCorrect') else 'wrong'}" if "gapSignCorrect" in m else ""))
        for b in bt["baselines"]:
            print(f"    baseline {b['name']}: {b['yesShare']:.1%}, MAE {b.get('sectorMae', float('nan')):.3f}")
        if s.get("after"):
            print(f"  after talk: sector MAE {s['after']['metrics']['sectorMae']:.3f}, r {s['after']['metrics']['sectorCorrelation']:+.2f}")
    tok_in = sum(m["prompt_tokens"] for m in st["models"].values())
    tok_out = sum(m["completion_tokens"] for m in st["models"].values())
    est_in = sum(m["est_prompt_tokens"] for m in st["models"].values())
    est_out = sum(m["est_completion_tokens"] for m in st["models"].values())
    if st["mock"]:
        print(f"  requests {st['requests_total']} (mock) — estimated live: ~{est_in:,} in / {est_out:,} out tokens, "
              f"~${st['mock_estimated_live_cost_usd_total']:.2f}, ~{st['estimated_live_minutes_at_rpm']:.0f} min at {st['rpm']} RPM")
    else:
        print(f"  requests {st['requests_total']}, tokens {tok_in:,} in / {tok_out:,} out, cost ${st['cost_usd_total']:.3f} "
              f"(unverified prices), wall-clock {s['wall_s']:.0f}s")


def estimate(n: int, pairs: int, unc_n: int):
    """Back-of-envelope live run estimate (token sizes measured from the prompts of a mock run)."""
    s = load_settings()
    per = {  # calls, input tokens, output tokens, model
        "reactions": (n, 1100, 220, s.model_reaction),
        "uncertainty (Nano)": (2 * unc_n, 1100, 220, s.model_reaction),
        "uncertainty (Super)": (3 * unc_n, 1100, 220, s.model_conversation),
        "conversations": (pairs, 1500, 650, s.model_conversation),
        "theme discovery": (1, 7000, 1200, s.model_synthesis),
        "theme assignment": ((n + pairs + 19) // 20, 1200, 400, s.model_reaction),
    }
    from llm import price_for
    tot_calls = tot_cost = 0
    print(f"Estimate per scenario for N={n}, {pairs} pairs, uncertainty subsample {unc_n} (thinking disabled):")
    for k, (c, i, o, m) in per.items():
        pin, pout = price_for(m, s.prices)
        cost = c * (i * pin + o * pout) / 1e6
        tot_calls += c
        tot_cost += cost
        print(f"  {k:22s} {c:5d} calls  ~${cost:.2f}  ({m.split('/')[-1]})")
    print(f"  total per scenario: {tot_calls} calls, ~${tot_cost:.2f}, ~{tot_calls / s.rpm:.0f} min at {s.rpm} RPM")
    print(f"  all 3 scenarios: {3 * tot_calls} calls, ~${3 * tot_cost:.2f}, ~{3 * tot_calls / s.rpm / 60:.1f} h at {s.rpm} RPM "
          f"(plus 12 leakage-probe calls). Prices are unverified defaults.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", default="all", help="all | " + " | ".join(ORDER))
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--mock", action="store_true", help="no API calls (default when no key in .env)")
    g.add_argument("--live", action="store_true", help="call Token Factory (needs TOKEN_FACTORY_API_KEY)")
    ap.add_argument("--dev", action="store_true", help="use the dev fixtures in pipeline/out/dev/")
    ap.add_argument("--n", type=int, default=0, help="run on a random subsample of N residents (testing)")
    ap.add_argument("--pairs", type=int, default=DEFAULT_PAIRS, help="number of neighbour conversations")
    ap.add_argument("--uncertainty-n", type=int, default=300, help="subsample size for the uncertainty runs")
    ap.add_argument("--skip-conversations", action="store_true")
    ap.add_argument("--skip-uncertainty", action="store_true")
    ap.add_argument("--out", type=str, default="", help="output folder (default: web/public/data/scenarios for a full real run; pipeline/out/dev/scenarios* for dev or --n runs)")
    ap.add_argument("--estimate", action="store_true", help="print a live time/cost estimate and exit")
    args = ap.parse_args()

    if args.estimate:
        estimate(args.n or 2000, args.pairs, args.uncertainty_n)
        return
    settings = load_settings()
    if args.live and not settings.has_key:
        print("--live needs TOKEN_FACTORY_API_KEY in the repo-root .env (never commit it).")
        sys.exit(1)
    if not args.live:
        args.mock = args.mock or not settings.has_key
    else:
        args.mock = False

    pop, mp, votations_path, dev = load_inputs(args.dev)
    subsample = bool(args.n and args.n < len(pop["residents"]))
    # Only a full run on the real population is published to the web app; test runs stay in pipeline/out/dev/.
    if args.out:
        out_dir = Path(args.out)
    elif subsample:
        out_dir = DEV / ("scenarios_fixture_subsample" if dev else "scenarios_subsample")
    else:
        out_dir = DEV / "scenarios" if dev else WEB_DATA / "scenarios"
    stats_suffix = "_dev" if (dev or subsample) else ""
    ctx = GeoContext.from_map(mp)
    prompts = read_json(SHARED / "prompts.json")
    extras = load_extras(dev, pop)
    scen = build_scenarios(votations_path)
    leak_path = OUT / "leakage.json"
    leakage = read_json(leak_path) if leak_path.exists() else None
    ids = ORDER if args.scenario == "all" else [args.scenario]
    for sid in ids:
        if sid not in scen:
            print(f"unknown scenario {sid}; choose from {ORDER}")
            sys.exit(1)
    print(f"Town-in-a-Box simulation — {'MOCK' if args.mock else 'LIVE'} — {len(pop['residents'])} residents "
          f"({'dev fixtures' if dev else 'real population'}) -> {out_dir}")
    if extras:
        print(f"  using longer persona text for {len(extras)} keys from population_full.json")
    t0 = time.time()
    for sid in ids:
        s = asyncio.run(run_scenario(scen[sid], pop, ctx, args, extras, prompts, out_dir, leakage, stats_suffix))
        print_summary(s)
    entries = write_index(out_dir, scen)
    print(f"\nindex.json: {[e['id'] for e in entries]}  — total wall-clock {time.time() - t0:.1f}s")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
