#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# run-workflow.sh <workflow.jsx> — generic host-side cron driver for ONE Smithers
# workflow. Sets the NVIDIA inference env (like run-experiments.sh) so launchd
# timers can run ops/benchmark workflows on a schedule. Per-workflow flock so two
# fires never overlap (Smithers' resume already dedupes the real work).
#
# Used by dev.nemoclaw.chad-{logdigest,mcphealth,failreport}.plist.

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
WF="${1:?usage: run-workflow.sh <workflow file, e.g. workflows/log-digest.jsx>}"
SMITHERS="${SMITHERS_BIN:-$HERE/node_modules/.bin/smithers}"
CREDS="${CHAD_HOST_CREDS:-/Users/r/.nemoclaw/credentials.json}"

if [ -z "${NVIDIA_API_KEY:-}" ] && [ -f "$CREDS" ]; then
  NVIDIA_API_KEY="$(python3 -c "import json;print(json.load(open('$CREDS')).get('NVIDIA_API_KEY',''))" 2>/dev/null || true)"
  export NVIDIA_API_KEY
fi
export CHAD_INFERENCE_BASE_URL="${CHAD_INFERENCE_BASE_URL:-https://integrate.api.nvidia.com/v1}"
export CHAD_CAPABLE_BACKEND="${CHAD_CAPABLE_BACKEND:-nemotron}"
export CHAD_CHEAP_BACKEND="${CHAD_CHEAP_BACKEND:-nemotron}"
# Headless: CLI agents (claude/codex/opencode) can't auth under launchd and the
# host claude hooks pollute output — keep selection AND fallback nemotron-only.
export CHAD_DISABLE_CLI_AGENTS="${CHAD_DISABLE_CLI_AGENTS:-1}"
# NB: the cheap tier defaults to Super 120B (reasoning-off, ~3s) in agents.js — fast
# enough for the 120s cheap cap. Ultra 550B (~7 tok/s) is capable-tier only. Set
# CHAD_NEMOTRON_MODEL here only to pin a different cheap model for ops workflows.

LOCK="/tmp/chad-wf-$(basename "$WF" .jsx).lock.d"
PIDF="$LOCK/pid"
if ! mkdir "$LOCK" 2>/dev/null; then
  # Lock held — but is the holder still alive? A SIGKILL'd run (or a crash) leaves
  # the dir behind and the EXIT trap never fires, which would silently block every
  # future run. Steal a stale lock whose recorded PID is gone; bail if it's live.
  HOLDER="$(cat "$PIDF" 2>/dev/null || true)"
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "run-workflow: $WF already running (pid $HOLDER); exiting" >&2
    exit 0
  fi
  echo "run-workflow: clearing stale lock for $WF (holder ${HOLDER:-unknown} gone)" >&2
  rm -rf "$LOCK"
  if ! mkdir "$LOCK" 2>/dev/null; then
    echo "run-workflow: $WF lock re-acquire race; exiting" >&2
    exit 0
  fi
fi
echo "$$" > "$PIDF"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

echo "run-workflow: $WF @ $(date -u +%FT%TZ)" >&2
exec "$SMITHERS" up "$WF"
