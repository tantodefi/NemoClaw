<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Chad Autonomy Loops

Chad's "always-on" claim cashes out as six distinct cron-driven loops
that read state, propose action, and apply or surface that proposal.
This page enumerates them and the wrappers that close each one.

## The six loops

| # | Loop | Wrapper(s) | Schedule | Reads | Writes |
|---|---|---|---|---|---|
| 1 | **Self-improvement** | `chad-self-improve` v2 (detached signal collection + ONE single-turn LLM call → machine-readable proposals) → `chad-proposal-apply` (applies safe-list) | Sun 03:00 UTC + daily 04:30 UTC | last 7 days of spawn-ledger failures, sub-agent results, cron run logs (`cron/runs/*.jsonl`, read directly — job UUIDs mapped to names), `auto-action-log.jsonl`, feedback memory titles, outstanding proposals | prepends `## Self-improvement run` + `### Proposals (machine-readable)` block to `feedback-proposals.md`; safe-list applies via `openclaw cron edit`; `## Applied` block back into proposals |
| 2 | **Bug → fix → ship** | `chad-issue-triage-cron` → `chad-drafter` → optional `chad-spawn --kind researcher/coder` | daily 10:00 UTC | top-N open issues in `${CHAD_BUG_REPO}` | drafts under `### Issue triage drafts` in today's memory; never auto-comments |
| 3 | **Cron telemetry / budget audit** | `chad-budget-audit` (emits prose + structured JSON) → `chad-proposal-apply` (consumes JSON) | Mon 04:00 UTC + daily 04:30 UTC | last-50 `openclaw cron runs` per task, `/tmp/chad-premium.jsonl`, `task-profiles.json` | recommendation table + `### Proposals (machine-readable)` JSON block to `feedback-proposals.md`; bounded `openclaw cron edit` calls; `## Applied` block |
| 4 | **Dreaming (gbrain consolidation)** | `chad-gbrain-dream` + dream-digest step | nightly 03:30 UTC | today's `memory/<date>.md`, `events-<date>.jsonl`, workspace doc set, gbrain stale chunks, `gbrain doctor` | gbrain pages upserted; `memory/dream-digest-<date>.md` (24h delta + doctor); `memory/feedback_brain_health_<date>.md` if doctor reports anomalies |
| 5 | **Skill discovery** | `chad-skill-watch` (daily diff) + `chad-setup.sh` skill-sync (host-driven) | daily 09:00 UTC + on-demand from host | `openclaw skills list --json` vs snapshot at `/sandbox/.openclaw-data/state/skills-snapshot.json`; `~/.claude/skills/gstack/.openclaw/skills/` | snapshot updated; `## Skill catalog diff` block in today's memory; signal-detector skill picks it up next reasoning cycle |
| 6 | **Autonomous experiment lifecycle** | `chad-experiment-cron` (deterministic observe → evaluate → design driver) + `chad-experiment` CLI | nightly 02:00 UTC | active experiment records, recent memory digest, archived hypotheses | heartbeat observations + LLM evaluation verdicts (promote/retire/extend) in `state/experiments/ledger.jsonl`; new whitelisted OpenWebUI artifacts (notes / automations / memories) via `chad-webui`; one-line summary in today's memory. Detailed in `chad-experiments.md` (use the `nemoclaw-manage-operations` skill). |

Every wrapper stays inside the **wrapper-only invariant** documented in
`chad-readme.md` §7.1: cron messages are one-line invocations, slow work
is `nohup`'d inside the wrapper. Inputs/outputs are markdown + JSONL
files under `/sandbox/.openclaw/workspace/memory/` and
`/sandbox/.openclaw-data/`, never live agent state.

## Closing the loops

Both write-only gaps are now closed by three new wrappers + one
extension. The autonomy loops are no longer one-way:

| Loop | Closing wrapper | Trigger | What it does |
|---|---|---|---|
| Loop 1 / 3 | **`chad-proposal-apply`** | daily 04:30 UTC cron | Reads the latest `### Proposals (machine-readable)` JSON block from `feedback-proposals.md`. Per-`kind` handlers: `cron_edit` (default) applies via `openclaw cron edit` if (field ∈ `{timeoutSeconds, maxOutputTokens}`, value ≤ absolute cap `7200`/`32768`, change ≥ 1.1×, last run ok, `chad-action-gate chad_self_modify_cron` returns `auto`); `memory` appends content via `chad_self_modify_memory` (auto by default); `automation`/`note`/`calendar_event` are recognised but parked for v3. Entries failing the gate (decision=`draft`) or above the cap route to a `## Pending operator review` table so they don't disappear. `## Applied` + `## Pending` blocks older than 30 days are pruned. |
| Loop 1 (signals) | **`chad-self-improve` v2** | weekly Sun 03:00 UTC cron | Full rewrite (2026-06-10): the cron agent only runs `chad-self-improve --detach` and acks the detach line. The wrapper collects signal deterministically (failed spawns, sub-agent results, cron failures read straight from `cron/runs/*.jsonl`, auto-action errors, feedback memory, outstanding proposals — capped at 7000 prompt chars), makes ONE single-turn no-tools LLM call, validates the response, and prepends prose + machine-readable proposals to `feedback-proposals.md`. Replaces the v1 multi-turn researcher spawn that hit LLM idle timeouts and duplicate-spawned 4× in 5 minutes. flock + per-day dedupe make reruns safe. |
| Loop 4 | **`chad-dream-digest`** (appended to `chad-gbrain-dream`) | nightly 03:30 UTC | After the dream cycle, writes `memory/dream-digest-<date>.md` with new pages since yesterday + `gbrain doctor` tail + stats. If doctor reports `[WARN]`/`[FAIL]`/`[ERROR]`, mirrors them into `memory/feedback_brain_health_<date>.md` so the next self-improve sees them as a recurring rule. |
| Loop 5 | **`chad-skill-watch`** | daily 09:00 UTC cron | Diffs `openclaw skills list --json` against `/sandbox/.openclaw-data/state/skills-snapshot.json` and surfaces added / removed / description-drifted skills under `## Skill catalog diff` in today's memory. The signal-detector skill picks them up on chad's next reasoning cycle. |

### Safety properties

- **No code or policy modification.** Every wrapper stays inside the
  draft-only boundary documented in `project_chad_autonomy_roadmap`.
  Code changes still round-trip through bug-intake → researcher →
  coder → human PR review.
- **Bounded knob tweaks.** `chad-proposal-apply` only ever moves
  `timeoutSeconds`/`maxOutputTokens` for an existing cron, up to
  absolute caps (`7200` / `32768`) — values above the cap route to
  operator review instead of being silently rejected. Replaces the
  earlier `±2×` bound that blocked evidence-based proposals from
  `chad-budget-audit`.
- **Per-action gating.** Every applied tweak passes
  `chad-action-gate check chad_self_modify_cron <name>` first; the
  global kill-switch file (`/sandbox/.openclaw/workspace/.auto-disabled`)
  shorts the whole loop on demand.
- **Idempotency.** Re-runs against the same proposals block are
  no-ops — entries are matched against the audit log
  (`/sandbox/.openclaw-data/state/auto-action-log.jsonl`) by
  `(target, field, new)` within 24h.
- **Fully audited.** Every apply emits one line to the audit log and
  one row to the `## Applied` table in `feedback-proposals.md`.
- **No daily noise.** Pending entries are deduped against blocks
  already in the file (same target/field/old/new), and a fully no-op
  applier run appends nothing — the daily cadence against weekly
  proposals doesn't grow the file.

## Sub-agent orchestration contract

Chad routes big tasks to sub-agents rather than absorbing them into
the live session. The contract lives in the pod's `AGENTS.md` (backed
up via `chad-workspace-backup`) and the `chad-orchestrator` skill:

- **Detect**: multi-step research, content drafting from sources, code
  or repo analysis, anything over ~2 minutes of focused tool work, or
  an explicit "in the background" → spawn; small lookups stay inline.
- **Route**: check `queue/tasks.jsonl` for a running duplicate first,
  then `chad-intake --from chat --task-file <file>` (auto-routes the
  kind) or `chad-spawn --kind <kind> --task-file <file>` directly.
- **Report — always**: every spawn (or refusal) is reported to the
  user: what was kicked off (kind + task_id), where results land
  (`subagents/<task_id>/` + today's memory), when to expect them, or
  why the task was not spawned. Big tasks are never silently absorbed.
- **Reconcile**: `chad-spawn-poll` (every 5 min, host launchd)
  transitions async gha entries; the weekly `spawn-gc` cron
  terminal-izes entries stuck `queued`/`running` >24h (orphaned by a
  killed parent) and prunes spawn branches.

## Maintenance crons behind the loops

| Cron | Schedule | What it protects |
|---|---|---|
| `spawn-gc` | Mon 02:30 UTC | Ledger hygiene (orphan reconcile) + `chad-spawn/*` branch retention (done=7d, failed=30d) |
| `gbrain-prune` | Sun 02:00 UTC | gbrain page retention (memory/events >365d, chat >180d) + stale workspace digests (>30d) |
| `memory-curator` | Sat 04:00 UTC | Memory consolidation proposals (never auto-applied) |
| `workspace-backup` | every 6h | Pod state survives sandbox resets |

## Always finish with text after tool calls

Chad's runtime expectation, enforced via `AGENTS.md` on the chad pod
(at `/sandbox/.openclaw/workspace/AGENTS.md`): every agent turn must
end with a text response, even when the substantive work was done via
tool calls. The pattern breaks when a turn ends with a `read` /
`exec` / `gbrain_search` / `webui__*` tool call but no closing text —
the morning-summary automation hit this on 2026-05-17, producing
empty replies in OpenWebUI chats despite the underlying tools
succeeding.

Source-of-truth note: `AGENTS.md` is not git-tracked in NemoClaw
because the canonical copy lives on the (ephemeral) chad pod and gets
backed up to `CHAD_STATE_REPO` (`tantodefi/chad-state` by default)
via the `chad-workspace-backup` cron. The "always finish with text"
rule was added to the pod copy on 2026-05-17. When the next major
refactor pulls workspace identity files into source (planned), this
rule moves into the source template.

## Cross-reference

- chad-devflow.md (use the `nemoclaw-manage-operations` skill) — full wrapper catalog and cron schedules.
- chad-skills.md (use the `nemoclaw-manage-operations` skill) — what skills are registered and how.
- gbrain.md (use the `nemoclaw-manage-operations` skill) — embedder + dream-cycle internals for loop 4.
- log-locations.md (use the `nemoclaw-manage-operations` skill) — where each loop's output lands.
