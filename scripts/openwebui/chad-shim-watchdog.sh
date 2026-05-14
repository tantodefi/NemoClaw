#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-shim-watchdog — host launchd job that supervises chad-shim.py
# inside the chad pod.
#
# Why this exists: chad-shim is the OpenAI-compatible bridge between
# open-webui (the `chad` model) and the openclaw agent. It's a stdlib
# Python HTTP server; if it dies (uncaught BrokenPipeError on a client
# drop, OOM, etc.), open-webui shows "model not found" until something
# restarts it. The only existing recovery path is the once-every-6h
# self-heal block inside chad-backup-to-github — leaves a multi-hour
# window where operators can't chat with chad.
#
# This watchdog matches the chad-gateway-watchdog pattern: probe a
# cheap endpoint (/v1/models), and if it doesn't respond, restart the
# shim. Each restart also writes a structured event to the agent-inbox
# so future chad turns see the incident.
#
# Installed as ~/Library/LaunchAgents/dev.nemoclaw.chad-shim-watchdog.plist.

set -uo pipefail

SSH_HOST="${CHAD_SSH_HOST:-openshell-chad}"
SHIM_PORT="${CHAD_SHIM_PORT:-8901}"
SHIM_PATCHED="${CHAD_SHIM_PATCHED:-/sandbox/.openclaw-data/bin/chad-shim.py}"
SHIM_FALLBACK="${CHAD_SHIM_FALLBACK:-/usr/local/bin/chad-shim.py}"
INBOX="${CHAD_AGENT_INBOX:-/sandbox/.openclaw-data/state/agent-inbox.jsonl}"
LOG="${CHAD_SHIM_WATCHDOG_LOG:-${HOME}/.nemoclaw/openwebui/chad-shim-watchdog.log}"

mkdir -p "$(dirname "$LOG")"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"; }

# Trim local log to last ~1000 lines.
trim_log() {
  if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 1000 ]; then
    tail -800 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# Probe — cheap: just hit /v1/models on the tunnel. Tunnel pid is supervised by
# chad-tunnel.plist; if the tunnel is wedged, kicking the shim won't fix it.
# Empty reply / non-2xx / curl error → shim is down.
if curl -fsS -m 5 "http://127.0.0.1:${SHIM_PORT}/v1/models" >/dev/null 2>&1; then
  trim_log
  exit 0
fi

log "shim not responding on :${SHIM_PORT} — checking pod state"

# Check whether the process is alive on the pod side. If alive but unresponsive,
# kill it first to avoid two competing instances on the same port.
RUNNING=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
  "pgrep -fc 'chad-shim.py' || true")
RUNNING="${RUNNING:-0}"

if [ "$RUNNING" -gt 0 ]; then
  log "found ${RUNNING} chad-shim process(es) on pod — killing before relaunch"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
    "pkill -9 -f 'chad-shim.py' || true"
  sleep 2
fi

# Relaunch under nohup. Prefer the sandbox-writable copy (operator routing v0.2);
# fall back to image binary.
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "
  if [ -x '${SHIM_PATCHED}' ]; then
    HOME=/sandbox nohup '${SHIM_PATCHED}' > /tmp/chad-shim.log 2>&1 < /dev/null &
    disown 2>/dev/null || true
    echo started_patched
  elif [ -x '${SHIM_FALLBACK}' ]; then
    HOME=/sandbox nohup '${SHIM_FALLBACK}' > /tmp/chad-shim.log 2>&1 < /dev/null &
    disown 2>/dev/null || true
    echo started_fallback
  else
    echo no_binary
    exit 5
  fi
" >> "$LOG" 2>&1
RC=$?

# Wait up to 30s for the port to start accepting.
RECOVERED=0
for i in 1 2 3 4 5 6; do
  sleep 5
  if curl -fsS -m 5 "http://127.0.0.1:${SHIM_PORT}/v1/models" >/dev/null 2>&1; then
    log "shim back up after ${i}x5s"
    RECOVERED=1
    break
  fi
done

# Inbox event — structured so cron / chat agent turns can surface it.
SEVERITY="info"
KIND="chad-shim-restarted"
if [ $RECOVERED -eq 0 ]; then
  SEVERITY="error"
  KIND="chad-shim-restart-failed"
  log "shim DID NOT come back up after 30s — manual intervention may be needed"
fi
INBOX_LINE=$(printf '{"ts":"%s","source":"chad-shim-watchdog","kind":"%s","severity":"%s","recovered":%s,"running_before_kill":%d,"exit_code":%d}' \
  "$(ts)" "$KIND" "$SEVERITY" \
  "$([ $RECOVERED -eq 1 ] && echo true || echo false)" \
  "$RUNNING" "$RC")
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "
  mkdir -p \$(dirname '$INBOX')
  echo '$INBOX_LINE' >> '$INBOX'
" >> "$LOG" 2>&1 || true

trim_log
[ $RECOVERED -eq 1 ] && exit 0 || exit 1
