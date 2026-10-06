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
#   bash scripts/openwebui-chad-tunnel.sh install    # launchd auto-start
#   bash scripts/openwebui-chad-tunnel.sh uninstall
#
# Environment:
#   CHAD_SSH_HOST    SSH alias for the sandbox (default: openshell-chad)
#   CHAD_SHIM_PORT   Port used on both sides (default: 8901)

set -euo pipefail

PORT="${CHAD_SHIM_PORT:-8901}"
HOST="${CHAD_SSH_HOST:-openshell-chad}"
ACTION="${1:-up}"
PLIST_LABEL="dev.nemoclaw.chad-tunnel"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"

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
    if [ -f "$PLIST_PATH" ]; then
      echo "${ok}    ✓${color_off} launchd agent installed (${PLIST_LABEL})"
    else
      echo "${warn}    ·${color_off} launchd agent not installed (run: bash $0 install)"
    fi
    ;;
  install|--install)
    # Install a per-user launchd agent that keeps the SSH port-forward alive
    # across logout/reboot. KeepAlive=true makes launchd respawn ssh whenever
    # it exits (network blip, sandbox restart, manual `down`).
    ssh_bin="$(command -v ssh || echo /usr/bin/ssh)"
    mkdir -p "$(dirname "$PLIST_PATH")"
    # Stop any foreground tunnel so launchd's instance owns the port.
    if is_running; then
      pkill -f "ssh.*-L ${PORT}:" || true
      sleep 1
    fi
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ssh_bin}</string>
    <string>-N</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-L</string><string>${PORT}:127.0.0.1:${PORT}</string>
    <string>${HOST}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/chad-tunnel.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/chad-tunnel.err.log</string>
</dict>
</plist>
EOF
    # bootout is a no-op if not loaded; bootstrap loads + starts.
    launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
      :
    else
      # bootstrap can fail with "Bootstrap failed: 5" if already loaded; try
      # the legacy load path as a fallback.
      launchctl load "$PLIST_PATH"
    fi
    sleep 2
    if is_running; then
      echo "${ok}    ✓${color_off} launchd agent installed and tunnel running (${PLIST_PATH})"
    else
      echo "${err}    ✗${color_off} launchd agent installed but ssh did not start — check /tmp/chad-tunnel.err.log" >&2
      exit 1
    fi
    ;;
  uninstall|--uninstall)
    if [ -f "$PLIST_PATH" ]; then
      launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" >/dev/null 2>&1 \
        || launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
      rm -f "$PLIST_PATH"
      echo "${ok}    ✓${color_off} launchd agent removed"
    else
      echo "${warn}    ·${color_off} no launchd agent at ${PLIST_PATH}"
    fi
    # Also kill any leftover foreground tunnel.
    if is_running; then
      pkill -f "ssh.*-L ${PORT}:" || true
      echo "${ok}    ✓${color_off} foreground tunnel stopped"
    fi
    ;;
  *)
    cat >&2 <<EOF
usage: $0 [up|down|status|install|uninstall]

  up         open SSH port-forward 127.0.0.1:${PORT} → ${HOST}:${PORT}
  down       stop the SSH port-forward
  status     report tunnel pid + chad-shim health
  install    install per-user launchd agent (auto-restart on reboot)
  uninstall  remove the launchd agent

env CHAD_SHIM_PORT=${PORT}, CHAD_SSH_HOST=${HOST}
EOF
    exit 2
    ;;
esac
