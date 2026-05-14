<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad Wrapper Bugs — Tracking & Workarounds

Five bugs in the deployed `chad-*` CLI tools at `/usr/local/bin/` on the
chad sandbox. All five were discovered 2026-05-13 while debugging why
`self-improve`, `memory-curator`, `issue-triage`, and `email-check`
weren't producing expected output. The deployed binaries are baked into
the chad image at `chad-setup.sh` deploy time and are root-RO inside the
sandbox, so the user-space workaround is a **shim-and-repoint pattern**:
patched copies at `/sandbox/.openclaw-data/bin/` plus absolute-path cron
payloads or env-var injections that route around the originals.

Once these fixes land in the canonical wrapper sources and a fresh
chad-setup.sh re-runs, the shims at `/sandbox/.openclaw-data/bin/`
become redundant and can be removed.

---

## Bug 1 — `chad-budget`: bare `export CHAD_BUDGET_FILE` with no value

**File:** `/usr/local/bin/chad-budget`, line 43

```bash
BUDGET_FILE="${CHAD_BUDGET_FILE:-/sandbox/.openclaw-data/budget.json}"
…
export CHAD_BUDGET_FILE CHAD_BUDGET_CMD="$cmd" CHAD_BUDGET_DEFAULT_LIMIT="$DEFAULT_LIMIT"
```

The fallback assignment goes into `BUDGET_FILE` (a *local* variable). The
`export CHAD_BUDGET_FILE` then exports whatever value the env var has —
which is *unset/empty* when no caller pre-set it. The Python heredoc
that follows reads `os.environ["CHAD_BUDGET_FILE"]` and dies on
`KeyError`. The caller's `2>/dev/null || echo 0` then swallows the
error, returning 0 — which any budget-gated wrapper interprets as
"out of budget, skip."

**Blast radius:** every caller of `chad-budget show --field` got 0
back. `chad-issue-triage` skipped every cron tick with
`remaining=0 < 182000` for ~11 days even though the actual budget
file showed `remaining_tokens: 485000`.

**Fix:**

```bash
# Set both variables, then export the env one explicitly with the value.
BUDGET_FILE="${CHAD_BUDGET_FILE:-/sandbox/.openclaw-data/budget.json}"
export CHAD_BUDGET_FILE="$BUDGET_FILE"
export CHAD_BUDGET_CMD="$cmd" CHAD_BUDGET_DEFAULT_LIMIT="$DEFAULT_LIMIT"
```

**Workaround in place:** `chad-gateway-watchdog.sh` exports
`CHAD_BUDGET_FILE='/sandbox/.openclaw-data/budget.json'` when
relaunching the gateway. Every gateway-spawned subprocess inherits a
valid value, so the broken `export CHAD_BUDGET_FILE` becomes a no-op.

---

## Bug 2 — `chad-issue-triage`: F=value passed as argv, read as env (×3)

**File:** `/usr/local/bin/chad-issue-triage`, lines 163, 181, 246

```bash
picked_count="$(python3 -c 'import json,os; print(len(json.load(open(os.environ["F"]))))' F="$selected_file")"
```

The shell pattern `command ARG ARG2` passes `ARG`/`ARG2` as
`sys.argv[1..]`, *not* as environment variables. `os.environ["F"]`
fails with `KeyError: 'F'`. Three identical occurrences in this file.

**Fix:** prefix the env var on the command, don't suffix it.

```bash
picked_count="$(F="$selected_file" python3 -c 'import json,os; print(len(json.load(open(os.environ["F"]))))')"
```

**Blast radius:** masked by Bug 1 (the budget gate was failing
earlier and short-circuiting out before reaching these lines). Once
the budget gate started passing, every triage cron tick traceback'd
on line 163. Currently doesn't bite because `chad-state` has zero
open issues, but the moment one appears it crashes.

**Workaround in place:** patched shim at
`/sandbox/.openclaw-data/bin/chad-issue-triage` (3 sites fixed).

---

## Bug 3 — `chad-mail-check`: `--limit=20` returns *oldest* 20 messages

**File:** `/usr/local/bin/chad-mail-check`, line 70

```bash
/usr/local/bin/proton-tool mail --limit=20 >"$INBOX" 2>&1
```

`proton-tool mail` returns messages in **ascending date order** with a
silent cap on `--limit`. With 27 messages in the supachad inbox and 5
unread, `--limit=20` returns the *oldest* 20 (all already-read April
notifications) and *never* sees the 7 newest messages including 5
unread ones. The cron has been reporting "Pending replies: 0" while
a tjcooke `Re:` thread sat unread for days.

**Two root causes:**

1. `proton-tool` should support newest-first ordering (e.g.
   `--order=desc`) or an `--unread-only` filter. Its `--help` doesn't
   mention the implicit ascending order.
2. `chad-mail-check` should defend by fetching enough rows (or
   filtering server-side) to be sure it sees the newest, then
   re-sort newest-first before piping to the downstream parser.

**Fix proposed in shim:**

```bash
# Fetch up to 500 then re-sort newest-first.
/usr/local/bin/proton-tool mail --limit=500 > "$RAW_INBOX" 2>&1
python3 -c '<sort blocks by Date: desc and renumber>' < "$RAW_INBOX" > "$INBOX"
# Also surface server-side unread count (from count-mail) so divergence is visible.
INBOX_UNREAD="$(proton-tool count-mail | awk '/^  Inbox /{print $NF}' | grep -oE '[0-9]+$')"
```

**Workaround in place:** patched shim at
`/sandbox/.openclaw-data/bin/chad-mail-check` does the fetch-all +
re-sort + emits `Inbox unread (server): N` so the agent always sees
divergence between server unread and what the parser parked.

---

## Bug 4 — `chad-issue-triage-cron`: hardcoded `/usr/local/bin/chad-issue-triage`

**File:** `/usr/local/bin/chad-issue-triage-cron`, line 231

```bash
nohup bash -c "
  if /usr/local/bin/chad-issue-triage --top '${TOP_N}' > '${LOG}' 2>&1; then
```

Using the absolute path defeats the PATH-prepend mechanism that's
supposed to let sandbox-writable shims at
`/sandbox/.openclaw-data/bin/` shadow buggy originals. Shipping
fix without an image rebuild is currently impossible from this site
alone — you have to shim *both* `chad-issue-triage-cron` and
`chad-issue-triage`.

**Fix:** drop the prefix, rely on `PATH` resolution.

```bash
if chad-issue-triage --top "${TOP_N}" > "${LOG}" 2>&1; then
```

Or, defensively, `"${CHAD_ISSUE_TRIAGE:-chad-issue-triage}"`.

**Workaround in place:** patched shim at
`/sandbox/.openclaw-data/bin/chad-issue-triage-cron` invokes
`/sandbox/.openclaw-data/bin/chad-issue-triage` directly. The cron
job payload was edited via `openclaw cron edit --message` to call
the shim by absolute path, since the openclaw runtime currently
*appends* `/sandbox/.openclaw-data/bin` to PATH (not prepend), so
PATH-based shadowing doesn't work without further changes.

---

## Bug 5 — `chad-email-check-cron`: hardcoded `/usr/local/bin/chad-mail-check`

**File:** `/usr/local/bin/chad-email-check-cron`, line 60

```bash
if /usr/local/bin/chad-mail-check >"$INBOX" 2>&1; then
```

Same class as Bug 4. Same fix.

**Workaround in place:** patched shim at
`/sandbox/.openclaw-data/bin/chad-email-check-cron` plus
cron-payload absolute-path override.

---

## Runtime PATH override is half-broken

The openclaw runtime currently mangles `PATH` for spawned subprocesses.
Setting `PATH=/sandbox/.openclaw-data/bin:/usr/local/bin:/usr/bin:/bin`
in the watchdog's relaunch SSH command results in the agent shell
seeing:

```
PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games:/sandbox/.openclaw-data/bin
```

The sandbox bin is *appended* rather than *prepended*. So PATH-based
shim shadowing does not currently work — you have to point absolute
paths at the shim. Worth fixing in upstream openclaw / nemoclaw so
the watchdog's PATH order is honored.

---

## Summary table

| # | File | Line(s) | Bug class | Shim path |
|---|------|---------|-----------|-----------|
| 1 | `chad-budget` | 43 | unset export | env-var override in watchdog |
| 2 | `chad-issue-triage` | 163, 181, 246 | argv-vs-env (`F=…` suffix) | `/sandbox/.openclaw-data/bin/chad-issue-triage` |
| 3 | `chad-mail-check` | 70 | proton-tool `--limit` cap + ascending order | `/sandbox/.openclaw-data/bin/chad-mail-check` |
| 4 | `chad-issue-triage-cron` | 231 | hardcoded `/usr/local/bin` path | `/sandbox/.openclaw-data/bin/chad-issue-triage-cron` |
| 5 | `chad-email-check-cron` | 60 | hardcoded `/usr/local/bin` path | `/sandbox/.openclaw-data/bin/chad-email-check-cron` |

When these land upstream and a fresh `chad-setup.sh` runs, delete the
five shims under `/sandbox/.openclaw-data/bin/` and the cron-payload
absolute-path overrides.
