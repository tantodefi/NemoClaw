#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Cron wrapper for chad-upstream-sync.sh.
#
# chad-upstream-sync.sh calls `gh pr create`, which needs the REPO OWNER's token
# (tantodefi) — Chad's "Supachad" gh account is a limited collaborator and cannot
# create PRs. The owner's classic token lives in the macOS keychain (what git uses),
# so we pull it and export it as GH_TOKEN for this run only. See the
# feedback_github_owner_vs_chad_auth memory.
#
# Scheduled weekly by dev.nemoclaw.chad-upstream-sync.plist. The underlying script
# only opens a PR when origin/chad-dev is behind upstream/main, and NEVER auto-merges
# — a human reviews and merges. Safe to run unattended.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tok="$(printf 'protocol=https\nhost=github.com\n\n' | git -C "$here/.." credential fill 2>/dev/null | grep '^password=' | cut -d= -f2- || true)"
if [ -z "$tok" ]; then
  echo "[upstream-sync-cron] ERROR: no owner GitHub token in keychain; cannot open PR" >&2
  exit 1
fi
export GH_TOKEN="$tok"

exec "$here/chad-upstream-sync.sh" "$@"
