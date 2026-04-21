#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-clone-source.sh — Runs inside Chad's sandbox.
#
# Clones (or updates) Chad's own source code at CHAD_SOURCE_DIR so the agent
# can grep/read its own skills, scripts, and policies. This is a one-time
# setup step called from scripts/chad-setup.sh after credentials are deployed.
#
# Defaults:
#   CHAD_SOURCE_REPO   — tantodefi/NemoClaw
#   CHAD_SOURCE_BRANCH — main
#   CHAD_SOURCE_DIR    — /sandbox/source
#
# Security note: `git clone` with a token in the URL stores that token in
# .git/config. Since /sandbox is owned by the sandbox user and no other users
# have access, this is acceptable. If you want stricter handling, switch to
# the git credential helper pattern.

set -euo pipefail

REPO="${CHAD_SOURCE_REPO:-tantodefi/NemoClaw}"
BRANCH="${CHAD_SOURCE_BRANCH:-main}"
DEST="${CHAD_SOURCE_DIR:-/sandbox/source}"
CREDS="${CHAD_CREDENTIALS:-/sandbox/.nemoclaw/credentials.json}"

log()  { echo "[clone] $*"; }
warn() { echo "[clone] $*" >&2; }

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
  warn "GITHUB_TOKEN not available — cannot clone source"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  warn "git not found"
  exit 1
fi

if [ -d "$DEST/.git" ]; then
  log "Updating existing clone at $DEST"
  cd "$DEST"
  # Refresh remote URL in case token was rotated
  git remote set-url origin \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
  git fetch --quiet --depth 1 origin "$BRANCH"
  git reset --quiet --hard "origin/${BRANCH}"
  log "Source updated at ${DEST} ($(git rev-parse --short HEAD))"
else
  log "Cloning ${REPO}@${BRANCH} → ${DEST}"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --depth 1 --branch "$BRANCH" \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" \
    "$DEST"
  log "Source available at ${DEST} ($(cd "$DEST" && git rev-parse --short HEAD))"
fi
