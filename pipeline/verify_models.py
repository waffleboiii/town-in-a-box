"""Check which Nemotron models your Token Factory key can use, and that structured JSON works.

    python pipeline/verify_models.py          # GET /v1/models, compare with the IDs in .env
    python pipeline/verify_models.py --ping   # also one tiny JSON-schema call per configured model

Needs TOKEN_FACTORY_API_KEY in the repo-root .env. The key is never printed.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time

import httpx

from llm import LLMClient, ledger_add, load_settings, reserve, release

PING_SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}, "word": {"type": "string"}},
               "required": ["ok", "word"], "additionalProperties": False}


def list_models(s) -> list[str]:
    r = httpx.get(f"{s.base_url}/models", headers={"Authorization": f"Bearer {s.api_key}"}, timeout=30)
    if r.status_code != 200:
        print(f"GET /models -> HTTP {r.status_code} (check the key and TOKEN_FACTORY_BASE_URL)")
        sys.exit(1)
    data = r.json()
    rows = data.get("data", data if isinstance(data, list) else [])
    return sorted(m.get("id", "") for m in rows if isinstance(m, dict))


def raw_probe(s, model: str, json_schema: bool, extra: bool) -> str:
    """One raw request, to see exactly what the API accepts and whether the model 'thinks'."""
    body = {"model": model, "temperature": 0.0, "max_tokens": 300,
            "messages": [{"role": "user", "content": "Réponds en JSON : ok=true et word = un mot français pour 'city'."}],
            "response_format": ({"type": "json_schema", "json_schema": {"name": "ping", "schema": PING_SCHEMA, "strict": True}}
                                if json_schema else {"type": "json_object"})}
    if extra:
        body.update(s.extra_body)
    t0 = time.time()
    worst = reserve(model, 200, body["max_tokens"], s.prices)  # stays under the spending cap
    try:
        r = httpx.post(f"{s.base_url}/chat/completions", json=body, timeout=120,
                       headers={"Authorization": f"Bearer {s.api_key}"})
    finally:
        release(worst)
    if r.status_code != 200:
        return f"HTTP {r.status_code}: {r.text[:160]}"
    p = r.json()
    ledger_add(model, p.get("usage") or {"prompt_tokens": 200, "completion_tokens": body["max_tokens"]}, s.prices)
    ch = p["choices"][0]
    msg = ch.get("message", {})
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
    thinks = bool(reasoning) or "<think>" in content
    u = p.get("usage", {})
    limits = {k: v for k, v in r.headers.items() if "ratelimit" in k.lower()}  # e.g. x-ratelimit-limit-requests
    if limits:
        print(f"     rate-limit headers: {limits}")
    return (f"OK {time.time() - t0:.1f}s, finish={ch.get('finish_reason')}, tokens {u.get('prompt_tokens')}+"
            f"{u.get('completion_tokens')}, thinking={'YES' if thinks else 'no'}, content={content[:70]!r}")


async def ping(s, models: list[str]):
    for m in models:
        print(f"  {m}")
        for js, ex, label in ((True, True, "json_schema + thinking-off"), (True, False, "json_schema, no extra body"),
                              (False, True, "json_object + thinking-off")):
            try:
                print(f"     {label:30s} {raw_probe(s, m, js, ex)}")
            except Exception as e:
                print(f"     {label:30s} FAILED ({type(e).__name__})")
    print("  If 'thinking=YES' even with thinking-off, set LLM_EXTRA_BODY in .env (e.g. '{}' and a '/no_think' system "
          "suffix via LLM_SYSTEM_SUFFIX) or raise REACTION max tokens; llm.py also retries truncated answers with more tokens.")
    async with LLMClient(mock=False, use_cache=False) as llm:
        for m in models:
            try:
                out = await llm.chat_json(model=m, messages=[
                    {"role": "user", "content": "Réponds en JSON : ok=true et word = un mot français pour 'city'."}],
                    schema=PING_SCHEMA, schema_name="ping", temperature=0.0, max_tokens=300, task="ping")
                print(f"  pipeline client OK for {m}: {out} (response_format={llm.schema_mode.get(m, 'json_schema')})")
            except Exception as e:
                print(f"  pipeline client FAILED for {m}: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ping", action="store_true")
    args = ap.parse_args()
    s = load_settings()
    if not s.has_key:
        print("TOKEN_FACTORY_API_KEY is not set in the repo-root .env — add it there (never commit it).")
        sys.exit(1)
    ids = list_models(s)
    print(f"{len(ids)} models available at {s.base_url}")
    nem = [i for i in ids if "nemotron" in i.lower()]
    print("Nemotron models:" if nem else "No model id contains 'nemotron'.")
    for i in nem:
        print("   ", i)
    configured = {"MODEL_REACTION": s.model_reaction, "MODEL_CONVERSATION": s.model_conversation,
                  "MODEL_SYNTHESIS": s.model_synthesis}
    print("\nConfigured in .env (or defaults):")
    lower = {i.lower(): i for i in ids}
    for k, v in configured.items():
        if v in ids:
            print(f"  OK       {k} = {v}")
        elif v.lower() in lower:
            print(f"  CASE     {k} = {v}  -> the API spells it {lower[v.lower()]}")
        else:
            hint = [i for i in nem if any(w in i.lower() for w in ("nano", "super", "ultra") if w in v.lower())]
            print(f"  MISSING  {k} = {v}" + (f"  -> did you mean {hint[0]}?" if hint else ""))
    if args.ping:
        print("\nPing (one structured-JSON call each, no cache):")
        asyncio.run(ping(s, [v for v in configured.values() if v in ids or v.lower() in lower]))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
