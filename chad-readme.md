<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad — The Orchestrator-Agent Development Stack

`chad-dev` branch of NemoClaw. This document is the single source of truth
for how Chad is developed, how he is deployed, and how he spawns sub-agents
from inside the sandbox. Read it before you edit anything under
`.github/skills/chad-*`, `scripts/chad-*`, or the `subagent-*` policy
presets.

> Chad is an always-on OpenClaw agent running inside a NemoClaw sandbox.
> He reads mail, tracks memory, grooms his own state, and — as of this
> branch — can delegate structured sub-tasks to typed sub-agents running
> under their own L7 network policies.

---

## 1. Why a Docker cluster at all

A naked CLI agent has no blast radius story. An interactive shell is fine
for testing, but the moment you let an agent run unattended (cron, email,
Slack, Discord) you need an answer to three questions:

| Question | Answer |
|---|---|
| What happens if the agent runs `rm -rf $HOME`? | It runs inside a container that only mounts `/sandbox`. |
| What happens if the agent exfiltrates `~/.ssh/id_rsa`? | The container has no host filesystem access. |
| What happens if a prompt-injection rewrites his egress policy? | The policy is enforced by an L7 gateway in a *separate* user, and the config is hash-verified at entrypoint. |

NemoClaw wraps OpenClaw in a sandbox with three concentric rings:

```text
┌─ Host (macOS / Linux) ────────────────────────────────────┐
│  nemoclaw CLI, credentials, launcher                      │
│  ┌─ Container runtime (docker / k3s on k8s) ──────────┐   │
│  │  OpenShell sandbox, gateway user, capsh drops      │   │
│  │  ┌─ Sandbox user ────────────────────────────┐     │   │
│  │  │  Chad, pi, claude, gh, curl, chromium     │     │   │
│  │  │  L7 policies: per-binary egress rules     │     │   │
│  │  └───────────────────────────────────────────┘     │   │
│  └────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

The middle ring is where the cluster story matters. We ship two deployment
flavors:

- **Single-host Docker** (`nemoclaw sandbox create`) — one container,
  bind-mounted PVC, fastest iteration loop.
- **k8s + nested k3s** (`k8s/nemoclaw-k8s.yaml`) — a `docker-in-docker`
  pod running a nested k3s node, which in turn runs the OpenShell sandbox.
  This is the deployment shape that scales to multiple Chads (one per
  user / per workspace / per model) without any of them seeing each other.

The cluster benefits we care about for Chad specifically:

1. **Per-Chad isolation.** Each sandbox is its own network namespace, its
   own filesystem, its own set of L7 policies. You can run a "coding
   Chad" on Nemotron and a "research Chad" on Claude in the same k3s
   cluster without sharing memory or credentials.
2. **Self-healing restarts.** Chad crashes? The Deployment controller
   brings him back with the same PVC. His `workspace/` survives because
   it lives on the PVC, not inside the image.
3. **Atomic image refresh.** A new Chad build is a new
   `ghcr.io/nvidia/nemoclaw/sandbox-base` layer plus a new per-build top
   layer. Rolling a new build is `kubectl rollout restart` — Chad comes
   back with new tools but same memory.
4. **Sub-agent fan-out.** Today sub-agents run *inside* the Chad
   container (budget-policed, but not isolated from each other). Phase-2
   will spawn each sub-agent into its *own* pod in the same k3s cluster
   so the reviewer cannot read the writer's draft unless the parent
   explicitly shuttles it.

---

## 2. The Dockerfile split (and why it matters for iteration speed)

The sandbox image is built in **two files on purpose**:

| File | Builds on | Contains | Rebuilt when |
|---|---|---|---|
| `Dockerfile.base` | `node:22-slim` | apt packages, gosu, openclaw CLI, users, `.openclaw` dir, gh, pyyaml, chromium | apt or openclaw version changes (rare) |
| `Dockerfile` | `${BASE_IMAGE}` | plugin, blueprint, chad helpers, sub-agent kinds, config | every PR (fast) |

The base image lives at `ghcr.io/nvidia/nemoclaw/sandbox-base:latest` and
is rebuilt on its own schedule. The thin top layer is what every
`nemoclaw sandbox create` or CI build touches, and it finishes in
seconds instead of minutes.

**Don't put anything in `Dockerfile.base` unless it changes less than
once a week.** Everything Chad-specific — skills, scripts, kind
manifests, orchestrator helpers — belongs in the top `Dockerfile`.

---

## 3. The development flow for Chad

### 3.1 One-command recovery (the happy path)

After a sandbox reset or a fresh deploy:

```bash
# Host side:
nemoclaw sandbox create --image ghcr.io/nvidia/nemoclaw/sandbox:latest
./scripts/chad-setup.sh <sandbox-name>
```

`chad-setup.sh` is idempotent and runs, in order:

1. **Restore** — pulls `workspace/` from `tantodefi/chad-state` via
   `chad-restore-from-github`. If there is no backup yet this is a no-op.
2. **Sync skills** — ships `proton-calendar`, `chad-bug-intake`, and
   **`chad-orchestrator`** from `.github/skills/` to
   `/sandbox/.openclaw-data/skills/` via a tar-over-ssh pipeline.
   This uses an atomic tempdir-then-mv swap (see §9) so partial tar
   failures don't corrupt a live skill.
3. **Deploy credentials** — filters the host credentials file and writes
   the runtime-safe subset to `/sandbox/.nemoclaw/credentials.json`.
4. **`gh auth`** — uses the deployed `GITHUB_TOKEN` to authenticate the
   bundled `gh` CLI.
5. **Clone source** — shallow-clones the fork into `/sandbox/source` so
   Chad can self-grep ("how did I implement this?") without egress.
6. **Register crons** — workspace-backup (6h), proton-inbox, memory-groom.

After this, Chad is "alive" — his memory, credentials, skills, and cron
jobs are all in place.

### 3.2 Inner dev loop: changing Chad

Most Chad changes happen in one of four places:

| What you want to change | Where | How to deploy |
|---|---|---|
| Chad's behavior / prompts / skill docs | `.github/skills/chad-*/SKILL.md` | `sync-skills-to-sandbox.sh` (no image rebuild) |
| A helper binary like `chad-spawn` | `.github/skills/chad-orchestrator/scripts/*.sh` | same — sync + `PATH` picks it up at `/sandbox/.openclaw-data/skills/chad-orchestrator/scripts/` |
| Network egress for a sub-agent kind | `nemoclaw-blueprint/policies/presets/subagent-*.yaml` | `nemoclaw policy apply` (reloads L7 gateway) |
| Anything in `bin/`, `nemoclaw/`, or `Dockerfile` | respective file | rebuild image → redeploy |

The skill sync path is the fast loop. You can iterate on Chad's prompts
and helper scripts without ever touching docker. `chad-spawn.sh`
deliberately resolves its orchestrator dir as:

```text
1. $CHAD_ORCH_DIR (tests)
2. /sandbox/.openclaw-data/skills/chad-orchestrator   (synced from host)
3. /opt/chad-orchestrator                             (baked into image)
```

Rule (2) means a freshly synced skill shadows the baked copy. Rule (3)
means a brand-new sandbox (pre-sync) still has working helpers. Never
delete the baked fallback — it's the safety net for emergency recovery.

### 3.3 Running Chad as a developer

```bash
# On the host
openshell ssh chad              # drops you into the sandbox as sandbox user
# Inside the sandbox
openclaw agent --agent main     # start Chad interactively
# or
chad-intake --from chat --task-file /tmp/task.md
```

The interactive path is where you prove a new skill works. The
`chad-intake` path is what cron calls — it's the same contract email,
Slack, or a GitHub issue would use.

---

## 4. The sub-agent contract

Chad's headline capability in this branch: he can delegate. Not in the
"fire a prompt" sense, but in the "spawn a typed process under a
separate L7 policy with a bounded budget and a structured return
value" sense. The contract lives in
[`.github/skills/chad-orchestrator/SKILL.md`](.github/skills/chad-orchestrator/SKILL.md)
and is implemented by six baked-in binaries.

### 4.1 The six helpers

| Binary | Purpose |
|---|---|
| `chad-route` | Classify a task into a kind (`coder`/`researcher`/`writer`/`reviewer`) deterministically. |
| `chad-budget` | Token budget bookkeeping with UTC day reset. `show` / `reserve` / `refund` / `reset`. |
| `chad-spawn` | Canonical spawner. Loads the kind manifest, checks budget, runs the sub-agent, writes `result.json`. |
| `chad-spawn-status` | Query the task ledger by id / state. |
| `chad-collect` | Merge recent `result.json` files into today's `memory/<YYYY-MM-DD>.md`. |
| `chad-intake` | Source-agnostic wrapper. `--from chat|proton|cron|issue`, does route→spawn→collect. |

All six are baked into `/usr/local/bin/` at image build time (see
`Dockerfile` lines ~115–133) **and** shipped from
`.github/skills/chad-orchestrator/scripts/` via `chad-setup.sh` so you
can iterate on them without a rebuild.

### 4.2 Kinds

A kind is a YAML manifest under
[`.github/skills/chad-orchestrator/kinds/`](.github/skills/chad-orchestrator/kinds/)
describing how to invoke a sub-agent. Today we ship five:

| Kind | Binary | Policy preset | Timeout / Budget | Use case |
|---|---|---|---|---|
| `coder` | `/usr/local/bin/pi` | `pi-agent` | 600s / 50000 tok | Write/refactor code, run build + tests |
| `researcher` | `/usr/local/bin/claude` | `subagent-researcher` | 300s / 20000 tok | gh search, web facts, report |
| `writer` | `/usr/local/bin/claude` | `subagent-writer` | 600s / 25000 tok | Draft mail, docs, articles (never publishes — one spawn per article) |
| `reviewer` | `/usr/local/bin/claude` | `subagent-reviewer` | 300s / 25000 tok | Audit PR diff, run checklist (read-only gh) |
| `fitness` | `/usr/local/bin/claude` | `subagent-researcher` | 300s / 15000 tok | Strength + mobility answers from gbrain-ingested books (Rippetoe, Starrett) — brain-first, falls back to archive.org |

The manifest shape:

```yaml
kind: coder
binary: /usr/local/bin/pi
invocation: prompt-stdin            # prompt-stdin | prompt-arg | openclaw-agent
network_policy_preset: pi-agent
default_timeout: 600
default_budget_tokens: 50000
prompt_template: |
  You are a coding sub-agent spawned by Chad...
  Task id: {{task_id}}
  Task:
  {{task}}
```

Adding a new kind is:

1. Drop a `kinds/<name>.yaml` file.
2. Drop a matching preset under `nemoclaw-blueprint/policies/presets/subagent-<name>.yaml` if the existing presets don't cover it.
3. Sync skills + apply policy.
4. Run `chad-spawn --kind <name> --task-file /tmp/t.md --dry-run` to validate.

No recompile, no image rebuild.

### 4.3 The canonical flow

```bash
# 1. Classify (or skip and pick the kind manually)
kind="$(chad-route --task-file /tmp/task.md)"     # echoes one of the five kinds

# 2. Spawn. Returns the task id on stdout.
task_id="$(chad-spawn --kind "$kind" --task-file /tmp/task.md)"

# 3. Poll (or block — chad-spawn is synchronous today; phase-2 goes async).
chad-spawn-status --id "$task_id"

# 4. Merge the result into today's memory.
chad-collect --today
```

Or, the source-agnostic shortcut:

```bash
chad-intake --from chat   --task-file /tmp/task.md
chad-intake --from proton --message-id <id>
chad-intake --from issue  --repo tantodefi/NemoClaw --issue 42
chad-intake --from cron   --task-file /sandbox/.openclaw-data/queue/cron-task.md
```

### 4.4 What each spawn writes to disk

```text
/sandbox/.openclaw-data/
├── subagents/
│   └── <task-id>/
│       ├── task.json / task.txt     # input (copied from --task-file)
│       ├── prompt.txt               # rendered prompt (template + task body)
│       ├── stdout.log               # sub-agent stdout
│       ├── stderr.log               # sub-agent stderr
│       └── result.json              # structured result (status, exit_code, summary, …)
├── queue/
│   └── tasks.jsonl                  # append-only ledger: queued → running → done|failed
└── budget.json                      # daily token budget with UTC day reset
```

All three paths are included in the `chad-backup-to-github` set so the
ledger and budget survive sandbox resets alongside `workspace/memory`.

### 4.5 Structured results

Sub-agents are expected to emit a JSON summary on the **last non-empty
line** of stdout. If they don't, `chad-spawn` synthesizes one:

```json
{
  "status": "done",
  "task_id": "3e4f…",
  "kind": "coder",
  "exit_code": 0,
  "dry_run": false,
  "summary": "refactored runner.ts, tests pass",
  "files_touched": ["nemoclaw/src/blueprint/runner.ts"],
  "follow_ups": ["add an integration test for the snapshot path"]
}
```

`chad-collect` reads `result.json` files modified in the last hour (or
any window passed via `--since`) and appends a markdown table under
`## Dispatched Tasks (<timestamp>)` in `memory/<today>.md`. Dedupe is
based on a header signature in the tail of the file so it's safe to run
repeatedly — at the end of every spawn batch, from cron, or by hand.

---

### 4.6 Brain & workflow stack (gbrain + gstack)

Two auxiliary systems live alongside the orchestrator: gbrain provides
shared persistent memory, gstack provides role-based reasoning frameworks.

#### gbrain

Hybrid vector + graph knowledge brain running as a local PGLite store at
`/sandbox/.gbrain/brain.pglite`. Wired into the sandbox in four places:

1. **Image build** — installed from the `tantodefi/gbrain` fork into
   `/usr/local/lib/gbrain/` with a shim at `/usr/local/bin/gbrain`. The
   bun-based install path is pinned so the binary resolves on Linux arm64.
2. **Per-sandbox init** — `chad-setup.sh` runs `gbrain init` and registers
   it as a persistent MCP server in `/sandbox/.openclaw/openclaw.json` via
   `openclaw mcp set gbrain '{"command":"/usr/local/bin/gbrain","args":["serve"]}'`.
   Every `openclaw agent` session thereafter has the brain MCP tools
   (`mcp_gbrain_search`, `mcp_gbrain_put_page`, …) available with no
   spawn-time flags required.
3. **Kind prompts** — `researcher`, `coder`, `reviewer`, and `fitness`
   sub-agents are instructed to `mcp_gbrain_search` before any external
   API call, and to write findings back with `mcp_gbrain_put_page` so the
   next spawn doesn't pay the same research cost twice.
4. **Backup/restore** — `chad-backup-to-github.sh` exports all pages as
   per-page `.md` files (sha-diff-checked). Restore: `gbrain import brain/
   --no-embed` — embeddings rebuild lazily on the first query.

> **Known gotcha — PGLite root-ownership.** Any `gbrain import` or
> `gbrain export` run that executes as root (e.g. during a chad-setup.sh
> restore step run via `kubectl exec`) writes WAL segments and lock files
> as `root:root`. On the next session startup `gbrain serve` cannot acquire
> the lock and aborts with `Timed out waiting for PGLite lock` or
> `PGlite failed to initialize properly`. The `chad-setup.sh` gbrain-init
> step now runs `chown -R sandbox:sandbox` and removes stale
> `postmaster.pid` / `.gbrain-lock` via `kubectl exec` before `gbrain init`.

#### gstack

gstack ships two distinct tiers; only the first works inside Chad's
sandbox.

**Tier 1 — openclaw reasoning skills (sandbox-safe, synced by chad-setup.sh)**

Four pure-text SKILL.md files from `garrytan/gstack`'s `openclaw/skills/`
directory. No browser daemon, no Bun binary, no Chromium. Just structured
reasoning frameworks the agent can invoke in-session:

| Skill | When to use |
|---|---|
| `gstack-openclaw-ceo-review` | Challenge a plan, expand or reduce scope, find landmines |
| `gstack-openclaw-investigate` | Root-cause debugging — no fix before diagnosis |
| `gstack-openclaw-office-hours` | Evaluate an idea before writing any code |
| `gstack-openclaw-retro` | Weekly engineering retrospective from commit history |

`chad-setup.sh` syncs these from `~/.claude/skills/gstack/openclaw/skills/`
on the host into `/sandbox/.openclaw-data/skills/` in the sandbox. If
gstack is not installed on the host the step warns and skips — it is not
a hard dependency.

Install gstack on the host once:
```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git \
  ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup
```

**Tier 2 — full gstack with browse daemon (host-only, not in sandbox)**

Skills like `/review`, `/qa`, `/ship`, `/browse`, `/gstack-ceo` rely on a
persistent headless Chromium daemon (`bun build --compile`). This tier
runs on the developer's host machine (tantodefi's Mac), driven by Claude
Code, and does not belong inside the Chad sandbox — the sandbox has no
Bun, no Chromium, and the L7 policy does not allow arbitrary browser
egress.

The two tiers combine cleanly: when tantodefi asks Chad to review code,
Chad spawns a `reviewer` sub-agent (tier 1, in-sandbox); when tantodefi
runs `/review` himself in Claude Code on the host, that's tier 2 with full
diff analysis and browser-based verification.

### 4.7 Fitness RAG kind

The `fitness` kind is the first application-specific sub-agent and the
worked example of the brain-first pattern:

- Two books ingested once into gbrain by
  [`chad-ingest-fitness-books.sh`](.github/skills/chad-orchestrator/scripts/chad-ingest-fitness-books.sh):
  **Starting Strength** (Rippetoe, 3rd ed., 313 chunks) and
  **Supple Leopard** (Starrett, 677 chunks). The ingest script pulls
  the OCR text from archive.org, chunks on paragraph boundaries with
  a 1-paragraph overlap, and calls `gbrain put` per chunk.
- The kind manifest
  [`kinds/fitness.yaml`](.github/skills/chad-orchestrator/kinds/fitness.yaml)
  instructs the sub-agent to run two `mcp_gbrain_search` calls, build
  the answer *only* from retrieved chunks, cite chunk titles, and emit
  a `NOT_FOUND` sentinel if the books don't cover the topic — no
  fallback to general training knowledge, no web search.
- Network egress is `subagent-researcher` plus the archive.org rules in
  the preset (see §5) — enough to re-fetch a book if the brain gets
  wiped, nothing more.

After a one-time ingest, answers are essentially free: keyword search
against PGLite, no inference unless the agent needs to synthesize across
chunks.

## 5. Network policy presets per kind

Each sub-agent kind runs under a dedicated set of L7 policies pinned to
specific binary paths. This is the single most important piece of the
contract — a rogue `writer` cannot call GitHub at all, a rogue
`reviewer` cannot `POST` to GitHub, a rogue `researcher` cannot push to
a git remote.

| Preset file | Binds | Egress scope |
|---|---|---|
| `presets/pi-agent.yaml` | `/usr/local/bin/pi` | NVIDIA inference only |
| `presets/subagent-researcher.yaml` | `claude`, `openclaw`, `node`, `gh`, `curl`, `python3` | NVIDIA inference + full `github.com` read + **GET-only `archive.org` / `*.archive.org`** for book/paper ingest |
| `presets/subagent-writer.yaml` | `claude`, `openclaw`, `node` | NVIDIA inference only — no github, no messaging |
| `presets/subagent-reviewer.yaml` | `claude`, `openclaw`, `node`, `gh`, `curl` | NVIDIA inference + `GET`-only `api.github.com` / `github.com` / `raw.githubusercontent.com` |
| `presets/gbrain.yaml` | `/usr/local/bin/gbrain`, `bun` | loopback (host MCP) + NVIDIA inference for embeddings |

The base `openclaw-sandbox` policy also adds an `internet_archive` rule
(GET-only) pinned to `python3` + `curl` so the top-level
`chad-ingest-fitness-books.sh` can run from the sandbox without
inheriting researcher privileges.

The reviewer's GET-only rule is the key asymmetry: it can fetch PR
diffs but it cannot post a review or a comment. Writing verdicts back
to GitHub is always the parent agent's job.

The contract we follow when adding a kind: **sub-agents draft, parents
publish**. If the sub-agent needs to change external state, the design
is wrong — have it write a `proposed_actions` array into `result.json`
and let Chad execute them.

---

## 6. Budget protection

Budget is the single safety net that makes delegation sane. Without it,
a Chad loop that spawns a sub-agent that spawns a sub-agent will drain
your NVIDIA key in minutes.

State lives at `/sandbox/.openclaw-data/budget.json`:

```json
{
  "date_utc": "2026-04-08",
  "daily_limit": 500000,
  "remaining_tokens": 450000,
  "spent_by_kind": { "coder": 30000, "researcher": 20000 }
}
```

Rules:

- First spawn of any UTC day rewrites the file with
  `remaining_tokens = daily_limit`.
- `chad-spawn` calls `chad-budget reserve $N $kind` before running the
  sub-agent. On insufficient budget the spawn exits 77.
- `--dry-run` skips the budget check entirely — use this freely.
- Override the limit with `CHAD_DAILY_TOKEN_LIMIT` at container start,
  or by editing the JSON by hand for one-off tests.
- Manual reset: `chad-budget reset` (typically only needed to recover
  from a botched manual edit).

Budget is **honor-based inside the sandbox**. It is not enforced by the
kernel or by the L7 gateway — a sub-agent that lies about its token
count will get away with it. The real kill-switch is the NVIDIA API
key itself and the OpenShell inference rate limiter. Budget is there to
catch honest bugs, not attackers.

---

## 7. Cron integration (token-optimized)

Chad runs **six** standing cron jobs, all registered by `chad-setup.sh`.
The schedules are **deliberately conservative** — every cron fire
tokenizes instructions and spawns a model call, so the rule is:
fewer, cheaper runs + a budget guard at the top of each one.

| Job | Cadence | Budget guard | What it does |
|---|---|---|---|
| `email-check` | `0 2,6-23 * * *` (19×/day) | skip if `remaining_tokens < 30000` | Reads mail via `proton-tool`, follows `EMAIL-POLICY.md` rules in the workspace, logs to `memory/<today>.md` |
| `workspace-backup` | every 6h | n/a (no model call) | `chad-backup-to-github` with the §12 diff-check |
| `issue-triage` | daily 10:00 UTC | skip if `remaining_tokens < 3×N×70k` | `chad-issue-triage` — scores open issues, routes top 2 through a researcher (see §12) |
| `gbrain-dream` | nightly 03:00 UTC | skip if `remaining_tokens < 50k` | `chad-gbrain-dream` — runs `gbrain dream` to consolidate links and surface orphans |
| `self-improve` | weekly Sun 03:00 UTC | skip if `remaining_tokens < 2×budget` | `chad-self-improve` — proposes 1–3 durable improvements based on last week's signal (see §13) |
| `chad-budget-audit` | weekly Mon 04:00 UTC | n/a (audits, no model call) | Compares last-50-runs telemetry against `task-profiles.json`, rolls up premium spend from `/tmp/chad-premium.jsonl`, appends recommendations to `memory/feedback-proposals.md` |

**What changed from the prior schedule:**

- `email-check` used to run every 30 min (48×/day) with a ~1400-char
  instruction string tokenized on every fire. The new 19×/day schedule
  + terse message (points at `EMAIL-POLICY.md` instead of inlining
  rules) cuts email-related token spend by roughly 60% without
  noticeably slower responses — admins get a reply within an hour
  instead of within 30 min, which is still well under human-scale
  latency for Chad's use case.
- Every new cron has a **budget guard** at the top of its message.
  The agent calls `chad-budget show --field remaining_tokens` and
  short-circuits before hitting the model if the reserve is too low.
  This is how a runaway Monday doesn't drain Tuesday's pool.
- `issue-triage` and `self-improve` are the new feedback loop — see
  §12 and §13.

The orchestrator plugs into this naturally: `email-check` can classify
a reply as "needs-research + draft-reply" and spawn both a `researcher`
and a `writer` in one shot. `issue-triage` is how a human-curated GitHub
issue turns into a triage plan without Chad having to poll all day.

### 7.1 Wrapper-only invariant (K2.5 caveat) and the hybrid Phase-2 inference path

`openclaw cron` runs in **isolated sessions** that re-tokenize the full
prompt every fire and don't inherit the interactive shell's env. Two
consequences:

1. **Cron prompts must be one-line wrapper invocations.** Multi-step
   prompts trigger K2.5's multi-turn tool-call regression, which has
   produced runs of 550k input tokens / 691s. Every cron message looks
   like: *"Run `<wrapper>`. Confirm it printed `<sentinel line>`, then
   exit. Do not …"*
2. **Slow work goes via `nohup … & disown` inside the wrapper.** The
   wrapper returns within 1–60s; the actual work writes its result into
   `memory/<today>.md` for the next cron tick to read. `chad-workspace-backup`
   is the canonical example.

The wrappers themselves live at `scripts/chad-cron-wrappers/` and are
deployed to `/usr/local/bin/` by `chad-setup.sh`. Each wrapper is its own
SPDX-headered script — diffs are reviewable, and individual wrappers can
be hot-patched on a running sandbox via `kubectl cp` without rerunning
the whole setup.

#### Phase-1 / Phase-2 hybrid

The wrapper-only invariant gives correctness but loses one nice property
the old "full inference" cron prompts had: actual *thinking* about the
inbox or the issue queue. Chad recovers it with a two-phase design:

- **Phase 1 — deterministic shell.** The wrapper does the boring,
  reliable work: parse `proton-tool inbox`, classify by sender/flags,
  batch `mark-read`, drop AuthContext blobs, write the memory block.
  Pure shell + Python regex. Always runs.
- **Phase 2 — single-turn, no-tools LLM draft.** When the wrapper has
  parked items that warrant thought, it shells out to
  `chad-phase2-draft-replies` for one assistant turn:
  - No MCP servers attached, no tools defined, prompt explicitly
    forbids tool use → K2.5 multi-turn regression cannot fire because
    there's nothing to round-trip.
  - Reasoning ON for max intelligence (per profile, currently `high`).
  - Output is a strict JSON object validated by a tolerant
    balanced-brace extractor; failure mode is a no-op.
  - Premium routes to Sonnet (or Opus) when the parked item came from
    a sender / GitHub mention that holds a valid AuthContext blob.
  - **Drafts are NEVER sent / posted** — they append to today's memory
    under "### Draft replies (review before sending)" or
    "### Issue triage drafts (review before posting)" for human gating.

Phase 2 is opt-in per task profile via a `phase2: { … }` block in
`scripts/task-profiles.json` (currently wired for `email-check` and
`issue-triage`). The block names model, thinking, max-tokens, timeout,
min-budget floor, and whether premium routing is allowed.

This is how the system gets the "full inference quality" feel back
without re-introducing the multi-turn regression: the cron payload stays
a dumb harness call (thinking off, tools on, K2.5-safe), and the heavy
thinking happens in the single-turn helper (thinking high, tools off,
K2.5-safe).

---

## 7.2 Premium escalation (Anthropic outsource)

Chad's primary inference is K2.5 via the NVIDIA "nemotron-3-super-120b"
endpoint. For tasks that K2.5 can't reliably do (multi-turn coding,
complex reasoning), Chad can escalate to Claude Opus through a tightly
gated wrapper.

| Component | Path | Purpose |
|---|---|---|
| `chad-premium-client` | `scripts/chad-cron-wrappers/chad-premium-client` | Python helper that POSTs to `api.anthropic.com/v1/messages`. Shells the actual HTTP call out to `curl` so OPA can pin a real binary identity (Python's `/proc/self/exe` is `/usr/bin/python3` — too broad). Logs every call to `/tmp/chad-premium.jsonl` (model, source, identity, in/out tokens, latency). |
| `chad-auth-context` | `scripts/chad-cron-wrappers/chad-auth-context` | AuthContext drop/show — `{source, verifiedIdentity, allowsPremium, createdAt, scope}`. Premium calls require `allowsPremium=true`. |
| `chad-premium` | `scripts/chad-cron-wrappers/chad-premium` | User-facing wrapper. Auto-detects `NEMOCLAW_INVOKER_TOKEN` for terminal use; reads `$CHAD_AUTH_CONTEXT_PATH` for cron use. |
| `chad-route-prompt` | `scripts/chad-cron-wrappers/chad-route-prompt` | Dashboard `/premium <prompt>` prefix → drops AuthContext → calls `chad-premium`. |
| `nemoclaw-blueprint/policies/presets/chad-premium.yaml` | policy preset | L7 policy: only `/usr/local/bin/chad-premium-client` and `/usr/bin/curl` may POST `/v1/messages`. |

**Authorized invocation paths** (each carries an AuthContext):

- Dashboard `/premium <prompt>` → `chad-route-prompt` → `chad-premium`
- Terminal `chad-premium` (auto-detects `NEMOCLAW_INVOKER_TOKEN`)
- `email-check` cron when From: matches `tantodefi@proton.me` / `supachad@proton.me`
- `issue-triage` cron when an open issue mentions `@supachad` / `@tantodefi`

Cron ticks with no inbound trigger have **no AuthContext** — `chad-premium-client`
fails closed at the application layer. Even if a future bug allowed an
unauthorized python script to fabricate an AuthContext, the L7 proxy still
blocks the call because only `chad-premium-client` is in the binaries
allowlist.

`chad-budget-audit` rolls up `/tmp/chad-premium.jsonl` weekly (model ×
source × identity × calls × tokens × p95 latency) into the audit report.

---

## 8. Backup and recovery

Chad's state lives in three places, in order of criticality:

| Tier | Location | Contents | Restored by |
|---|---|---|---|
| **1. GitHub** | `tantodefi/chad-state` (private) | `workspace/` including MEMORY.md, memory/, subagents/, queue/, budget.json | `chad-restore-from-github` |
| **2. Host tarball** | `~/.nemoclaw/backups/*.tar.gz` | Full `/sandbox` snapshot | `scripts/backup-host.sh --restore` |
| **3. Container PVC** | k8s PV or docker volume | Live filesystem | automatic on restart |

Tier 1 is the "nuclear survival" path — if every tier below is lost,
`chad-setup.sh` on a blank sandbox recovers everything but the running
processes.

`chad-backup-to-github` was updated in this branch to **diff-check**
before PUT: it computes the local blob sha (using the same algorithm
as `git hash-object`) and compares it to the remote sha before
uploading. Unchanged files are skipped. With ~20 files and a 6h cron
this saves ~400 GitHub API calls per day.

The backup set also grew on this branch:

- Workspace top-level now pushes `HEARTBEAT.md` and `TOOLS.md`
  alongside `SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`,
  `MEMORY.md`.
- **Brain pages** are exported as a directory of per-page `.md` files
  (via `gbrain export --dir`) instead of a single `pages.ndjson`. The
  backup script briefly stops `gbrain serve` to release the PGLite
  lock, exports, pushes each markdown file through the sha-diff path
  (so unchanged pages skip), then restarts `gbrain serve`. The restore
  mirror (`chad-restore-from-github.sh`) uses `gbrain import <dir>
  --no-embed`, which re-indexes lazily at first query.

---

## 9. Small fixes bundled into this branch

- **Backup diff-check.** `scripts/chad-backup-to-github.sh` now computes
  a local blob sha and skips the PUT if the remote already matches.
  Log line reports `Pushed N files, skipped M unchanged, K errors`.
- **Atomic skill sync.** `.github/skills/chad-bug-intake/scripts/sync-skills-to-sandbox.sh`
  no longer does `rm -rf $remote_dir/$skill; tar xf -` — it now extracts
  into a tempdir next to the live skill and atomically `mv`s the live
  copy out and the new copy in. If tar or ssh die mid-stream, the live
  skill is untouched and the sync rolls back. This prevents the
  "half-populated skill directory" failure mode that could leave
  `chad-spawn.sh` unable to find its `kinds/` tree.
- **Dockerfile wiring.** The six orchestrator helpers and the kind
  manifests are now baked into the image (`/usr/local/bin/chad-*` and
  `/opt/chad-orchestrator/kinds/`) as a last-resort fallback when the
  synced skill directory is missing.
- **chad-setup.sh.** The default skill sync list now includes
  `chad-orchestrator` alongside `proton-calendar` and `chad-bug-intake`.
- **Python UTC handling.** All the Python snippets in the orchestrator
  use `datetime.now(_UTC)` where `_UTC = getattr(datetime, "UTC", datetime.timezone.utc)`
  so they don't emit deprecation warnings on Python 3.12+.
- **YAML fallback.** `chad-spawn.sh` ships a stdlib-only YAML loader
  so the helpers work on hosts without PyYAML (matters for local
  iteration — the sandbox base image always has it).
- **gbrain MCP auto-register.** `chad-setup.sh` now runs
  `openclaw mcp set gbrain …` after `gbrain init`, momentarily making
  `/sandbox/.openclaw` writable for the edit and restoring the stricter
  `444` perms on `openclaw.json` afterwards. Sub-agents get the gbrain
  tools without any per-spawn flag.
- **Spawner cleanup.** `chad-spawn.sh` dropped the `--local` flag and
  the inline `--mcp-server gbrain` wiring — both are incompatible with
  openclaw 2026.4.x. Gbrain lives in `openclaw.json` instead, and the
  spawner sets `HOME=/sandbox` so `openclaw agent` resolves its config
  regardless of the invoking uid.
- **Gbrain install path.** The image now installs gbrain into a fixed
  project dir (`/usr/local/lib/gbrain`) from the `tantodefi/gbrain`
  fork and ships a small wrapper at `/usr/local/bin/gbrain`.
  `bun install -g` had unpredictable bin-link paths on Linux arm64;
  this is deterministic. `/opt/gbrain` is also whitelisted for read +
  execute in the base sandbox policy so bun can run it.
- **Sub-agent `fitness` + archive.org egress.** New kind + routing rule
  in `chad-route`; new `internet_archive` policy in
  `openclaw-sandbox.yaml` and matching rule in
  `subagent-researcher.yaml`. GET-only, pinned to `python3` + `curl`.
- **Router additions.** `chad-route` now matches fitness vocab
  (squat/deadlift/mobility/Rippetoe/Starrett/…) before the generic
  `coder` regex, so "how do I fix my squat" stops getting classified
  as a code task.
- **Onboarding typing fix.** `src/lib/onboard.ts` gained a local
  `isChannelConfigured` helper so the non-interactive messaging-setup
  path stops crashing when the symbol is referenced before the
  interactive branch defines it.

---

## 10. Phase-2 (not in this branch)

The orchestrator landed on this branch is intentionally the **minimum
viable contract**. A lot of obvious improvements were deliberately held
for a follow-up so this PR stays reviewable.

1. **Nested sandbox spawn.** Today all sub-agents share Chad's container
   (different L7 policies, same filesystem). Phase-2 spawns each
   sub-agent into its own k3s pod in the same cluster, so a compromised
   sub-agent can't read another sub-agent's `stdout.log`.
2. **Async queue with a worker.** `chad-spawn` is synchronous. A proper
   worker drains `queue/tasks.jsonl` in a background process and
   `chad-spawn-status` becomes the only way to poll.
3. **Cron DSL.** `chad-intake --from cron` takes a task file today. A
   YAML DSL would let Chad register new crons at runtime — "every
   Tuesday 9am, spawn a reviewer against my open PRs".
4. **`openclaw-sandbox.yaml` split.** The single 346-line policy file
   is at its complexity ceiling. Splitting per-domain (inference /
   github / messaging / browsing) would make policy review tractable.
5. **Multi-Chad scheduling.** One k3s cluster, multiple Chads, a shared
   scheduler that routes by kind + load. Needed the moment a second
   user shows up.
6. **MCP hub.** Expose the six orchestrator helpers as MCP tools so a
   non-Chad agent (Claude Code, a local editor) can drive the same
   sub-agent contract without Chad in the middle.
7. **Diff-checked, compressed backups.** The §9 diff-check is
   per-file. Phase-2 consolidates into a single commit with a tree
   sha diff — one API call per backup run instead of one per file.

---

## 11. Safety rules

These are the rules I will reject PRs over:

- **Never** let a sub-agent spawn another sub-agent without explicit
  parent approval. Budget is honor-based — the contract is the only
  enforcement.
- **Never** route a task to `coder` without Chad reading the task file
  first. A malicious task body can hide prompt injection.
- **Never** commit secrets into `result.json`, `stdout.log`, or
  `memory/`. The backup pipeline pushes these to a private repo but
  the same rule applies as with any git history.
- **Never** grant a new sub-agent kind write access to GitHub without
  writing the "why" into its preset header. Writes belong to the
  parent, draft-only belongs to the sub-agent.
- **Always** `--dry-run` the first invocation of a new kind or after
  editing any `kinds/*.yaml` manifest.
- **Always** let `chad-collect` run after a spawn batch so the ledger
  converges with `memory/YYYY-MM-DD.md` before the next cron fire.
- **Always** keep the `/opt/chad-orchestrator/kinds/` baked fallback in
  the Dockerfile. It's the only thing standing between a half-synced
  sandbox and a silent "kind not found" failure mode.

---

## 12. Where to look next

- **SKILL.md** — [`/.github/skills/chad-orchestrator/SKILL.md`](.github/skills/chad-orchestrator/SKILL.md) is the operator-facing doc Chad reads at invocation time.
- **Spawner** — [`/.github/skills/chad-orchestrator/scripts/chad-spawn.sh`](.github/skills/chad-orchestrator/scripts/chad-spawn.sh) is the canonical implementation of the contract.
- **Setup script** — [`/scripts/chad-setup.sh`](scripts/chad-setup.sh) is the one-command-recovery path.
- **Policies** — [`/nemoclaw-blueprint/policies/presets/subagent-*.yaml`](nemoclaw-blueprint/policies/presets/) are the kind-specific L7 rules.
- **Dockerfile** — [`/Dockerfile`](Dockerfile) lines ~115–133 wire the orchestrator helpers into the image.

For anything NemoClaw-wide (CLI, blueprint, plugin, tests), read
[`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).
