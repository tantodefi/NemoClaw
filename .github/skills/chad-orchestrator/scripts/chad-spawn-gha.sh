#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-spawn-gha — GitHub Actions substrate runner for chad-spawn.
#
# Invoked by chad-spawn when a kind manifest sets `substrate: gha` (or
# the caller passes `--substrate gha`). Pushes the spawn config to
# `tantodefi/chad-state` on a chad-spawn/<task_id> branch, triggers the
# agent-job.yml workflow, polls until the runner commits result.json
# back, copies result + logs into the local workdir.
#
# Sync mode only in v1 (matches existing chad-spawn caller contract).
# Async + webhook callback is Phase C (see docs/design/spawn-as-github-run.md).
#
# Required env (passed by chad-spawn parent):
#   CHAD_GHA_TASK_ID          uuid
#   CHAD_GHA_KIND             kind name
#   CHAD_GHA_WORKDIR          local subagents/<id>/ dir
#   CHAD_GHA_RESULT_FILE      where to write result.json
#   CHAD_GHA_PROMPT_FILE      rendered prompt
#   CHAD_GHA_TASK_FILE        original task input
#   CHAD_GHA_MANIFEST_FILE    the kind manifest yaml
#   CHAD_GHA_BINARY           manifest binary (sandbox absolute path)
#   CHAD_GHA_INVOCATION       prompt-stdin | prompt-arg
#   CHAD_GHA_TIMEOUT          seconds
#   CHAD_GHA_BUDGET_TOKENS    token budget
#
# Optional env:
#   CHAD_STATE_REPO           default: tantodefi/chad-state
#   CHAD_GHA_POLL_INTERVAL    seconds between polls (default 10)
#   CHAD_GHA_POLL_EXTRA       extra timeout for runner cold start (default 180)
#
# Exit codes:
#    0  ran (result extracted, exit_code may still be non-zero — read result.json)
#    5  gha plumbing failure (clone / push / dispatch / poll-timeout)
#    7  result.json missing or unparseable

set -uo pipefail

REPO="${CHAD_STATE_REPO:-tantodefi/chad-state}"
POLL_INTERVAL="${CHAD_GHA_POLL_INTERVAL:-10}"
POLL_EXTRA="${CHAD_GHA_POLL_EXTRA:-180}"
NO_POLL="${CHAD_GHA_NO_POLL:-0}"

# Required-env check
for v in CHAD_GHA_TASK_ID CHAD_GHA_KIND CHAD_GHA_WORKDIR CHAD_GHA_RESULT_FILE \
         CHAD_GHA_PROMPT_FILE CHAD_GHA_TASK_FILE CHAD_GHA_MANIFEST_FILE \
         CHAD_GHA_BINARY CHAD_GHA_INVOCATION CHAD_GHA_TIMEOUT CHAD_GHA_BUDGET_TOKENS; do
  if [ -z "${!v:-}" ]; then
    echo "chad-spawn-gha: required env $v missing" >&2
    exit 5
  fi
done

task_id="$CHAD_GHA_TASK_ID"
kind="$CHAD_GHA_KIND"
workdir="$CHAD_GHA_WORKDIR"
result_file="$CHAD_GHA_RESULT_FILE"
prompt_file="$CHAD_GHA_PROMPT_FILE"
task_file="$CHAD_GHA_TASK_FILE"
manifest_file="$CHAD_GHA_MANIFEST_FILE"
binary="$CHAD_GHA_BINARY"
invocation="$CHAD_GHA_INVOCATION"
timeout_secs="$CHAD_GHA_TIMEOUT"
budget_tokens="$CHAD_GHA_BUDGET_TOKENS"

branch="chad-spawn/${task_id}"
spawn_path="spawns/${task_id}"
state_dir="$(mktemp -d -t "chad-state-spawn-${task_id}-XXXXXX")"
trap 'rm -rf "$state_dir"' EXIT

mkdir -p "$workdir"

log() { echo "[chad-spawn-gha] $*" >&2; }
fail() { log "FAIL: $*"; exit "${2:-5}"; }

# Sanity: gh CLI present and authenticated
command -v gh >/dev/null 2>&1 || fail "gh CLI not found in PATH"
gh auth status --hostname github.com >/dev/null 2>&1 || fail "gh not authenticated"

# ── 1. Clone chad-state ──────────────────────────────────────────────
log "cloning $REPO -> $state_dir"
gh repo clone "$REPO" "$state_dir" -- --depth 1 --quiet \
  >>"${workdir}/gha.log" 2>&1 || fail "clone failed; see ${workdir}/gha.log"

cd "$state_dir"

# ── 2. Create spawn branch + push task config ────────────────────────
git checkout -b "$branch" >>"${workdir}/gha.log" 2>&1 \
  || fail "branch create failed"
mkdir -p "$spawn_path"
cp "$prompt_file" "${spawn_path}/prompt.txt"
case "$task_file" in
  *.json) cp "$task_file" "${spawn_path}/task.json" ;;
  *)      cp "$task_file" "${spawn_path}/task.txt"  ;;
esac
cp "$manifest_file" "${spawn_path}/kind.yaml"

# Synthesize manifest.json the runner reads
python3 - <<PY > "${spawn_path}/manifest.json"
import json, datetime
print(json.dumps({
    "task_id": "$task_id",
    "kind": "$kind",
    "binary": "$binary",
    "invocation": "$invocation",
    "timeout_secs": int("$timeout_secs"),
    "budget_tokens": int("$budget_tokens"),
    "substrate": "gha",
    "created_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}, indent=2))
PY

git config user.email "supachad@proton.me"
git config user.name "Chad (sandbox)"
git add "${spawn_path}/"
git commit -m "chad-spawn(${task_id}): queued (kind=${kind} substrate=gha)" \
  >>"${workdir}/gha.log" 2>&1 || fail "commit failed"
git push -u origin "$branch" --quiet \
  >>"${workdir}/gha.log" 2>&1 || fail "push failed"

# ── 3. Trigger workflow_dispatch ─────────────────────────────────────
log "triggering agent-job.yml workflow on $REPO"
gh workflow run agent-job.yml \
  --repo "$REPO" \
  -f "task_id=${task_id}" \
  -f "branch=${branch}" \
  >>"${workdir}/gha.log" 2>&1 || fail "workflow_dispatch failed; see ${workdir}/gha.log"

# Async mode: dispatch only, return without polling. chad-spawn-poll
# cron will reconcile when the runner commits result.json back.
if [ "$NO_POLL" = "1" ]; then
  log "async mode: dispatched workflow on branch ${branch}, returning"
  echo "0"
  exit 0
fi

# ── 4. Poll for result.json on the spawn branch ──────────────────────
poll_timeout=$(( timeout_secs + POLL_EXTRA ))
poll_start=$(date +%s)
log "polling for result (timeout ${poll_timeout}s, interval ${POLL_INTERVAL}s)"

while true; do
  elapsed=$(( $(date +%s) - poll_start ))
  if [ "$elapsed" -gt "$poll_timeout" ]; then
    fail "poll timeout (${poll_timeout}s); workflow may still be running" 5
  fi
  git fetch origin "$branch" --quiet 2>/dev/null || true
  git reset --hard "origin/${branch}" --quiet 2>/dev/null || true
  if [ -f "${spawn_path}/result.json" ]; then
    log "result detected after ${elapsed}s"
    break
  fi
  sleep "$POLL_INTERVAL"
done

# ── 5. Copy result + logs back to local workdir ──────────────────────
cp "${spawn_path}/result.json" "$result_file" \
  || fail "result copy failed" 7
[ -f "${spawn_path}/stdout.log" ] && cp "${spawn_path}/stdout.log" "${workdir}/stdout.log" || true
[ -f "${spawn_path}/stderr.log" ] && cp "${spawn_path}/stderr.log" "${workdir}/stderr.log" || true

# Extract exit_code from result for parent's ledger entry
exit_code="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get("exit_code", 0))
except Exception:
    print(1)
' "$result_file" 2>/dev/null || echo 1)"

log "spawn complete: exit_code=${exit_code} branch=${branch}"
echo "$exit_code"
exit 0
