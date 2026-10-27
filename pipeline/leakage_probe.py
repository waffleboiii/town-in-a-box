"""Leakage probe: do the models already KNOW the backtest results?

Nemotron 3 pretraining reportedly ends around June 2025 — after both Paris votations (2023, 2024).
If a model simply remembers "89% voted against scooters", a good backtest proves little. So, for
each vote and each model, with NO persona, we ask:
  - direct:    "What was the official result of the vote of <date> on <topic>?"
  - disguised: the same question framed as a hypothetical vote to estimate.
Results go to pipeline/out/leakage.json; simulate.py copies a summary into Scenario.backtest.leakage
and uses the reaction model's disguised estimate as the "bare model" baseline.

Usage:
  python pipeline/leakage_probe.py          (needs TOKEN_FACTORY_API_KEY in .env)
  python pipeline/leakage_probe.py --mock   (tests the code path; writes pipeline/out/dev/leakage_mock.json)
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone

from common import OUT, SHARED, read_json, write_json
from llm import MOCK_EN, LLMClient, fill, seeded_rng
from scenarios import OFFICIAL_FALLBACK, build_scenarios

QUESTIONS = {
    "paris_suv_2024": {
        "direct": ("What was the official result of the Paris 'votation citoyenne' held on 4 February 2024 on creating a "
                   "specific parking rate for heavy, bulky, polluting individual cars (often described as an SUV parking "
                   "fee)? What share of valid votes was 'Pour', and what was the turnout?"),
        "disguised": ("Imagine the city of Paris asks its registered voters, in a Sunday citizens' vote with no other "
                      "election on the ballot, 'Pour ou contre la création d'un tarif spécifique pour le stationnement des "
                      "voitures individuelles lourdes, encombrantes, polluantes ?' — visitors' cars of 1.6 t or more "
                      "(2 t for electric) would pay triple for on-street parking (€18/h in the centre, €12/h elsewhere); "
                      "residents are exempt in their own zone. Estimate the 'Pour' share among valid votes and the turnout."),
    },
    "paris_scooters_2023": {
        "direct": ("What was the official result of the Paris 'votation citoyenne' held on 2 April 2023 on self-service "
                   "(rental) e-scooters? What share of valid votes was 'Pour' (keep them), and what was the turnout?"),
        "disguised": ("Imagine the city of Paris asks its registered voters, in a Sunday citizens' vote with no other "
                      "election on the ballot, 'Pour ou contre les trottinettes en libre-service ?' — 'Pour' means keeping "
                      "the ~15,000 rental e-scooters, 'Contre' means removing them. Estimate the 'Pour' share among valid "
                      "votes and the turnout."),
    },
}


def mock_probe(vote_id: str, model: str, variant: str) -> dict:
    rng = seeded_rng("leak", vote_id, model, variant)
    return {"knows": False, "yes_share": round(rng.uniform(0.2, 0.6), 3), "turnout": round(rng.uniform(0.05, 0.3), 3),
            "answer": MOCK_EN + "Mock answer — no model was called."}


def verdict_for(actual_yes: float, probes: list[dict]) -> tuple[str, str]:
    """Return (verdict, notes) from the probe answers. Threshold: within 5 percentage points."""
    direct_hits = [p for p in probes if p["variant"] == "direct" and p["knows"] and abs(p["yesShare"] - actual_yes) <= 0.05]
    disguised_hits = [p for p in probes if p["variant"] == "disguised" and abs(p["yesShare"] - actual_yes) <= 0.05]
    if direct_hits:
        names = ", ".join(sorted({p["model"].split("/")[-1] for p in direct_hits}))
        return ("possible leakage", f"{names} recalled a result within 5 points of the official {actual_yes:.0%} when asked "
                                    "directly. Treat the backtest as weaker evidence for these models.")
    if disguised_hits:
        names = ", ".join(sorted({p["model"].split("/")[-1] for p in disguised_hits}))
        return ("unclear", f"No model recalled the result directly, but {names} estimated within 5 points of "
                           f"{actual_yes:.0%} from the disguised question (general knowledge or partial leakage).")
    return ("no evidence of memorisation", "No model recalled or estimated the result within 5 points of the official "
                                           f"{actual_yes:.0%}.")


async def probe(mock: bool) -> dict:
    prompts = read_json(SHARED / "prompts.json")
    scen = build_scenarios()
    out = {"generatedAt": datetime.now(timezone.utc).isoformat(), "mock": mock, "probed": not mock, "votes": {}}
    async with LLMClient(mock=mock) as llm:
        s = llm.settings
        models = [s.model_reaction, s.model_conversation, s.model_synthesis]
        out["models"] = models
        for vote_id, qs in QUESTIONS.items():
            gt = scen[vote_id].backtest or {}
            actual_yes = gt.get("yes") if gt.get("yes") is not None else OFFICIAL_FALLBACK[vote_id]["yes"]
            probes = []
            for model in models:
                for variant, q in qs.items():
                    tpl = prompts["leakage_direct" if variant == "direct" else "leakage_disguised"]
                    try:
                        data = await llm.chat_json(
                            model=model,
                            messages=[{"role": "system", "content": tpl["system"]},
                                      {"role": "user", "content": fill(tpl["user"], {"question": q})}],
                            schema=tpl["schema"], schema_name="probe", temperature=0.0, max_tokens=400,
                            task="leakage", mock=lambda v=vote_id, m=model, var=variant: mock_probe(v, m, var))
                    except Exception as e:  # keep probing the other models
                        print(f"  {vote_id} {model} {variant}: failed ({e})")
                        continue
                    probes.append({"model": model, "variant": variant, "knows": bool(data["knows"]),
                                   "yesShare": float(data["yes_share"]), "turnout": float(data["turnout"]),
                                   "answer": data["answer"]})
            verdict, notes = verdict_for(actual_yes, probes)
            bare = next((p for p in probes if p["model"] == s.model_reaction and p["variant"] == "disguised"), None)
            out["votes"][vote_id] = {
                "actualYes": actual_yes, "probes": probes, "verdict": verdict, "notes": notes,
                "bareModel": {"model": bare["model"], "yesShare": bare["yesShare"]} if bare else None,
                "bareModelAnswer": (f"{bare['model'].split('/')[-1]} (disguised, no persona): {bare['yesShare']:.0%} 'Pour', "
                                    f"turnout {bare['turnout']:.0%} — {bare['answer']}") if bare else "",
            }
        stats = llm.write_stats(OUT / ("dev/run_stats_leakage_mock.json" if mock else "run_stats_leakage.json"))
    out["costUsd"] = stats["cost_usd_total"]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mock", action="store_true", help="no API calls; writes pipeline/out/dev/leakage_mock.json")
    args = ap.parse_args()
    from llm import load_settings
    if not args.mock and not load_settings().has_key:
        print("TOKEN_FACTORY_API_KEY is not set in .env — the leakage probe needs the real models. Use --mock to test the code path.")
        sys.exit(1)
    res = asyncio.run(probe(args.mock))
    path = OUT / ("dev/leakage_mock.json" if args.mock else "leakage.json")
    write_json(path, res, compact=False)
    for vid, v in res["votes"].items():
        print(f"{vid}: {v['verdict']} — {v['notes']}")
    print(f"written {path}")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
