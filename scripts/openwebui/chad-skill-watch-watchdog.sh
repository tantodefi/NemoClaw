#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-skill-watch-watchdog — host launchd job that runs chad-skill-watch
# inside the chad pod.
#
# Why this exists: the openclaw cron version of chad-skill-watch wrapped
# each invocation in a full agent turn that:
#   1. Cost ~30k tokens to invoke a pure shell diff
#   2. Reliably failed with "⚠️ ✉️ Message failed" — the post-run delivery
#      resolver hits "Channel is required" even with mode=none + bestEffort,
#      and the error string gets surfaced as the cron run's status.
#
# Same pattern that worked for spawn-poll: move it off the agent layer.
# The script is `openclaw skills list --json` + a diff against a snapshot —
# zero LLM reasoning needed. Output still lands in today's memory so the
# signal-detector skill picks new skills up on chad's next reasoning cycle.
#
# Schedule: every 1h via StartInterval. The job is cheap (one openclaw
# skills list call); checking faster than daily means new skills (e.g.
# from chad-setup.sh runs or gstack-upgrade) surface within ~1h instead
# of waiting for the next day's run.

set -uo pipefail

SSH_HOST="${CHAD_SSH_HOST:-openshell-chad}"
INBOX="${CHAD_AGENT_INBOX:-/sandbox/.openclaw-data/state/agent-inbox.jsonl}"
LOG="${CHAD_SKILL_WATCH_WATCHDOG_LOG:-${HOME}/.nemoclaw/openwebui/chad-skill-watch-watchdog.log}"

mkdir -p "$(dirname "$LOG")"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"; }

trim_log() {
  if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 1000 ]; then
    tail -800 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# Run the wrapper. Prefer sandbox-writable shim path; fall back to image binary.
OUTPUT=$(
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" "
    if [ -x /sandbox/.openclaw-data/bin/chad-skill-watch ]; then
      /sandbox/.openclaw-data/bin/chad-skill-watch 2>&1
    else
      /usr/local/bin/chad-skill-watch 2>&1
    fi
  "
)
RC=$?

# Classify. The wrapper emits one of:
#   chad-skill-watch: no changes (N skills)        -> quiet, no inbox entry
#   chad-skill-watch: +A -R ~C (total N skills)    -> changes detected
#   chad-skill-watch: <error>                       -> something broke
event_kind=""
severity=""
case "$OUTPUT" in
  *"no changes"*)
    log "quiet rc=$RC out=$(printf '%s' "$OUTPUT" | head -c 80)"
    trim_log
    exit 0
    ;;
  *"+"*"-"*"~"*"(total"*)
    event_kind="skills-changed"
    severity="info"
    ;;
esac
if [ $RC -ne 0 ] || [ -z "$event_kind" ]; then
  event_kind="skill-watch-error"
  severity="error"
fi

SUMMARY=$(printf '%s' "$OUTPUT" | head -c 600 | tr '\n' ' ' | sed 's/"/\\"/g')
INBOX_LINE=$(printf '{"ts":"%s","source":"chad-skill-watch-watchdog","kind":"%s","severity":"%s","exit_code":%d,"summary":"%s"}' \
  "$(ts)" "$event_kind" "$severity" "$RC" "$SUMMARY")

ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "
  mkdir -p \$(dirname '$INBOX')
  echo '$INBOX_LINE' >> '$INBOX'
" >> "$LOG" 2>&1 || true

log "kind=$event_kind severity=$severity rc=$RC summary=$(printf '%s' "$SUMMARY" | head -c 160)"
trim_log
exit 0
