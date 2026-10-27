"""Fill Resident.personaEn in web/public/data/population.json with English one-liners (Nano model).

    python pipeline/translate_personas.py            # needs TOKEN_FACTORY_API_KEY
    python pipeline/translate_personas.py --mock     # no-op: reports how many would be translated
    python pipeline/translate_personas.py --apply-cache   # re-apply saved translations after a population rebuild

Translations are also saved by dataset uuid in pipeline/out/cache/persona_en.json, so rebuilding
the population does not cost a second translation run (use --apply-cache).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from common import OUT, SHARED, WEB_DATA, read_json, write_json
from llm import LLMClient, fill, gather_progress, load_settings

BATCH = 10
SAVED = OUT / "cache" / "persona_en.json"


def save_population(path: Path, pop: dict, raw_head: str):
    # Keep the writer's formatting: compact unless the file was indented.
    write_json(path, pop, compact="\n" not in raw_head)


async def translate(pop: dict, prompts: dict, limit: int) -> dict[str, str]:
    todo = [r for r in pop["residents"] if not r.get("personaEn")]
    if limit:
        todo = todo[:limit]
    tpl = prompts["translate"]
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    out: dict[str, str] = {}
    async with LLMClient(mock=False) as llm:
        model = llm.settings.model_reaction

        async def one(batch):
            items = "\n".join(f"{r['id']}: {r['personaFr']}" for r in batch)
            data = await llm.chat_json(
                model=model, messages=[{"role": "system", "content": tpl["system"]},
                                       {"role": "user", "content": fill(tpl["user"], {"items": items})}],
                schema=tpl["schema"], schema_name="translations", temperature=0.2, max_tokens=90 * len(batch),
                task="translate")
            got = {it["id"]: it["en"].strip() for it in data["items"]}
            return {r["uuid"]: got[r["id"]] for r in batch if got.get(r["id"])}

        for res in await gather_progress([one(b) for b in batches], "translations"):
            if not isinstance(res, Exception):
                out.update(res)
        llm.write_stats(OUT / "run_stats_translate.json")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--apply-cache", action="store_true")
    ap.add_argument("--path", default=str(WEB_DATA / "population.json"))
    ap.add_argument("--limit", type=int, default=0, help="translate at most N residents (testing)")
    args = ap.parse_args()
    path = Path(args.path)
    if not path.exists():
        print(f"{path} not found")
        sys.exit(1)
    raw_head = path.read_text(encoding="utf-8")[:300]
    pop = read_json(path)
    saved = read_json(SAVED) if SAVED.exists() else {}
    missing = [r for r in pop["residents"] if not r.get("personaEn")]
    if args.apply_cache or args.mock or not load_settings().has_key:
        n = 0
        if args.apply_cache:
            for r in missing:
                if saved.get(r["uuid"]):
                    r["personaEn"] = saved[r["uuid"]]
                    n += 1
            if n:
                save_population(path, pop, raw_head)
            print(f"applied {n} saved translations; {len(missing) - n} still empty")
        else:
            print(f"MOCK / no API key: {len(missing)} of {len(pop['residents'])} residents have no personaEn "
                  f"({sum(1 for r in missing if saved.get(r['uuid']))} available in the saved cache). Nothing changed.")
        return
    new = asyncio.run(translate(pop, read_json(SHARED / "prompts.json"), args.limit))
    saved.update(new)
    write_json(SAVED, saved)
    n = 0
    for r in pop["residents"]:
        if not r.get("personaEn") and saved.get(r["uuid"]):
            r["personaEn"] = saved[r["uuid"]]
            n += 1
    save_population(path, pop, raw_head)
    print(f"translated {len(new)}; filled {n}; {sum(1 for r in pop['residents'] if not r.get('personaEn'))} still empty")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
