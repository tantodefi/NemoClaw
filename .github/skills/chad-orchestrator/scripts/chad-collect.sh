#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-collect.sh — Merge finished sub-agent results into daily memory.
#
# Reads the task ledger and each subagent workdir's result.json, then
# appends a "## Dispatched Tasks" section to
# /sandbox/.openclaw/workspace/memory/<today>.md.
#
# This is intended to run:
#   - After a spawn batch, from within a Chad session.
#   - From a cron if you want periodic reconciliation.
#
# Flags:
#   --today              append to today's memory file (default)
#   --since SECONDS      only include tasks newer than this many seconds
#   --print-only         print the merged section to stdout, don't write
#   --memory-file PATH   override the memory file path

set -euo pipefail

SUBAGENTS_DIR="${CHAD_SUBAGENTS_DIR:-/sandbox/.openclaw-data/subagents}"
QUEUE_FILE="${CHAD_QUEUE_FILE:-/sandbox/.openclaw-data/queue/tasks.jsonl}"
WORKSPACE_MEMORY_DIR="${CHAD_MEMORY_DIR:-/sandbox/.openclaw/workspace/memory}"

since_seconds=""
print_only=0
memory_file=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --today)       shift ;;
    --since)       since_seconds="$2"; shift 2 ;;
    --print-only)  print_only=1; shift ;;
    --memory-file) memory_file="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed -e 's/^# \{0,1\}//' -e '1,3d'
      exit 0 ;;
    *) echo "chad-collect: unknown argument: $1" >&2; exit 2 ;;
  esac
done

today="$(date -u +%Y-%m-%d)"
default_memory_file="${WORKSPACE_MEMORY_DIR}/${today}.md"
memory_file="${memory_file:-$default_memory_file}"
mkdir -p "$(dirname "$memory_file")"

CHAD_COLLECT_SUBAGENTS="$SUBAGENTS_DIR" \
CHAD_COLLECT_QUEUE="$QUEUE_FILE" \
CHAD_COLLECT_SINCE="${since_seconds:-}" \
CHAD_COLLECT_PRINT="$print_only" \
CHAD_COLLECT_OUT="$memory_file" \
python3 <<'PY'
import os, sys, json, time, datetime, glob
_UTC = getattr(datetime, "UTC", datetime.timezone.utc)

subagents_dir = os.environ["CHAD_COLLECT_SUBAGENTS"]
queue_file    = os.environ["CHAD_COLLECT_QUEUE"]
since_raw     = os.environ.get("CHAD_COLLECT_SINCE", "")
print_only    = os.environ["CHAD_COLLECT_PRINT"] == "1"
memory_file   = os.environ["CHAD_COLLECT_OUT"]

cutoff = None
if since_raw:
    cutoff = time.time() - int(since_raw)

# Use the ledger if it exists; fall back to filesystem scan.
tasks = []
try:
    with open(queue_file) as f:
        latest = {}
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            latest[rec["id"]] = rec
        tasks = list(latest.values())
except FileNotFoundError:
    for d in sorted(glob.glob(os.path.join(subagents_dir, "*"))):
        if not os.path.isdir(d):
            continue
        tasks.append({"id": os.path.basename(d), "workdir": d, "status": "unknown"})

rows = []
for t in tasks:
    wd = t.get("workdir") or os.path.join(subagents_dir, t["id"])
    rp = os.path.join(wd, "result.json")
    if cutoff is not None:
        try:
            if os.path.getmtime(rp) < cutoff:
                continue
        except OSError:
            continue
    result = {}
    try:
        with open(rp) as f:
            result = json.load(f)
    except Exception:
        pass
    rows.append({
        "id":      t["id"],
        "kind":    t.get("kind") or result.get("kind", "?"),
        "status":  result.get("status") or t.get("status", "?"),
        "exit":    result.get("exit_code", ""),
        "summary": (result.get("summary") or "")[:200],
        "dry_run": result.get("dry_run", False),
        "workdir": wd,
    })

rows.sort(key=lambda r: r["id"])

lines = []
lines.append(f"## Dispatched Tasks ({datetime.datetime.now(_UTC).strftime('%Y-%m-%d %H:%M UTC')})")
lines.append("")
if not rows:
    lines.append("_No sub-agent tasks found._")
else:
    lines.append("| id | kind | status | exit | summary |")
    lines.append("|---|---|---|---|---|")
    for r in rows:
        sid = r["id"][:8]
        dry = " (dry)" if r["dry_run"] else ""
        summary = r["summary"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| `{sid}` | {r['kind']}{dry} | {r['status']} | {r['exit']} | {summary} |")
lines.append("")

section = "\n".join(lines) + "\n"

if print_only:
    sys.stdout.write(section)
    sys.exit(0)

# Append to memory file, but only if the same summary text isn't
# already at the tail — avoid repeated appends on every run.
existing = ""
try:
    with open(memory_file) as f:
        existing = f.read()
except FileNotFoundError:
    pass

# Cheap dedupe: skip if the last 400 chars already contain the same header.
header_sig = lines[0]
if existing.rstrip().endswith(header_sig.rstrip()) is False and header_sig in existing[-400:]:
    # recent duplicate — bail
    sys.exit(0)

with open(memory_file, "a") as f:
    if existing and not existing.endswith("\n"):
        f.write("\n")
    f.write(section)
PY
