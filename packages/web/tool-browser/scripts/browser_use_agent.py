#!/usr/bin/env python3
"""browser-use agent wrapper for the dsh `browser_use` tool.

Reads one JSON object from stdin:
    { "task": string,            # required: natural-language browser task
      "url":  string?,           # optional: first URL to open
      "max_steps": int?,         # optional: step budget (default 20)
      "model": string?           # optional: OpenRouter model override
    }

Environment:
    OPENROUTER_API_KEY   required (resolved by the dsh credentials service)
    BROWSER_USE_MODEL    default model when the payload names none
    BROWSER_USE_DEBUG    "1" enables browser-use verbose logging on stderr

Writes one JSON object to stdout:
    { "ok": bool,
      "result": string,          # final agent answer
      "urls": [string],          # distinct URLs visited, in order
      "steps": int,              # number of agent steps taken
      "duration_seconds": float,
      "error"?: string           # present when ok is false
    }

Exit status is always 0 when the JSON envelope was produced; the `ok` flag
carries the outcome so a failed agent run still returns parseable output.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

DEFAULT_MODEL = os.environ.get("BROWSER_USE_MODEL", "stealth/ox-alpha")
DEFAULT_MAX_STEPS = 20
STEP_TIMEOUT_SECONDS = 120


async def run_agent(payload: dict) -> dict:
    from browser_use import Agent, BrowserProfile, BrowserSession
    from browser_use.llm.openrouter.chat import ChatOpenRouter

    task = payload["task"].strip()
    if not task:
        return {"ok": False, "result": "", "urls": [], "steps": 0,
                "duration_seconds": 0.0, "error": "task must be a non-empty string"}

    model = payload.get("model") or DEFAULT_MODEL
    max_steps = int(payload.get("max_steps") or DEFAULT_MAX_STEPS)
    max_steps = max(1, min(max_steps, 50))
    start_url = payload.get("url")

    llm = ChatOpenRouter(
        model=model,
        api_key=os.environ["OPENROUTER_API_KEY"],
        temperature=0,
        max_retries=5,
    )

    profile = BrowserProfile(
        headless=True,
        chromium_sandbox=False,   # container-safe: Chromium runs without a user namespace
        highlight_elements=False,
        wait_between_actions=0.1,
    )
    session = BrowserSession(browser_profile=profile)

    if start_url:
        task = f"First navigate to {start_url}. Then: {task}"

    agent = Agent(task=task, llm=llm, browser_session=session, use_vision=False)

    try:
        history = await asyncio.wait_for(agent.run(max_steps=max_steps),
                                         timeout=max_steps * STEP_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        return {"ok": False, "result": "", "urls": [], "steps": 0,
                "duration_seconds": float(max_steps * STEP_TIMEOUT_SECONDS),
                "error": f"browser task exceeded the {max_steps * STEP_TIMEOUT_SECONDS}s budget"}
    except Exception as exc:  # noqa: BLE001 - surface any agent failure as data
        return {"ok": False, "result": "", "urls": [], "steps": 0,
                "duration_seconds": 0.0, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        try:
            await session.close()
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass

    try:
        urls = list(dict.fromkeys(history.urls()))
    except Exception:  # noqa: BLE001
        urls = []
    try:
        steps = history.number_of_steps()
    except Exception:  # noqa: BLE001
        steps = 0
    try:
        duration = round(float(history.total_duration_seconds()), 1)
    except Exception:  # noqa: BLE001
        duration = 0.0

    result = history.final_result() or ""
    errors = []
    try:
        errors = [str(e) for e in history.errors() if e]
    except Exception:  # noqa: BLE001
        errors = []

    ok = bool(result) and not history.has_errors()
    if not result and errors:
        result = "Agent failed: " + "; ".join(errors[:3])

    return {
        "ok": ok,
        "result": str(result),
        "urls": urls,
        "steps": steps,
        "duration_seconds": duration,
        **({"error": "; ".join(errors[:3])} if errors else {}),
    }


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "result": "", "urls": [], "steps": 0,
                          "duration_seconds": 0.0, "error": f"invalid JSON input: {exc}"}))
        return

    if "OPENROUTER_API_KEY" not in os.environ:
        print(json.dumps({"ok": False, "result": "", "urls": [], "steps": 0,
                          "duration_seconds": 0.0,
                          "error": "OPENROUTER_API_KEY is not set in the environment"}))
        return

    if os.environ.get("BROWSER_USE_DEBUG") == "1":
        import logging
        logging.basicConfig(level=logging.DEBUG, stream=sys.stderr)

    try:
        envelope = asyncio.run(run_agent(payload))
    except Exception as exc:  # noqa: BLE001 - never emit non-JSON to stdout
        envelope = {"ok": False, "result": "", "urls": [], "steps": 0,
                    "duration_seconds": 0.0, "error": f"{type(exc).__name__}: {exc}"}
    sys.stdout.write(json.dumps(envelope))


if __name__ == "__main__":
    main()
