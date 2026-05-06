#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-spawn.sh — Canonical sub-agent spawner for Chad.
#
# Implements the sub-agent contract documented in
# .github/skills/chad-orchestrator/SKILL.md. Reads a kind manifest,
# checks the budget, writes a queued entry to the task ledger, runs
# the sub-agent binary with the rendered prompt, streams stdout/stderr
# to the workdir, and writes a structured result.json on exit.
#
# Usage:
#   chad-spawn --kind KIND --task-file PATH [--workdir DIR] [--result-file PATH]
#              [--timeout SECS] [--budget-tokens N] [--dry-run] [--id ID]
#
# Exit codes:
#    0  sub-agent ran and wrote a result.json
#    2  usage / validation error
#    3  kind manifest not found or malformed
#    4  task file not found or unreadable
#   77  budget exhausted — refused to spawn

set -euo pipefail

# Canonical orchestrator dir — prefers a synced-from-host copy under
# skills/, falls back to the image-baked read-only copy under /opt.
# Explicit CHAD_ORCH_DIR override wins for tests.
if [ -z "${CHAD_ORCH_DIR:-}" ]; then
  if [ -d /sandbox/.openclaw-data/skills/chad-orchestrator/kinds ]; then
    CHAD_ORCH_DIR=/sandbox/.openclaw-data/skills/chad-orchestrator
  elif [ -d /opt/chad-orchestrator/kinds ]; then
    CHAD_ORCH_DIR=/opt/chad-orchestrator
  else
    CHAD_ORCH_DIR=/sandbox/.openclaw-data/skills/chad-orchestrator
  fi
fi
ORCH_DIR="$CHAD_ORCH_DIR"
SUBAGENTS_DIR="${CHAD_SUBAGENTS_DIR:-/sandbox/.openclaw-data/subagents}"
QUEUE_FILE="${CHAD_QUEUE_FILE:-/sandbox/.openclaw-data/queue/tasks.jsonl}"

kind=""
task_file=""
workdir=""
result_file=""
timeout_secs=""
budget_tokens=""
dry_run=0
override_id=""
substrate_override=""

usage() {
  cat <<'EOF'
Usage: chad-spawn --kind KIND --task-file PATH [options]

Options:
  --kind KIND            sub-agent kind (coder|researcher|writer|reviewer|…)
  --task-file PATH       path to the task file (markdown or JSON)
  --workdir DIR          override the workdir (default: subagents/<id>/)
  --result-file PATH     override the result file (default: workdir/result.json)
  --timeout SECS         override the kind default timeout
  --budget-tokens N      override the kind default token budget
  --dry-run              don't execute the sub-agent, write a synthetic result
  --id ID                override the generated task id
  --substrate S          execution substrate: local (in-container) or gha
                         (GitHub Actions runner). Overrides the kind
                         manifest's `substrate` field. Default: local.
  -h, --help             show this help
EOF
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kind)          kind="$2"; shift 2 ;;
    --task-file)     task_file="$2"; shift 2 ;;
    --workdir)       workdir="$2"; shift 2 ;;
    --result-file)   result_file="$2"; shift 2 ;;
    --timeout)       timeout_secs="$2"; shift 2 ;;
    --budget-tokens) budget_tokens="$2"; shift 2 ;;
    --dry-run)       dry_run=1; shift ;;
    --id)            override_id="$2"; shift 2 ;;
    --substrate)     substrate_override="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *) echo "chad-spawn: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$kind" ]      || { echo "chad-spawn: --kind is required" >&2; exit 2; }
[ -n "$task_file" ] || { echo "chad-spawn: --task-file is required" >&2; exit 2; }
[ -f "$task_file" ] || { echo "chad-spawn: task file not found: $task_file" >&2; exit 4; }

manifest_file="${ORCH_DIR}/kinds/${kind}.yaml"
[ -f "$manifest_file" ] || {
  echo "chad-spawn: kind manifest not found: $manifest_file" >&2
  exit 3
}

# ── Load manifest via Python to avoid shell-level YAML parsing ─────
# Uses PyYAML when available (baked into the sandbox base image) and
# falls back to a small stdlib-only loader that handles our manifest
# shape: flat key: value pairs plus one block scalar (`|`) for
# prompt_template. The eval pattern is safe because shlex.quote is
# used for every value before it is printed.
set +e
manifest_eval="$(python3 - "$manifest_file" <<'PY'
import sys, shlex

def load_fallback(path):
    """Parse the tiny subset of YAML our kind manifests use."""
    out, block_key, block_indent, block_lines = {}, None, None, []
    with open(path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            if block_key is not None:
                if not line.strip():
                    block_lines.append("")
                    continue
                indent = len(line) - len(line.lstrip(" "))
                if block_indent is None:
                    block_indent = indent or 2
                if indent >= block_indent and line.strip():
                    block_lines.append(line[block_indent:])
                    continue
                out[block_key] = "\n".join(block_lines).rstrip() + "\n"
                block_key, block_indent, block_lines = None, None, []
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if ":" not in stripped:
                continue
            key, _, val = stripped.partition(":")
            key, val = key.strip(), val.strip()
            if val == "|":
                block_key, block_indent, block_lines = key, None, []
                continue
            if val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                val = val[1:-1]
            out[key] = val
    if block_key is not None:
        out[block_key] = "\n".join(block_lines).rstrip() + "\n"
    return out

try:
    import yaml
    with open(sys.argv[1]) as f:
        m = yaml.safe_load(f) or {}
except ModuleNotFoundError:
    m = load_fallback(sys.argv[1])
except Exception as e:
    sys.stderr.write(f"manifest parse error: {e}\n")
    sys.exit(3)

fields = [
    ("kind",                  ""),
    ("binary",                ""),
    ("invocation",            "prompt-stdin"),
    ("network_policy_preset", ""),
    ("default_timeout",       600),
    ("default_budget_tokens", 20000),
    ("substrate",             "local"),
]
for k, default in fields:
    print(f"manifest_{k}={shlex.quote(str(m.get(k, default)))}")
PY
)"
manifest_rc=$?
set -e
[ "$manifest_rc" -eq 0 ] || exit 3
eval "$manifest_eval"

[ -n "$manifest_binary" ] || { echo "chad-spawn: manifest missing 'binary'" >&2; exit 3; }

# Generate a task id if the caller didn't supply one.
task_id="${override_id:-$(
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    python3 -c 'import uuid; print(uuid.uuid4())'
  fi
)}"

workdir="${workdir:-${SUBAGENTS_DIR}/${task_id}}"
result_file="${result_file:-${workdir}/result.json}"
timeout_secs="${timeout_secs:-${manifest_default_timeout}}"
budget_tokens="${budget_tokens:-${manifest_default_budget_tokens}}"

mkdir -p "$workdir" "$(dirname "$QUEUE_FILE")"

# ── Budget check (skipped for dry-run) ─────────────────────────────
if [ "$dry_run" -eq 0 ]; then
  if ! chad-budget reserve "$budget_tokens" "$kind" >/dev/null; then
    echo "chad-spawn: budget exhausted, refusing to spawn (need ${budget_tokens})" >&2
    exit 77
  fi
fi

# ── Render prompt ──────────────────────────────────────────────────
# All string handling goes through Python via env vars so we never
# have to worry about shell quoting of task bodies that contain
# quotes, backticks, dollar signs, or newlines.
prompt_file="${workdir}/prompt.txt"
CHAD_MANIFEST_FILE="$manifest_file" \
CHAD_TASK_FILE="$task_file" \
CHAD_TASK_ID="$task_id" \
CHAD_PROMPT_OUT="$prompt_file" \
python3 <<'PY'
import os

def load_fallback(path):
    out, block_key, block_indent, block_lines = {}, None, None, []
    with open(path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            if block_key is not None:
                if not line.strip():
                    block_lines.append("")
                    continue
                indent = len(line) - len(line.lstrip(" "))
                if block_indent is None:
                    block_indent = indent or 2
                if indent >= block_indent and line.strip():
                    block_lines.append(line[block_indent:])
                    continue
                out[block_key] = "\n".join(block_lines).rstrip() + "\n"
                block_key, block_indent, block_lines = None, None, []
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if ":" not in stripped:
                continue
            key, _, val = stripped.partition(":")
            key, val = key.strip(), val.strip()
            if val == "|":
                block_key, block_indent, block_lines = key, None, []
                continue
            if val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                val = val[1:-1]
            out[key] = val
    if block_key is not None:
        out[block_key] = "\n".join(block_lines).rstrip() + "\n"
    return out

try:
    import yaml
    with open(os.environ["CHAD_MANIFEST_FILE"]) as f:
        m = yaml.safe_load(f) or {}
except ModuleNotFoundError:
    m = load_fallback(os.environ["CHAD_MANIFEST_FILE"])

tmpl = m.get("prompt_template", "") or ""
with open(os.environ["CHAD_TASK_FILE"]) as f:
    body = f.read()
out = tmpl.replace("{{task}}", body).replace("{{task_id}}", os.environ["CHAD_TASK_ID"])
with open(os.environ["CHAD_PROMPT_OUT"], "w") as f:
    f.write(out)
PY

# Copy the raw task file into the workdir for backup + audit.
case "$task_file" in
  *.json) cp "$task_file" "${workdir}/task.json" ;;
  *)      cp "$task_file" "${workdir}/task.txt"  ;;
esac

# ── Ledger: queued ─────────────────────────────────────────────────
ledger_append() {
  local status="$1"
  CHAD_LEDGER_ID="$task_id" \
  CHAD_LEDGER_KIND="$kind" \
  CHAD_LEDGER_STATUS="$status" \
  CHAD_LEDGER_WORKDIR="$workdir" \
  CHAD_LEDGER_BUDGET="$budget_tokens" \
  CHAD_LEDGER_FILE="$QUEUE_FILE" \
  python3 <<'PY'
import os, json, datetime
_UTC = getattr(datetime, "UTC", datetime.timezone.utc)
rec = {
    "id":      os.environ["CHAD_LEDGER_ID"],
    "kind":    os.environ["CHAD_LEDGER_KIND"],
    "status":  os.environ["CHAD_LEDGER_STATUS"],
    "workdir": os.environ["CHAD_LEDGER_WORKDIR"],
    "budget_tokens": int(os.environ["CHAD_LEDGER_BUDGET"]),
    "ts_utc": datetime.datetime.now(_UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(os.environ["CHAD_LEDGER_FILE"], "a") as f:
    f.write(json.dumps(rec) + "\n")
PY
}
ledger_append queued

# ── Dry-run fast path ──────────────────────────────────────────────
if [ "$dry_run" -eq 1 ]; then
  CHAD_DR_TASK_ID="$task_id" \
  CHAD_DR_KIND="$kind" \
  CHAD_DR_BINARY="$manifest_binary" \
  CHAD_DR_INVOCATION="$manifest_invocation" \
  CHAD_DR_PROMPT="$prompt_file" \
  CHAD_DR_BUDGET="$budget_tokens" \
  CHAD_DR_OUT="$result_file" \
  python3 <<'PY'
import os, json
out = {
    "status": "done",
    "dry_run": True,
    "task_id": os.environ["CHAD_DR_TASK_ID"],
    "kind": os.environ["CHAD_DR_KIND"],
    "would_invoke": os.environ["CHAD_DR_BINARY"],
    "invocation": os.environ["CHAD_DR_INVOCATION"],
    "prompt_path": os.environ["CHAD_DR_PROMPT"],
    "budget_tokens": int(os.environ["CHAD_DR_BUDGET"]),
    "summary": "dry-run: no sub-agent was executed",
}
with open(os.environ["CHAD_DR_OUT"], "w") as f:
    json.dump(out, f, indent=2)
PY
  ledger_append done
  echo "$task_id"
  exit 0
fi

# ── Resolve effective substrate ────────────────────────────────────
# CLI --substrate wins, then kind manifest's `substrate` field, then
# default "local". Validate to avoid passing garbage to the dispatcher.
effective_substrate="${substrate_override:-${manifest_substrate:-local}}"
case "$effective_substrate" in
  local|gha) ;;
  *) echo "chad-spawn: invalid substrate: $effective_substrate (must be local|gha)" >&2; exit 2 ;;
esac

# ── Run the sub-agent ──────────────────────────────────────────────
ledger_append running

stdout_log="${workdir}/stdout.log"
stderr_log="${workdir}/stderr.log"

if [ "$effective_substrate" = "gha" ]; then
  # GHA substrate: chad-spawn-gha handles branch push, workflow_dispatch,
  # poll for result.json, copy back. Sync mode (matches local contract).
  # See docs/design/spawn-as-github-run.md for the architecture.
  set +e
  CHAD_GHA_TASK_ID="$task_id" \
  CHAD_GHA_KIND="$kind" \
  CHAD_GHA_WORKDIR="$workdir" \
  CHAD_GHA_RESULT_FILE="$result_file" \
  CHAD_GHA_PROMPT_FILE="$prompt_file" \
  CHAD_GHA_TASK_FILE="$task_file" \
  CHAD_GHA_MANIFEST_FILE="$manifest_file" \
  CHAD_GHA_BINARY="$manifest_binary" \
  CHAD_GHA_INVOCATION="$manifest_invocation" \
  CHAD_GHA_TIMEOUT="$timeout_secs" \
  CHAD_GHA_BUDGET_TOKENS="$budget_tokens" \
    "${ORCH_DIR}/scripts/chad-spawn-gha.sh"
  helper_rc=$?
  set -e

  # On helper failure with no result.json, synthesize one so chad-collect
  # has something to merge. On success, the helper has already populated
  # result.json from the runner's commit.
  if [ "$helper_rc" -ne 0 ] && [ ! -s "$result_file" ]; then
    CHAD_GHA_RC="$helper_rc" \
    CHAD_GHA_TID="$task_id" \
    CHAD_GHA_KND="$kind" \
    CHAD_GHA_OUT="$result_file" \
    CHAD_GHA_ERR="$stderr_log" \
    python3 <<'PY'
import os, json
json.dump({
    "status": "failed",
    "task_id": os.environ["CHAD_GHA_TID"],
    "kind": os.environ["CHAD_GHA_KND"],
    "exit_code": int(os.environ["CHAD_GHA_RC"]),
    "substrate": "gha",
    "summary": f"chad-spawn-gha helper failed (exit {os.environ['CHAD_GHA_RC']}); see {os.environ['CHAD_GHA_ERR']}",
}, open(os.environ["CHAD_GHA_OUT"], "w"), indent=2)
PY
  fi

  exit_code="$(CHAD_GHA_RES="$result_file" python3 -c '
import json, os, sys
try:
    print(json.load(open(os.environ["CHAD_GHA_RES"])).get("exit_code", 0))
except Exception:
    print(1)
' 2>/dev/null || echo "$helper_rc")"

  final_status="done"
  [ "$exit_code" -eq 0 ] || final_status="failed"
  ledger_append "$final_status"
  echo "$task_id"
  exit "$exit_code"
fi

# Local substrate: existing in-container execution path.
export CHAD_RESULT_WORKDIR="$workdir"
export CHAD_TASK_ID="$task_id"

set +e
case "$manifest_invocation" in
  prompt-stdin)
    timeout --kill-after=10 "${timeout_secs}s" "$manifest_binary" \
      < "$prompt_file" \
      > "$stdout_log" 2> "$stderr_log"
    exit_code=$?
    ;;
  prompt-arg)
    prompt_body="$(cat "$prompt_file")"
    timeout --kill-after=10 "${timeout_secs}s" "$manifest_binary" \
      "$prompt_body" \
      > "$stdout_log" 2> "$stderr_log"
    exit_code=$?
    ;;
  openclaw-agent)
    # Each spawn gets its own session id so contexts don't bleed.
    # gbrain MCP is registered persistently in openclaw.json via
    # `openclaw mcp set gbrain ...` (done during chad-setup). The
    # --mcp-server flag is not supported in openclaw 2026.4.x.
    # HOME=/sandbox so openclaw finds its config at /sandbox/.openclaw
    # regardless of which user kubectl exec runs as.
    prompt_body="$(cat "$prompt_file")"
    timeout --kill-after=10 "${timeout_secs}s" \
      env HOME=/sandbox \
      openclaw agent --agent main --timeout "${timeout_secs}" \
        --session-id "sub-${task_id}" \
        -m "$prompt_body" \
      > "$stdout_log" 2> "$stderr_log"
    exit_code=$?
    ;;
  *)
    echo "chad-spawn: unknown invocation style: $manifest_invocation" > "$stderr_log"
    exit_code=3
    ;;
esac
set -e

# ── Extract structured result ──────────────────────────────────────
# Sub-agents are required to emit a JSON summary on the very last line
# of stdout. Fall back to a synthetic result if they didn't.
CHAD_RES_STDOUT="$stdout_log" \
CHAD_RES_EXIT="$exit_code" \
CHAD_RES_TASK_ID="$task_id" \
CHAD_RES_KIND="$kind" \
CHAD_RES_OUT="$result_file" \
python3 <<'PY'
import os, json
exit_code = int(os.environ["CHAD_RES_EXIT"])
last = ""
try:
    with open(os.environ["CHAD_RES_STDOUT"]) as f:
        for line in f:
            line = line.rstrip("\n")
            if line.strip():
                last = line
except FileNotFoundError:
    pass

parsed = None
try:
    v = json.loads(last)
    if isinstance(v, dict):
        parsed = v
except Exception:
    parsed = None

if parsed is None:
    parsed = {
        "status": "failed" if exit_code != 0 else "done",
        "summary": "sub-agent did not emit a JSON summary on the last line",
    }

parsed.setdefault("status", "failed" if exit_code != 0 else "done")
parsed.update({
    "task_id": os.environ["CHAD_RES_TASK_ID"],
    "kind": os.environ["CHAD_RES_KIND"],
    "exit_code": exit_code,
    "dry_run": False,
})
with open(os.environ["CHAD_RES_OUT"], "w") as f:
    json.dump(parsed, f, indent=2)
PY

final_status="done"
[ "$exit_code" -eq 0 ] || final_status="failed"
ledger_append "$final_status"

echo "$task_id"
exit "$exit_code"
