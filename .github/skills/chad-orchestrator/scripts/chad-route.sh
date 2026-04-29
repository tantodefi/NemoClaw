#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-route.sh — Classify a task into one of the sub-agent kinds.
#
# This is a deterministic keyword router, not an LLM. The point is to
# keep Chad's routing decisions auditable and free: if Chad wants the
# LLM to pick the kind, Chad can do that itself in the main session
# and just call chad-spawn directly with --kind.
#
# Usage:
#   chad-route --task-file PATH [--default coder|researcher|writer|reviewer]
#   chad-route --task "some free-text task body" [--default ...]
#
# Output:
#   Echoes one of: coder | researcher | writer | reviewer | fitness
#   Exit 0 if a match was found, exit 0 with the default if not.
#
# The patterns below are intentionally small — Chad is expected to
# tune them over time in the source repo and re-sync the skill.

set -euo pipefail

task_file=""
task_body=""
default_kind="researcher"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --task-file) task_file="$2"; shift 2 ;;
    --task)      task_body="$2"; shift 2 ;;
    --default)   default_kind="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed -e 's/^# \{0,1\}//' -e '1,3d'
      exit 0 ;;
    *) echo "chad-route: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$task_file" ]; then
  [ -f "$task_file" ] || { echo "chad-route: task file not found: $task_file" >&2; exit 4; }
  task_body="$(cat "$task_file")"
fi

[ -n "$task_body" ] || { echo "chad-route: --task or --task-file required" >&2; exit 2; }

CHAD_ROUTE_BODY="$task_body" CHAD_ROUTE_DEFAULT="$default_kind" python3 <<'PY'
import os, re, sys

body = os.environ["CHAD_ROUTE_BODY"].lower()
default = os.environ["CHAD_ROUTE_DEFAULT"]

# Highest weight wins. Ties fall back to the default.
# brain kind is checked first with higher-weight patterns so memory
# operations don't get misrouted to researcher.
patterns = [
    ("brain", [
        r"\b(remember|recall|what do you know|brain query|knowledge graph|entity|extract entities|store in brain|gbrain|put.?page|what.?know.?about)\b",
        r"\b(summaris?e for memory|add to memory|memory entry|timeline|link entities)\b",
    ]),
    ("fitness", [
        r"\b(squat|deadlift|bench press|overhead press|barbell|powerlifting|novice linear progression)\b",
        r"\b(starting strength|supple leopard|rippetoe|starrett|hip hinge|brace|thoracic)\b",
        r"\b(mobility|stretch|warmup|warm.?up|tissue|fascia|foam roll|lacrosse ball)\b",
        r"\b(lift|lifting|form check|technique|cue|programming|sets?|reps?|load)\b",
    ]),
    ("coder", [
        r"\b(implement|refactor|patch|fix|bug|diff|write code|rewrite|unit test|pytest|vitest|compile|build fail)\b",
        r"\b(?:function|class|module|method)\s+\w+",
    ]),
    ("researcher", [
        r"\b(research|find out|look ?up|search|investigate|what is|who is|when did|compare)\b",
        r"\b(docs?|documentation|rfc|spec)\b",
    ]),
    ("writer", [
        r"\b(draft|compose|write (?:an? )?(?:email|reply|comment|post|message|doc))\b",
        r"\b(reply to|respond to)\b",
    ]),
    ("reviewer", [
        r"\b(review|audit|checklist|inspect|evaluate|security scan|lint)\b",
        r"\bPR\s*#?\d+",
    ]),
]

scores = {k: 0 for k, _ in patterns}
for kind, rxs in patterns:
    for rx in rxs:
        scores[kind] += len(re.findall(rx, body, flags=re.I))

best = max(scores.items(), key=lambda kv: kv[1])
if best[1] == 0:
    print(default)
else:
    print(best[0])
PY
