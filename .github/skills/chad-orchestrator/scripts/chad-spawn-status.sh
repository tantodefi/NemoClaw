#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-spawn-status.sh — Inspect the task ledger.
#
# Usage:
#   chad-spawn-status                    list all tasks (latest status per id)
#   chad-spawn-status --id ID            show one task's status + workdir
#   chad-spawn-status --open             list only queued|running
#   chad-spawn-status --failed           list only failed
#   chad-spawn-status --json             machine-readable output

set -euo pipefail

QUEUE_FILE="${CHAD_QUEUE_FILE:-/sandbox/.openclaw-data/queue/tasks.jsonl}"
SUBAGENTS_DIR="${CHAD_SUBAGENTS_DIR:-/sandbox/.openclaw-data/subagents}"

filter_id=""
filter_status=""
as_json=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --id)      filter_id="$2"; shift 2 ;;
    --open)    filter_status="open"; shift ;;
    --failed)  filter_status="failed"; shift ;;
    --done)    filter_status="done"; shift ;;
    --json)    as_json=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed -e 's/^# \{0,1\}//' -e '1,3d'
      exit 0 ;;
    *) echo "chad-spawn-status: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$QUEUE_FILE" ]; then
  echo "No task ledger at $QUEUE_FILE" >&2
  exit 0
fi

CHAD_STATUS_FILE="$QUEUE_FILE" \
CHAD_STATUS_ID="$filter_id" \
CHAD_STATUS_FILTER="$filter_status" \
CHAD_STATUS_JSON="$as_json" \
CHAD_STATUS_SUBAGENTS="$SUBAGENTS_DIR" \
python3 <<'PY'
import os, sys, json

path         = os.environ["CHAD_STATUS_FILE"]
want_id      = os.environ.get("CHAD_STATUS_ID", "")
want_filter  = os.environ.get("CHAD_STATUS_FILTER", "")
as_json      = os.environ.get("CHAD_STATUS_JSON", "0") == "1"
subagents    = os.environ["CHAD_STATUS_SUBAGENTS"]

latest = {}
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        latest[rec["id"]] = rec

rows = list(latest.values())
rows.sort(key=lambda r: r.get("ts_utc", ""), reverse=True)

def match(row):
    if want_id and row["id"] != want_id:
        return False
    if want_filter == "open"   and row["status"] not in ("queued", "running"):
        return False
    if want_filter == "failed" and row["status"] != "failed":
        return False
    if want_filter == "done"   and row["status"] != "done":
        return False
    return True

rows = [r for r in rows if match(r)]

if as_json:
    print(json.dumps(rows, indent=2))
    sys.exit(0)

if not rows:
    print("No matching tasks.")
    sys.exit(0)

print(f"{'id':<12}  {'kind':<12}  {'status':<9}  workdir")
for r in rows:
    sid = r["id"][:8]
    print(f"{sid:<12}  {r.get('kind','?'):<12}  {r['status']:<9}  {r.get('workdir','')}")
PY
