#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-self-improve.sh — Weekly self-improvement loop.
#
# Scans recent signal (failed sub-agent spawns, feedback memory entries,
# budget exhaustion events, bug reports filed by chad-report-bug) and
# spawns a researcher sub-agent asking it to propose 1-3 *durable*
# improvements. Proposals land in memory/feedback-proposals.md for Chad
# to triage on his next wake.
#
# Rules:
#   - DRAFT-ONLY. This script never edits feedback memory entries, cron
#     definitions, policies, or config files directly. Every output is
#     a proposal that Chad reviews.
#   - Budget-aware. If remaining_tokens < 2 × the researcher budget,
#     the script exits 0 without spawning (so the weekly cron never
#     blocks the Monday-morning token pool).
#   - Idempotent. Writes to feedback-proposals.md with a signature
#     header; reruns on the same day append-with-dedupe.
#
# Usage:
#   chad-self-improve                    # default: last 7 days of signal
#   chad-self-improve --days 3           # shorter window
#   chad-self-improve --dry-run          # collect signal but don't spawn
#   chad-self-improve --budget-tokens N  # override researcher budget (default: 15000)
#
# Exit codes:
#   0  ran (or intentionally skipped due to budget); see stdout
#   2  usage error
#   3  signal collection failed

set -euo pipefail

OPENCLAW_DATA="${CHAD_OPENCLAW_DATA:-/sandbox/.openclaw-data}"
WORKSPACE="${CHAD_WORKSPACE:-/sandbox/.openclaw/workspace}"
PROPOSALS_FILE="${WORKSPACE}/memory/feedback-proposals.md"
QUEUE_FILE="${OPENCLAW_DATA}/queue/tasks.jsonl"
SUBAGENTS_DIR="${OPENCLAW_DATA}/subagents"

days=7
dry_run=0
budget_tokens=15000

usage() {
  cat <<'EOF'
Usage: chad-self-improve [--days N] [--dry-run] [--budget-tokens N]
EOF
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --days)          days="$2";          shift 2 ;;
    --dry-run)       dry_run=1;          shift ;;
    --budget-tokens) budget_tokens="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *) echo "chad-self-improve: unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$PROPOSALS_FILE")"

# ── Budget guard ───────────────────────────────────────────────────
# Refuse to spawn if there isn't a comfortable reserve. The
# self-improve cron is the lowest-priority signal consumer — it must
# never steal budget from real work.
if [ "$dry_run" -eq 0 ] && command -v chad-budget >/dev/null 2>&1; then
  remaining="$(chad-budget show --field remaining_tokens 2>/dev/null || echo 0)"
  needed=$((budget_tokens * 2))
  if [ "${remaining:-0}" -lt "$needed" ]; then
    echo "chad-self-improve: remaining=${remaining} < ${needed} (2× budget) — skipping weekly run" >&2
    echo "_(skipped: budget too low on $(date -u +%Y-%m-%dT%H:%M:%SZ))_" >> "$PROPOSALS_FILE"
    exit 0
  fi
fi

# ── Collect signal ─────────────────────────────────────────────────
# Writes a task file to /tmp/self-improve-<ts>.md for the researcher.
# All string handling in Python — ledger entries and memory files can
# contain quotes, backticks, and newlines.
task_file="$(mktemp /tmp/self-improve.XXXXXX.md)"

CHAD_SI_DAYS="$days" \
CHAD_SI_QUEUE_FILE="$QUEUE_FILE" \
CHAD_SI_SUBAGENTS_DIR="$SUBAGENTS_DIR" \
CHAD_SI_WORKSPACE="$WORKSPACE" \
CHAD_SI_TASK_FILE="$task_file" \
python3 <<'PY'
import os, json, datetime, pathlib

_UTC = getattr(datetime, "UTC", datetime.timezone.utc)
days = int(os.environ["CHAD_SI_DAYS"])
cutoff = datetime.datetime.now(_UTC) - datetime.timedelta(days=days)
queue_file = pathlib.Path(os.environ["CHAD_SI_QUEUE_FILE"])
subagents = pathlib.Path(os.environ["CHAD_SI_SUBAGENTS_DIR"])
workspace = pathlib.Path(os.environ["CHAD_SI_WORKSPACE"])
task_path = pathlib.Path(os.environ["CHAD_SI_TASK_FILE"])

def parse_ts(s):
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None

# 1. Failed or stuck spawns
failed = []
if queue_file.is_file():
    for raw in queue_file.read_text().splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except Exception:
            continue
        ts = parse_ts(rec.get("ts_utc", ""))
        if ts is None or ts < cutoff:
            continue
        if rec.get("status") in ("failed",):
            failed.append(rec)

# 2. Recent sub-agent results (last 25)
recent_results = []
if subagents.is_dir():
    dirs = sorted(
        (p for p in subagents.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime, reverse=True,
    )[:25]
    for d in dirs:
        r = d / "result.json"
        if r.is_file():
            try:
                parsed = json.loads(r.read_text())
                if parsed.get("status") in ("failed", "done"):
                    recent_results.append({
                        "id": d.name,
                        "kind": parsed.get("kind"),
                        "status": parsed.get("status"),
                        "summary": parsed.get("summary", "")[:300],
                        "follow_ups": parsed.get("follow_ups", []),
                    })
            except Exception:
                pass

# 3. Recent feedback memories (these are the *existing* rules; the
#    researcher should propose *new* ones or amendments)
feedback = []
mem_dir = workspace / "memory" if (workspace / "memory").is_dir() else None
if mem_dir:
    for p in mem_dir.glob("feedback_*.md"):
        try:
            feedback.append({"file": p.name, "head": p.read_text()[:800]})
        except Exception:
            pass

# Assemble the task brief
lines = [
    "# Task: propose durable self-improvements",
    "",
    "You are the researcher sub-agent. Chad has accumulated a week of",
    "operational signal — failed sub-agent spawns, results with follow-up",
    "items, and the existing feedback memory corpus. Your job is to",
    "propose **1-3 durable improvements** Chad can apply to his own",
    "behavior. Each proposal must be one of these shapes:",
    "",
    "- **New feedback memory entry** (filename, body)",
    "- **Amendment to existing feedback memory** (file, diff)",
    "- **Cron tweak** (cron name, old schedule, new schedule, reason)",
    "- **New kind manifest** (name, binary, policy, budget)",
    "",
    "Rules:",
    "- Do NOT propose code changes or policy changes — those go through",
    "  the bug-intake / PR loop, not this loop.",
    "- Do NOT propose anything that isn't directly supported by the",
    "  signal below. If the signal is too thin, say so and exit.",
    "- Propose at most 3. Fewer is better. Chad will reject proposals",
    "  that feel speculative.",
    "",
    "## Signal",
    "",
    f"### Failed spawns ({len(failed)} in last {days} days)",
    "",
    "```json",
    *(json.dumps(f) for f in failed[:10]),
    "```",
    "",
    f"### Recent sub-agent results ({len(recent_results)})",
    "",
    "```json",
    *(json.dumps(r) for r in recent_results),
    "```",
    "",
    f"### Existing feedback memories ({len(feedback)})",
    "",
]
for f in feedback[:6]:
    lines.append(f"**{f['file']}:**")
    lines.append("")
    lines.append(f["head"])
    lines.append("")
lines += [
    "## Output format",
    "",
    "Write the proposals as a markdown section titled",
    "`## Self-improvement proposals (<today-UTC>)` with one H3 per",
    "proposal. End with a JSON summary on the last line:",
    "",
    '    {"status":"done","proposals":<N>,"summary":"..."}',
]
task_path.write_text("\n".join(lines))
print(f"wrote {task_path}")
PY

# ── Spawn researcher ───────────────────────────────────────────────
if [ "$dry_run" -eq 1 ]; then
  echo "[dry-run] task file: $task_file"
  echo "[dry-run] would spawn: chad-spawn --kind researcher --task-file $task_file --budget-tokens $budget_tokens"
  exit 0
fi

if ! command -v chad-spawn >/dev/null 2>&1; then
  echo "chad-self-improve: chad-spawn not on PATH — orchestrator not installed?" >&2
  exit 3
fi

task_id="$(chad-spawn --kind researcher --task-file "$task_file" \
             --budget-tokens "$budget_tokens" \
             --timeout 300 2>&1)" || {
  echo "chad-self-improve: spawn failed: $task_id" >&2
  exit 3
}

# ── Append proposal to memory/feedback-proposals.md ────────────────
workdir="${OPENCLAW_DATA}/subagents/${task_id}"
result_file="${workdir}/result.json"
report_file="${workdir}/report.md"

{
  printf '\n## Self-improvement run — %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '- **task_id:** `%s`\n' "$task_id"
  if [ -f "$result_file" ]; then
    printf '- **result:**\n\n'
    printf '  ```json\n'
    sed 's/^/  /' "$result_file"
    printf '\n  ```\n'
  fi
  if [ -f "$report_file" ]; then
    printf '\n### Report\n\n'
    cat "$report_file"
  fi
} >> "$PROPOSALS_FILE"

echo "$task_id"
