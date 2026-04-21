#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-issue-triage.sh — Daily issue triage loop.
#
# Fetches open issues from Chad's bug repo (default: the repo chad-
# report-bug posts to), scores them by signal quality, and picks the
# top N to route through chad-intake. The scoring is deliberately
# simple — label + reactions + age + linked-PR — so anyone reading
# the source can predict which issues will be picked up.
#
# This is the "high-quality bug signal" feedback loop: Chad reports
# bugs with state attached, humans triage and react/label them, Chad
# picks up the high-signal ones the next day and proposes fixes.
#
# Rules:
#   - Read-only against GitHub (uses `gh issue list` and
#     `gh issue view`). No labels are added or removed here — that's
#     reviewer territory.
#   - Draft-only downstream: the routed tasks go to researcher/writer
#     sub-agents that produce proposed patches and write them to the
#     workdir. Chad reviews and decides whether to open a PR.
#   - Budget-aware. Exits 0 if remaining_tokens < 3 × N × coder budget.
#
# Usage:
#   chad-issue-triage                       # triage top 2 issues
#   chad-issue-triage --top 5               # top N
#   chad-issue-triage --repo OWNER/NAME     # override repo
#   chad-issue-triage --dry-run             # score + select but don't spawn
#   chad-issue-triage --label needs-chad    # only score issues with this label
#
# Exit codes:
#   0  triaged successfully (or skipped due to budget)
#   2  usage error
#   3  gh or spawn failure

set -euo pipefail

REPO="${CHAD_BUG_REPO:-tantodefi/chad-state}"
OPENCLAW_DATA="${CHAD_OPENCLAW_DATA:-/sandbox/.openclaw-data}"
WORKSPACE="${CHAD_WORKSPACE:-/sandbox/.openclaw/workspace}"

top_n=2
dry_run=0
require_label=""

usage() {
  cat <<'EOF'
Usage: chad-issue-triage [--top N] [--repo OWNER/NAME] [--label LABEL]
                         [--dry-run]
EOF
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --top)     top_n="$2";         shift 2 ;;
    --repo)    REPO="$2";          shift 2 ;;
    --label)   require_label="$2"; shift 2 ;;
    --dry-run) dry_run=1;          shift ;;
    -h|--help) usage ;;
    *) echo "chad-issue-triage: unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || {
  echo "chad-issue-triage: gh not found" >&2
  exit 3
}

# ── Budget guard ───────────────────────────────────────────────────
if [ "$dry_run" -eq 0 ] && command -v chad-budget >/dev/null 2>&1; then
  remaining="$(chad-budget show --field remaining_tokens 2>/dev/null || echo 0)"
  # Reserve for N × (researcher 20K + coder 50K) with a 30% safety margin.
  needed=$(( top_n * 70000 * 130 / 100 ))
  if [ "${remaining:-0}" -lt "$needed" ]; then
    echo "chad-issue-triage: remaining=${remaining} < ${needed} — skipping daily run" >&2
    exit 0
  fi
fi

# ── Fetch open issues ──────────────────────────────────────────────
list_args=(issue list --repo "$REPO" --state open --limit 50
           --json number,title,body,labels,reactionGroups,updatedAt,url)
if [ -n "$require_label" ]; then
  list_args+=(--label "$require_label")
fi

if ! raw_issues="$(gh "${list_args[@]}" 2>&1)"; then
  echo "chad-issue-triage: gh issue list failed: $raw_issues" >&2
  exit 3
fi

# ── Score and select ───────────────────────────────────────────────
# Score = reaction_count * 3 + recent_update_bonus + label_bonus -
#         stale_penalty. Simple, predictable, tunable via env.
selected_file="$(mktemp /tmp/triage-selected.XXXXXX.json)"
CHAD_TR_RAW="$raw_issues" \
CHAD_TR_TOP="$top_n" \
CHAD_TR_OUT="$selected_file" \
python3 <<'PY'
import os, json, datetime

_UTC = getattr(datetime, "UTC", datetime.timezone.utc)
now = datetime.datetime.now(_UTC)
raw = os.environ["CHAD_TR_RAW"]
top = int(os.environ["CHAD_TR_TOP"])
out_path = os.environ["CHAD_TR_OUT"]

try:
    issues = json.loads(raw)
except Exception as e:
    print(f"parse error: {e}")
    issues = []

POSITIVE = {"THUMBS_UP", "HEART", "HOORAY", "ROCKET", "LAUGH"}
HIGH_SIGNAL_LABELS = {"bug", "needs-chad", "high-priority", "regression"}
LOW_SIGNAL_LABELS  = {"discussion", "question", "wontfix", "duplicate"}

def score(it):
    total_reactions = 0
    for g in (it.get("reactionGroups") or []):
        if g.get("content") in POSITIVE:
            total_reactions += g.get("users", {}).get("totalCount", 0)
    s = total_reactions * 3

    labels = {l.get("name", "") for l in (it.get("labels") or [])}
    if labels & HIGH_SIGNAL_LABELS:
        s += 10
    if labels & LOW_SIGNAL_LABELS:
        s -= 20

    try:
        updated = datetime.datetime.fromisoformat(it["updatedAt"].replace("Z", "+00:00"))
        days = (now - updated).days
        if days <= 1:
            s += 5
        elif days > 30:
            s -= 10
    except Exception:
        pass

    # Chad-filed issues with state snapshots are highest signal — they
    # already come with reproducible context.
    if "chad-filed" in labels:
        s += 15

    return s

scored = sorted(((score(it), it) for it in issues), key=lambda x: x[0], reverse=True)
# Drop negative scores
picked = [it for (s, it) in scored if s > 0][:top]

with open(out_path, "w") as f:
    json.dump(picked, f)

print(f"scored={len(scored)} picked={len(picked)}")
for s, it in scored[:top]:
    print(f"  [{s:3d}] #{it.get('number')} {it.get('title', '')[:70]}")
PY

picked_count="$(python3 -c 'import json,os; print(len(json.load(open(os.environ["F"]))))' F="$selected_file")"
if [ "$picked_count" = "0" ]; then
  echo "chad-issue-triage: no issues with positive score — nothing to do"
  rm -f "$selected_file"
  exit 0
fi

# ── Spawn one researcher per picked issue ─────────────────────────
# Each issue gets its own task file + researcher spawn. The researcher
# reads the issue body (which may include a Chad state snapshot),
# proposes a plan, and writes it to its workdir. The parent (Chad)
# reviews on his next wake and decides whether to spawn a coder.
if [ "$dry_run" -eq 1 ]; then
  echo "[dry-run] would spawn $picked_count researcher(s). Selected:"
  python3 -c '
import json, os
for it in json.load(open(os.environ["F"])):
    print(f"  #{it.get(\"number\")} {it.get(\"title\", \"\")}")
' F="$selected_file"
  rm -f "$selected_file"
  exit 0
fi

command -v chad-spawn >/dev/null 2>&1 || {
  echo "chad-issue-triage: chad-spawn not on PATH" >&2
  rm -f "$selected_file"
  exit 3
}

spawned=()
while IFS= read -r issue_json; do
  [ -z "$issue_json" ] && continue
  task_file="$(mktemp /tmp/triage-issue.XXXXXX.md)"
  CHAD_TR_ISSUE="$issue_json" \
  CHAD_TR_TASK="$task_file" \
  CHAD_TR_REPO="$REPO" \
  python3 <<'PY'
import os, json
it = json.loads(os.environ["CHAD_TR_ISSUE"])
path = os.environ["CHAD_TR_TASK"]
repo = os.environ["CHAD_TR_REPO"]
lines = [
    f"# Task: triage issue {repo}#{it.get('number')}",
    "",
    f"**Title:** {it.get('title', '')}",
    f"**URL:** {it.get('url', '')}",
    "",
    "You are the researcher sub-agent. Read the issue body below and",
    "produce a **triage report** with these sections:",
    "",
    "1. **Reproduction plan** — how a coder would reproduce this bug",
    "   given only the info in the body (and any attached state snapshot).",
    "2. **Suspected root cause** — file paths, function names, or areas",
    "   of the codebase that are likely involved.",
    "3. **Proposed next action** — one of:",
    "   - `spawn coder` (trivial fix, high confidence)",
    "   - `needs human review` (ambiguous, or policy change required)",
    "   - `close as invalid` (not a bug)",
    "   - `close as duplicate of <url>` (found a dupe)",
    "",
    "Do NOT post a comment to the issue. Do NOT edit labels. Write the",
    "report to `$CHAD_RESULT_WORKDIR/triage.md` and emit a JSON summary",
    "on the last line:",
    '    {"status":"done","issue_url":"...","next_action":"..."}',
    "",
    "## Issue body",
    "",
    it.get("body", "") or "_(empty)_",
]
open(path, "w").write("\n".join(lines))
print(path)
PY
  task_id="$(chad-spawn --kind researcher --task-file "$task_file" \
               --budget-tokens 15000 --timeout 300 2>&1)" || {
    echo "chad-issue-triage: spawn failed for issue: $task_id" >&2
    continue
  }
  spawned+=("$task_id")
  rm -f "$task_file"
done < <(python3 -c '
import json, os
for it in json.load(open(os.environ["F"])):
    print(json.dumps(it))
' F="$selected_file")

rm -f "$selected_file"

# ── Append to today's memory ───────────────────────────────────────
today="$(date -u +%Y-%m-%d)"
memory_file="${WORKSPACE}/memory/${today}.md"
if [ -d "$(dirname "$memory_file")" ]; then
  {
    printf '\n## Issue triage run — %s\n\n' "$(date -u +%H:%M:%SZ)"
    printf '- **Repo:** %s\n' "$REPO"
    printf '- **Spawned:** %d researcher(s)\n' "${#spawned[@]}"
    for tid in "${spawned[@]}"; do
      printf '  - `%s`\n' "$tid"
    done
  } >> "$memory_file"
fi

printf '%s\n' "${spawned[@]}"
