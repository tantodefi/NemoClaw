#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-inbox-prune-cron — daily host launchd job that prunes the
# agent-inbox event stream to its last N entries.
#
# /sandbox/.openclaw-data/state/agent-inbox.jsonl grows unbounded as
# watchdogs append events. During the 24h chad-shim-watchdog thrash
# window of 2026-05-15→16, the file grew by ~50 noisy lines. Without
# a prune, the file ratchets up over months and the `chad-inbox tail
# --since 7d` calls take longer than they should.
#
# Default: keep the last 200 events (~ one week of normal volume,
# assuming ~30 events/day across the watchdog fleet).

set -uo pipefail

SSH_HOST="${CHAD_SSH_HOST:-openshell-chad}"
INBOX_BIN="${CHAD_INBOX_BIN:-/sandbox/.openclaw-data/bin/chad-inbox}"
KEEP="${CHAD_INBOX_PRUNE_KEEP:-200}"
LOG="${CHAD_INBOX_PRUNE_LOG:-${HOME}/.nemoclaw/openwebui/chad-inbox-prune.log}"

mkdir -p "$(dirname "$LOG")"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"; }

OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
  "${INBOX_BIN} prune --keep ${KEEP}" 2>&1)
log "${OUT}"

# Bound the local log too.
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 200 ]; then
  tail -150 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit 0
