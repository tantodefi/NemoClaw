---
title:
  page: "Chad Workflow Scenarios"
  nav: "Chad Workflows"
description:
  main: "Catalog of the realistic email scenarios Chad is expected to handle, the path each one takes through the cron pipeline, and how to verify the result."
  agent: "Reference catalog of named workflow scenarios for tantodefi (engineer) and tjcooke (fitness coach). Use when the user asks `what should Chad do for X` or wants to test/regress a specific path."
keywords: ["chad workflows", "email scenarios", "auto-reply test", "fitness rag", "drafter"]
topics: ["operations", "testing"]
tags: ["openclaw", "openshell", "nemoclaw", "chad", "operations"]
content:
  type: reference
  difficulty: technical_intermediate
  audience: ["developer", "engineer", "operator"]
status: draft
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad Workflow Scenarios

This page enumerates the named workflow scenarios Chad is expected to handle end-to-end. Each scenario names the inbound trigger, the wrappers + sub-agents involved, the action-gate decision, and the verification step. Use it as a regression spec when changing `chad-email-check-cron`, `chad-drafter`, `chad-autosend-replies`, or any kind manifest.

## Scope

- **Chad's mailbox:** `supachad@proton.me`. The `email-check-cron` wrapper polls this inbox via `proton-tool`. Any auto-reply Chad sends has `From: supachad@proton.me`.
- **Admin senders (auto-reply allowlist):** `tantodefi@proton.me`, `tjcooke@protonmail.com` / `tjcooke@pm.me`, plus `supachad@proton.me` itself. See `auto-actions.json` `email_reply` block.
- **Inbound trigger:** every scenario in this doc starts as a Proton email landing in `supachad@proton.me`'s inbox. Future channels (GitHub mentions, Discord, dashboard `/premium`) plug into the same `chad-intake` contract.
- **Out of scope here:** outbound-initiated work (cron-driven backups, gbrain dream, self-improve). Those are documented in [chad-devflow.md](chad-devflow.md) §Cron pipeline.

## Workflow catalog

### tantodefi (engineer / operator)

| # | Sender intent | Inbound shape | Path through the pipeline | Expected outcome |
|---|---|---|---|---|
| T1 | **Daily status check** | tantodefi → supachad: "What did you do today?" | `email-check-cron` polls `supachad@proton.me` → `chad-drafter` (single-turn, no tools) reads `memory/<today>.md` → action-gate `email_reply: auto` for tantodefi → `chad-autosend-replies` → reply sent from supachad back to tantodefi | Reply summarizes today's memory bullets; counter `email_reply` increments by 1 |
| T2 | **GBrain question** | tantodefi → supachad: "What does the brain say about chad-shim?" | drafter routes via `mcp_gbrain_search` (chad agent has the MCP tool registered) | Reply quotes one or two brain pages with chunk titles; falls back to "no relevant page" if empty |
| T3 | **Cron status** | tantodefi → supachad: "Are crons running?" / "How many crons fired today?" | drafter shells `openclaw cron list --json` → counts | Reply lists job names + last-run state; flags any `lastRunStatus=error` |
| T4 | **Action request (in-policy)** | tantodefi → supachad: "Archive everything from `noreply@github.com`" | drafter classifies as `email_archive` → action-gate `_default: auto` → `proton-tool trash-mail` (or batch mark-read) | Reply confirms count archived; counter `email_archive` increments |
| T5 | **Action request (out-of-policy)** | tantodefi → supachad: "Send a tweet for me" / "Open PR #X in NemoClaw" | drafter classifies action → action-gate `web_post_twitter: 0` budget / `github_pr_open: 1` budget → returns `block` or `draft` | Reply explains why it can't act; if `draft`, the proposal is parked under `### Drafts pending review` in today's memory |
| T6 | **Bug report against Chad** | tantodefi → supachad: "Chad didn't reply to TJ's last email" | drafter parks under `### Bug reports` → no auto-reply (default block for bug acknowledgements; opens loop for human triage) | Memory file gets a `### Bug report` block with sender, subject, body, timestamp; no outbound reply |

### tjcooke (fitness coach client)

| # | Sender intent | Inbound shape | Path through the pipeline | Expected outcome |
|---|---|---|---|---|
| C1 | **Quick fitness question** | tjcooke → supachad: "What's the right depth for a back squat?" | EMAIL-POLICY routes "Quick question" → drafter → `mcp_gbrain_search "squat depth Rippetoe"` returns chunks → drafter cites them inline | Reply quotes 1–2 chunks from *Starting Strength* with chunk titles; counter `email_reply` increments |
| C2 | **Client coaching question** | tjcooke → supachad: "Client has knee pain on squats, what to do?" | EMAIL-POLICY routes "client check-in / programming question" → spawns `fitness` sub-agent (kind: fitness, brain-first, no general training knowledge fallback) | Reply built only from gbrain chunks; emits `NOT_FOUND` sentinel if Rippetoe + Starrett don't cover it; auto-sends per `email_reply: auto` |
| C3 | **Article topic request** | tjcooke → supachad: "Write me 3 blog posts on hip mobility" | EMAIL-POLICY routes "Article / post topics" → `chad-intake --from proton --message-id MSGID` → spawns `researcher` first, then one `writer` per article | Three drafts land under `### Article drafts` in today's memory; **no auto-send** (drafts review-only); short ack reply auto-sends confirming the work is queued |
| C4 | **Content schedule** | tjcooke → supachad: "Plan next week's posts on shoulder mobility" | Same as C3 but the researcher's job is calendar-shaped (one topic per day) | One memory block listing 5 topic outlines + draft titles; ack reply auto-sends |
| C5 | **Logistics / scheduling** | tjcooke → supachad: "Move my Thursday 2pm to Friday 10am" | drafter classifies as `calendar_update` → action-gate `_default: block` → returns draft | Memory has a draft action proposal; reply explains TJ should confirm with tantodefi who will execute |

## Verification matrix

For each row above, the **memory** + **action-log** + **counters** should agree:

```text
/sandbox/.openclaw/workspace/memory/<today>.md   # human-readable thread
/sandbox/.openclaw-data/state/auto-action-log.jsonl  # structured event log
/sandbox/.openclaw-data/state/auto-action-counters.json  # daily quota state
```

A scenario "passes" when:

1. The memory file has a section matching the expected block (e.g. `## Email-check (cron wrapper)` → `### Pending replies` → matched scenario).
2. The action-log has one or more JSONL entries with the expected `decision` (`auto` / `draft` / `block`) and `target`.
3. The counters reflect the budget consumed (one per `auto` action; `draft` and `block` do not increment).
4. For `auto` paths, `proton-tool sent --days=1` shows the outbound message.

## Test mechanism

This is split into two tiers with different cadences and different goals:

### Tier 1 — Hook smoke test (manual, live, rare)

One real email confirms the production path is wired end-to-end:
`proton-tool fetch → email-check-cron → chad-drafter → action-gate → chad-autosend-replies → proton-tool reply`. tantodefi sends scenario T1 (or any cheap admin-allowed scenario) from `tantodefi@proton.me` → `supachad@proton.me`, waits for the next cron tick, and confirms a reply lands in his inbox. Done once after any change to the cron pipeline; not part of the batch.

### Tier 2 — Batch regression (frequent, model-driven, captured)

All 11 scenarios run as **direct model invocations**, not real emails. Each scenario is a reproducible fixture; the runner pipes it into the same code path the cron uses (`chad-drafter` for single-turn replies, `chad-spawn --kind fitness` for C1/C2, `chad-intake` for the multi-spawn flows in C3/C4) but with the inbound message synthesised from the fixture instead of fetched from Proton. Outputs are captured as structured JSON so successive runs can be diffed and scored.

This is the loop the user actually cares about: **measure prompt quality over time**. Replaying the same fixtures against new prompts (or new models) produces an output diff that tells us whether a change helped. The opposite strategy — "ship a prompt change and hope replies look better in the wild" — has no signal.

#### Fixture format

One file per scenario at `scripts/chad-workflows/fixtures/<scenario>.yaml`:

```yaml
id: T1
name: daily-status-check
sender: tantodefi@proton.me
subject: "What did you do today?"
body: |
  hey — quick check, what did you actually get done today?
expected:
  path: drafter
  decision: auto
  rubric:
    - reply references at least one bullet from today's memory
    - reply does not invent work that isn't in memory
    - reply length under 250 words
```

The rubric is fed to a separate scoring model pass (Tier 2.5 below).

#### Runner contract

`scripts/chad-cron-wrappers/chad-workflow-batch` (new wrapper, in-sandbox):

- Iterates fixtures, invokes the right code path per `expected.path`.
- Writes each output to `/sandbox/.openclaw/workspace/regressions/<UTC-ts>/<scenario>.json`:
  ```json
  { "id": "T1", "model": "kimi-k2.5", "prompt_version": "abc1234",
    "output": "...", "decision": "auto", "tokens_in": …, "tokens_out": …,
    "duration_ms": …, "ts": "2026-04-29T18:30:00Z" }
  ```
- Idempotent — re-running with the same prompts and inputs produces the same output (modulo model nondeterminism, which we accept and average over).
- Exits 0 always; failures are recorded in the JSON, not raised.

#### Scoring (Tier 2.5)

A second pass — `chad-workflow-score` — runs the rubric for each scenario through a single-turn LLM call (no tools, no MCP) and emits a pass/fail/score per rubric line. Rolled up into `regressions/<run-ts>/summary.md` with per-scenario results and a delta-from-last-run table. This is what the user actually reads.

### Improvement loop

The existing `chad-self-improve` weekly cron (`0 3 * * 0`) gains a step that reads the last 7 days of `regressions/*/summary.md`, identifies any scenario whose score regressed week-over-week, and proposes targeted prompt/policy edits. Proposals land under `## Self-improvement` in today's memory for human review — never auto-applied. Over weeks, the diff log shows what changed, when, and what the regression score did in response.

## Next steps

In rough dependency order — keep each step small and committable:

- [ ] **Smoke test (Tier 1).** tantodefi sends T1 live from `tantodefi@proton.me` → `supachad@proton.me`. Confirm the reply arrives, the action-log gets one `email_reply: auto` entry, and the counter increments. One-time check after any cron pipeline change.
- [ ] **Fixtures.** Write 11 YAML fixtures under `scripts/chad-workflows/fixtures/` (one per scenario T1–T6, C1–C5) using the format above. Source-controlled so prompt + expected behavior versions track in git.
- [ ] **Runner.** Add `scripts/chad-cron-wrappers/chad-workflow-batch` — iterates fixtures, invokes drafter / spawn / intake per `expected.path`, writes structured JSON to `workspace/regressions/<UTC-ts>/`. `install_to_usrlocal` it via chad-setup.sh.
- [ ] **Scorer.** Add `chad-workflow-score` — single-turn rubric scoring → `summary.md`. Same install path.
- [ ] **First baseline run.** Invoke the runner+scorer manually; commit the summary to chad-state. This is the "before" snapshot every later run diffs against.
- [ ] **Wire into self-improve.** Extend `chad-self-improve`'s weekly Sunday prompt to read `regressions/*/summary.md` and propose targeted prompt edits when a scenario regresses. Drafts only — never auto-apply.
- [ ] **Weekly batch cron.** New `chad-workflow-batch-cron` wrapper, schedule `0 2 * * 0` (Sunday 2am, just before self-improve). Runs the full suite, lets self-improve consume the freshest run.

## Cross-reference

- [EMAIL-POLICY.md](https://github.com/tantodefi/chad-state/blob/main/workspace/EMAIL-POLICY.md) — the in-sandbox routing rules each scenario depends on (lives in chad-state).
- [chad-devflow.md](chad-devflow.md) — wrapper catalog.
- [auto-actions.json](https://github.com/NVIDIA/NemoClaw/blob/main/scripts/chad-cron-wrappers/auto-actions.template.json) — action-gate budgets and per-target overrides.
- The `fitness` kind manifest at `.github/skills/chad-orchestrator/kinds/fitness.yaml` and `subagent-researcher` policy preset for the brain-first contract used by C1/C2.
