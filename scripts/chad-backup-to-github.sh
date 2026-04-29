#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-backup-to-github.sh — Runs inside Chad's sandbox.
#
# Pushes /sandbox/.openclaw/workspace/ to the CHAD_STATE_REPO GitHub repo
# (default: tantodefi/chad-state, branch main). Invoked by the
# workspace-backup cron every 6 hours.
#
# Requires:
#   - gh CLI installed at /usr/bin/gh (comes from github-tools policy)
#   - GITHUB_TOKEN in /sandbox/.nemoclaw/credentials.json (deployed by
#     chad-setup.sh) OR already authenticated via `gh auth login`
#   - Target repo exists. Create it once from the host with:
#       gh repo create tantodefi/chad-state --private \
#         --description "Chad workspace state backups"
#
# Exits:
#   0 — all files uploaded successfully (or nothing to do)
#   1 — any file failed to upload, or prerequisites missing

set -euo pipefail

REPO="${CHAD_STATE_REPO:-tantodefi/chad-state}"
BRANCH="${CHAD_STATE_BRANCH:-main}"
WORKSPACE="${CHAD_WORKSPACE:-/sandbox/.openclaw/workspace}"
OPENCLAW_DATA="${CHAD_OPENCLAW_DATA:-/sandbox/.openclaw-data}"
CREDS="${CHAD_CREDENTIALS:-/sandbox/.nemoclaw/credentials.json}"

log()  { echo "[backup] $*"; }
warn() { echo "[backup] $*" >&2; }

# Load GITHUB_TOKEN from credentials if not already in the environment.
# gh CLI reads GITHUB_TOKEN automatically.
if [ -z "${GITHUB_TOKEN:-}" ] && [ -f "$CREDS" ]; then
  GITHUB_TOKEN="$(python3 -c "
import json
try:
    print(json.load(open('$CREDS')).get('GITHUB_TOKEN', ''))
except Exception:
    pass
" 2>/dev/null || echo "")"
  [ -n "$GITHUB_TOKEN" ] && export GITHUB_TOKEN
fi

if ! command -v gh >/dev/null 2>&1; then
  warn "gh not found — cannot back up"
  exit 1
fi

if [ ! -d "$WORKSPACE" ]; then
  log "No workspace at $WORKSPACE — nothing to back up"
  exit 0
fi

log "Pushing workspace → ${REPO}@${BRANCH}"

count=0
skipped=0
errors=0
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# GitHub computes blob sha as: sha1("blob <size>\0<content>"). We replicate
# that locally so we can skip files whose remote sha already matches the
# on-disk contents. Saves ~480 GH API PUTs/day (24 runs × ~20 files).
local_blob_sha() {
  local src="$1"
  local size
  size="$(wc -c < "$src" | tr -d ' ')"
  { printf 'blob %s\0' "$size"; cat "$src"; } | \
    { sha1sum 2>/dev/null || shasum -a 1; } | awk '{print $1}'
}

push_file() {
  local src="$1"
  local dst="$2"

  # Current remote sha (empty string if file doesn't exist yet)
  local sha
  sha="$(gh api "repos/${REPO}/contents/${dst}?ref=${BRANCH}" \
    --jq '.sha' 2>/dev/null || echo "")"

  # Diff check: skip the PUT entirely if the remote blob sha already
  # matches the local file. GitHub returns 422 "sha wasn't supplied" or
  # similar for no-op updates, and even successful no-op PUTs count
  # against our rate limit.
  if [ -n "$sha" ]; then
    local local_sha
    local_sha="$(local_blob_sha "$src" 2>/dev/null || echo "")"
    if [ -n "$local_sha" ] && [ "$local_sha" = "$sha" ]; then
      skipped=$((skipped + 1))
      log "  skip: ${dst} (unchanged)"
      return 0
    fi
  fi

  local content
  content="$(base64 -w0 < "$src" 2>/dev/null || base64 < "$src" | tr -d '\n')"

  local args=(
    "repos/${REPO}/contents/${dst}"
    --method PUT
    -f "message=chore(backup): workspace snapshot ${ts}"
    -f "content=${content}"
    -f "branch=${BRANCH}"
  )
  if [ -n "$sha" ]; then
    args+=(-f "sha=${sha}")
  fi

  if gh api "${args[@]}" >/dev/null 2>&1; then
    count=$((count + 1))
    log "  ok: ${dst}"
  else
    errors=$((errors + 1))
    warn "  fail: ${dst}"
  fi
}

# Sectioned manifest at /usr/local/share/chad/chad-workspace-files.txt
# (deployed by chad-setup.sh from scripts/chad-workspace-files.txt — same
# file the host-side backup-workspace.sh reads).
#
# Sections:
#   [workspace]    files under $WORKSPACE        → repo path workspace/<rel>
#   [runtime]      files under $OPENCLAW_DATA    → repo path <rel> (preserves dir prefix)
#   [runtime-dirs] dirs  under $OPENCLAW_DATA    → recursive, repo path <rel>
#   [exclude]      documentation only, never backed up
#
# Forward-compatible: unknown sections are skipped silently.
WORKSPACE_FILES_LIST="${CHAD_WORKSPACE_FILES_LIST:-/usr/local/share/chad/chad-workspace-files.txt}"
WORKSPACE_FILES=()
RUNTIME_FILES=()
RUNTIME_DIRS=()
if [ -r "$WORKSPACE_FILES_LIST" ]; then
  current_section=""
  while IFS= read -r line; do
    # Strip comments and whitespace.
    line="${line%%#*}"
    line="${line//[$'\t\r\n']/}"
    line="${line## }"; line="${line%% }"
    [ -z "$line" ] && continue
    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      current_section="${BASH_REMATCH[1]}"
      continue
    fi
    case "$current_section" in
      workspace)    WORKSPACE_FILES+=("$line") ;;
      runtime)      RUNTIME_FILES+=("$line") ;;
      runtime-dirs) RUNTIME_DIRS+=("${line%/}") ;;
      exclude|"")   : ;;
      *)            : ;;  # unknown section — forward-compat skip
    esac
  done < "$WORKSPACE_FILES_LIST"
fi
# Defaults if manifest is missing or empty (older deployments).
if [ "${#WORKSPACE_FILES[@]}" -eq 0 ]; then
  WORKSPACE_FILES=(SOUL.md USER.md IDENTITY.md AGENTS.md MEMORY.md HEARTBEAT.md TOOLS.md EMAIL-POLICY.md)
fi
if [ "${#RUNTIME_FILES[@]}" -eq 0 ]; then
  RUNTIME_FILES=(queue/tasks.jsonl queue/budget.json)
fi

# [workspace] — push under workspace/<file>
for f in "${WORKSPACE_FILES[@]}"; do
  if [ -f "${WORKSPACE}/${f}" ]; then
    push_file "${WORKSPACE}/${f}" "workspace/${f}"
  fi
done

# Memory directory (recursive). Always backed up, not listed in manifest.
if [ -d "${WORKSPACE}/memory" ]; then
  while IFS= read -r -d '' file; do
    rel="${file#${WORKSPACE}/}"
    push_file "$file" "workspace/${rel}"
  done < <(find "${WORKSPACE}/memory" -type f -print0)
fi

# [runtime] — push individual files under $OPENCLAW_DATA. Repo path keeps the
# relative dir prefix (e.g. cron/jobs.json → cron/jobs.json) so the restore
# script can mirror the structure.
for f in "${RUNTIME_FILES[@]}"; do
  if [ -f "${OPENCLAW_DATA}/${f}" ]; then
    push_file "${OPENCLAW_DATA}/${f}" "${f}"
  fi
done

# [runtime-dirs] — recursively push directories under $OPENCLAW_DATA.
for d in "${RUNTIME_DIRS[@]}"; do
  src_dir="${OPENCLAW_DATA}/${d}"
  if [ -d "$src_dir" ]; then
    while IFS= read -r -d '' file; do
      rel="${file#${OPENCLAW_DATA}/}"
      push_file "$file" "${rel}"
    done < <(find "$src_dir" -type f -print0)
  fi
done

# GBrain export — export all pages as markdown and push to brain/ in the state repo.
# gbrain export writes one .md file per page; we push each via push_file (sha-checked,
# so subsequent runs skip unchanged pages). The serve process holds the PGLite lock, so
# we stop it briefly, export, then restart it.
GBRAIN_DATA="${GBRAIN_DATA:-/sandbox/.gbrain}"
GBRAIN_SERVE_PID="$(pgrep -f 'gbrain.*serve' | head -1 || true)"
if command -v gbrain >/dev/null 2>&1 && [ -d "$GBRAIN_DATA" ]; then
  brain_export_dir="$(mktemp -d /tmp/brain-export-XXXXXX)"
  if [ -n "$GBRAIN_SERVE_PID" ]; then
    kill "$GBRAIN_SERVE_PID" 2>/dev/null
    # give the process a moment to release the lock
    for _ in 1 2 3 4 5; do
      kill -0 "$GBRAIN_SERVE_PID" 2>/dev/null || break
      sleep 1
    done
  fi
  if HOME=/sandbox gbrain export --dir "$brain_export_dir" 2>/dev/null; then
    page_count="$(find "$brain_export_dir" -name '*.md' | wc -l | tr -d ' ')"
    log "Brain export: $page_count pages"
    if [ "$page_count" -gt 0 ]; then
      while IFS= read -r -d '' md_file; do
        rel="${md_file#${brain_export_dir}/}"
        push_file "$md_file" "brain/${rel}"
      done < <(find "$brain_export_dir" -name '*.md' -print0)
    fi
  else
    warn "Brain export failed — skipped"
  fi
  rm -rf "$brain_export_dir"
  # Restart gbrain serve
  if [ -n "$GBRAIN_SERVE_PID" ]; then
    HOME=/sandbox nohup gbrain serve >/dev/null 2>&1 &
    log "gbrain serve restarted (PID $!)"
  fi
fi

log "Pushed ${count} files, skipped ${skipped} unchanged, ${errors} errors"
[ "$errors" -eq 0 ]
