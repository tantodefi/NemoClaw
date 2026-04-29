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
OPENCLAW_DATA="${CHAD_OPENCLAW_DATA:-/sandbox/.openclaw-data}"
CREDS="${CHAD_CREDENTIALS:-/sandbox/.nemoclaw/credentials.json}"
WORKSPACE_FILES_LIST="${CHAD_WORKSPACE_FILES_LIST:-/usr/local/share/chad/chad-workspace-files.txt}"

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

# Restore [runtime] files and [runtime-dirs] from the manifest. Mirrors
# what chad-backup-to-github.sh wrote: repo paths preserve their relative
# dir prefix under /sandbox/.openclaw-data/.
#
# Falls back to the original two-file restore (queue/tasks.jsonl + queue/budget.json)
# if the manifest is missing or has no [runtime] section.
RUNTIME_FILES=()
RUNTIME_DIRS=()
if [ -r "$WORKSPACE_FILES_LIST" ]; then
  current_section=""
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line//[$'\t\r\n']/}"
    line="${line## }"; line="${line%% }"
    [ -z "$line" ] && continue
    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      current_section="${BASH_REMATCH[1]}"
      continue
    fi
    case "$current_section" in
      runtime)      RUNTIME_FILES+=("$line") ;;
      runtime-dirs) RUNTIME_DIRS+=("${line%/}") ;;
    esac
  done < "$WORKSPACE_FILES_LIST"
fi
if [ "${#RUNTIME_FILES[@]}" -eq 0 ]; then
  RUNTIME_FILES=(queue/tasks.jsonl queue/budget.json)
fi

mkdir -p "$OPENCLAW_DATA"
restored_runtime=0
for f in "${RUNTIME_FILES[@]}"; do
  src="$tmp_dir/state/${f}"
  dst="${OPENCLAW_DATA}/${f}"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    restored_runtime=$((restored_runtime + 1))
    log "Restored ${f}"
  fi
done

restored_runtime_dirs=0
for d in "${RUNTIME_DIRS[@]}"; do
  src="$tmp_dir/state/${d}"
  dst="${OPENCLAW_DATA}/${d}"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -a "$src/." "$dst/"
    restored_runtime_dirs=$((restored_runtime_dirs + 1))
    log "Restored ${d}/ (recursive)"
  fi
done

[ "$restored_runtime" -gt 0 ] && log "Runtime files restored: $restored_runtime"
[ "$restored_runtime_dirs" -gt 0 ] && log "Runtime dirs restored: $restored_runtime_dirs"

# Reload cron jobs into the running gateway. Restoring cron/jobs.json to disk
# is necessary but NOT sufficient — the gateway holds the in-memory list and
# was already running with an empty list when restore happened. chad-cron-reload
# diffs the two and re-registers any missing entries.
if [ -f "${OPENCLAW_DATA}/cron/jobs.json" ] && command -v chad-cron-reload >/dev/null 2>&1; then
  if chad-cron-reload 2>&1; then
    log "Cron jobs reloaded into gateway"
  else
    warn "chad-cron-reload exited non-zero — cron jobs may not be active until next gateway restart"
  fi
fi

# Import brain pages if gbrain is available and brain/ directory has .md files.
# --no-embed skips re-embedding (embeddings are rebuilt lazily on first query if
# the inference endpoint is available). Stops gbrain serve if running, imports,
# then restarts it.
if [ -d "$tmp_dir/state/brain" ] && command -v gbrain >/dev/null 2>&1; then
  page_count="$(find "$tmp_dir/state/brain" -name '*.md' | wc -l | tr -d ' ')"
  if [ "$page_count" -gt 0 ]; then
    log "Importing ${page_count} brain pages from chad-state"
    GBRAIN_SERVE_PID="$(pgrep -f 'gbrain.*serve' | head -1 || true)"
    if [ -n "$GBRAIN_SERVE_PID" ]; then
      kill "$GBRAIN_SERVE_PID" 2>/dev/null
      for _ in 1 2 3 4 5; do
        kill -0 "$GBRAIN_SERVE_PID" 2>/dev/null || break; sleep 1
      done
    fi
    if HOME=/sandbox gbrain import "$tmp_dir/state/brain" --no-embed 2>/dev/null; then
      log "Brain import complete"
    else
      warn "Brain import failed — run 'HOME=/sandbox gbrain import brain/ --no-embed' manually"
    fi
    if [ -n "$GBRAIN_SERVE_PID" ]; then
      HOME=/sandbox nohup gbrain serve >/dev/null 2>&1 &
      log "gbrain serve restarted"
    fi
  else
    log "No brain/*.md files in chad-state — skipping brain restore"
  fi
else
  [ ! -d "$tmp_dir/state/brain" ] && log "No brain/ in chad-state — skipping brain restore"
  ! command -v gbrain >/dev/null 2>&1 && warn "gbrain not found — brain restore skipped"
fi
