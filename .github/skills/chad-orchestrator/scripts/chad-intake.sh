#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-intake.sh — Source-agnostic entry point for the orchestrator.
#
# Wraps chad-route + chad-spawn + chad-collect in one call. Use when
# you have a task from a known source and want Chad to handle the
# full fan-out + merge in a single invocation.
#
# Usage:
#   chad-intake --from chat       --task-file PATH
#   chad-intake --from proton     --message-id MSGID
#   chad-intake --from cron       --task-file PATH
#   chad-intake --from issue      --issue NUMBER [--repo owner/name]
#
# Flags:
#   --kind KIND        skip the router and force a kind
#   --dry-run          pass --dry-run through to chad-spawn
#   --no-collect       skip chad-collect after the spawn
#   --timeout SECS     override kind default timeout
#   --budget-tokens N  override kind default budget

set -euo pipefail

source_kind=""
task_file=""
message_id=""
issue_number=""
repo=""
forced_kind=""
dry_run=0
no_collect=0
timeout_secs=""
budget_tokens=""

usage() {
  sed -n '2,22p' "$0" | sed -e 's/^# \{0,1\}//' -e '1,3d'
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from)          source_kind="$2"; shift 2 ;;
    --task-file)     task_file="$2"; shift 2 ;;
    --message-id)    message_id="$2"; shift 2 ;;
    --issue)         issue_number="$2"; shift 2 ;;
    --repo)          repo="$2"; shift 2 ;;
    --kind)          forced_kind="$2"; shift 2 ;;
    --dry-run)       dry_run=1; shift ;;
    --no-collect)    no_collect=1; shift ;;
    --timeout)       timeout_secs="$2"; shift 2 ;;
    --budget-tokens) budget_tokens="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *) echo "chad-intake: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$source_kind" ] || { echo "chad-intake: --from is required" >&2; exit 2; }

# ── Materialize the task file depending on source ─────────────────
tmp_task=""
case "$source_kind" in
  chat|cron)
    [ -n "$task_file" ] || { echo "chad-intake: --task-file required for --from $source_kind" >&2; exit 2; }
    ;;

  proton)
    [ -n "$message_id" ] || { echo "chad-intake: --message-id required for --from proton" >&2; exit 2; }
    command -v proton-tool >/dev/null 2>&1 || {
      echo "chad-intake: proton-tool not available" >&2; exit 3; }
    tmp_task="$(mktemp /tmp/chad-intake-proton-XXXXXX.txt)"
    # read-mail auto-marks the message as read; that is intentional.
    proton-tool read-mail --id="$message_id" > "$tmp_task"
    task_file="$tmp_task"
    ;;

  issue)
    [ -n "$issue_number" ] || { echo "chad-intake: --issue required for --from issue" >&2; exit 2; }
    command -v gh >/dev/null 2>&1 || { echo "chad-intake: gh CLI not available" >&2; exit 3; }
    tmp_task="$(mktemp /tmp/chad-intake-issue-XXXXXX.md)"
    gh_args=(issue view "$issue_number" --json title,body,author,labels -t \
      '{{.title}}{{"\n\n"}}{{.body}}{{"\n\nauthor: @"}}{{.author.login}}{{"\nlabels: "}}{{range .labels}}{{.name}} {{end}}')
    if [ -n "$repo" ]; then
      gh_args+=(--repo "$repo")
    fi
    gh "${gh_args[@]}" > "$tmp_task"
    task_file="$tmp_task"
    ;;

  *)
    echo "chad-intake: unknown source: $source_kind" >&2
    exit 2
    ;;
esac

# ── Route ─────────────────────────────────────────────────────────
if [ -n "$forced_kind" ]; then
  kind="$forced_kind"
else
  kind="$(chad-route --task-file "$task_file")"
fi
echo "chad-intake: source=${source_kind} kind=${kind}" >&2

# ── Spawn ─────────────────────────────────────────────────────────
spawn_args=(--kind "$kind" --task-file "$task_file")
[ -n "$timeout_secs" ]  && spawn_args+=(--timeout "$timeout_secs")
[ -n "$budget_tokens" ] && spawn_args+=(--budget-tokens "$budget_tokens")
[ "$dry_run" -eq 1 ]    && spawn_args+=(--dry-run)

task_id="$(chad-spawn "${spawn_args[@]}")"
echo "chad-intake: task_id=${task_id}" >&2
echo "$task_id"

# ── Collect (optional) ────────────────────────────────────────────
if [ "$no_collect" -eq 0 ]; then
  chad-collect --today --since 300 >/dev/null || true
fi

# Clean up temp task file if we created one.
if [ -n "$tmp_task" ] && [ -f "$tmp_task" ]; then
  rm -f "$tmp_task"
fi
