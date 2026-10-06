#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: normalize-bug-title.sh [raw subject text]

Normalizes chat or ProtonMail subjects into a GitHub bug title.
If no argument is provided, reads from stdin.
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

raw_subject=""
if [ "$#" -gt 0 ]; then
  raw_subject="$*"
elif [ ! -t 0 ]; then
  raw_subject="$(cat)"
fi

title="$(printf '%s' "$raw_subject" | tr '\r\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//')"

while :; do
  stripped="$(printf '%s' "$title" | sed -E 's/^\[[^]]+\][[:space:]]*//; s/^(Re|Fwd?|FW|Bug|Issue|Problem)[[:space:]]*:[[:space:]]*//I')"
  if [ "$stripped" = "$title" ]; then
    break
  fi
  title="$stripped"
done

title="$(printf '%s' "$title" | sed -E 's/^[[:space:][:punct:]]+//; s/[[:space:][:punct:]]+$//; s/[[:space:]]+/ /g')"

if [ -z "$title" ]; then
  printf 'bug: needs-triage\n'
  exit 0
fi

lowered="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')"
case "$lowered" in
  bug:*)
    printf '%s\n' "$title"
    ;;
  *)
    printf 'bug: %s\n' "$title"
    ;;
esac
