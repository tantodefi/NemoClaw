#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# run-experiments.sh — host-side nightly driver for the Smithers evolutionary
# experiment loop. Honors the cron-wrapper rule: this is the one-line entry the
# scheduler calls; Smithers itself is the durable detached driver, so there is
# no slow LLM work inside a cron agent turn.
#
# Steps:
#   1. flock so two nights never overlap (idempotent with Smithers' own resume).
#   2. `smithers up experiments.jsx` — durable; resumes a prior crashed run.
#   3. Post the leaderboard to OpenWebUI as an operator-visible note (the
#      experiment-night success criterion) via chad-webui, if available. The
#      post is best-effort and never fails the run.
#
# Usage: run-experiments.sh [--dry-run]
#
# Env: see README. CHAD_WEBUI_BIN points at the chad-webui CLI; if unset/missing
# the artifact post is skipped (run still records to experiments.db + state/).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

LOCK="/tmp/chad-experiment-smithers.lock.d"
DRY="${1:-}"
SMITHERS="${SMITHERS_BIN:-$HERE/node_modules/.bin/smithers}"
REPORT="${CHAD_EXPERIMENT_REPORT:-$HERE/state/last-report.md}"

# ── Inference backend for the cron context ──────────────────────────────────
# Under launchd the `claude` CLI can't auth (subscription is keychain/GUI-bound)
# and its user hooks pollute headless output. So nightly runs use Nemotron Ultra
# via the NVIDIA API directly — the model we actually want to evaluate, no
# keychain, no hooks. Read NVIDIA_API_KEY from host credentials at runtime (kept
# out of the plist). Override CHAD_CAPABLE_BACKEND to keep claude if running
# interactively with a logged-in shell.
CREDS="${CHAD_HOST_CREDS:-/Users/r/.nemoclaw/credentials.json}"
if [ -z "${NVIDIA_API_KEY:-}" ] && [ -f "$CREDS" ]; then
  NVIDIA_API_KEY="$(python3 -c "import json;print(json.load(open('$CREDS')).get('NVIDIA_API_KEY',''))" 2>/dev/null || true)"
  export NVIDIA_API_KEY
fi
export CHAD_INFERENCE_BASE_URL="${CHAD_INFERENCE_BASE_URL:-https://integrate.api.nvidia.com/v1}"
export CHAD_CAPABLE_BACKEND="${CHAD_CAPABLE_BACKEND:-nemotron}"
export CHAD_CHEAP_BACKEND="${CHAD_CHEAP_BACKEND:-nemotron}"

# Portable atomic lock (mkdir succeeds for exactly one racer). flock is absent
# on macOS, where this runner lives; Smithers' own resume already dedupes the
# actual work, so this only guards against two scheduler fires colliding.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "run-experiments: another run holds the lock; exiting" >&2
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

if [ "$DRY" = "--dry-run" ]; then
  DRY_RUN=1 "$SMITHERS" up experiments.jsx
  DRY_RUN=1 "$SMITHERS" up workflows/token-optimize.jsx
  DRY_RUN=1 "$SMITHERS" up workflows/bug-report.jsx
  echo "run-experiments: dry run complete (no state written, no artifact posted)"
  exit 0
fi

# Durable run. Smithers checkpoints every frame; a prior crashed run resumes.
"$SMITHERS" up experiments.jsx
rc=$?

# Best-effort operator-visible artifact. Never let a posting failure mask the run.
# chad-webui lives ON THE POD (not the host), so we stream the report over ssh
# and run it there. Verified 2026-06-13: notes create --content-file works; the
# note id is returned for later cleanup. CHAD_POD_SSH / CHAD_WEBUI_POD_BIN override.
POD_SSH="${CHAD_POD_SSH:-openshell-chad}"
POD_WEBUI="${CHAD_WEBUI_POD_BIN:-/sandbox/.openclaw-data/bin/chad-webui}"
if [ -f "$REPORT" ]; then
  title="Chad experiments — $(date -u +%Y-%m-%d)"
  # Capture the created note id to a log — `notes list` is currently broken
  # (HTTP 500), so the returned id is the only handle for later cleanup.
  note_out="$(ssh -o ConnectTimeout=15 "$POD_SSH" \
       "cat > /tmp/chad-exp-report.md && '$POD_WEBUI' notes create --title '$title' --content-file /tmp/chad-exp-report.md --tags chad-experiments" \
       < "$REPORT" 2>&1 || true)"
  note_id="$(printf '%s' "$note_out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  if [ -n "$note_id" ]; then
    printf '%s\t%s\n' "$(date -u +%FT%TZ)" "$note_id" >> "$HERE/state/posted-notes.log"
    echo "run-experiments: posted leaderboard to OpenWebUI (note $note_id)"
  else
    echo "run-experiments: OpenWebUI post failed (run still recorded at $REPORT)" >&2
  fi
else
  echo "run-experiments: no report at $REPORT to post" >&2
fi

# Model benchmark (tokenmaxxing): produces the per-(task-kind, model) scores that
# feed the runs-IDE "Model × Task" matrix. SHADOW — never applies here
# (CHAD_TOKENOPT_APPLY stays unset); any downgrade it proposes waits for operator
# approval in the dashboard. Best-effort: a failure must not mask the run's rc.
echo "run-experiments: running model benchmark (token-optimize, shadow)…" >&2
CHAD_TOKENOPT_APPLY= "$SMITHERS" up workflows/token-optimize.jsx >/dev/null 2>&1 \
  || echo "run-experiments: token-optimize benchmark non-fatal failure" >&2

# Self-bug-report (shadow): Chad scans his own failures (failed runs/nodes + logs)
# and drafts GitHub issues; any NEW bug waits for operator approval (and
# CHAD_BUGREPORT_POST=1) in the runs IDE before it is actually filed. Best-effort.
echo "run-experiments: running self-bug-report (shadow)…" >&2
"$SMITHERS" up workflows/bug-report.jsx >/dev/null 2>&1 \
  || echo "run-experiments: bug-report non-fatal failure" >&2

exit "$rc"
