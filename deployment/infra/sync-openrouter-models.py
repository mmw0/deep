#!/usr/bin/env python3
"""Sync verified-working OpenRouter models into dsh (~/.dsh/settings.yaml).

v2 improvements:
- Quota-aware: a 429 "free-models-per-day" means the ACCOUNT daily quota is
  exhausted (not a broken model) -> keep already-configured models, mark new
  ones as pending for the next run (quota resets daily at 20:00 UTC).
- Retry logic: transient upstream 429s get up to 2 retries with backoff.
- Discovers QUOTA-EXEMPT zero-priced models too (no ':free' suffix, e.g.
  openrouter/free router, stealth/* models) - these bypass the daily quota.
- Never drops a previously verified model due to quota/transient errors.
- Reads the key from ~/.dsh/.credentials.yaml.

Run anytime:
    python3 ~/.dsh/sync-openrouter-models.py
"""
import json
import re
import time
import urllib.request
import urllib.error
import os

CRED = os.path.expanduser("~/.dsh/.credentials.yaml")
SETTINGS = os.path.expanduser("~/.dsh/settings.yaml")
CATALOG_URL = "https://openrouter.ai/api/v1/models"
CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
PROBE = "Who are you? State your exact model name in one short sentence."

KEY = re.search(r"sk-or-v1-[a-zA-Z0-9]+", open(CRED).read()).group(0)

# Models that work but are not chat models (classifiers / music gen etc.)
EXCLUDE = {
    "nvidia/nemotron-3.5-content-safety:free",
    "google/lyria-3-pro-preview",
    "google/lyria-3-clip-preview",
}

# Quota-exempt routes that are ALWAYS worth having (verified working).
PINNED = [
    {"id": "openrouter/free", "name": "OpenRouter: Free Auto-Router (Unlimited)"},
]

QUOTA_MARKERS = ("free-models-per-day", "Rate limit exceeded: free-models")


def api(url, body=None, timeout=60):
    headers = {
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/deepseek-ai/deepseek-harness",
        "X-Title": "DeepSeek Harness (dsh)",
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def test_model(mid, retries=2):
    """Returns (status, latency, reply). status in: ok | quota | fail"""
    body = {"model": mid, "messages": [{"role": "user", "content": PROBE}], "max_tokens": 200}
    for attempt in range(retries + 1):
        t0 = time.time()
        try:
            data = api(CHAT_URL, body, timeout=90)
            msg = data["choices"][0]["message"]
            content = (msg.get("content") or msg.get("reasoning") or "").strip()
            return "ok", round(time.time() - t0, 1), content[:160]
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode()).get("error", {}).get("message", "")
            except Exception:
                err = ""
            if any(mk in err for mk in QUOTA_MARKERS):
                return "quota", round(time.time() - t0, 1), "account daily quota exhausted"
            if e.code == 429 and attempt < retries:  # transient upstream
                time.sleep(15)
                continue
            return "fail", round(time.time() - t0, 1), f"HTTP {e.code}: {err[:80]}"
        except Exception as e:
            if attempt < retries:
                time.sleep(10)
                continue
            return "fail", round(time.time() - t0, 1), str(e)[:80]
    return "fail", 0, "retries exhausted"


def clean_name(m):
    n = m.get("name") or m["id"]
    return re.sub(r"\s*\((free|preview)\)\s*$", "", n).strip()


def model_entry(m, name_override=None):
    return {
        "id": m["id"],
        "name": name_override or clean_name(m),
        "contextWindow": min(m.get("context_length") or 262144, 1048576),
        "maxTokens": 32768,
        "input": ["text"],
        "compat": {"thinkingFormat": "openrouter", "supportsDeveloperRole": False},
    }


def main():
    import yaml
    catalog = api(CATALOG_URL)["data"]

    # Candidates: :free models + zero-priced non-:free chat models (quota-exempt)
    free = [m for m in catalog if m["id"].endswith(":free") and m["id"] not in EXCLUDE]
    zero_priced = []
    for m in catalog:
        if m["id"].endswith(":free") or m["id"] in EXCLUDE:
            continue
        p = m.get("pricing", {})
        try:
            if float(p.get("prompt", "1") or 1) == 0 and float(p.get("completion", "1") or 1) == 0:
                arch = m.get("architecture", {})
                if "text" in (arch.get("input_modalities") or []) and "text" in (arch.get("output_modalities") or []):
                    zero_priced.append(m)
        except (ValueError, TypeError):
            pass
    print(f"Catalog: {len(catalog)} models | {len(free)} :free | {len(zero_priced)} zero-priced non-:free")

    cfg = yaml.safe_load(open(SETTINGS))
    route = cfg["llm-pi-ai"]["providers"].get("openrouter-verified") or {"models": []}
    existing = {m["id"]: m for m in route.get("models", [])}

    verified, pending_quota = [], []
    # 1. Always include pinned quota-exempt routes
    for p in PINNED:
        entry = dict(p)
        entry.update({"contextWindow": 200000, "maxTokens": 32768, "input": ["text"],
                      "compat": {"thinkingFormat": "openrouter", "supportsDeveloperRole": False}})
        verified.append(entry)

    # 2. Test zero-priced non-:free candidates (quota-exempt, always testable)
    for m in zero_priced:
        status, lat, reply = test_model(m["id"])
        mark = {"ok": "OK  ", "quota": "QUOTA", "fail": "FAIL"}[status]
        print(f"[exempt] {mark} {m['id']} ({lat}s) {reply[:80]}")
        if status == "ok":
            verified.append(model_entry(m))
        time.sleep(3)

    # 3. Test :free candidates
    for i, m in enumerate(free, 1):
        mid = m["id"]
        status, lat, reply = test_model(mid)
        mark = {"ok": "OK  ", "quota": "QUOTA", "fail": "FAIL"}[status]
        print(f"[{i}/{len(free)}] {mark} {mid} ({lat}s) {reply[:80]}")
        if status == "ok":
            verified.append(model_entry(m))
        elif status == "quota":
            # Account quota exhausted: keep existing config, defer new ones
            if mid in existing:
                verified.append(existing[mid])
            else:
                pending_quota.append(mid)
        time.sleep(2)

    # 4. Merge: keep any existing model not re-tested now (e.g. quota-deferred)
    seen = {v["id"] for v in verified}
    for mid, entry in existing.items():
        if mid not in seen:
            verified.append(entry)
            seen.add(mid)

    # Dedup by id, PINNED names win
    final = {}
    for v in verified:
        final[v["id"]] = v
    for p in PINNED:
        if p["id"] in final:
            final[p["id"]]["name"] = p["name"]

    cfg["llm-pi-ai"]["providers"]["openrouter-verified"] = {
        "displayName": "OpenRouter (Verified Free)",
        "api": "openai-completions",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "defaultMaxTokens": 32768,
        "models": list(final.values()),
    }
    yaml.safe_dump(cfg, open(SETTINGS, "w"), sort_keys=False, allow_unicode=True)

    print(f"\nPicker now has {len(final)} models:")
    for v in final.values():
        print(f"  - {v['id']}")
    if pending_quota:
        print(f"\nPending verification after daily quota reset (20:00 UTC): {pending_quota}")
        print("Re-run this script after the reset to verify them.")


if __name__ == "__main__":
    main()
