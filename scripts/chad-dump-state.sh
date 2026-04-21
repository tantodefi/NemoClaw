#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-dump-state.sh — Snapshot Chad's runtime state into a structured
# markdown report suitable for attaching to a GitHub issue or saving to
# the workspace for later analysis.
#
# Captures:
#   - Today's memory/<YYYY-MM-DD>.md (tail, redacted)
#   - The last N entries of queue/tasks.jsonl (JSON ledger)
#   - /sandbox/.openclaw-data/budget.json
#   - Results of the last M sub-agent spawns (result.json + stderr tail)
#   - Gateway + openclaw version info
#   - The config hash from /sandbox/.openclaw/.config-hash
#
# Usage:
#   chad-dump-state                        # print to stdout
#   chad-dump-state --out /tmp/dump.md     # write to file
#   chad-dump-state --tar /tmp/dump.tar.gz # bundle markdown + raw logs
#   chad-dump-state --ledger 20            # include last 20 ledger entries (default 10)
#   chad-dump-state --subagents 5          # include last 5 result.json files (default 3)
#   chad-dump-state --memory-lines 200     # tail N lines from today's memory (default 80)
#
# SECURITY:
#   The dump deliberately includes the tail of today's memory and the
#   last few sub-agent stderr streams. These may contain task bodies the
#   agent received but SHOULD NOT contain credentials because the base
#   image redacts them at load time. Still — treat the output as
#   potentially sensitive and prefer attaching to a private issue.
#
# Exit codes:
#   0  dump generated successfully
#   2  usage error
#   3  one of the required state paths is missing

set -euo pipefail

OPENCLAW_DATA="${CHAD_OPENCLAW_DATA:-/sandbox/.openclaw-data}"
OPENCLAW_DIR="${CHAD_OPENCLAW_DIR:-/sandbox/.openclaw}"
WORKSPACE="${CHAD_WORKSPACE:-/sandbox/.openclaw/workspace}"
QUEUE_FILE="${OPENCLAW_DATA}/queue/tasks.jsonl"
BUDGET_FILE="${OPENCLAW_DATA}/budget.json"
SUBAGENTS_DIR="${OPENCLAW_DATA}/subagents"
CONFIG_HASH="${OPENCLAW_DIR}/.config-hash"

out_file=""
tar_file=""
ledger_n=10
subagents_n=3
memory_lines=80

usage() {
  cat <<'EOF'
Usage: chad-dump-state [--out FILE] [--tar FILE] [--ledger N]
                       [--subagents N] [--memory-lines N]

Prints a markdown state dump to stdout (or --out / --tar).
EOF
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)          out_file="$2";      shift 2 ;;
    --tar)          tar_file="$2";      shift 2 ;;
    --ledger)       ledger_n="$2";      shift 2 ;;
    --subagents)    subagents_n="$2";   shift 2 ;;
    --memory-lines) memory_lines="$2";  shift 2 ;;
    -h|--help)      usage ;;
    *) echo "chad-dump-state: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# All string handling goes through Python so we never have to worry
# about shell quoting of multi-line memory files or JSON blobs.
CHAD_DS_OUT="$out_file" \
CHAD_DS_TAR="$tar_file" \
CHAD_DS_LEDGER_N="$ledger_n" \
CHAD_DS_SUBAGENTS_N="$subagents_n" \
CHAD_DS_MEMORY_LINES="$memory_lines" \
CHAD_DS_OPENCLAW_DATA="$OPENCLAW_DATA" \
CHAD_DS_WORKSPACE="$WORKSPACE" \
CHAD_DS_QUEUE_FILE="$QUEUE_FILE" \
CHAD_DS_BUDGET_FILE="$BUDGET_FILE" \
CHAD_DS_SUBAGENTS_DIR="$SUBAGENTS_DIR" \
CHAD_DS_CONFIG_HASH="$CONFIG_HASH" \
python3 <<'PY'
import os, sys, json, datetime, pathlib, tarfile, io, subprocess, re

_UTC = getattr(datetime, "UTC", datetime.timezone.utc)
NOW = datetime.datetime.now(_UTC)
TODAY = NOW.strftime("%Y-%m-%d")

out_path     = os.environ["CHAD_DS_OUT"] or None
tar_path     = os.environ["CHAD_DS_TAR"] or None
ledger_n     = int(os.environ["CHAD_DS_LEDGER_N"])
subagents_n  = int(os.environ["CHAD_DS_SUBAGENTS_N"])
memory_lines = int(os.environ["CHAD_DS_MEMORY_LINES"])
workspace    = pathlib.Path(os.environ["CHAD_DS_WORKSPACE"])
queue_file   = pathlib.Path(os.environ["CHAD_DS_QUEUE_FILE"])
budget_file  = pathlib.Path(os.environ["CHAD_DS_BUDGET_FILE"])
subagents    = pathlib.Path(os.environ["CHAD_DS_SUBAGENTS_DIR"])
config_hash  = pathlib.Path(os.environ["CHAD_DS_CONFIG_HASH"])

# ── Redaction ──────────────────────────────────────────────────────
# The memory and log files are supposed to be credential-free by the
# time they get here (base image redacts at load) but belt+braces:
# strip anything that looks like a token or API key.
SECRET_RE = re.compile(
    r"(?i)\b(nvapi-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{20,}"
    r"|npm_[A-Za-z0-9]+|xoxb-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{20,})\b"
)
def redact(s: str) -> str:
    return SECRET_RE.sub("[REDACTED-SECRET]", s)

def tail_file(path: pathlib.Path, n_lines: int) -> str:
    if not path.is_file():
        return f"_(not found: {path})_\n"
    try:
        lines = path.read_text(errors="replace").splitlines()
    except Exception as e:
        return f"_(read error: {e})_\n"
    return redact("\n".join(lines[-n_lines:]) + "\n")

def read_json(path: pathlib.Path):
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except Exception as e:
        return {"_error": str(e)}

def last_ledger_entries(path: pathlib.Path, n: int):
    if not path.is_file():
        return []
    out = []
    try:
        for raw in path.read_text().splitlines()[-n*4:]:  # over-read, dedupe below
            raw = raw.strip()
            if not raw:
                continue
            try:
                out.append(json.loads(raw))
            except Exception:
                continue
    except Exception:
        return []
    return out[-n:]

def recent_subagent_dirs(base: pathlib.Path, n: int):
    if not base.is_dir():
        return []
    try:
        candidates = [p for p in base.iterdir() if p.is_dir()]
    except Exception:
        return []
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[:n]

def run_cmd(cmd):
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=5
        ).stdout.strip()
    except Exception as e:
        return f"(error: {e})"

# ── Assemble the markdown report ───────────────────────────────────
parts: list[str] = []
parts.append(f"# Chad state dump — {NOW.strftime('%Y-%m-%d %H:%M:%SZ')}\n\n")
parts.append("_Generated by `chad-dump-state`. Attach to an issue via `chad-report-bug` or save for later._\n\n")

parts.append("## 1. Environment\n\n```\n")
parts.append(f"openclaw: {run_cmd(['openclaw', '--version']) or '(not installed)'}\n")
parts.append(f"node:     {run_cmd(['node', '--version']) or '(not installed)'}\n")
parts.append(f"pi:       {run_cmd(['pi', '--version']) or '(not installed)'}\n")
parts.append(f"gh:       {run_cmd(['gh', '--version']).splitlines()[0] if run_cmd(['gh', '--version']) else '(not installed)'}\n")
if config_hash.is_file():
    parts.append(f"config-hash: {config_hash.read_text().strip()}\n")
else:
    parts.append("config-hash: (missing)\n")
parts.append("```\n\n")

parts.append("## 2. Budget\n\n```json\n")
b = read_json(budget_file)
parts.append(json.dumps(b, indent=2) if b is not None else "(no budget.json)")
parts.append("\n```\n\n")

parts.append(f"## 3. Last {ledger_n} ledger entries\n\n```json\n")
entries = last_ledger_entries(queue_file, ledger_n)
if entries:
    parts.append("\n".join(json.dumps(e) for e in entries))
else:
    parts.append("(no entries)")
parts.append("\n```\n\n")

parts.append(f"## 4. Last {subagents_n} sub-agent results\n\n")
dirs = recent_subagent_dirs(subagents, subagents_n)
if not dirs:
    parts.append("_(none)_\n\n")
for d in dirs:
    parts.append(f"### `{d.name}`\n\n")
    res = read_json(d / "result.json")
    parts.append("```json\n")
    parts.append(json.dumps(res, indent=2) if res is not None else "(no result.json)")
    parts.append("\n```\n\n")
    stderr_log = d / "stderr.log"
    if stderr_log.is_file() and stderr_log.stat().st_size > 0:
        parts.append("Last 20 lines of stderr:\n\n```\n")
        parts.append(tail_file(stderr_log, 20))
        parts.append("\n```\n\n")

parts.append(f"## 5. Today's memory (last {memory_lines} lines)\n\n```markdown\n")
memory_today = workspace / "memory" / f"{TODAY}.md"
parts.append(tail_file(memory_today, memory_lines))
parts.append("```\n\n")

parts.append("---\n")
parts.append("_End of state dump._\n")

md = "".join(parts)

# ── Output ─────────────────────────────────────────────────────────
if tar_path:
    # Bundle the markdown report + raw logs for the last N subagents.
    with tarfile.open(tar_path, "w:gz") as tar:
        ti = tarfile.TarInfo(name="state-dump.md")
        data = md.encode("utf-8")
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))
        for d in dirs:
            for fname in ("result.json", "stdout.log", "stderr.log", "prompt.txt"):
                p = d / fname
                if p.is_file():
                    tar.add(p, arcname=f"subagents/{d.name}/{fname}")
        if queue_file.is_file():
            tar.add(queue_file, arcname="queue/tasks.jsonl")
        if budget_file.is_file():
            tar.add(budget_file, arcname="budget.json")
        if memory_today.is_file():
            tar.add(memory_today, arcname=f"memory/{TODAY}.md")
    print(tar_path)
elif out_path:
    pathlib.Path(out_path).write_text(md)
    print(out_path)
else:
    sys.stdout.write(md)
PY
