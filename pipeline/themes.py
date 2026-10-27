"""Themes: the arguments behind the reactions, and which ones a consultation would miss.

1. Discover 6-10 themes with the synthesis model (Ultra) from a STRATIFIED sample of reasons:
   every (stance side x participation tercile) cell is represented and the lowest-participation
   tercile gets a double quota, so voices that rarely show up at consultations shape the themes too.
2. Assign every reason (and each conversation's key argument) to one theme with the reaction
   model (Nano), in batches of 20.
3. Statistics per theme: share of residents, side (from the members' mean stance), and
   missingGap = share among NON-attendees minus share among attendees (positive = a voice the
   consultation would miss), using the participation probability weights.

Mock mode: the themes are the scenario's template themes and assignment is keyword matching.
"""
from __future__ import annotations

import re

from llm import fill, gather_progress, hash01, seeded_rng

SAMPLE_SIZE = 150
BATCH = 20


def _clean(t: str) -> str:
    return re.sub(r"^\[(démo|demo)\]\s*", "", t or "").strip()


def keyword_assign(text: str, themes: list[dict]) -> str:
    """Mock / fallback: pick the theme whose keywords appear most often in the text."""
    t = (text or "").lower()
    best, best_hits = "other", 0
    for th in themes:
        hits = sum(1 for k in th.get("keywords", []) if k.lower() in t)
        if hits > best_hits:
            best, best_hits = th["id"], hits
    return best


def stratified_sample(residents: list[dict], reactions: dict, part: dict, k: int, seed: str) -> list[int]:
    rng = seeded_rng("theme_sample", seed)
    scores = sorted(part[r["id"]]["participationScore"] if part[r["id"]]["eligible"] else 0.0 for r in residents)
    t1 = scores[len(scores) // 3] if scores else 0
    t2 = scores[2 * len(scores) // 3] if scores else 0
    buckets: dict[tuple, list[int]] = {}
    for r in residents:
        s = reactions[r["id"]]["stance"]
        side = 1 if s > 0 else -1 if s < 0 else 0
        p = part[r["id"]]["participationScore"] if part[r["id"]]["eligible"] else 0.0
        tercile = 0 if p <= t1 else 1 if p <= t2 else 2
        buckets.setdefault((side, tercile), []).append(r["id"])
    for ids in buckets.values():
        rng.shuffle(ids)
    picked: list[int] = []
    keys = sorted(buckets)
    while len(picked) < k and any(buckets.values()):
        for key in keys:
            quota = 2 if key[1] == 0 else 1  # the least likely participants count double
            for _ in range(quota):
                if buckets[key] and len(picked) < k:
                    picked.append(buckets[key].pop())
    return picked


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")
    return s[:40] or "theme"


async def discover_themes(llm, sdef, residents, reactions, part, prompts, model) -> list[dict]:
    if llm.mock:
        await llm.chat_json(model=model, messages=[{"role": "user", "content": "mock theme discovery"}],
                            schema=prompts["themes_discover"]["schema"], task="themes_discover",
                            mock=lambda: {"themes": [{"id": t.id, "label": t.label, "label_fr": t.labelFr,
                                                      "side": t.side, "description": t.label} for t in sdef.mock_themes]})
        return [{"id": t.id, "label": t.label, "labelFr": t.labelFr, "side": t.side, "description": t.label,
                 "keywords": t.keywords} for t in sdef.mock_themes]
    ids = stratified_sample(residents, reactions, part, SAMPLE_SIZE, sdef.id)
    lines = [f"- ({reactions[i]['stance']:+d}) {_clean(reactions[i]['reasonEn'])}" for i in ids if reactions[i]["reasonEn"]]
    tpl = prompts["themes_discover"]
    data = await llm.chat_json(
        model=model,
        messages=[{"role": "system", "content": tpl["system"]},
                  {"role": "user", "content": fill(tpl["user"], {"proposal": sdef.proposalEn, "reasons": "\n".join(lines)})}],
        schema=tpl["schema"], schema_name="themes", temperature=0.2, max_tokens=2000, task="themes_discover")
    themes, seen = [], set()
    for t in data["themes"][:10]:
        tid = _slug(t["id"] or t["label"])
        while tid in seen:
            tid += "_2"
        seen.add(tid)
        themes.append({"id": tid, "label": t["label"], "labelFr": t["label_fr"], "side": t["side"],
                       "description": t["description"], "keywords": []})
    return themes


async def assign_themes(llm, themes: list[dict], items: list[tuple[str, str]], prompts, model) -> dict[str, str]:
    """items = [(key, text)] -> {key: themeId}. Keyword matching in mock mode or as a fallback."""
    if llm.mock:
        return {key: keyword_assign(text, themes) for key, text in items}
    tpl = prompts["themes_assign"]
    ids = [t["id"] for t in themes] + ["other"]
    schema = {**tpl["schema"]}
    schema["properties"] = {"assignments": {**tpl["schema"]["properties"]["assignments"]}}
    item_schema = dict(schema["properties"]["assignments"]["items"])
    item_schema["properties"] = {"i": {"type": "integer"}, "theme": {"type": "string", "enum": ids}}
    schema["properties"]["assignments"]["items"] = item_schema
    theme_text = "\n".join(f"- {t['id']}: {t['label']} — {t['description']}" for t in themes)
    batches = [items[i:i + BATCH] for i in range(0, len(items), BATCH)]

    async def one(batch):
        text = "\n".join(f"{n + 1}. {_clean(t)}" for n, (_, t) in enumerate(batch))
        data = await llm.chat_json(
            model=model,
            messages=[{"role": "system", "content": tpl["system"]},
                      {"role": "user", "content": fill(tpl["user"], {"themes": theme_text, "items": text})}],
            schema=schema, schema_name="assignments", temperature=0.0, max_tokens=60 + 25 * len(batch),
            task="themes_assign")
        got = {a["i"]: a["theme"] for a in data["assignments"]}
        return {key: got.get(n + 1, keyword_assign(t, themes)) for n, (key, t) in enumerate(batch)}

    out: dict[str, str] = {}
    results = await gather_progress([one(b) for b in batches], "theme assignment")
    for b, res in zip(batches, results):
        if isinstance(res, Exception):
            out.update({key: keyword_assign(t, themes) for key, t in b})
        else:
            out.update(res)
    return out


def theme_stats(themes: list[dict], residents: list[dict], reactions: dict, part: dict, assigned: dict[int, str]) -> list[dict]:
    """Contract Theme objects, sorted by share. Weights: raking weight; attendees w*p, others w*(1-p)."""
    w = {r["id"]: float(r.get("weight", 1.0)) for r in residents}
    p = {r["id"]: (part[r["id"]]["participationScore"] if part[r["id"]]["eligible"] else 0.0) for r in residents}
    tot = sum(w.values()) or 1
    tot_att = sum(w[i] * p[i] for i in w) or 1
    tot_non = sum(w[i] * (1 - p[i]) for i in w) or 1
    defs = {t["id"]: t for t in themes}
    if any(v == "other" for v in assigned.values()):
        defs["other"] = {"id": "other", "label": "Other reasons", "labelFr": "Autres raisons", "side": "mixed"}
    out = []
    for tid, t in defs.items():
        members = [i for i, th in assigned.items() if th == tid]
        if not members:
            continue
        mw = sum(w[i] for i in members)
        mean = sum(w[i] * reactions[i]["stance"] for i in members) / mw if mw else 0
        side = t["side"]
        if len(members) >= 3:
            side = "support" if mean > 0.35 else "oppose" if mean < -0.35 else "mixed"
        share_att = sum(w[i] * p[i] for i in members) / tot_att
        share_non = sum(w[i] * (1 - p[i]) for i in members) / tot_non
        # Representative quotes: strongest views first, spread over districts, stable order.
        ranked = sorted(members, key=lambda i: (-abs(reactions[i]["stance"]), hash01("quote", tid, i)))
        quotes, seen_d = [], set()
        by_id = {r["id"]: r for r in residents}
        for i in ranked:
            d = by_id[i]["districtIdx"]
            if d not in seen_d:
                quotes.append(i)
                seen_d.add(d)
            if len(quotes) >= 4:
                break
        for i in ranked:
            if len(quotes) >= 4:
                break
            if i not in quotes:
                quotes.append(i)
        theme = {"id": tid, "label": t["label"], "side": side, "share": round(mw / tot, 4),
                 "missingGap": round(share_non - share_att, 4), "quoteIds": quotes}
        if t.get("labelFr"):
            theme["labelFr"] = t["labelFr"]
        out.append(theme)
    out.sort(key=lambda x: -x["share"])
    return out
