# dsh — Custom Build & Full Project Backup (2026-08-25)

This repo is the complete snapshot of our customized **DeepSeek Harness (dsh)**
build — upstream base `v0.1.1-rc.2` plus every feature we built on top of it,
and a deployment kit that reproduces the running system end-to-end.

## ⚠️ Security notes — read first

- **Your OpenRouter API key is NOT in this repo** (by design). After cloning,
  create `~/.dsh/.credentials.yaml` with your key:
  ```yaml
  OPENROUTER_API_KEY: sk-or-...your-key...
  ```
- `deployment/dsh-config/sessions/` contains your chat history logs. If this
  repo is public and you want the history private, remove that folder.
- The GitHub token used to push this repo was pasted in chat — rotate it at
  https://github.com/settings/tokens when done.

## Repo layout

| Path | What it is |
|------|------------|
| `packages/`, `apps/`, `docs/`, `native/`, `examples/` | The dsh source tree with **all our customizations** (75 modified files + 5 new packages, listed below). |
| `deployment/infra/` | `fence-fix-proxy.js` (preview-URL header proxy :3000), `workspace-preview-server.js` (live file preview :3111), `sync-openrouter-models.py` (verified-model auto-sync). |
| `deployment/launcher/run-dsh.sh` | One-command startup of the full stack. |
| `deployment/dsh-config/` | Runtime config: `settings.yaml` (13 verified models, default `openrouter/free`), workspace registry, session/chat logs. |
| `deployment/screenshots/` | Verification captures of every working feature. |
| `deployment/worklog.md` | Full engineering history — every task, root cause, patch, verification. |

## Custom features (vs upstream dsh v0.1.1-rc.2)

- **Dual-mode UI** — Chat is the default mode (instantly typeable, no workspace
  picking, sessions grouped under "Chat"); NIXE is the one-click agent workspace
  (`~/NIXE`) for file-producing agentic tasks.
- **Permanent delete** — deleting a workspace or chat wipes registry + in-memory
  sessions + UI rows + disk folder + session logs, instantly, no ghosts.
- **Working web search** — keyless Bing + Google News fast path (sub-second)
  with OpenRouter `:online` fallback using your existing key
  (`packages/web/web-search-openrouter`). No DeepSeek key needed.
- **browser_use tool** — real Chromium automation via the browser-use Python
  agent (`packages/web/tool-browser`), 10-minute cooperative budget.
- **Live workspace preview** — agent-written files render at
  `/preview/<workspace>/<file>` with auto-reload while the agent writes.
- **Files UI** — `packages/client/ui-files` for viewing/editing agent-created files.
- **SQLite session persistence** — hard-delete session support
  (`packages/session/session-persistence-sqlite`).
- **13 verified OpenRouter models** in the picker; default `openrouter/free`
  (Free Models Router — quota-exempt).
- **Separate storage root** (`~/sandboxes`) for user files, away from the app tree.

## Architecture

```
browser → preview URL → fence-fix-proxy (:3000)  →  dsh web (:3100)
   header rewriting (Host/Origin)                     the app itself
                            ↘ /preview/*  →  workspace preview (:3111)
```

## Restore on a new machine

Prerequisites: Node.js 20+, pnpm 9+, Python 3.11+, uv.

1. **Install dependencies**
   ```bash
   git clone https://github.com/mmw0/deep.git deepseek-harness
   cd deepseek-harness
   pnpm install
   ```
   The repo ships prebuilt output; to rebuild from source:
   ```bash
   npx tsc -b tsconfig.host.json && npx tsdown --env.DSH_BUILD_FACE host
   ```

2. **Runtime config + your key**
   ```bash
   mkdir -p ~/.dsh
   cp -r deployment/dsh-config/. ~/.dsh/
   echo "OPENROUTER_API_KEY: sk-or-...your-key..." > ~/.dsh/.credentials.yaml
   chmod 600 ~/.dsh/.credentials.yaml ~/.dsh/settings.yaml
   ```

3. **Browser tool (browser-use) environment**
   ```bash
   uv venv ~/.venv
   uv pip install "browser-use==0.13.8"
   # Chromium downloads automatically on first browser_use run
   ```

4. **Start everything**
   ```bash
   cp deployment/infra/*.js deployment/infra/*.py /your/scripts/dir/   # or keep in place
   bash deployment/launcher/run-dsh.sh   # edit absolute paths inside first
   # → app :3100, proxy :3000, live preview :3111
   ```

## Models & quota

- Default: `openrouter/free` — routes to Inkling variants, exempt from the
  50 req/day free quota.
- The 11 `:free`-suffixed models share a 50/day quota (resets 20:00 UTC).
  `stealth/ox-alpha` is unlimited but flaky (~50% retries).
- Re-sync verified models anytime: `python3 ~/.dsh/sync-openrouter-models.py`

## Note on CI workflows

The upstream `.github/workflows/*.yml` CI pipelines were **stripped from this
repo's history** — the push token lacked GitHub's `workflow` scope. They are not
needed to build or run this project (see Restore below). If you want them back,
fetch upstream: `git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git && git fetch upstream`.

## Runtime notes

- Launched with `DSH_PERMISSION_MODE=danger-full-access` — agent Bash runs
  without approval prompts (sandbox is the isolation boundary here). Change it
  if you restore outside a sandboxed container.
- `settings.yaml` hot-reloads — model config changes need no restart.
- Stop the stack: `pkill -f "bin.ts web"` (NOT `pkill -f "dsh web"` — that only
  kills the pnpm wrapper), plus `pkill -f fence-fix-proxy` and
  `pkill -f workspace-preview-server`.
