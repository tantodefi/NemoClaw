#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Post-sandbox-creation skill setup.
# Installs npm-based tools and CLI skills into the writable sandbox area.
# Idempotent — safe to re-run after sandbox restart or rebuild.
#
# Usage (from host):
#   ssh openshell-<sandbox-name> 'bash -s' < scripts/setup-skills.sh
#
# Or copy into sandbox and run:
#   scp scripts/setup-skills.sh openshell-<sandbox-name>:/sandbox/
#   ssh openshell-<sandbox-name> 'bash /sandbox/setup-skills.sh'

set -euo pipefail

SANDBOX_HOME="/sandbox"
LOCAL_BIN="${SANDBOX_HOME}/.local/bin"
SKILLS_DIR="${SANDBOX_HOME}/.openclaw-data/skills"

echo "==> Setting up skill tooling in ${SANDBOX_HOME}"

# ── Ensure PATH dirs exist ──────────────────────────────────────
mkdir -p "${LOCAL_BIN}"

# ── npm-based tools ─────────────────────────────────────────────
cd "${SANDBOX_HOME}"

# pi coding agent (NVIDIA inference sub-agent)
if ! command -v pi &>/dev/null; then
  echo "  Installing pi coding agent..."
  npm install --no-fund --no-audit @mariozechner/pi-coding-agent 2>/dev/null
  ln -sf "${SANDBOX_HOME}/node_modules/.bin/pi" "${LOCAL_BIN}/pi"
  echo "  ✓ pi $(pi --version 2>/dev/null || echo 'installed')"
else
  echo "  ✓ pi already installed"
fi

# agent-browser (headless browser automation)
if ! command -v agent-browser &>/dev/null; then
  echo "  Installing agent-browser..."
  npm install --no-fund --no-audit agent-browser 2>/dev/null
  ln -sf "${SANDBOX_HOME}/node_modules/.bin/agent-browser" "${LOCAL_BIN}/agent-browser"
  echo "  ✓ agent-browser installed"
else
  echo "  ✓ agent-browser already installed"
fi

# ── gog CLI (Google Workspace) ──────────────────────────────────
# gog is a standalone Go binary — must be pre-copied or downloaded.
# If not present, skip with instructions.
if [ -x "${SANDBOX_HOME}/gog" ] || command -v gog &>/dev/null; then
  ln -sf "${SANDBOX_HOME}/gog" "${LOCAL_BIN}/gog" 2>/dev/null || true
  echo "  ✓ gog already installed"
else
  echo "  ⚠ gog binary not found. Copy from host:"
  echo "    scp /path/to/gog openshell-<sandbox>:/sandbox/gog"
  echo "    ssh openshell-<sandbox> 'chmod +x /sandbox/gog'"
fi

# ── PATH and env persistence ───────────────────────────────────
for rcfile in "${SANDBOX_HOME}/.bashrc" "${SANDBOX_HOME}/.profile"; do
  if ! grep -q '.local/bin' "$rcfile" 2>/dev/null; then
    echo 'export PATH="/sandbox/.local/bin:/sandbox/node_modules/.bin:$PATH"' >> "$rcfile"
  fi
done

# ── Verify ──────────────────────────────────────────────────────
export PATH="${LOCAL_BIN}:${SANDBOX_HOME}/node_modules/.bin:${PATH}"
echo ""
echo "==> Skill binary status:"
for tool in pi agent-browser gh gog; do
  if command -v "$tool" &>/dev/null; then
    echo "  ✓ ${tool}: $(command -v "$tool")"
  else
    echo "  ✗ ${tool}: not found"
  fi
done

echo ""
echo "==> Run 'openclaw skills check' to verify skill eligibility."
