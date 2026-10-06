#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-moshi-hook-refresh.sh — keep the Moshi claude hooks CURRENT so Chad-session
# continue/permission alerts keep firing. moshi-hook auto-updates (homebrew) and
# periodically adds new hook event types (e.g. PreToolUse[AskUserQuestion],
# PreToolUse[ExitPlanMode]); when it does, the installed ~/.claude/settings.json
# hook config goes STALE and alerts silently stop until `moshi-hook install` is
# re-run. This guard detects the stale state and re-installs — the durable fix for
# the "Moshi stopped alerting" recurrence.
#
# Runs from launchd (dev.nemoclaw.moshi-hook-refresh.plist): RunAtLoad + daily.
# Safe + idempotent: no-op when hooks are already current.

set -uo pipefail
HOOK="${MOSHI_HOOK_BIN:-/opt/homebrew/bin/moshi-hook}"
[ -x "$HOOK" ] || { echo "moshi-refresh: moshi-hook not found at $HOOK; skipping" >&2; exit 0; }

status="$("$HOOK" status 2>/dev/null)" || { echo "moshi-refresh: status failed; skipping" >&2; exit 0; }

# The status line for the claude target looks like:  "claude   stale   missing: …"
# or "claude   current  <path>". Re-install only when it's not current.
claude_line="$(printf '%s\n' "$status" | grep -E '^\s*claude\b' | head -1)"
if printf '%s' "$claude_line" | grep -qiE '\bcurrent\b'; then
  echo "moshi-refresh: claude hooks current — no-op" >&2
  exit 0
fi

echo "moshi-refresh: claude hooks not current ($claude_line) — re-installing" >&2
if "$HOOK" install --target claude 2>&1; then
  echo "moshi-refresh: re-installed; now: $("$HOOK" status 2>/dev/null | grep -E '^\s*claude\b' | head -1)" >&2
else
  echo "moshi-refresh: install failed" >&2
  exit 1
fi
