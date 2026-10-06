#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-budget.sh — Daily token budget for Chad's sub-agent spawns.
#
# Keeps /sandbox/.openclaw-data/budget.json in a simple shape:
#
#   {
#     "date_utc":        "2026-04-08",
#     "daily_limit":     500000,
#     "remaining_tokens": 450000,
#     "spent_by_kind":   { "coder": 30000, "researcher": 20000 }
#   }
#
# Commands:
#   chad-budget show [--field KEY]
#       Print the current budget as JSON. With --field, prints only the
#       named top-level key (remaining_tokens | daily_limit | date_utc).
#   chad-budget reserve N KIND
#       Decrement by N tokens for KIND. Exit 0 on success, 1 on insufficient.
#       Auto-resets the file at the start of a new UTC day.
#   chad-budget refund N KIND
#       Credit N tokens back (e.g., on sub-agent failure that didn't touch inference).
#   chad-budget reset [LIMIT]
#       Force-reset to a fresh day at LIMIT tokens (default: CHAD_DAILY_TOKEN_LIMIT
#       or 500000).
#
# The enforcement is honor-based — nothing inside the sandbox prevents a
# misbehaving caller from editing the file directly. The point is to
# catch *accidental* runaway loops, not a malicious agent.

set -euo pipefail

BUDGET_FILE="${CHAD_BUDGET_FILE:-/sandbox/.openclaw-data/budget.json}"
DEFAULT_LIMIT="${CHAD_DAILY_TOKEN_LIMIT:-500000}"

mkdir -p "$(dirname "$BUDGET_FILE")"

cmd="${1:-show}"
shift || true

export CHAD_BUDGET_FILE CHAD_BUDGET_CMD="$cmd" CHAD_BUDGET_DEFAULT_LIMIT="$DEFAULT_LIMIT"
export CHAD_BUDGET_ARG1="${1:-}" CHAD_BUDGET_ARG2="${2:-}"

python3 <<'PY'
import os, sys, json, datetime

path  = os.environ["CHAD_BUDGET_FILE"]
cmd   = os.environ["CHAD_BUDGET_CMD"]
limit = int(os.environ["CHAD_BUDGET_DEFAULT_LIMIT"])
arg1  = os.environ.get("CHAD_BUDGET_ARG1", "")
arg2  = os.environ.get("CHAD_BUDGET_ARG2", "")

# Use timezone-aware UTC to avoid DeprecationWarning on Python 3.12+.
# datetime.UTC exists from 3.11 onward, which matches the base image.
_UTC = getattr(datetime, "UTC", datetime.timezone.utc)
today = datetime.datetime.now(_UTC).strftime("%Y-%m-%d")

def load():
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

def save(b):
    with open(path, "w") as f:
        json.dump(b, f, indent=2)

def fresh(l):
    return {
        "date_utc": today,
        "daily_limit": int(l),
        "remaining_tokens": int(l),
        "spent_by_kind": {},
    }

b = load()
if b is None or b.get("date_utc") != today:
    b = fresh(limit if b is None else b.get("daily_limit", limit))

if cmd == "show":
    # Optional --field KEY: print just one top-level key (useful for
    # budget-aware callers that need to short-circuit on low reserve).
    if arg1 == "--field" and arg2:
        val = b.get(arg2)
        if val is None:
            sys.stderr.write(f"chad-budget: unknown field: {arg2}\n")
            sys.exit(2)
        print(val)
    else:
        print(json.dumps(b, indent=2))
    sys.exit(0)

if cmd == "reserve":
    if not arg1:
        sys.stderr.write("chad-budget reserve: need N tokens\n")
        sys.exit(2)
    n = int(arg1)
    kind = arg2 or "unknown"
    if n > b["remaining_tokens"]:
        sys.stderr.write(
            f"chad-budget: insufficient (have {b['remaining_tokens']}, need {n})\n"
        )
        sys.exit(1)
    b["remaining_tokens"] -= n
    b["spent_by_kind"][kind] = b["spent_by_kind"].get(kind, 0) + n
    save(b)
    sys.exit(0)

if cmd == "refund":
    if not arg1:
        sys.stderr.write("chad-budget refund: need N tokens\n")
        sys.exit(2)
    n = int(arg1)
    kind = arg2 or "unknown"
    b["remaining_tokens"] = min(b["daily_limit"], b["remaining_tokens"] + n)
    if kind in b["spent_by_kind"]:
        b["spent_by_kind"][kind] = max(0, b["spent_by_kind"][kind] - n)
    save(b)
    sys.exit(0)

if cmd == "reset":
    l = int(arg1) if arg1 else limit
    save(fresh(l))
    sys.exit(0)

sys.stderr.write(f"chad-budget: unknown command: {cmd}\n")
sys.exit(2)
PY
