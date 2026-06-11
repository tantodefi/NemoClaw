---
name: "nemoclaw-spawn-as-github-run"
description: "Documentation-derived skill for nemoclaw spawn as github run."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Spawn As Github Run

**Status:** Implemented (Phase C, 2026-06) as `chad-spawn --substrate gha
--async`; reconciliation via `chad-spawn-poll` (host launchd) and the
weekly `spawn-gc` cron. This page is the original design. Inspired by
`stephengpope/thepopebot`'s agent-job pattern (branch-as-job-record +
GitHub Actions runner + auto-merge as policy gate).

**Author / reviewer:** Chad operator team.

## Step 1: Why

Today (per `chad-readme.md` §4), `chad-spawn` runs sub-agents
**in-container** under the parent Chad's process tree. Three
constraints follow:

1. **No isolation between sub-agents** — a compromised `writer` can read
   the `reviewer`'s draft because they share a filesystem and process
   namespace. `chad-readme.md` §10 calls this out as a phase-2 item
   ("Phase-2 will spawn each sub-agent into its *own* pod").
2. **Synchronous and serial** — `chad-spawn` blocks; long-running
   sub-agents pin Chad's main process and block cron ticks behind them.
3. **Single substrate** — every sub-agent runs on Chad's host. A
   `coder` that wants 8 vCPUs for `npm test` competes with the embedded
   Nemotron for the same Mac M4 Pro.

Phase-2 in the readme proposes "spawn into its own k3s pod." That's one
valid answer. **This design proposes an alternative: spawn into a
GitHub Actions workflow run.** Same isolation goal, different substrate.

## Step 2: Pattern (lifted from popebot)

A spawn becomes a **branch in `tantodefi/chad-state`** plus a workflow
trigger:

```
chad-spawn --kind <K> --task-file <T>
  ↓
1. mint task_id (uuid)
2. push branch chad-spawn/<task_id> with:
     spawns/<task_id>/task.json     # input
     spawns/<task_id>/kind.yaml     # snapshot of the kind manifest
     spawns/<task_id>/budget.json   # token budget snapshot
3. workflow_dispatch trigger fires .github/workflows/agent-job.yml
4. workflow:
     a. checkout the spawn branch
     b. install the kind's binary (pi/claude/codex/opencode)
     c. render prompt from kind manifest + task.json
     d. invoke the binary with budget cap
     e. capture stdout/stderr → spawns/<task_id>/{stdout,stderr,result}.json
     f. commit + push back to the spawn branch
5. notify-pr-complete.yml posts to Chad's gateway webhook with task_id + status
6. Chad's webhook handler runs chad-collect to merge result into today's memory
```

The branch IS the job record. `git log chad-spawn/<task_id>` is the
audit trail. No new database, no jobs table.

## Step 3: How this maps to existing chad-orchestrator

`chad-spawn` already has the right shape: takes `--kind`, `--task-file`,
returns `task_id`, writes to `subagents/<task_id>/result.json`, appends
to `queue/tasks.jsonl`. The migration is a flag:

- `chad-spawn --kind X --task-file Y` (current) → in-container, blocking
- `chad-spawn --kind X --task-file Y --substrate gha` → GitHub Actions

Or per-kind default in the manifest:

```yaml
kind: codex
binary: /usr/local/bin/codex   # used by in-container substrate
substrate: gha                  # default substrate for this kind
gha:
  workflow: codex-job.yml
  runner: ubuntu-latest
```

## Step 4: Multi-provider swap

The kinds dir today has 6 entries (`brain`, `coder`, `fitness`,
`researcher`, `reviewer`, `writer`). The `binary` field already
abstracts provider — `coder` uses `pi`, others use `claude`. Adding new
providers is mostly:

| Provider | Stub status | Where it goes |
|---|---|---|
| `pi`     | shipped (chad-readme.md §4.2 lists it) | `kinds/coder.yaml` already wired |
| `claude` | shipped | several kinds use it |
| `codex`  | stub added 2026-05-06 (this branch) | `kinds/codex.yaml` |
| `opencode` | not yet | future `kinds/opencode.yaml` + `presets/subagent-opencode.yaml` |

Provider swap *within a kind* (e.g., "use codex for the writer instead
of claude") needs a different mechanism than adding a new kind. Options:

1. **`--binary-override` flag on chad-spawn** — explicit per-spawn
   override. Cleanest. Doesn't proliferate kinds.
2. **Per-kind backend list** — kind manifest lists fallback binaries:
   `binaries: [/usr/local/bin/claude, /usr/local/bin/codex]` and
   chad-spawn picks based on availability + cost + load. More machinery.
3. **Aliased kinds** — `writer-claude.yaml`, `writer-codex.yaml`. Worst
   for maintenance.

Recommend (1) for v1, (2) only if there's actual demand for automatic
fallback.

## Step 5: Trade-offs vs in-sandbox phase-2 pods

| Dimension | k3s pods (current phase-2 plan) | GitHub Actions (this design) |
|---|---|---|
| Isolation per spawn | True kernel isolation, separate netns | True VM isolation, fresh runner |
| Network policy | L7 policy preset enforced | **Lost** — Actions runners get full egress |
| Cost | Fixed (Mac M4 Pro / k3s nodes) | Free for public repos, $0.008/min for private |
| Setup complexity | Heavy (nested k3s, PVCs, RBAC) | Light (one workflow YAML) |
| Async by default | Requires queue + watcher | Native (workflow_dispatch is async) |
| Inference reach | Local Nemotron + NVIDIA via gateway | Public APIs only (no Nemotron, no gateway) |
| GBrain access | Local PGLite | Would need export/sync — not great |
| Secret management | OpenShell creds | GitHub Actions secrets |
| Debugging | `kubectl logs` | `gh run view` |
| Audit trail | tasks.jsonl in PVC | Branch + PR history |

**Verdict:** GitHub Actions is the right substrate for **public-API,
self-contained, network-permissive** sub-agents (codex calling OpenAI to
write a markdown report). It's the wrong substrate for **gbrain-bound,
NVIDIA-bound, or L7-policy-bound** sub-agents (researcher needing
gateway-routed Nemotron + local brain).

## Step 6: Hybrid recommendation

Keep both substrates. Per-kind default, per-spawn override:

| Kind | Default substrate | Why |
|---|---|---|
| `coder` (pi) | in-container | Uses local source clone + L7 pinning |
| `researcher` | in-container | Brain-first; needs local gbrain |
| `fitness` | in-container | Brain-first; gbrain pages are the answer |
| `writer` | in-container | Often needs internal context |
| `reviewer` | in-container | Reads in-progress diffs |
| `brain` | in-container | Direct gbrain CLI |
| `codex` | gha | Self-contained, OpenAI-bound, no gbrain dependency by contract |
| `opencode` | gha | Same as codex |

## Step 7: Migration path

**Phase A** (shipped 2026-05-06): kinds + presets, all in-container.
Codex stub kind manifest landed.

**Phase B** (shipped 2026-05-06): `--substrate <local|gha>` flag on
chad-spawn; `chad-spawn-gha.sh` helper does push + dispatch + sync
poll; `agent-job.yml` workflow lives in
`scripts/chad-state-templates/.github/workflows/`; `chad-state-bootstrap`
installs it into chad-state. Codex kind defaults to `gha`. Provider
routing in the runner: NVIDIA fallback for codex/opencode when
`OPENAI_API_KEY` not set; claude requires `ANTHROPIC_API_KEY`
(no fallback).

**Phase C** (shipped 2026-05-06):

- `chad-spawn --async` flag: dispatches workflow + writes "running"
  ledger entry, returns task_id immediately. Ledger now carries
  `substrate` and `async` fields so reconcilers can find work.
- `chad-spawn-gha.sh` honors `CHAD_GHA_NO_POLL=1` to skip the
  polling phase.
- `chad-spawn-poll` cron (every 5min): scans ledger for running gha
  entries, fetches result.json from chad-state, copies back to local
  workdir, transitions ledger to done|failed (or timeout if
  workflow exceeded budget), runs `chad-collect` on success. Single
  shared chad-state checkout per run keeps wall time small.
- `chad-spawn-gc` cron (weekly Mon 02:30 UTC): retention pruning of
  `chad-spawn/*` branches in chad-state. Default: done=7d, failed=30d,
  in-flight always kept. Branches with no matching ledger entry are
  flagged but kept for operator review.
- `chad-spawn --binary-override <path>`: per-spawn binary swap (use
  codex on a writer kind once without touching the manifest). The L7
  policy preset is still the kind's, so the override binary must be in
  that preset's allowlist.
- `opencode` kind + `subagent-opencode` preset: parallel to codex,
  multi-provider (OpenAI/Anthropic/OpenRouter/NVIDIA). Defaults to
  gha substrate.

**Phase D** (eventual): k3s pod substrate added as third option for
sub-agents that want both L7 policy enforcement AND isolation. The
hybrid table above gets a third column. Webhook-based completion
(replacing the polling cron) and an `auto-merge.yml` policy gate so
spawn results into `spawns/<id>/` paths can land into main, but
anything outside that path requires human review (popebot pattern).

## Step 8: Memory curator alignment

The `chad-memory-curator` cron (wave 2 Hermes pattern, shipped this
branch) is a candidate for Phase B migration: the curator's prompt
doesn't need gbrain, doesn't need Nemotron, doesn't write to local
state. Running it on a GitHub Actions runner with the premium model
would free Chad's local cycles AND give the curator more reasoning
depth than embedded Nemotron offers. Keep this in mind when Phase B
lands — the curator could be the first non-stub gha-substrate consumer.

## Step 9: Provider routing in the gha runner

Chad's primary inference is NVIDIA Nemotron via
`integrate.api.nvidia.com/v1` (OpenAI-compatible endpoint). The
agent-job runner uses that as a fallback so the substrate works even
without OpenAI / Anthropic keys configured:

| Binary | Primary | Fallback | Notes |
|---|---|---|---|
| `codex` | `OPENAI_API_KEY` | `NVIDIA_API_KEY` via OpenAI-compat | Sets `OPENAI_BASE_URL` + `OPENAI_DEFAULT_MODEL` (Nemotron) |
| `opencode` | `OPENAI_API_KEY` | `NVIDIA_API_KEY` via OpenAI-compat | Same env override pattern |
| `claude` | `ANTHROPIC_API_KEY` | **none** | Anthropic-only; fails fast if missing |
| (unknown) | best-effort | `NVIDIA_API_KEY` first | Generic OpenAI-compat path tried |

The "Resolve provider + endpoint" step in `agent-job.yml` picks at run
time: if `OPENAI_API_KEY` is set use it, else fall back to
`NVIDIA_API_KEY` with `OPENAI_BASE_URL` pointing at
`integrate.api.nvidia.com/v1` and `OPENAI_DEFAULT_MODEL` set to the
configured Nemotron model. Result.json carries the resolved provider
back to Chad so chad-collect knows which model produced the output.

This matches Chad's host-side inference posture: the same
`NVIDIA_API_KEY` Chad already has in `/sandbox/.nemoclaw/credentials.json`
can be re-used as a chad-state GHA secret with no additional account
setup. For coding work specifically: codex's responses API may not be
fully supported by NVIDIA's OpenAI-compat endpoint — the operator will
get a clear error from the binary if so, at which point setting
`OPENAI_API_KEY` upgrades the path to real OpenAI without changing
anything else.

## Step 10: Open questions

1. **Secret management.** Anthropic / OpenAI keys in GitHub Actions
   secrets is the obvious path, but key rotation and per-spawn auth
   context needs a story. Popebot does per-container short-lived tokens
   minted via callback — would need an equivalent.
2. **Egress trust.** A sub-agent with full GitHub Actions network
   access can call any public API. Is the operator OK with that for
   `codex`-grade work? If not, the gha substrate may need its own
   egress gate (e.g., a sidecar proxy in the runner that mirrors the
   L7 policy).
3. **Branch hygiene.** With 24 spawns/day budget, that's ~700
   `chad-spawn/<id>` branches/month. Need a retention policy (popebot
   relies on auto-delete after merge, but failed-no-merge branches
   accumulate). `chad-state` GC cron.
4. **Cost ceiling.** GitHub Actions free tier is 2000 min/month for
   private repos. A sub-agent that runs 10 minutes × 24 spawns/day
   exhausts that in ~9 days. Either move `chad-state` public (with
   secrets in env), pay for minutes, or move to self-hosted runner.
