#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-gateway-watchdog — host launchd job that detects a dead OpenClaw
# gateway in the chad pod and restarts it in-place.
#
# Why this exists: the chad pod has NO supervisor for the gateway process.
# The container's PID 1 is openshell-sandbox (just a sidecar), not the
# nemoclaw-start.sh entrypoint that originally launched the gateway. When
# the gateway crashes (e.g. OOM at 2GB V8 default heap during a heavy
# webui session), nothing restarts it. The 2026-05-12 incident left it
# dead for 9 hours, silently failing every cron + chad-shim call.
#
# This watchdog pings the WS port via SSH every 5 minutes. If the port
# isn't listening, it relaunches the gateway with NODE_OPTIONS bumped to
# 4 GB heap headroom and logs the recovery.
#
# Installed as ~/Library/LaunchAgents/dev.nemoclaw.chad-gateway-watchdog.plist
# Runs as the host user; no sandbox privileges escalate.

set -uo pipefail

SSH_HOST="${CHAD_SSH_HOST:-openshell-chad}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
LOG="${CHAD_GATEWAY_WATCHDOG_LOG:-${HOME}/.nemoclaw/openwebui/chad-gateway-watchdog.log}"
HEAP_MB="${OPENCLAW_GATEWAY_HEAP_MB:-4096}"

mkdir -p "$(dirname "$LOG")"
log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG"
}

# Cheap liveness check — ss is on the sandbox image; no node spawn needed.
if ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_HOST" "ss -tln 2>/dev/null | grep -q ':${PORT}\b'"; then
  exit 0
fi

log "gateway not listening on :${PORT} — relaunching"

# Verify there isn't already a dying process. If `openclaw gateway` is
# running but stuck (not yet bound), don't pile on a second instance.
running=$(ssh -o BatchMode=yes "$SSH_HOST" "pgrep -fc 'openclaw.*gateway run' || true")
if [ "${running:-0}" -gt 0 ]; then
  log "found ${running} stale gateway process(es) — killing before relaunch"
  ssh -o BatchMode=yes "$SSH_HOST" "pkill -9 -f 'openclaw.*gateway run' || true"
  sleep 2
fi

# Relaunch under nohup; NODE_OPTIONS gives 4 GB headroom (default V8 cap is
# ~1.7 GB which OOM'd on a 35k-token webui session). The gateway run is
# detached so it survives the SSH exit.
ssh -o BatchMode=yes "$SSH_HOST" "
  NODE_OPTIONS='--max-old-space-size=${HEAP_MB}' \
  nohup openclaw gateway run --port ${PORT} \
    > /tmp/gateway-watchdog-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 < /dev/null &
  disown 2>/dev/null || true
"

# Wait up to 30s for the port to bind.
for i in 1 2 3 4 5 6; do
  sleep 5
  if ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_HOST" "ss -tln 2>/dev/null | grep -q ':${PORT}\b'"; then
    log "gateway back up after ${i}x5s (heap=${HEAP_MB}MB)"
    exit 0
  fi
done

log "gateway DID NOT come back up after 30s — manual intervention needed"
exit 1
