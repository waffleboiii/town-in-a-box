"""One round of neighbour conversations: do arguments spread, do opinions move?

How pairs are chosen (no cherry-picking): residents are visited in a seeded random order; each
one not yet paired is matched with a random unpaired NEIGHBOUR whose home is within RADIUS
tiles (300 m), or, if there is none, with a random unpaired resident of the same district. We
never select pairs by how much they disagree.

Each pair gets one short conversation written by the conversation model (Super). The model
returns each person's stance after talking and the key argument that travelled; the key
argument is later assigned to a theme (themes.py), so we can see which arguments spread.
"""
from __future__ import annotations

from collections import defaultdict

from llm import MOCK_EN, MOCK_FR, fill, gather_progress, seeded_rng, stable_seed

RADIUS = 3  # tiles (100 m each)
DEFAULT_PAIRS = 280
SPOTS_FR = ["en bas de leur immeuble", "au marché", "à l'arrêt de bus", "devant la boulangerie", "dans le square",
            "à la sortie de l'école", "au café du coin"]


def make_pairs(residents: list[dict], n_pairs: int, seed: str) -> list[tuple[int, int, str]]:
    rng = seeded_rng("pairs", seed)
    by_id = {r["id"]: r for r in residents}
    cells: dict[tuple[int, int], list[int]] = defaultdict(list)
    by_district: dict[int, list[int]] = defaultdict(list)
    for r in residents:
        cells[(r["home"][0] // RADIUS, r["home"][1] // RADIUS)].append(r["id"])
        by_district[r["districtIdx"]].append(r["id"])
    order = [r["id"] for r in residents]
    rng.shuffle(order)
    used: set[int] = set()
    pairs = []
    for a in order:
        if len(pairs) >= n_pairs:
            break
        if a in used:
            continue
        ra = by_id[a]
        cx, cy = ra["home"][0] // RADIUS, ra["home"][1] // RADIUS
        near = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for b in cells.get((cx + dx, cy + dy), []):
                    if b != a and b not in used:
                        rb = by_id[b]
                        if (ra["home"][0] - rb["home"][0]) ** 2 + (ra["home"][1] - rb["home"][1]) ** 2 <= RADIUS ** 2:
                            near.append(b)
        kind = "neighbour"
        if not near:
            near = [b for b in by_district[ra["districtIdx"]] if b != a and b not in used]
            kind = "district"
        if not near:
            continue
        b = rng.choice(sorted(near))
        used.update((a, b))
        pairs.append((a, b, kind))
    return pairs


STANCE_FR = {-2: "vraiment contre", -1: "plutôt contre", 0: "partagé·e", 1: "plutôt pour", 2: "vraiment pour"}
STANCE_EN = {-2: "strongly against", -1: "rather against", 0: "undecided", 1: "rather in favour", 2: "strongly in favour"}


def _strip(t: str) -> str:
    for p in (MOCK_FR, MOCK_EN):
        if t.startswith(p):
            t = t[len(p):]
    return t


def mock_conversation(sid: str, a: dict, b: dict, ra: dict, rb: dict) -> dict:
    """Deterministic conversation in the 'conversation' schema."""
    rng = seeded_rng("conv", sid, a["id"], b["id"])
    sa, sb = ra["stance"], rb["stance"]
    same = (sa > 0 and sb > 0) or (sa < 0 and sb < 0) or (sa == 0 and sb == 0)
    lines = [
        {"speaker": "A", "fr": f"{MOCK_FR}Tu as entendu parler de ce projet ? Moi, je suis {STANCE_FR[sa]}.",
         "en": f"{MOCK_EN}Have you heard about this proposal? I'm {STANCE_EN[sa]}."},
        {"speaker": "B", "fr": f"{MOCK_FR}{'Pareil.' if same else 'Ah, pas moi.'} {_strip(rb['reasonFr'])}",
         "en": f"{MOCK_EN}{'Same here.' if same else 'Not me.'} {_strip(rb['reasonEn'])}"},
        {"speaker": "A", "fr": f"{MOCK_FR}{_strip(ra['reasonFr'])}", "en": f"{MOCK_EN}{_strip(ra['reasonEn'])}"},
    ]
    a_after, b_after = sa, sb
    persuader = "A" if abs(sa) >= abs(sb) else "B"
    if sa != sb and rng.random() < 0.3:
        # The less convinced person moves one step towards the other.
        if abs(sa) < abs(sb) or (abs(sa) == abs(sb) and rng.random() < 0.5):
            a_after = sa + (1 if sb > sa else -1)
            persuader = "B"
        else:
            b_after = sb + (1 if sa > sb else -1)
            persuader = "A"
        mover = "B" if persuader == "A" else "A"
        lines.append({"speaker": mover, "fr": f"{MOCK_FR}C'est vrai, je n'avais pas vu les choses comme ça.",
                      "en": f"{MOCK_EN}That's true, I hadn't looked at it that way."})
    elif same:
        lines.append({"speaker": "B", "fr": f"{MOCK_FR}On est d'accord, alors.", "en": f"{MOCK_EN}We agree, then."})
    else:
        lines.append({"speaker": "B", "fr": f"{MOCK_FR}Bon, on ne sera pas d'accord, mais c'est bien d'en parler.",
                      "en": f"{MOCK_EN}Well, we won't agree, but it's good to talk about it."})
    key = ra["reasonEn"] if persuader == "A" else rb["reasonEn"]
    return {"lines": lines, "a_stance_after": a_after, "b_stance_after": b_after,
            "key_argument_en": MOCK_EN + _strip(key)}


async def run_conversations(llm, sdef, by_id: dict, reactions: dict, profiles: dict, place_fn, prompts: dict,
                            model: str, n_pairs: int = DEFAULT_PAIRS) -> list[dict]:
    """Return a list of internal conversation dicts (contract fields + keyArgumentEn)."""
    pairs = make_pairs(list(by_id.values()), n_pairs, sdef.id)
    tpl = prompts["conversation"]

    async def one(idx: int, a_id: int, b_id: int, kind: str):
        a, b = by_id[a_id], by_id[b_id]
        ra, rb = reactions[a_id], reactions[b_id]
        rng = seeded_rng("spot", sdef.id, a_id, b_id)
        where_fr = f"{rng.choice(SPOTS_FR)}, {place_fn(a['districtIdx'])['in_fr']}"
        system = fill(tpl["system"], {"where": where_fr})
        user = fill(tpl["user"], {
            "aId": a_id, "aProfile": profiles[a_id], "aStance": ra["stance"], "aReason": _strip(ra["reasonFr"]),
            "bId": b_id, "bProfile": profiles[b_id], "bStance": rb["stance"], "bReason": _strip(rb["reasonFr"]),
            "proposal": sdef.proposalFr,
        })
        data = await llm.chat_json(
            model=model, messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            schema=tpl["schema"], schema_name="conversation", temperature=0.7, max_tokens=900,
            seed=stable_seed("conv", sdef.id, a_id, b_id), task="conversation",
            mock=lambda: mock_conversation(sdef.id, a, b, ra, rb))
        lines = [{"speaker": a_id if ln["speaker"] == "A" else b_id, "fr": ln["fr"], "en": ln["en"]}
                 for ln in data["lines"] if ln.get("fr") or ln.get("en")]
        where = [int((a["home"][0] + b["home"][0]) / 2), int((a["home"][1] + b["home"][1]) / 2)]
        return {
            "id": f"{sdef.id}-c{idx:03d}", "a": a_id, "b": b_id, "where": where, "lines": lines,
            "stanceBefore": {"a": ra["stance"], "b": rb["stance"]},
            "stanceAfter": {"a": int(data["a_stance_after"]), "b": int(data["b_stance_after"])},
            "keyArgumentEn": data["key_argument_en"], "pairKind": kind,
        }

    results = await gather_progress([one(i, a, b, k) for i, (a, b, k) in enumerate(pairs)], "conversations")
    convs, failed = [], 0
    for res in results:
        if isinstance(res, Exception):
            failed += 1
        else:
            convs.append(res)
    if failed:
        print(f"    conversations: {failed} failed and were skipped")
    return convs


def conversation_summary(convs: list[dict]) -> dict:
    moved = sum((c["stanceAfter"]["a"] != c["stanceBefore"]["a"]) + (c["stanceAfter"]["b"] != c["stanceBefore"]["b"]) for c in convs)
    neighbours = sum(1 for c in convs if c.get("pairKind") == "neighbour")
    return {"pairs": len(convs), "residentsTalked": 2 * len(convs), "residentsChanged": int(moved),
            "neighbourPairs": neighbours, "sameDistrictPairs": len(convs) - neighbours}
