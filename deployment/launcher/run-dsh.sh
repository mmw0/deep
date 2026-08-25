#!/bin/bash
# dsh launcher: starts the full stack (dsh app + fence-fix proxy + live preview)
# Web search (Bing + Google News fast path, OpenRouter :online fallback) and the
# browser_use tool (browser-use Python agent on /home/z/.venv's python3) load
# with the app — no extra services needed.
# Usage: bash /home/z/my-project/download/run-dsh.sh

set -e
cd /home/z/my-project/repos/deepseek-harness

echo "[1/4] Starting workspace live preview server (:3111)..."
pkill -f workspace-preview-server 2>/dev/null || true
(nohup node /home/z/my-project/scripts/workspace-preview-server.js > /tmp/preview-server.log 2>&1 &)
sleep 2

echo "[2/4] Starting fence-fix proxy (:3000 -> :3100, /preview -> :3111)..."
pkill -f fence-fix-proxy 2>/dev/null || true
(nohup node /home/z/my-project/scripts/fence-fix-proxy.js > /tmp/fence-proxy.log 2>&1 &)
sleep 2

echo "[3/4] Starting dsh web (:3100)..."
pkill -f "bin.ts web" 2>/dev/null || true
sleep 2
(nohup env DSH_PERMISSION_MODE=danger-full-access pnpm dsh web --no-open --port 3100 > /tmp/dsh-web.log 2>&1 &)
sleep 15

echo "[4/4] Health checks..."
curl -s --max-time 10 -o /dev/null -w "  dsh app   :3100  -> %{http_code}\n" http://127.0.0.1:3100/ || true
curl -s --max-time 10 -o /dev/null -w "  proxy     :3000  -> %{http_code}\n" http://127.0.0.1:3000/ || true
curl -s --max-time 10 -o /dev/null -w "  preview   :3111  -> %{http_code}\n" -L http://127.0.0.1:3111/ || true

echo ""
echo "App:      http://127.0.0.1:3000  (use the platform preview URL)"
echo "Preview:  /preview/  on the same URL  (e.g. /preview/Home/demo.html)"
echo "Chat Mode: mode selector (bottom-left of input) -> 'Chat Mode'"
echo "Web search: ask anything current — web_search answers in under a second"
echo "Browser:   ask the agent to browse/open a site — browser_use drives Chromium"
