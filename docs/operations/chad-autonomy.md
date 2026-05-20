---
title:
  page: "Chad Autonomy Loops"
  nav: "Chad Autonomy"
description:
  main: "The six self-driving loops Chad runs from cron, the two known gaps in current autonomy, and the recommended next wrappers to close them."
  agent: "Reference for the autonomy surface area: which loops exist, where their wrappers live, what they read and write, and where the loop is broken (write-only proposals, blind self-improve)."
keywords: ["chad autonomy", "self-improve", "feedback proposals", "cron telemetry", "gbrain dream", "skill discovery"]
topics: ["operations", "autonomy"]
tags: ["openclaw", "openshell", "nemoclaw", "chad", "operations"]
content:
  type: reference
  difficulty: technical_intermediate
  audience: ["developer", "engineer", "operator"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad Autonomy Loops

Chad's "always-on" claim cashes out as six distinct cron-driven loops
that read state, propose action, and apply or surface that proposal.
This page enumerates them and the wrappers that close each one.

## The six loops

| # | Loop | Wrapper(s) | Schedule | Reads | Writes |
|---|---|---|---|---|---|
| 1 | **Self-improvement** | `chad-self-improve` (writes proposals) → `chad-proposal-apply` (applies safe-list) | Sun 03:00 UTC + daily 04:30 UTC | last 7 days of `memory/<date>.md`, `auto-action-log.jsonl`, `openclaw cron runs --limit 50` per cron, prior proposals | proposals to `feedback-proposals.md`; safe-list applies via `openclaw cron edit`; `## Applied` block back into proposals |
| 2 | **Bug → fix → ship** | `chad-issue-triage-cron` → `chad-drafter` → optional `chad-spawn --kind researcher/coder` | daily 10:00 UTC | top-N open issues in `${CHAD_BUG_REPO}` | drafts under `### Issue triage drafts` in today's memory; never auto-comments |
| 3 | **Cron telemetry / budget audit** | `chad-budget-audit` (emits prose + structured JSON) → `chad-proposal-apply` (consumes JSON) | Mon 04:00 UTC + daily 04:30 UTC | last-50 `openclaw cron runs` per task, `/tmp/chad-premium.jsonl`, `task-profiles.json` | recommendation table + `### Proposals (machine-readable)` JSON block to `feedback-proposals.md`; bounded `openclaw cron edit` calls; `## Applied` block |
| 4 | **Dreaming (gbrain consolidation)** | `chad-gbrain-dream` + dream-digest step | nightly 03:30 UTC | today's `memory/<date>.md`, `events-<date>.jsonl`, workspace doc set, gbrain stale chunks, `gbrain doctor` | gbrain pages upserted; `memory/dream-digest-<date>.md` (24h delta + doctor); `memory/feedback_brain_health_<date>.md` if doctor reports anomalies |
| 5 | **Skill discovery** | `chad-skill-watch` (daily diff) + `chad-setup.sh` skill-sync (host-driven) | daily 09:00 UTC + on-demand from host | `openclaw skills list --json` vs snapshot at `/sandbox/.openclaw-data/state/skills-snapshot.json`; `~/.claude/skills/gstack/.openclaw/skills/` | snapshot updated; `## Skill catalog diff` block in today's memory; signal-detector skill picks it up next reasoning cycle |
| 6 | **Autonomous experiment lifecycle** | `chad-experiment-night` cron + `chad-experiment` CLI | nightly 02:00 UTC | recent memory (`chad-experiment recent-memory`), recent ledger (`chad-experiment recent-ledger`), `webui__*` MCP tools, gbrain queries, operator chat history | up to N new designed experiments per operator (`state/experiments/active/<id>.json`); observations + state transitions in `state/experiments/ledger.jsonl`; auto-promote/retire on score vs `regression_threshold`; `[chad-experiment]` / `[operator-sync]` calendar events on operators' calendars; summary block in today's memory. Detailed in [`chad-experiments.md`](chad-experiments.md). |

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
| Loop 1 (signals) | **`chad-self-improve` extension** | weekly Sun 03:00 UTC cron | Now also pulls `openclaw cron runs --limit 50` per registered cron and the last 7 days of `auto-action-log.jsonl` failures, plus a tail of outstanding (unapplied) proposals. The researcher sees infrastructure failures it was previously deaf to. |
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

- [chad-devflow.md](chad-devflow.md) — full wrapper catalog and cron schedules.
- [chad-skills.md](chad-skills.md) — what skills are registered and how.
- [gbrain.md](gbrain.md) — embedder + dream-cycle internals for loop 4.
- [log-locations.md](log-locations.md) — where each loop's output lands.
