#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-restore-from-github.sh — Runs inside Chad's sandbox.
#
# Pulls /sandbox/.openclaw/workspace/ contents from CHAD_STATE_REPO
# (default: tantodefi/chad-state, branch main) back into the workspace.
# Intended as a disaster-recovery fallback when chad-setup.sh finds no
# local backup in ~/.nemoclaw/backups/.
#
# Requires:
#   - git installed at /usr/bin/git
#   - GITHUB_TOKEN in /sandbox/.nemoclaw/credentials.json
#
# Exits:
#   0 — files restored (or nothing to restore)
#   1 — clone failed / prerequisites missing

set -euo pipefail

REPO="${CHAD_STATE_REPO:-tantodefi/chad-state}"
BRANCH="${CHAD_STATE_BRANCH:-main}"
WORKSPACE="${CHAD_WORKSPACE:-/sandbox/.openclaw/workspace}"
CREDS="${CHAD_CREDENTIALS:-/sandbox/.nemoclaw/credentials.json}"

log()  { echo "[restore] $*"; }
warn() { echo "[restore] $*" >&2; }

if [ -z "${GITHUB_TOKEN:-}" ] && [ -f "$CREDS" ]; then
  GITHUB_TOKEN="$(python3 -c "
import json
try:
    print(json.load(open('$CREDS')).get('GITHUB_TOKEN', ''))
except Exception:
    pass
" 2>/dev/null || echo "")"
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  warn "GITHUB_TOKEN not available — cannot restore"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  warn "git not found — cannot restore"
  exit 1
fi

mkdir -p "$WORKSPACE/memory"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

log "Cloning ${REPO}@${BRANCH}"
if ! git clone --quiet --depth 1 --branch "$BRANCH" \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" \
    "$tmp_dir/state" 2>/dev/null; then
  warn "Clone failed — ${REPO}@${BRANCH} may not exist yet"
  exit 1
fi

if [ ! -d "$tmp_dir/state/workspace" ]; then
  log "No workspace/ directory in ${REPO} — nothing to restore"
  exit 0
fi

# Copy workspace contents in place (does not delete files that exist
# locally but not in the snapshot — safer for partial restores).
cp -a "$tmp_dir/state/workspace/." "$WORKSPACE/"

count="$(find "$tmp_dir/state/workspace" -type f | wc -l | tr -d ' ')"
log "Restored ${count} files to ${WORKSPACE}"

# Restore queue/tasks.jsonl and budget.json if present.
QUEUE_FILE="${CHAD_QUEUE_FILE:-/sandbox/.openclaw-data/queue/tasks.jsonl}"
BUDGET_FILE="${CHAD_BUDGET_FILE:-/sandbox/.openclaw-data/budget.json}"
if [ -f "$tmp_dir/state/queue/tasks.jsonl" ]; then
  mkdir -p "$(dirname "$QUEUE_FILE")"
  cp "$tmp_dir/state/queue/tasks.jsonl" "$QUEUE_FILE"
  log "Restored task queue ($(wc -l < "$QUEUE_FILE") entries)"
fi
if [ -f "$tmp_dir/state/queue/budget.json" ]; then
  cp "$tmp_dir/state/queue/budget.json" "$BUDGET_FILE"
  log "Restored budget.json"
fi

# Import brain pages if gbrain is available and brain/pages.ndjson exists.
GBRAIN_DIR="${GBRAIN_DIR:-/sandbox/.openclaw-data/gbrain}"
if [ -f "$tmp_dir/state/brain/pages.ndjson" ] && command -v gbrain >/dev/null 2>&1; then
  page_count="$(wc -l < "$tmp_dir/state/brain/pages.ndjson" | tr -d ' ')"
  log "Importing ${page_count} brain pages from chad-state"
  # gbrain import reads NDJSON from stdin; --skip-existing avoids re-importing
  # pages that were already in the brain from a partial prior restore.
  if gbrain import --skip-existing < "$tmp_dir/state/brain/pages.ndjson" 2>/dev/null; then
    log "Brain import complete"
  else
    warn "Brain import failed — brain may be empty; run 'gbrain init' and retry"
  fi
else
  [ ! -f "$tmp_dir/state/brain/pages.ndjson" ] && log "No brain/pages.ndjson in chad-state — skipping brain restore"
  ! command -v gbrain >/dev/null 2>&1 && warn "gbrain not found — brain restore skipped (image may need rebuild)"
fi
