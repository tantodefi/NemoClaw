#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# install-schedules.sh — (re)load the chad-smithers launchd timers (idempotent).
# Copies the source plists into ~/Library/LaunchAgents and bootstraps them:
#   chad-experiments  3x/day (benchmark loop: experiments + token-optimize; reports at 05:00)
#   chad-logdigest    every 6h
#   chad-mcphealth    hourly
#   chad-failreport   hourly
# Run after editing any plist. Unload one: launchctl bootout gui/$(id -u)/<label>

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
U="$(id -u)"
for label in dev.nemoclaw.chad-experiments dev.nemoclaw.chad-logdigest dev.nemoclaw.chad-mcphealth dev.nemoclaw.chad-failreport; do
  src="$HERE/$label.plist"; dst="$LA/$label.plist"
  [ -f "$src" ] || { echo "skip $label (no source plist)"; continue; }
  cp "$src" "$dst"
  launchctl bootout "gui/$U/$label" 2>/dev/null || true
  if launchctl bootstrap "gui/$U" "$dst" 2>/dev/null; then echo "loaded  $label"; else echo "FAILED  $label (try: launchctl load -w $dst)"; fi
done
echo "verify: launchctl list | grep nemoclaw"
