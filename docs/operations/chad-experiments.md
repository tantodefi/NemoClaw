<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad — Autonomous Experiment Lifecycle

Chad runs a structured iteration loop every night at 02:00 UTC. He
scans memory for objectives or tasks the operator does repeatedly,
designs experiments to automate them, builds the OpenWebUI artifact
(automation, function, tool, knowledge base, calendar event, memory,
or note), measures outcomes against a baseline, and either promotes
or retires the experiment — all bounded by an explicit
concurrent-experiment budget and a regression auto-retire threshold.

This document is the operator's-eye view. Chad's playbook is the
`chad-experiment` skill at `/sandbox/.openclaw-data/skills/chad-experiment/SKILL.md`
(source-tracked at `scripts/openwebui/chad-experiment-skill.md`).

## Architecture at a glance

```
02:00 UTC nightly cron (experiment-night)

  Phase 1 PROPOSE   memory + ledger scan → up to 3 designs / operator
  Phase 2 OBSERVE   gather evidence from OpenWebUI surfaces
  Phase 3 EVALUATE  score 0..1 vs baseline → auto promote / retire
  Phase 4 CALENDAR  [chad-block] / [chad-experiment] / [operator-sync]

          ↓ writes to
  /sandbox/.openclaw-data/state/experiments/
    ├── config.json           budget + thresholds + tag map
    ├── ledger.jsonl          append-only event log
    ├── active/<id>.json      currently running
    └── archive/<id>.json     promoted or retired

          ↓ gbrain-dream at 03:30 UTC picks this up
          ↓ chad-proposal-apply at 04:30 UTC sees proposals
```

## Files Chad touches

| Path | Purpose |
|---|---|
| `/sandbox/.openclaw-data/bin/chad-experiment` | Lifecycle CLI (design, start, observe, evaluate, promote, retire, list, show, budget, ab-start, ab-pick, recent-memory, recent-ledger) |
| `/sandbox/.openclaw-data/bin/chad-webui` | Artifact mutation surface chad-experiment calls under the hood |
| `/sandbox/.openclaw-data/skills/chad-experiment/SKILL.md` | The methodology Chad consults |
| `/sandbox/.openclaw-data/state/experiments/config.json` | Budget, thresholds, calendar tag map |
| `/sandbox/.openclaw-data/state/experiments/ledger.jsonl` | One JSON line per state transition |
| `/sandbox/.openclaw-data/state/experiments/active/<id>.json` | Live experiment record |
| `/sandbox/.openclaw-data/state/experiments/archive/<id>.json` | Promoted or retired (snapshot) |

## Autonomy boundaries

Default config (`config.json`):

```jsonc
{
  "max_active_per_operator": 3,
  "default_evaluation_window_days": 7,
  "regression_threshold": -0.30,
  "allowed_types": [
    "automation", "function", "tool", "knowledge",
    "memory", "note", "calendar", "chad-cron"
  ]
}
```

- **Concurrent cap**: max 3 active experiments per operator.
- **Regression threshold**: score ≤ 0.70 at evaluation auto-retires.
- **Type whitelist**: only listed types are allowed.
- **Operator scoping**: every experiment is tied to a
  `CHAD_OPERATOR_SLUG`; `chad-webui` enforces per-operator API keys.

## Surface mapping — hypothesis → artifact type

| Hypothesis pattern | Artifact type | Created via |
|---|---|---|
| "Run this prompt on a schedule …" | `automation` | `webui__automations_create` (RRULE) |
| "Every chat turn should be transformed by …" | `function` | `webui__functions_create` |
| "Model should invoke this tool on demand" | `tool` | `webui__tools_create` |
| "Grounding for chats about X should reference …" | `knowledge` | `webui__knowledge_create` + `add_file` |
| "Operator should remember that …" | `memory` | `webui__memories_create` |
| "Capture this draft / source / note" | `note` | `webui__notes_create` |
| "Block out time / mark Chad activity" | `calendar` | `webui__calendar_create_event` (tag-prefixed title) |
| "Recurring task at the sandbox layer" | `chad-cron` | `openclaw cron add` |

## Calendar tag conventions

| Title prefix | Meaning |
|---|---|
| `[chad-block]` | Chad doing focused work on operator's behalf — visibility, not invitation |
| `[chad-experiment]` | An active experiment is running; title includes hypothesis snippet |
| `[operator-sync]` | Proposed coordination between two operators (Chad cannot write to both calendars unilaterally — only proposes on operator A and notifies operator B) |
| `[experiment-review]` | Weekly recurring Chad ↔ operator review block |

## Inspecting Chad's activity

```sh
# What's running right now
ssh openshell-chad "/sandbox/.openclaw-data/bin/chad-experiment list"

# Filter to one operator
ssh openshell-chad "/sandbox/.openclaw-data/bin/chad-experiment list --operator tjcooke"

# Include archived
ssh openshell-chad "/sandbox/.openclaw-data/bin/chad-experiment list --all"

# Full record
ssh openshell-chad "/sandbox/.openclaw-data/bin/chad-experiment show --id exp-..."

# Recent ledger events
ssh openshell-chad "/sandbox/.openclaw-data/bin/chad-experiment recent-ledger --limit 20"

# Budget snapshot
ssh openshell-chad "/sandbox/.openclaw-data/bin/chad-experiment budget"
```

## Tuning Chad's autonomy

Edit `/sandbox/.openclaw-data/state/experiments/config.json`. The
next cron tick picks up new values (config re-read every invocation).

| Goal | Adjust |
|---|---|
| More aggressive (more concurrent experiments) | Raise `max_active_per_operator` (e.g. 5) |
| Tighter quality bar (kill failures faster) | Tighten `regression_threshold` (e.g. `-0.15`) |
| Looser quality bar (more rope) | Loosen `regression_threshold` (e.g. `-0.50`) |
| Longer evaluation windows | Raise `default_evaluation_window_days` |
| Block a class of artifact | Remove the type from `allowed_types` |

## Failure modes

| Symptom | Likely cause | Recovery |
|---|---|---|
| Cron summary says `proposed=0 observed=0 evaluated=0` repeatedly | Memory + ledger sparse OR all operators at cap | Check `chad-experiment budget`; raise cap or retire stale experiments |
| Same hypothesis re-proposed nightly | Phase 1 not deduping against archive | Add operator memory entry "chad already tried X on YYYY-MM-DD" |
| Experiment promoted but operator never engages | Success metric too lenient | Manually retire; tighten metric in future similar designs |
| Auto-retire on borderline winner | `regression_threshold` too tight | Loosen, then design afresh |
| `start` fails with `chad-webui` error | Artifact creation rejected | Retire design; re-design with valid args |
| Custom rollback didn't execute | Non-`chad-webui` rollback strings aren't auto-run (safety) | Run manually; note in retire reason |

## Integration with the rest of Chad

| System | Where experiment integrates |
|---|---|
| `gbrain-dream` (03:30 UTC) | Reads experiment ledger + memory into the brain |
| `chad-proposal-apply` (04:30 UTC) | Sees experiment-related proposals in `feedback-proposals.md` |
| `chad-mail-check` (hourly) | Inbound operator pain points feed Phase 1 hypothesis sourcing |
| `chad-issue-triage` (daily 10:00 UTC) | Triage outcomes that look like recurring tasks → experiments instead of bug tickets |
| `chad-self-improve` (Sun 03:00 UTC) | Weekly meta-review: should thresholds change? |
| `memory-curator` (Sat 04:00 UTC) | Dedupes experiment-related memory entries |
| `workspace-backup` (every 6h) | Backs up `state/experiments/` to `tantodefi/chad-state` (if added to manifest) |
| `chad-webui` MCP tools | Every artifact mutation — structured audit trail |

## A/B testing pattern

```sh
chad-experiment ab-start \
  --hypothesis "Terse system prompt outperforms warm for daily brief" \
  --type automation \
  --success-metric "Read-through rate by chat-duration signal" \
  --surface-cmd "automations create" \
  --surface-args-a '{"name":"...","prompt":"Three bullets.","rrule":"..."}' \
  --surface-args-b '{"name":"...","prompt":"Good morning!","rrule":"..."}'

# After observation window:
chad-experiment ab-pick --id <either> --winner B
# Promotes B, retires A
```

Both variants count toward the operator's concurrent budget — so
ab-start with default 3-cap requires ≤1 active going in.

## Next steps

- [chad-devflow.md](chad-devflow.md) — full wrapper catalog
- [openwebui.md](openwebui.md) — underlying artifact surface
- [wrapper-bugs.md](wrapper-bugs.md) — known issues + workarounds
