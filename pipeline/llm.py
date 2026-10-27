"""Async client for NVIDIA Nemotron models on Nebius Token Factory (OpenAI-compatible API).

What this module does, in plain words:
- Sends chat-completion requests and asks for JSON that follows a schema
  (response_format = json_schema, strict). If a model rejects that, it falls back to
  "json_object" mode and checks the answer against the schema locally.
- Retries with exponential backoff on 429 (rate limit), 5xx errors and timeouts.
- Respects rate limits from .env: LLM_RPM (requests/minute), LLM_TPM (tokens/minute)
  and LLM_CONCURRENCY (requests in flight at the same time).
- Caches every successful answer on disk (pipeline/out/cache/llm/), keyed by a hash of
  (model, messages, schema, parameters). Re-running the pipeline costs nothing.
- Counts tokens, latency and an estimated cost per model -> pipeline/out/run_stats_<scenario>.json.
- MOCK provider: with no API key (or with --mock), no network call is made. The caller gives a
  small `mock` function that returns deterministic heuristic JSON. Every mock text starts with
  "[démo] " (French) or "[demo] " (English) and every output file is flagged mock: true.

The API key is read from the repo-root .env. It is never printed, logged or written to disk,
and it is never sent anywhere except the Token Factory base URL.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import random
import re
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

from common import CONFIG, OUT, env, write_json

CACHE_DIR = Path(env("LLM_CACHE_DIR", str(OUT / "cache" / "llm")))

# Prices in US$ per 1M tokens (input, output). UNVERIFIED: taken from a third-party price
# listing; check the Token Factory pricing page. Override with LLM_PRICES in .env, e.g.
# LLM_PRICES={"nano": [0.06, 0.24], "super": [0.30, 0.90], "ultra": [1.0, 3.0]}
DEFAULT_PRICES = {"nano": (0.06, 0.24), "super": (0.30, 0.90), "ultra": (1.0, 3.0)}

MOCK_FR = "[démo] "
MOCK_EN = "[demo] "


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@dataclass
class LLMSettings:
    api_key: str | None
    base_url: str
    model_reaction: str
    model_conversation: str
    model_synthesis: str
    rpm: int
    tpm: int
    concurrency: int
    timeout_s: float
    max_retries: int
    extra_body: dict
    prices: dict
    system_suffix: str = ""  # optional text appended to every system prompt (e.g. "/no_think")

    @property
    def has_key(self) -> bool:
        return bool(self.api_key)


def load_settings() -> LLMSettings:
    d = CONFIG["llmDefaults"]
    # Nemotron 3 models "think" before answering by default. For short JSON answers we turn
    # thinking off through the chat template (configurable: LLM_EXTRA_BODY in .env, "{}" = none).
    extra_raw = env("LLM_EXTRA_BODY", '{"chat_template_kwargs": {"enable_thinking": false}}')
    try:
        extra = json.loads(extra_raw) if extra_raw else {}
    except json.JSONDecodeError:
        extra = {}
    prices = dict(DEFAULT_PRICES)
    try:
        override = json.loads(env("LLM_PRICES", "{}") or "{}")
        prices.update({k.lower(): tuple(v) for k, v in override.items()})
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return LLMSettings(
        api_key=env("TOKEN_FACTORY_API_KEY"),
        base_url=(env("TOKEN_FACTORY_BASE_URL", d["baseUrl"]) or d["baseUrl"]).rstrip("/"),
        model_reaction=env("MODEL_REACTION", d["modelReaction"]),
        model_conversation=env("MODEL_CONVERSATION", d["modelConversation"]),
        model_synthesis=env("MODEL_SYNTHESIS", d["modelSynthesis"]),
        rpm=int(env("LLM_RPM", "60")),
        tpm=int(env("LLM_TPM", "400000")),
        concurrency=int(env("LLM_CONCURRENCY", "8")),
        timeout_s=float(env("LLM_TIMEOUT_S", "120")),
        max_retries=int(env("LLM_MAX_RETRIES", "6")),
        extra_body=extra,
        system_suffix=env("LLM_SYSTEM_SUFFIX", "") or "",
        prices=prices,
    )


def price_for(model: str, prices: dict) -> tuple[float, float]:
    m = model.lower()
    for k, v in prices.items():
        if k in m:
            return float(v[0]), float(v[1])
    return 0.0, 0.0


# ---------------------------------------------------------------------------
# Tiny JSON-schema helper (enough for our own schemas: object/array/string/integer/number/enum)
# ---------------------------------------------------------------------------

def coerce(obj: Any, schema: dict) -> Any:
    """Best-effort repair: '2' -> 2, 1.7 -> 2 for integers, clamp to min/max, trim strings."""
    t = schema.get("type")
    if t == "object" and isinstance(obj, dict):
        props = schema.get("properties", {})
        out = {}
        for k, v in obj.items():
            if k in props:
                out[k] = coerce(v, props[k])
            elif schema.get("additionalProperties", True) is not False:
                out[k] = v
        return out
    if t == "array" and isinstance(obj, list):
        item = schema.get("items", {})
        return [coerce(v, item) for v in obj]
    if t in ("integer", "number"):
        try:
            v = float(obj)
        except (TypeError, ValueError):
            return obj
        if t == "integer":
            v = int(round(v))
        if "minimum" in schema:
            v = max(schema["minimum"], v)
        if "maximum" in schema:
            v = min(schema["maximum"], v)
        return v
    if t == "string" and isinstance(obj, str):
        return obj.strip()
    if t == "string" and isinstance(obj, (int, float)) and "enum" not in schema:
        return str(obj)
    return obj


def validate(obj: Any, schema: dict, path: str = "$") -> list[str]:
    """Return a list of problems (empty list = valid)."""
    errs: list[str] = []
    t = schema.get("type")
    if t == "object":
        if not isinstance(obj, dict):
            return [f"{path}: expected object"]
        for k in schema.get("required", []):
            if k not in obj:
                errs.append(f"{path}.{k}: missing")
        for k, sub in schema.get("properties", {}).items():
            if k in obj:
                errs += validate(obj[k], sub, f"{path}.{k}")
    elif t == "array":
        if not isinstance(obj, list):
            return [f"{path}: expected array"]
        if "minItems" in schema and len(obj) < schema["minItems"]:
            errs.append(f"{path}: fewer than {schema['minItems']} items")
        for i, v in enumerate(obj):
            errs += validate(v, schema.get("items", {}), f"{path}[{i}]")
    elif t == "integer":
        if not isinstance(obj, int) or isinstance(obj, bool):
            errs.append(f"{path}: expected integer")
    elif t == "number":
        if not isinstance(obj, (int, float)) or isinstance(obj, bool):
            errs.append(f"{path}: expected number")
    elif t == "string":
        if not isinstance(obj, str):
            errs.append(f"{path}: expected string")
    elif t == "boolean":
        if not isinstance(obj, bool):
            errs.append(f"{path}: expected boolean")
    if "enum" in schema and obj not in schema["enum"]:
        errs.append(f"{path}: {obj!r} not in enum")
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        if "minimum" in schema and obj < schema["minimum"]:
            errs.append(f"{path}: below minimum")
        if "maximum" in schema and obj > schema["maximum"]:
            errs.append(f"{path}: above maximum")
    return errs


_THINK = re.compile(r"<think>.*?</think>", re.S)


def extract_json(text: str) -> Any:
    """Parse JSON from a model answer, tolerating <think> blocks and ``` fences."""
    if text is None:
        raise ValueError("empty answer")
    t = _THINK.sub("", text).strip()
    if "</think>" in t:  # an unclosed think block: keep what follows it
        t = t.split("</think>")[-1]
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t.strip())
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    start = t.find("{")
    end = t.rfind("}")
    if start >= 0 and end > start:
        return json.loads(t[start : end + 1])
    raise ValueError("no JSON object found in answer")


# ---------------------------------------------------------------------------
# Rate limiter: sliding one-minute window on requests and tokens
# ---------------------------------------------------------------------------

class RateLimiter:
    def __init__(self, rpm: int, tpm: int):
        self.rpm = max(1, rpm)
        self.tpm = max(1000, tpm)
        self.events: deque[list] = deque()  # [timestamp, tokens]
        self.lock = asyncio.Lock()

    async def acquire(self, tokens: int) -> list:
        while True:
            async with self.lock:
                now = time.monotonic()
                while self.events and now - self.events[0][0] >= 60:
                    self.events.popleft()
                used_tokens = sum(e[1] for e in self.events)
                if len(self.events) < self.rpm and used_tokens + tokens <= self.tpm:
                    ev = [now, tokens]
                    self.events.append(ev)
                    return ev
                wait = 60 - (now - self.events[0][0]) + 0.05 if self.events else 1.0
            await asyncio.sleep(min(max(wait, 0.05), 5.0))


# ---------------------------------------------------------------------------
# Accounting
# ---------------------------------------------------------------------------

@dataclass
class ModelStats:
    calls: int = 0  # real HTTP requests that succeeded
    cache_hits: int = 0
    mock_calls: int = 0
    errors: int = 0  # requests that finally failed
    retries: int = 0
    schema_fallbacks: int = 0
    truncated: int = 0  # answers cut off by max_tokens (retried with a bigger budget)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_s: float = 0.0
    # Estimated tokens for mock calls (chars / 3.5) -> lets a mock run estimate live cost.
    est_prompt_tokens: int = 0
    est_completion_tokens: int = 0


@dataclass
class Stats:
    started: float = field(default_factory=time.time)
    by_model: dict[str, ModelStats] = field(default_factory=dict)
    by_task: dict[str, int] = field(default_factory=dict)

    def m(self, model: str) -> ModelStats:
        return self.by_model.setdefault(model, ModelStats())

    def report(self, settings: LLMSettings, mock: bool) -> dict:
        models = {}
        total_cost = 0.0
        est_cost = 0.0
        total_requests = 0
        for model, s in self.by_model.items():
            pin, pout = price_for(model, settings.prices)
            cost = (s.prompt_tokens * pin + s.completion_tokens * pout) / 1e6
            ecost = (s.est_prompt_tokens * pin + s.est_completion_tokens * pout) / 1e6
            total_cost += cost
            est_cost += ecost
            total_requests += s.calls + s.mock_calls + s.cache_hits
            models[model] = {
                **s.__dict__,
                "latency_s": round(s.latency_s, 2),
                "mean_latency_s": round(s.latency_s / s.calls, 2) if s.calls else None,
                "cost_usd": round(cost, 4),
                "mock_estimated_live_cost_usd": round(ecost, 4) if s.mock_calls else None,
                "price_per_1M_in_out_usd_UNVERIFIED": [pin, pout],
            }
        return {
            "mock": mock,
            "wall_clock_s": round(time.time() - self.started, 1),
            "requests_total": total_requests,
            "by_task": self.by_task,
            "models": models,
            "cost_usd_total": round(total_cost, 4),
            "mock_estimated_live_cost_usd_total": round(est_cost, 4) if mock else None,
            "estimated_live_minutes_at_rpm": round(total_requests / max(1, settings.rpm), 1),
            "rpm": settings.rpm,
            "note": "Prices are UNVERIFIED defaults (Nano $0.06/$0.24, Super $0.30/$0.90, Ultra $1/$3 per 1M in/out tokens). Mock token counts are estimated as characters/3.5.",
        }


# ---------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------

class LLMError(RuntimeError):
    pass


_LEARNED_SCHEMA_MODE: dict[str, str] = {}
_LEARNED_NO_EXTRA: set[str] = set()


class LLMClient:
    """Use as: `async with LLMClient(mock=...) as llm: data = await llm.chat_json(...)`."""

    def __init__(self, mock: bool | None = None, settings: LLMSettings | None = None, use_cache: bool = True):
        self.settings = settings or load_settings()
        # Mock when asked, or automatically when there is no key.
        self.mock = (not self.settings.has_key) if mock is None else (mock or not self.settings.has_key)
        self.use_cache = use_cache
        self.stats = Stats()
        self.limiter = RateLimiter(self.settings.rpm, self.settings.tpm)
        self.sem = asyncio.Semaphore(max(1, self.settings.concurrency))
        self.http: httpx.AsyncClient | None = None
        # Per-model degradations learned at runtime (e.g. json_schema not supported). Shared by every
        # client in this process, so the next scenario does not have to learn them again.
        self.schema_mode: dict[str, str] = _LEARNED_SCHEMA_MODE
        self.no_extra: set[str] = _LEARNED_NO_EXTRA

    async def __aenter__(self):
        if not self.mock:
            self.http = httpx.AsyncClient(
                base_url=self.settings.base_url,
                timeout=httpx.Timeout(self.settings.timeout_s, connect=20.0),
                headers={"Authorization": f"Bearer {self.settings.api_key}", "Content-Type": "application/json"},
            )
        return self

    async def __aexit__(self, *exc):
        if self.http:
            await self.http.aclose()

    # -- cache ---------------------------------------------------------------
    def cache_key(self, model: str, messages: list, schema: dict | None, params: dict) -> str:
        # The base URL is part of the key so answers from another endpoint (e.g. a test server) are never reused.
        blob = json.dumps({"base": self.settings.base_url, "model": model, "messages": messages, "schema": schema,
                           "params": params}, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    @staticmethod
    def _cache_path(key: str) -> Path:
        return CACHE_DIR / key[:2] / f"{key}.json"

    def _cache_get(self, key: str):
        p = self._cache_path(key)
        if self.use_cache and p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                return None
        return None

    def _cache_put(self, key: str, value: dict) -> None:
        if self.use_cache:
            write_json(self._cache_path(key), value)

    # -- main entry point ----------------------------------------------------
    async def chat_json(
        self,
        *,
        model: str,
        messages: list[dict],
        schema: dict,
        schema_name: str = "answer",
        temperature: float = 0.7,
        max_tokens: int = 600,
        seed: int | None = None,
        extra_body: dict | None = None,
        mock: Callable[[], dict] | None = None,
        task: str = "chat",
    ) -> dict:
        """Return a dict that satisfies `schema`. Raises LLMError if every attempt failed."""
        self.stats.by_task[task] = self.stats.by_task.get(task, 0) + 1
        stats = self.stats.m(model)

        if self.mock:
            if mock is None:
                raise LLMError(f"no mock function for task {task}")
            out = coerce(mock(), schema)
            problems = validate(out, schema)
            if problems:
                raise LLMError(f"mock output for {task} violates schema: {problems[:3]}")
            stats.mock_calls += 1
            prompt_chars = sum(len(m["content"]) for m in messages)
            stats.est_prompt_tokens += int(prompt_chars / 3.5) + 8 * len(messages)
            stats.est_completion_tokens += int(len(json.dumps(out, ensure_ascii=False)) / 3.5)
            return out

        if self.settings.system_suffix:
            messages = [dict(m) for m in messages]
            if messages[0]["role"] == "system":
                messages[0]["content"] += "\n" + self.settings.system_suffix
            else:
                messages.insert(0, {"role": "system", "content": self.settings.system_suffix})
        extra = dict(self.settings.extra_body if extra_body is None else extra_body)
        params = {"temperature": temperature, "max_tokens": max_tokens, "seed": seed, "extra": extra}
        key = self.cache_key(model, messages, schema, params)
        hit = self._cache_get(key)
        if hit is not None:
            stats.cache_hits += 1
            return hit["data"]

        data, usage = await self._request_with_retries(model, messages, schema, schema_name, temperature,
                                                       max_tokens, seed, extra, stats)
        self._cache_put(key, {"model": model, "data": data, "usage": usage, "created": time.time()})
        return data

    async def _request_with_retries(self, model, messages, schema, schema_name, temperature, max_tokens, seed,
                                    extra, stats: ModelStats):
        last_err: Exception | None = None
        schema_chars = len(json.dumps(schema, ensure_ascii=False))
        for attempt in range(self.settings.max_retries + 1):
            est_tokens = int((sum(len(m["content"]) for m in messages) + schema_chars) / 3.5) + max_tokens
            async with self.sem:
                ev = await self.limiter.acquire(est_tokens)
                # Build the body only now: while this request waited for a slot, another one may have
                # learned that this model rejects json_schema or the extra body.
                mode = self.schema_mode.get(model, "json_schema")
                body = self._body(model, messages, schema, schema_name, temperature, max_tokens, seed, extra, mode)
                t0 = time.monotonic()
                transport_error = None
                try:
                    r = await self.http.post("/chat/completions", json=body)
                except (httpx.TimeoutException, httpx.TransportError) as e:
                    transport_error = e
                latency = time.monotonic() - t0
            if transport_error is not None:  # back off outside the semaphore so other requests can go
                last_err = transport_error
                stats.retries += 1
                await asyncio.sleep(self._backoff(attempt))
                continue

            if r.status_code == 400:
                txt = r.text[:500].lower()
                if mode == "json_schema" and any(w in txt for w in ("response_format", "json_schema", "schema", "guided")):
                    self.schema_mode[model] = "json_object"
                    stats.schema_fallbacks += 1
                    continue
                if model not in self.no_extra and extra and any(w in txt for w in ("chat_template_kwargs", "extra", "unexpected", "unrecognized")):
                    self.no_extra.add(model)
                    continue
                stats.errors += 1
                raise LLMError(f"400 from API for {model}: {r.text[:200]}")
            if r.status_code in (401, 403):
                stats.errors += 1
                raise LLMError(f"{r.status_code}: API key rejected or model not allowed ({model})")
            if r.status_code == 404:
                stats.errors += 1
                raise LLMError(f"404: model {model} not found — run pipeline/verify_models.py")
            if r.status_code == 429 or r.status_code >= 500:
                last_err = LLMError(f"HTTP {r.status_code}")
                stats.retries += 1
                retry_after = r.headers.get("retry-after")
                wait = float(retry_after) if retry_after and retry_after.replace(".", "").isdigit() else self._backoff(attempt)
                await asyncio.sleep(min(wait, 60))
                continue
            if r.status_code != 200:
                stats.errors += 1
                raise LLMError(f"HTTP {r.status_code} for {model}")

            payload = r.json()
            usage = payload.get("usage") or {}
            ev[1] = int(usage.get("total_tokens") or ev[1])  # correct the limiter with real usage
            stats.calls += 1
            stats.latency_s += latency
            stats.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            stats.completion_tokens += int(usage.get("completion_tokens") or 0)
            try:
                choice = payload["choices"][0]
                content = choice["message"].get("content")
                data = coerce(extract_json(content), schema)
            except (KeyError, IndexError, ValueError, TypeError) as e:
                last_err = e
                stats.retries += 1
                # Cut off mid-answer (e.g. the model spent its budget "thinking"): allow more tokens next time.
                if isinstance(payload.get("choices"), list) and payload["choices"] and \
                        payload["choices"][0].get("finish_reason") == "length":
                    max_tokens = min(4000, max_tokens * 2)
                    stats.truncated += 1
                continue
            problems = validate(data, schema)
            if problems:
                last_err = LLMError(f"schema problems: {problems[:3]}")
                stats.retries += 1
                if mode == "json_schema" and attempt >= 1:
                    self.schema_mode[model] = "json_object"
                    stats.schema_fallbacks += 1
                continue
            return data, usage

        stats.errors += 1
        raise LLMError(f"giving up on {model} after {self.settings.max_retries + 1} attempts: {last_err}")

    def _body(self, model, messages, schema, schema_name, temperature, max_tokens, seed, extra, mode) -> dict:
        msgs = messages
        if mode == "json_object":
            # The model cannot enforce the schema: describe it in the prompt instead.
            msgs = [dict(m) for m in messages]
            msgs[-1]["content"] += ("\n\nRéponds uniquement avec un objet JSON valide qui respecte ce schéma JSON :\n"
                                    + json.dumps(schema, ensure_ascii=False))
        body: dict[str, Any] = {"model": model, "messages": msgs, "temperature": temperature, "max_tokens": max_tokens}
        if seed is not None:
            body["seed"] = seed
        if mode == "json_schema":
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": schema_name, "schema": schema, "strict": True}}
        else:
            body["response_format"] = {"type": "json_object"}
        if extra and model not in self.no_extra:
            body.update(extra)
        return body

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(60.0, (2 ** attempt) + random.random())

    def write_stats(self, path: Path) -> dict:
        rep = self.stats.report(self.settings, self.mock)
        write_json(path, rep, compact=False)
        return rep


# ---------------------------------------------------------------------------
# Helpers shared by the modules that build prompts
# ---------------------------------------------------------------------------

def fill(template: str, values: dict) -> str:
    """Replace {{name}} placeholders. Unknown placeholders become empty strings."""
    return re.sub(r"\{\{(\w+)\}\}", lambda m: str(values.get(m.group(1), "")), template)


def seeded_rng(*parts) -> random.Random:
    """A random generator whose output depends only on `parts` (stable across runs and machines)."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return random.Random(int(h[:16], 16))


def hash01(*parts) -> float:
    """A stable pseudo-random number in [0, 1) from `parts`."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return int(h[:13], 16) / float(16 ** 13)


def stable_seed(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return int(h[:8], 16)


async def gather_progress(coros: list, label: str, every: float = 0.1) -> list:
    """Run coroutines concurrently (the client limits concurrency) and print progress."""
    n = len(coros)
    done = 0
    next_mark = every
    t0 = time.time()

    async def wrap(c):
        nonlocal done, next_mark
        try:
            return await c
        finally:
            done += 1
            if n >= 20 and done / n >= next_mark:
                # Only report progress for slow (live) runs; mock runs finish instantly.
                if time.time() - t0 > 2.0:
                    print(f"    {label}: {done}/{n} ({time.time() - t0:.0f}s)", flush=True)
                next_mark += every

    return await asyncio.gather(*(wrap(c) for c in coros), return_exceptions=True)
