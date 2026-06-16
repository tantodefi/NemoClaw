#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# install-runs-ui.sh — host-side installer for the runs.supachad.com dashboard
# (serve-runs.js). Idempotent: safe to re-run. Mirrors the openwebui tunnel
# install pattern (a launchd agent + a health check).
#
# What it does:
#   1. bun install (deps for serve-runs.js).
#   2. Install + (re)load the launchd agent dev.nemoclaw.chad-runs-ui
#      (KeepAlive, binds 0.0.0.0:7331).
#   3. Health-check the local service.
#   4. Print the remaining manual steps (Cloudflare — token tunnel = dashboard).
#
# It does NOT touch Cloudflare (token-managed tunnel = dashboard-only) and does
# NOT recreate cloudflared; the host.docker.internal extra_hosts fix already
# lives in scripts/openwebui/docker-compose.yml.
#
# Usage: bash install-runs-ui.sh [--uninstall]

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="dev.nemoclaw.chad-runs-ui.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST"
BUN="${BUN:-$HOME/.bun/bin/bun}"
PORT="${CHAD_RUNS_PORT:-7331}"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$DEST" 2>/dev/null && echo "unloaded $PLIST"
  rm -f "$DEST" && echo "removed $DEST"
  exit 0
fi

cd "$HERE"

echo "1/3 deps…"
"$BUN" install >/dev/null 2>&1 && echo "    bun install ok" || { echo "    bun install FAILED"; exit 1; }

echo "    chad-runs CLI ready ($HERE/chad-runs) — Chad's API client"
chmod +x "$HERE/chad-runs" 2>/dev/null || true

echo "2/3 launchd agent…"
cp "$HERE/$PLIST" "$DEST"
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST" && echo "    loaded $PLIST" || { echo "    launchctl load FAILED"; exit 1; }

echo "3/3 health…"
sleep 3
if curl -sS --max-time 6 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then
  echo "    ✓ dashboard healthy on http://127.0.0.1:$PORT"
else
  echo "    ✗ not healthy — check: tail \$HOME/.nemoclaw/openwebui/chad-runs-ui.err.log"
  exit 1
fi

cat <<EOF

Done (host side). Remaining manual steps (one-time):
  • Cloudflare Zero Trust → Tunnels → nemoclaw-chad → Public Hostname:
      runs.supachad.com  (HTTP)  →  http://host.docker.internal:7331
  • Cloudflare Access → Application for runs.supachad.com (mirror chad.supachad.com policy)
  • cloudflared must have extra_hosts host.docker.internal:host-gateway
    (already in scripts/openwebui/docker-compose.yml; recreate cloudflared if not applied)
Verify:  curl https://runs.supachad.com/api/health   (302 → Access login = good)

Chad's API access (chad-runs):
  • Host (local):  ./chad-runs runs | workflows | launch <wf> | get <id> | logs <id>
      (auto-uses SMITHERS_RUNS_API_KEY from credentials.json against 127.0.0.1:7331)
  • Pod: deploy chad-runs to /sandbox/.openclaw-data/bin/, set
      CHAD_RUNS_URL=https://runs.supachad.com, ensure the pod credentials.json has
      SMITHERS_RUNS_API_KEY + CF_ACCESS_CLIENT_ID/SECRET. THEN add that service
      token to the runs.supachad.com Access application policy (CF dashboard) so
      it can pass Access non-interactively.
EOF
