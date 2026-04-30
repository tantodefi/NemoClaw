#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# openwebui-chad-tunnel — SSH port-forward for the in-sandbox `chad-shim`.
#
# The shim listens on the OpenShell sandbox at 127.0.0.1:CHAD_SHIM_PORT and
# turns OpenAI chat completions into `openclaw agent` invocations. The
# open-webui container then reaches it via host.docker.internal:<port>,
# which Docker's `host-gateway` mapping resolves to the local end of this
# SSH tunnel.
#
# Usage:
#   bash scripts/openwebui-chad-tunnel.sh            # idempotent up
#   bash scripts/openwebui-chad-tunnel.sh up
#   bash scripts/openwebui-chad-tunnel.sh down
#   bash scripts/openwebui-chad-tunnel.sh status
#
# Environment:
#   CHAD_SSH_HOST    SSH alias for the sandbox (default: openshell-chad)
#   CHAD_SHIM_PORT   Port used on both sides (default: 8901)

set -euo pipefail

PORT="${CHAD_SHIM_PORT:-8901}"
HOST="${CHAD_SSH_HOST:-openshell-chad}"
ACTION="${1:-up}"

color_off=$'\033[0m'
ok=$'\033[0;32m'
warn=$'\033[0;33m'
err=$'\033[0;31m'

is_running() {
  pgrep -f "ssh.*-L ${PORT}:" >/dev/null 2>&1
}

case "$ACTION" in
  up|--up)
    if is_running; then
      echo "${ok}    ✓${color_off} tunnel already running on 127.0.0.1:${PORT}"
      exit 0
    fi
    ssh -fN \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -L "${PORT}:127.0.0.1:${PORT}" \
      "$HOST"
    sleep 1
    if is_running; then
      echo "${ok}    ✓${color_off} tunnel up: localhost:${PORT} → ${HOST}:${PORT}"
    else
      echo "${err}    ✗${color_off} tunnel failed to start (check ssh ${HOST})" >&2
      exit 1
    fi
    ;;
  down|--down|stop)
    if ! is_running; then
      echo "${warn}    ·${color_off} tunnel not running"
      exit 0
    fi
    pkill -f "ssh.*-L ${PORT}:" || true
    sleep 1
    if is_running; then
      echo "${err}    ✗${color_off} tunnel still running after pkill" >&2
      exit 1
    fi
    echo "${ok}    ✓${color_off} tunnel down"
    ;;
  status|--status)
    if is_running; then
      pid=$(pgrep -f "ssh.*-L ${PORT}:" | head -1)
      echo "${ok}    ✓${color_off} ssh tunnel pid=${pid} (localhost:${PORT} → ${HOST}:${PORT})"
      if curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | grep -q '^200$'; then
        echo "${ok}    ✓${color_off} chad-shim /healthz responding"
      else
        echo "${err}    ✗${color_off} chad-shim not responding — is it running inside the sandbox?"
        echo "      ssh ${HOST} 'pgrep -af chad-shim.py'"
        exit 1
      fi
    else
      echo "${warn}    ·${color_off} tunnel not running (run: bash $0 up)"
      exit 1
    fi
    ;;
  *)
    cat >&2 <<EOF
usage: $0 [up|down|status]

  up      open SSH port-forward 127.0.0.1:${PORT} → ${HOST}:${PORT}
  down    stop the SSH port-forward
  status  report tunnel pid + chad-shim health

env CHAD_SHIM_PORT=${PORT}, CHAD_SSH_HOST=${HOST}
EOF
    exit 2
    ;;
esac
