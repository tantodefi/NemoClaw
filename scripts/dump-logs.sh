#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# dump-logs.sh — Host-side wrapper that combines the local Mac log streams
# with a sandbox dump (chad-dump-logs over SSH/kubectl) into a single
# unpacked directory under ~/.nemoclaw/log-dumps/<TS>/.
#
# Streams collected on the host:
#   ~/Library/Logs/Claude/*.log     (Claude IDE, coworkd, native host)
#   ~/.claude/sessions/             (most recent session metadata)
#   ~/.nemoclaw/sandboxes.json      (redacted)
#   ~/.nemoclaw/onboard-session.json (redacted)
#   ~/.nemoclaw/state/shields-audit.jsonl (if present)
#
# Streams collected from the sandbox:
#   tarball produced by chad-dump-logs inside the pod, copied back via SSH.
#
# Usage:
#   dump-logs.sh [<sandbox>] [--tail N] [--category list] [--no-sandbox] [--no-host]
#
# Default sandbox is "chad". Output: ~/.nemoclaw/log-dumps/<TS>/

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="chad"
TAIL_N=200
CATEGORIES="gateway,cron,subagent,memory,tui,system,premium"
SKIP_HOST=0
SKIP_SANDBOX=0
NO_REDACT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tail) TAIL_N="$2"; shift 2 ;;
    --category) CATEGORIES="$2"; shift 2 ;;
    --no-host) SKIP_HOST=1; shift ;;
    --no-sandbox) SKIP_SANDBOX=1; shift ;;
    --no-redact) NO_REDACT=1; shift ;;
    -h|--help)
      sed -n '4,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "dump-logs.sh: unknown flag $1" >&2
      exit 2
      ;;
    *)
      SANDBOX="$1"; shift ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_BASE="${HOME}/.nemoclaw/log-dumps/${TS}"
mkdir -p "$OUT_BASE/host" "$OUT_BASE/sandbox"

step() { printf "==> %s\n" "$*"; }
warn() { printf "!! %s\n" "$*" >&2; }

redact_inplace() {
  [ "$NO_REDACT" -eq 1 ] && return 0
  local target="$1"
  # macOS sed needs -i ''
  find "$target" -type f \( -name "*.json" -o -name "*.jsonl" -o -name "*.log" -o -name "*.md" -o -name "*.txt" \) -print0 \
  | xargs -0 -I{} sed -i.bak -E \
      -e 's/(sk-ant-[A-Za-z0-9_-]{8,})[A-Za-z0-9_-]{4,}/\1__REDACTED/g' \
      -e 's/(nvapi-[A-Za-z0-9_-]{8,})[A-Za-z0-9_-]{4,}/\1__REDACTED/g' \
      -e 's/(github_pat_[A-Za-z0-9_]{8,})[A-Za-z0-9_]{4,}/\1__REDACTED/g' \
      -e 's/(ghp_[A-Za-z0-9]{8,})[A-Za-z0-9]{4,}/\1__REDACTED/g' \
      "{}" 2>/dev/null || true
  find "$target" -name "*.bak" -delete 2>/dev/null || true
}

if [ "$SKIP_HOST" -eq 0 ]; then
  step "Collecting host logs"
  if [ -d "${HOME}/Library/Logs/Claude" ]; then
    mkdir -p "$OUT_BASE/host/claude-logs"
    for f in "${HOME}/Library/Logs/Claude"/*.log; do
      [ -r "$f" ] || continue
      tail -n "$TAIL_N" "$f" > "$OUT_BASE/host/claude-logs/$(basename "$f")" 2>/dev/null || true
    done
  fi
  if [ -d "${HOME}/.claude/sessions" ]; then
    mkdir -p "$OUT_BASE/host/claude-sessions"
    # Most recent 3 sessions only — sessions can be huge
    ls -t "${HOME}/.claude/sessions" 2>/dev/null | head -n 3 | while read -r d; do
      cp -R "${HOME}/.claude/sessions/$d" "$OUT_BASE/host/claude-sessions/" 2>/dev/null || true
    done
  fi
  for f in "${HOME}/.nemoclaw/sandboxes.json" "${HOME}/.nemoclaw/onboard-session.json"; do
    [ -r "$f" ] || continue
    cp "$f" "$OUT_BASE/host/$(basename "$f")"
  done
  if [ -r "${HOME}/.nemoclaw/state/shields-audit.jsonl" ]; then
    tail -n "$TAIL_N" "${HOME}/.nemoclaw/state/shields-audit.jsonl" > "$OUT_BASE/host/shields-audit.jsonl"
  fi
  redact_inplace "$OUT_BASE/host"
fi

if [ "$SKIP_SANDBOX" -eq 0 ]; then
  step "Collecting sandbox logs from openshell-${SANDBOX}"
  REMOTE_HOST="openshell-${SANDBOX}"
  CHAD_DUMP_FLAGS=( "--tail" "$TAIL_N" "--category" "$CATEGORIES" )
  [ "$NO_REDACT" -eq 1 ] && CHAD_DUMP_FLAGS+=( "--no-redact" )

  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" 'true' 2>/dev/null; then
    REMOTE_TAR="$(ssh "$REMOTE_HOST" "/usr/local/bin/chad-dump-logs ${CHAD_DUMP_FLAGS[*]}" 2>&1 | tail -n 1)"
    if [ -n "$REMOTE_TAR" ] && [ "${REMOTE_TAR#/tmp/chad-dump-}" != "$REMOTE_TAR" ]; then
      # Stream via `ssh cat` rather than scp: the sandbox image lacks
      # /usr/lib/openssh/sftp-server (OpenSSH 9+ scp default), and some
      # callers run in shells where scp is on PATH but blocked. `ssh cat`
      # always works because it's just stdin/stdout.
      local_tar="$OUT_BASE/sandbox/$(basename "$REMOTE_TAR")"
      if ssh "$REMOTE_HOST" "cat '$REMOTE_TAR'" > "$local_tar" 2>/dev/null && [ -s "$local_tar" ]; then
        ssh "$REMOTE_HOST" "rm -f '$REMOTE_TAR'" 2>/dev/null || true
        tar -C "$OUT_BASE/sandbox" -xzf "$local_tar" 2>/dev/null || warn "tar -x failed"
        rm -f "$local_tar"
      else
        warn "ssh cat of $REMOTE_TAR failed or empty"
        rm -f "$local_tar"
      fi
    else
      warn "chad-dump-logs returned: $REMOTE_TAR"
    fi
  else
    warn "Cannot SSH to $REMOTE_HOST — skipping sandbox dump"
  fi
fi

# Manifest
{
  echo "dump-logs manifest"
  echo "ts: $TS"
  echo "sandbox: $SANDBOX"
  echo "tail_n: $TAIL_N"
  echo "categories: $CATEGORIES"
  echo "redact: $((1-NO_REDACT))"
  echo ""
  echo "tree:"
  if command -v tree >/dev/null 2>&1; then
    (cd "$OUT_BASE" && tree -L 4)
  else
    find "$OUT_BASE" -maxdepth 4 -type f -printf '  %p\n' 2>/dev/null | sed "s|$OUT_BASE/||" | sort
  fi
} > "$OUT_BASE/MANIFEST.txt"

step "Dump complete: $OUT_BASE"
ls -la "$OUT_BASE"
