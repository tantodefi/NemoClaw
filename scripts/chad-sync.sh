#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-sync — Single-command snapshot orchestrator for Chad's persistent state.
#
# Runs from the host. Wraps the four moving parts of the persistence pipeline
# into one idempotent command so a sandbox reset never silently drops state again.
#
# What it does (in order):
#   1. ssh sandbox 'chad-dump-state' → save a triage snapshot to ~/.nemoclaw/dumps/
#      (human-readable, never pushed to chad-state — local-only history of resets).
#   2. ssh sandbox 'chad-backup-to-github' → push everything in the sectioned
#      manifest (workspace .md + memory + queue + cron/jobs.json + auto-actions.json
#      + agents/ + flows/ + hooks/ + brain export) to ${CHAD_STATE_REPO:-tantodefi/chad-state}.
#   3. ssh sandbox 'openclaw cron list --json' → print a count of registered
#      cron jobs so divergence between disk (jobs.json) and gateway memory is
#      visible in the same output.
#   4. Print a summary with file counts and any errors.
#
# Usage:
#   bash scripts/chad-sync.sh             # full sync
#   bash scripts/chad-sync.sh --dry-run   # show what would be done, no remote calls
#   bash scripts/chad-sync.sh --no-dump   # skip the local dump (faster)
#   bash scripts/chad-sync.sh --sandbox foo  # target a non-default sandbox name
#
# Or via npm:
#   npm run chad:sync
#   npm run chad:sync:dry
#
# Environment:
#   CHAD_SANDBOX        sandbox name (default: chad)
#   CHAD_STATE_REPO     state repo (default: tantodefi/chad-state)
#   CHAD_DUMP_DIR       local dump directory (default: ~/.nemoclaw/dumps)

set -uo pipefail

# ── Args ───────────────────────────────────────────────────────────────────
SANDBOX="${CHAD_SANDBOX:-chad}"
STATE_REPO="${CHAD_STATE_REPO:-tantodefi/chad-state}"
DUMP_DIR="${CHAD_DUMP_DIR:-${HOME}/.nemoclaw/dumps}"
DRY_RUN=0
SKIP_DUMP=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --no-dump)   SKIP_DUMP=1; shift ;;
    --sandbox)   SANDBOX="$2"; shift 2 ;;
    -h|--help)
      sed -n '4,30p' "$0" | sed 's|^# *||'
      exit 0
      ;;
    *) echo "chad-sync: unknown arg: $1" >&2; exit 2 ;;
  esac
done

REMOTE_HOST="openshell-${SANDBOX}"

# ── Output helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

step() { echo -e "${BLUE}==>${RESET} $*"; }
info() { echo -e "    $*"; }
ok()   { echo -e "${GREEN}    ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}    !${RESET} $*"; }
fail() { echo -e "${RED}    ✗${RESET} $*"; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] $*"
  else
    "$@"
  fi
}

ssh_run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] ssh $REMOTE_HOST '$*'"
    return 0
  fi
  ssh "$REMOTE_HOST" "$@"
}

# ── Preflight ──────────────────────────────────────────────────────────────
step "chad-sync starting (sandbox='${SANDBOX}', state-repo='${STATE_REPO}')"

if [ "$DRY_RUN" -eq 0 ]; then
  if ! ssh -o ConnectTimeout=5 "$REMOTE_HOST" 'true' >/dev/null 2>&1; then
    fail "cannot ssh to ${REMOTE_HOST} — is the sandbox running?"
  fi
  ok "ssh reachable"
fi

# ── 1. Local triage dump ───────────────────────────────────────────────────
if [ "$SKIP_DUMP" -eq 1 ]; then
  step "Skipping local dump (--no-dump)"
else
  step "Capturing local triage dump"
  mkdir -p "$DUMP_DIR"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  dump_file="${DUMP_DIR}/state-${SANDBOX}-${ts}.md"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] ssh ${REMOTE_HOST} 'chad-dump-state' > ${dump_file}"
  else
    if ssh "$REMOTE_HOST" 'chad-dump-state' > "$dump_file" 2>/dev/null; then
      ok "dump saved → ${dump_file} ($(wc -l < "$dump_file" | tr -d ' ') lines)"
    else
      warn "chad-dump-state failed — continuing without dump"
      rm -f "$dump_file"
    fi
  fi
fi

# ── 2. Push to chad-state ──────────────────────────────────────────────────
step "Pushing state to ${STATE_REPO}"
backup_log="$(mktemp)"
trap 'rm -f "$backup_log"' EXIT
if [ "$DRY_RUN" -eq 1 ]; then
  echo "    [dry-run] ssh ${REMOTE_HOST} 'chad-backup-to-github'"
else
  if ssh "$REMOTE_HOST" 'chad-backup-to-github' > "$backup_log" 2>&1; then
    pushed="$(grep -c '^\[backup\]   ok:' "$backup_log" 2>/dev/null || echo 0)"
    skipped="$(grep -c '^\[backup\]   skip:' "$backup_log" 2>/dev/null || echo 0)"
    summary_line="$(grep -E '^\[backup\] Pushed' "$backup_log" | tail -1)"
    if [ -n "$summary_line" ]; then
      ok "${summary_line#\[backup\] }"
    else
      ok "pushed ${pushed} files, skipped ${skipped} unchanged"
    fi
  else
    warn "backup exited non-zero — full log:"
    sed 's/^/      /' "$backup_log"
  fi
fi

# ── 3. Cron audit: disk vs in-memory ───────────────────────────────────────
step "Auditing cron jobs (disk vs gateway memory)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "    [dry-run] ssh ${REMOTE_HOST} 'openclaw cron list --json'"
else
  audit="$(ssh "$REMOTE_HOST" "
    JOBS_FILE=/sandbox/.openclaw-data/cron/jobs.json
    disk=\$(python3 -c 'import json,sys;
try:
    d=json.load(open(\"'\"\$JOBS_FILE\"'\")); print(len(d.get(\"jobs\", [])))
except Exception:
    print(0)' 2>/dev/null || echo 0)
    mem=\$(openclaw cron list --all --json 2>/dev/null \
      | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    j = d if isinstance(d, list) else d.get(\"jobs\", []) or d.get(\"items\", [])
    print(len(j))
except Exception:
    print(-1)' 2>/dev/null || echo -1)
    echo \"\$disk \$mem\"
  " 2>/dev/null)"
  disk_count="$(echo "$audit" | awk '{print $1}')"
  mem_count="$(echo "$audit" | awk '{print $2}')"
  if [ -z "$disk_count" ] || [ -z "$mem_count" ]; then
    warn "cron audit failed — gateway may not be reachable"
  elif [ "$mem_count" = "-1" ]; then
    warn "cron list query failed — gateway may not be reachable"
  elif [ "$disk_count" = "$mem_count" ]; then
    ok "cron jobs: ${disk_count} on disk = ${mem_count} in gateway"
  else
    warn "cron drift: ${disk_count} on disk vs ${mem_count} in gateway"
    warn "  → run: ssh ${REMOTE_HOST} 'chad-cron-reload'"
  fi
fi

# ── 4. Summary ─────────────────────────────────────────────────────────────
step "Sync complete"
[ "$SKIP_DUMP" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && [ -f "${dump_file:-}" ] && info "  dump:   ${dump_file}"
[ "$DRY_RUN" -eq 0 ] && info "  remote: ${STATE_REPO}@main"
info "  next:   chad-sync runs are idempotent — re-run any time"
