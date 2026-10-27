"""Check scenario outputs against the TypeScript data contract (web/src/types.ts), field by field.

    python pipeline/validate_outputs.py            # web/public/data/scenarios + population.json + map.json
    python pipeline/validate_outputs.py --dev      # pipeline/out/dev/scenarios + dev fixtures

Checks: required keys and types, enums, numeric ranges, unknown keys (warnings), ids matching the
population, attendees/eligibility consistency, turnout calibration, theme/quote/conversation
references, tiles inside the grid, [demo] prefixes on every text when mock: true (and none when
mock: false), and no secret values in the files.
Exit code 1 if any error.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from common import OUT, WEB_DATA, env, read_json

# ---------------------------------------------------------------------------
# A tiny type language mirroring web/src/types.ts
# ---------------------------------------------------------------------------


class T:
    def __init__(self, kind, **kw):
        self.kind, self.kw = kind, kw


S = T("str")
B = T("bool")


def N(lo=None, hi=None):
    return T("num", lo=lo, hi=hi)


def I(lo=None, hi=None):  # noqa: E743
    return T("int", lo=lo, hi=hi)


def E(*vals):
    return T("enum", vals=vals)


def A(item):
    return T("arr", item=item)


def TUP(n, item):
    return T("tuple", n=n, item=item)


def O(fields: dict, optional: tuple = ()):  # noqa: E741
    return T("obj", fields=fields, optional=set(optional))


def REC(keys, item):
    return T("rec", keys=keys, item=item)


ICONS = E("car", "home", "noise", "heat", "job", "tax", "water", "power", "scooter", "walk", "park", "money",
          "construction", "none")
STANCE = I(-2, 2)
SHARE = N(0, 1)
XY = TUP(2, N())

VIEW_AGG = O({"n": I(0), "support": SHARE, "oppose": SHARE, "neutral": SHARE, "yesShare": SHARE,
              "meanStance": N(-2, 2), "yesRange": TUP(2, SHARE)}, optional=("yesRange",))
VIEWS = REC(("everyone", "eligible", "attendees"), VIEW_AGG)
REASON = O({"code": S, "text": S, "icon": ICONS, "at": A(XY)}, optional=("at",))
RESULT = O({
    "id": I(0), "exposure": O({"score": I(0, 3), "reasons": A(REASON)}), "stance": STANCE, "stanceAfter": STANCE,
    "affectedLLM": I(0, 3), "behaviourEn": S, "reasonFr": S, "reasonEn": S, "wouldParticipateLLM": SHARE,
    "participationScore": SHARE, "eligible": B, "attendee": B, "themeId": S, "talkedWith": A(I(0)),
    "runStances": A(N(-2, 2)),
}, optional=("stanceAfter", "themeId", "talkedWith", "runStances"))
CONVERSATION = O({
    "id": S, "a": I(0), "b": I(0), "where": XY, "lines": A(O({"speaker": I(0), "fr": S, "en": S})),
    "stanceBefore": O({"a": N(-2, 2), "b": N(-2, 2)}), "stanceAfter": O({"a": N(-2, 2), "b": N(-2, 2)}), "themeId": S,
}, optional=("themeId",))
DISTRICT_AGG = O({"districtIdx": I(1), "n": I(0), "everyone": VIEW_AGG, "attendees": VIEW_AGG, "meanExposure": N(0, 3)})
GROUP_AGG = O({"groupId": S, "label": S, "n": I(0), "everyone": VIEW_AGG, "representationRatio": N(0),
               "meanExposure": N(0, 3)})
THEME = O({"id": S, "label": S, "labelFr": S, "side": E("support", "oppose", "mixed"), "share": SHARE,
           "missingGap": N(-1, 1), "quoteIds": A(I(0))}, optional=("labelFr",))
CONSULT = O({"groupId": S, "label": S, "why": S, "meanExposure": N(0, 3), "representationRatio": N(0),
             "impactShare": SHARE, "voiceShare": SHARE,
             "districts": A(I(0)), "channels": A(S), "hypotheses": A(S)}, optional=("impactShare", "voiceShare"))
SECTOR = O({"sector": S, "districtIdxs": A(I(1)), "actualYes": SHARE, "actualTurnout": SHARE,
            "simEveryoneYes": SHARE, "simAttendeesYes": SHARE}, optional=("actualTurnout",))
SIMULATED = O({"everyoneYes": SHARE, "eligibleYes": SHARE, "attendeesYes": SHARE})
METRICS = O({"sectorMae": N(0, 1), "sectorCorrelation": N(-1, 1), "gapSignCorrect": B}, optional=("gapSignCorrect",))
BACKTEST = O({
    "voteName": S, "date": S, "question": S, "sources": A(O({"name": S, "url": S})),
    "actual": O({"yesShare": SHARE, "turnout": SHARE}),
    "poll": O({"org": S, "date": S, "n": N(0), "yesShare": SHARE, "url": S, "note": S}, optional=("n", "note")),
    "simulated": SIMULATED, "bySector": A(SECTOR), "metrics": METRICS,
    "baselines": A(O({"name": S, "description": S, "yesShare": SHARE, "sectorMae": N(0, 1)}, optional=("sectorMae",))),
    "leakage": O({"probed": B, "bareModelAnswer": S, "verdict": S, "notes": S}, optional=("bareModelAnswer", "verdict")),
}, optional=("poll",))
SCENARIO = O({
    "version": E(1), "id": S, "title": S, "titleFr": S, "summary": S, "proposalFr": S, "proposalEn": S,
    "kind": E("backtest", "hypothetical", "custom"), "date": S,
    "channel": E("votation", "public_meeting", "online_consultation"), "turnoutTarget": SHARE,
    "voterScope": E("paris_eligible", "all_residents"),
    "site": O({"lon": N(), "lat": N(), "x": N(), "y": N(), "label": S, "ringsTiles": A(N(0))}),
    "zoneDistricts": A(I(1)), "mock": B,
    "models": O({"reaction": S, "conversation": S, "synthesis": S}, optional=("conversation", "synthesis")),
    "generatedAt": S, "results": A(RESULT), "conversations": A(CONVERSATION),
    "aggregates": O({"views": VIEWS, "viewsAfterTalk": VIEWS, "byDistrict": A(DISTRICT_AGG), "byGroup": A(GROUP_AGG)},
                    optional=("viewsAfterTalk",)),
    "themes": A(THEME), "consult": A(CONSULT),
    "extraGroups": A(O({"id": S, "label": S, "description": S, "memberIds": A(I(0))})), "backtest": BACKTEST,
    "backtestAfterTalk": O({"simulated": SIMULATED, "bySector": A(SECTOR), "metrics": METRICS}),
    "uncertainty": O({"method": S, "runs": N(0)}), "notes": A(S),
}, optional=("date", "site", "zoneDistricts", "extraGroups", "backtest", "backtestAfterTalk"))
INDEX_ENTRY = O({"id": S, "title": S, "subtitle": S, "kind": E("backtest", "hypothetical", "custom"), "icon": S,
                 "date": S, "mock": B}, optional=("date",))


def check(v, t: T, path: str, errs: list, warns: list, max_errs=60):
    if len(errs) > max_errs:
        return
    k = t.kind
    if k == "str":
        if not isinstance(v, str):
            errs.append(f"{path}: expected string, got {type(v).__name__}")
    elif k == "bool":
        if not isinstance(v, bool):
            errs.append(f"{path}: expected boolean")
    elif k in ("num", "int"):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            errs.append(f"{path}: expected number, got {type(v).__name__}")
            return
        if k == "int" and not (isinstance(v, int) or float(v).is_integer()):
            errs.append(f"{path}: expected integer, got {v}")
        if v != v:
            errs.append(f"{path}: NaN")
        lo, hi = t.kw.get("lo"), t.kw.get("hi")
        if lo is not None and v < lo - 1e-9:
            errs.append(f"{path}: {v} < {lo}")
        if hi is not None and v > hi + 1e-9:
            errs.append(f"{path}: {v} > {hi}")
    elif k == "enum":
        if v not in t.kw["vals"]:
            errs.append(f"{path}: {v!r} not in {t.kw['vals']}")
    elif k in ("arr", "tuple"):
        if not isinstance(v, list):
            errs.append(f"{path}: expected array")
            return
        if k == "tuple" and len(v) != t.kw["n"]:
            errs.append(f"{path}: expected {t.kw['n']} items, got {len(v)}")
        for i, x in enumerate(v):
            check(x, t.kw["item"], f"{path}[{i}]", errs, warns)
    elif k == "rec":
        if not isinstance(v, dict):
            errs.append(f"{path}: expected object")
            return
        for key in t.kw["keys"]:
            if key not in v:
                errs.append(f"{path}.{key}: missing")
            else:
                check(v[key], t.kw["item"], f"{path}.{key}", errs, warns)
    elif k == "obj":
        if not isinstance(v, dict):
            errs.append(f"{path}: expected object")
            return
        for name, sub in t.kw["fields"].items():
            if name not in v:
                if name not in t.kw["optional"]:
                    errs.append(f"{path}.{name}: missing")
            else:
                check(v[name], sub, f"{path}.{name}", errs, warns)
        extra = set(v) - set(t.kw["fields"])
        if extra:
            warns.append(f"{path}: keys not in contract {sorted(extra)}")


# ---------------------------------------------------------------------------
# Semantic checks
# ---------------------------------------------------------------------------

MOCK_FR, MOCK_EN = "[démo] ", "[demo] "


def semantic(s: dict, pop: dict | None, mp: dict | None, errs: list, warns: list):
    res = s["results"]
    ids = [r["id"] for r in res]
    if len(set(ids)) != len(ids):
        errs.append("results: duplicate ids")
    if ids != sorted(ids):
        errs.append("results: not sorted by id")
    by = {r["id"]: r for r in res}
    w = {}
    if pop:
        pids = [r["id"] for r in pop["residents"]]
        if ids != pids:
            errs.append(f"results ids do not match population ids ({len(ids)} vs {len(pids)})")
        w = {r["id"]: float(r.get("weight", 1.0)) for r in pop["residents"]}
        pid = {r["id"]: r for r in pop["residents"]}
        if s["voterScope"] == "paris_eligible":
            bad = [r["id"] for r in res if r["id"] in pid and r["eligible"] != bool(pid[r["id"]]["eligibleParis"])]
            if bad:
                errs.append(f"eligible != population.eligibleParis for {len(bad)} residents")
    W, H = (mp["width"], mp["height"]) if mp else (10 ** 6, 10 ** 6)
    dist_ok = {d["idx"] for d in mp["districtList"]} if mp else None

    def in_grid(p, path):
        if not (0 <= p[0] < W and 0 <= p[1] < H):
            errs.append(f"{path}: tile {p} outside grid")

    n_att = 0
    for r in res:
        if r["attendee"]:
            n_att += 1
            if not r["eligible"]:
                errs.append(f"results[{r['id']}]: attendee but not eligible")
        if not r["eligible"] and r["participationScore"] != 0:
            errs.append(f"results[{r['id']}]: participationScore must be 0 outside the scope")
        if not r["exposure"]["reasons"]:
            errs.append(f"results[{r['id']}]: exposure has no reasons")
        for x in r["exposure"]["reasons"]:
            for p in x.get("at", []):
                in_grid(p, f"results[{r['id']}].exposure.at")
        if ("stanceAfter" in r) != ("talkedWith" in r):
            errs.append(f"results[{r['id']}]: stanceAfter and talkedWith must come together")
        for o in r.get("talkedWith", []):
            if o not in by:
                errs.append(f"results[{r['id']}].talkedWith: unknown id {o}")
    scope = [r for r in res if r["eligible"]]
    expect = min(len(scope), max(25, round(s["turnoutTarget"] * len(scope))))
    if n_att != expect:
        errs.append(f"attendees: {n_att} flagged, expected {expect}")
    if scope and w:
        tw = sum(w[r["id"]] for r in scope)
        ep = sum(w[r["id"]] * r["participationScore"] for r in scope)
        if abs(ep / tw - s["turnoutTarget"]) > 0.002:
            errs.append(f"participation calibration: weighted mean {ep / tw:.4f} vs target {s['turnoutTarget']}")
    theme_ids = {t["id"] for t in s["themes"]}
    for r in res:
        if "themeId" in r and r["themeId"] not in theme_ids:
            errs.append(f"results[{r['id']}].themeId {r['themeId']!r} not in themes")
    for t in s["themes"]:
        for q in t["quoteIds"]:
            if q not in by:
                errs.append(f"themes[{t['id']}].quoteIds: unknown id {q}")
    tot_share = sum(t["share"] for t in s["themes"])
    if s["themes"] and not 0.95 <= tot_share <= 1.05:
        warns.append(f"theme shares sum to {tot_share:.3f}")
    for c in s["conversations"]:
        for k in ("a", "b"):
            if c[k] not in by:
                errs.append(f"conversation {c['id']}: unknown resident {c[k]}")
                continue
            if by[c[k]]["stance"] != c["stanceBefore"][k]:
                errs.append(f"conversation {c['id']}: stanceBefore.{k} != results stance")
            if by[c[k]].get("stanceAfter") != c["stanceAfter"][k]:
                errs.append(f"conversation {c['id']}: stanceAfter.{k} != results stanceAfter")
        for ln in c["lines"]:
            if ln["speaker"] not in (c["a"], c["b"]):
                errs.append(f"conversation {c['id']}: speaker {ln['speaker']} is neither a nor b")
        in_grid(c["where"], f"conversation {c['id']}.where")
        if "themeId" in c and c["themeId"] not in theme_ids:
            errs.append(f"conversation {c['id']}: themeId not in themes")
    aggs = [("views." + k, v) for k, v in s["aggregates"]["views"].items()]
    aggs += [("viewsAfterTalk." + k, v) for k, v in s["aggregates"].get("viewsAfterTalk", {}).items()]
    aggs += [(f"byDistrict[{d['districtIdx']}].{k}", d[k]) for d in s["aggregates"]["byDistrict"] for k in ("everyone", "attendees")]
    for path, v in aggs:
        tot = v["support"] + v["oppose"] + v["neutral"]
        if v["n"] > 0 and abs(tot - 1) > 0.002:
            errs.append(f"{path}: support+oppose+neutral = {tot:.4f}")
        if "yesRange" in v:
            lo, hi = v["yesRange"]
            if lo > hi or not (lo - 1e-6 <= v["yesShare"] <= hi + 1e-6):
                errs.append(f"{path}: yesRange {v['yesRange']} does not contain yesShare {v['yesShare']}")
    if dist_ok is not None:
        for d in s["aggregates"]["byDistrict"]:
            if d["districtIdx"] not in dist_ok:
                errs.append(f"byDistrict: unknown districtIdx {d['districtIdx']}")
        for c in s["consult"]:
            for d in c["districts"]:
                if d not in dist_ok:
                    errs.append(f"consult[{c['groupId']}]: unknown district {d}")
        for d in s.get("zoneDistricts", []):
            if d not in dist_ok:
                errs.append(f"zoneDistricts: unknown district {d}")
    if pop:
        gids = {g["id"] for g in pop.get("groups", [])} | {g["id"] for g in s.get("extraGroups", [])}
        for g in s["aggregates"]["byGroup"]:
            if g["groupId"] not in gids:
                errs.append(f"byGroup: unknown group {g['groupId']}")
        for c in s["consult"]:
            if c["groupId"] not in gids:
                errs.append(f"consult: unknown group {c['groupId']}")
        pids = {r["id"] for r in pop.get("residents", [])}
        for g in s.get("extraGroups", []):
            if any(i not in pids for i in g["memberIds"]):
                errs.append(f"extraGroups[{g['id']}]: member ids not in the population")
    if s["kind"] == "backtest" and "backtest" not in s:
        errs.append("backtest scenario without backtest block")
    if "site" in s:
        in_grid([s["site"]["x"], s["site"]["y"]], "site")
    # Mock prefixes
    texts = [(f"results[{r['id']}].reasonFr", r["reasonFr"], MOCK_FR) for r in res if not r["reasonFr"].startswith("(")]
    texts += [(f"results[{r['id']}].reasonEn", r["reasonEn"], MOCK_EN) for r in res if not r["reasonEn"].startswith("(")]
    texts += [(f"results[{r['id']}].behaviourEn", r["behaviourEn"], MOCK_EN) for r in res if r["behaviourEn"]]
    for c in s["conversations"]:
        texts += [(f"conversation {c['id']}.fr", ln["fr"], MOCK_FR) for ln in c["lines"]]
        texts += [(f"conversation {c['id']}.en", ln["en"], MOCK_EN) for ln in c["lines"]]
    if s["mock"]:
        bad = [p for p, t, pre in texts if not t.startswith(pre)]
        if bad:
            errs.append(f"mock: {len(bad)} texts without the [demo]/[démo] prefix, e.g. {bad[:3]}")
    else:
        bad = [p for p, t, _ in texts if t.startswith(MOCK_FR) or t.startswith(MOCK_EN)]
        if bad:
            errs.append(f"mock is false but {len(bad)} texts carry a [demo] prefix, e.g. {bad[:3]}")


def scan_file(path: Path, errs: list):
    raw = path.read_text(encoding="utf-8")
    key = env("TOKEN_FACTORY_API_KEY")
    if key and key in raw:
        errs.append(f"{path.name}: contains the API key value!")
    if re.search(r"Bearer\s+[A-Za-z0-9_\-]{16,}", raw):
        errs.append(f"{path.name}: contains a bearer token")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", action="store_true")
    ap.add_argument("--dir", default="")
    ap.add_argument("--population", default="")
    ap.add_argument("--map", default="")
    args = ap.parse_args()
    base = OUT / "dev" if args.dev else WEB_DATA
    sdir = Path(args.dir) if args.dir else (base / "scenarios")
    pop_p = Path(args.population) if args.population else base / "population.json"
    map_p = Path(args.map) if args.map else base / "map.json"
    pop = read_json(pop_p) if pop_p.exists() else None
    mp = read_json(map_p) if map_p.exists() else None
    print(f"scenarios: {sdir}\npopulation: {pop_p if pop else 'MISSING (id checks skipped)'}\nmap: {map_p if mp else 'MISSING'}")
    total_err = 0
    idx_p = sdir / "index.json"
    if idx_p.exists():
        errs, warns = [], []
        idx = read_json(idx_p)
        check(idx, A(INDEX_ENTRY), "index", errs, warns)
        for e in idx if isinstance(idx, list) else []:
            if not (sdir / f"{e['id']}.json").exists():
                errs.append(f"index: {e['id']}.json missing")
        print(f"\nindex.json: {len(idx)} entries — {'OK' if not errs else 'ERRORS'}")
        for x in errs + warns:
            print("   ", x)
        total_err += len(errs)
    else:
        print("index.json missing")
        total_err += 1
    for p in sorted(sdir.glob("*.json")):
        if p.name == "index.json":
            continue
        errs, warns = [], []
        s = read_json(p)
        check(s, SCENARIO, s.get("id", p.stem), errs, warns)
        try:
            semantic(s, pop, mp, errs, warns)
        except (KeyError, TypeError, IndexError) as e:
            errs.append(f"semantic checks stopped early ({type(e).__name__}: {e})")
        scan_file(p, errs)
        size = p.stat().st_size / 1e6
        n_att = sum(r["attendee"] for r in s.get("results", []))
        print(f"\n{p.name}: {'OK' if not errs else f'{len(errs)} ERRORS'} — {size:.2f} MB, mock={s.get('mock')}, "
              f"{len(s.get('results', []))} results, {n_att} attendees, {len(s.get('conversations', []))} conversations, "
              f"{len(s.get('themes', []))} themes, {len(s.get('consult', []))} consult recs")
        for x in errs[:40]:
            print("   ERROR", x)
        for x in sorted(set(warns))[:10]:
            print("   warn ", x)
        total_err += len(errs)
    print(f"\n{'ALL OK' if total_err == 0 else f'{total_err} errors'}")
    sys.exit(1 if total_err else 0)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
