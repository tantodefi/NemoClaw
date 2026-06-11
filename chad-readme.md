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
describing how to invoke a sub-agent. Today we ship seven:

| Kind | Binary | Policy preset | Substrate | Timeout / Budget | Use case |
|---|---|---|---|---|---|
| `coder` | `/usr/local/bin/pi` | `pi-agent` | local | 600s / 50000 tok | Write/refactor code, run build + tests |
| `researcher` | `/usr/local/bin/claude` | `subagent-researcher` | local | 300s / 20000 tok | gh search, web facts, report |
| `writer` | `/usr/local/bin/claude` | `subagent-writer` | local | 600s / 25000 tok | Draft mail, docs, articles (never publishes — one spawn per article) |
| `reviewer` | `/usr/local/bin/claude` | `subagent-reviewer` | local | 300s / 25000 tok | Audit PR diff, run checklist (read-only gh) |
| `fitness` | `/usr/local/bin/claude` | `subagent-researcher` | local | 300s / 15000 tok | Strength + mobility answers from gbrain-ingested books (Rippetoe, Starrett) — brain-first, falls back to archive.org |
| `codex` | `/usr/local/bin/codex` | `subagent-codex` | **gha** | 600s / 50000 tok | OpenAI Codex CLI as alternate code/research backend. NVIDIA fallback when `OPENAI_API_KEY` absent. |
| `opencode` | `/usr/local/bin/opencode` | `subagent-opencode` | **gha** | 600s / 50000 tok | Multi-provider coding CLI (OpenAI/Anthropic/OpenRouter/NVIDIA). Honors `OPENAI_BASE_URL` for fallback routing. |

**Substrates.** Each kind picks where it executes:

- `local` — sub-agent runs in-container under the kind's L7 policy
  preset. Existing default. Synchronous spawn.
- `gha` — sub-agent runs on a GitHub Actions runner via
  `tantodefi/chad-state` (popebot-style branch-as-job-record). Lets us
  add new providers (codex, opencode) without baking binaries into the
  Chad image. Loses L7 policy enforcement; gains real isolation per
  spawn. See [docs/design/spawn-as-github-run.md](docs/design/spawn-as-github-run.md).

Per-spawn override: `chad-spawn --substrate gha` (or `--substrate local`).
Per-spawn binary swap: `chad-spawn --binary-override /usr/local/bin/codex --kind writer ...` (the kind's L7 policy still applies, so the override binary must be in its allowlist).
Async (gha-only): `chad-spawn --async --substrate gha ...` returns task_id immediately; the `chad-spawn-poll-watchdog` launchd job (host-side, 5 min) reconciles when the runner commits result.json back. (Was an openclaw cron until 2026-05-14 — moved out for cost: ~12.7M tokens/day saved. See `docs/operations/chad-devflow.md` § Host-side watchdogs.)

The manifest shape:

```yaml
kind: coder
binary: /usr/local/bin/pi
invocation: prompt-stdin            # prompt-stdin | prompt-arg | openclaw-agent
network_policy_preset: pi-agent
substrate: local                    # local | gha (default: local)
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
3. For gha-substrate kinds: ensure `agent-job.yml` in chad-state knows how to install the binary (edit the workflow's "Install <name>" step), and any new provider keys are set as chad-state secrets.
4. Sync skills + apply policy.
5. Run `chad-spawn --kind <name> --task-file /tmp/t.md --dry-run` to validate.

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
2. **Per-sandbox init** — `chad-setup.sh` Step 3a runs `gbrain init` only.
   gbrain is **intentionally NOT registered as an MCP server**. PGLite is
   single-process; an always-on `gbrain serve` would hold the file lock
   continuously and block every cron wrapper that uses gbrain CLI
   (`chad-gbrain-dream`, `chad-issue-triage-cron`, …). chad-setup.sh
   Step 3f actively removes `mcp.servers.gbrain` from the config on every
   run as defense-in-depth against wave-N plugin enables that may
   re-introduce it. Agents access gbrain via subprocess CLI
   (`gbrain query`, `gbrain put`, `gbrain doctor`, …); each call
   acquires + releases the lock atomically. See the
   `[[pglite-single-process]]` page in the memory-wiki vault for
   symptoms + the toggle-back-on procedure if you ever need MCP for an
   interactive session.
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

##### Memory maintenance pipeline

gbrain has three scheduled jobs that keep it current and bounded. All
three write summaries to today's workspace memory file and produce
feedback artifacts the signal-detector and self-improve loops consume.

| Job | Schedule | Where it runs | What it does |
|---|---|---|---|
| **chad-gbrain-dream** | Daily 03:30 UTC (sandbox cron) | sandbox | Ingest workspace docs + memory + events → `gbrain put`; extract timeline; doctor; detach `gbrain embed --stale` and `gbrain extract links`. Writes `dream-digest-<date>.md` and (if doctor flags `[WARN/FAIL/ERROR]`) `feedback_brain_health_<date>.md`. Also surfaces `Embedded/Chunks` ratio in the digest; writes `feedback_embed_staleness_<date>.md` if < 95% (catches a silently-stalled embed job). |
| **chad-webui-ingest** | Daily 04:30 UTC (host launchd) | host | Reads `~/.nemoclaw/openwebui/data/webui.db`, extracts chats updated in the last 25h from the `chat.chat` JSON column, formats as markdown with frontmatter, SSHes content into the sandbox via `gbrain put chat/<chat-id>`. Idempotent. Without this, OpenWebUI conversation history is invisible to long-term memory. |
| **chad-gbrain-prune** | Weekly Sundays 02:00 UTC (sandbox cron) | sandbox | Retention sweep. Deletes `memory/<date>` and `events/<date>` >365d from gbrain; deletes workspace `dream-digest-*.md`, `feedback_*.md`, `prune-log-*.md` >30d. **Protects** `system/*`, `agent/*`, and the workspace `<date>.md` journal (source-of-truth). Default `DRY_RUN=1` — set `DRY_RUN=0` in the cron env to actually delete. |

The three together implement the convergence loop: openwebui chats →
gbrain (`webui-ingest`) → dream consolidation (`dream`) → bounded
storage (`prune`). Both CLI-originated and OpenWebUI-originated turns
end up in the same brain.

Host-side launchd inventory: `dev.nemoclaw.{nvidia-proxy,
nvidia-liveness, chad-webui-ingest, chad-tunnel}.plist`. Sandbox-side
cron inventory: `openclaw cron list`. Memory-plugin inventory: the
gateway loads 9 plugins (`acpx, active-memory, browser, device-pair,
memory-lancedb, memory-wiki, phone-control, talk-voice, tokenjuice`)
— `memory-lancedb` actively injects ~3 contextual memories per agent
turn alongside gbrain queries; it is **not** orphaned and must not be
deleted.

#### gstack

gstack ships two distinct tiers; only the first works inside Chad's
sandbox.

**Tier 1 — openclaw reasoning skills (sandbox-safe, synced by chad-setup.sh)**

The full canonical 40-skill OpenClaw-adapter bundle from
`garrytan/gstack`'s `.openclaw/skills/` directory — no browser daemon, no
Bun binary, no Chromium. Structured reasoning frameworks the agent can
invoke in-session. Names dropped the `gstack-openclaw-` prefix and use
the canonical `gstack-<verb>` shape (e.g. `gstack-investigate`,
`gstack-ceo-review`, `gstack-qa`, `gstack-ship`, `gstack-review`,
`gstack-retro`, `gstack-canary`, `gstack-cso`, `gstack-design-review`,
`gstack-plan-eng-review`, `gstack-land-and-deploy`, `gstack-health`,
`gstack-context-save`/`-restore`, `gstack-freeze`/`-unfreeze`,
`gstack-document-release`, `gstack-make-pdf`, `gstack-codex`, …). The
full list is enumerated in
[docs/operations/chad-skills.md](docs/operations/chad-skills.md).

`chad-setup.sh` syncs these from `~/.claude/skills/gstack/.openclaw/skills/`
(note the dot-prefix — that's the canonical host-adapter dir, alongside
`.cursor`, `.opencode`, `.agents`, etc., kept current by
`gstack-upgrade`) into `/sandbox/.openclaw-data/skills/` in the sandbox.
The setup script also prunes any legacy `gstack-openclaw-*` dirs from a
previous 4-skill sync so they don't ship as duplicates of the canonical
names. If gstack is not installed on the host the step warns and skips —
it is not a hard dependency.

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

Chad runs **twelve** standing openclaw cron jobs plus **three host-side
launchd watchdogs**, all registered by `chad-setup.sh` (crons) and one-shot
plist loads (watchdogs). The schedules are **deliberately conservative**
— every cron fire tokenizes instructions and spawns a model call, so the
rule is: fewer, cheaper runs + a budget guard at the top of each one.

| Job | Cadence | Budget guard | What it does |
|---|---|---|---|
| `email-check` | `0 2,6-23 * * *` (19×/day) | skip if `remaining_tokens < 30000` | Reads mail via `proton-tool`, follows `EMAIL-POLICY.md` rules in the workspace, logs to `memory/<today>.md` |
| `workspace-backup` | every 6h | n/a (no model call) | `chad-backup-to-github` with the §12 diff-check |
| `issue-triage` | daily 10:00 UTC | skip if `remaining_tokens < 3×N×70k` | `chad-issue-triage` — scores open issues, routes top 2 through a researcher (see §12) |
| `gbrain-dream` | nightly 03:30 UTC | skip if `remaining_tokens < 50k` | `chad-gbrain-dream` — runs `gbrain dream` to consolidate links and surface orphans |
| `self-improve` | weekly Sun 03:00 UTC | skip if `remaining_tokens < 2×budget` | `chad-self-improve --detach` (v2, 2026-06-10) — wrapper detaches, collects last week's signal deterministically, ONE single-turn LLM call drafts prose + machine-readable proposals into `feedback-proposals.md` (see §13) |
| `chad-budget-audit` | weekly Mon 04:00 UTC | n/a (audits, no model call) | Compares last-50-runs telemetry against `task-profiles.json`, rolls up premium spend from `/tmp/chad-premium.jsonl`, appends recommendations to `memory/feedback-proposals.md` |
| `chad-proposal-apply` | daily 04:30 UTC | n/a (applies safe-list) | Reads structured proposals from `feedback-proposals.md`, applies bounded `timeoutSeconds`/`maxOutputTokens` edits via `openclaw cron edit`, appends `## Applied` block. |
| `chad-skill-watch` | daily 09:00 UTC | n/a (diff only) | Diffs `openclaw skills list --json` against `state/skills-snapshot.json`, surfaces added/removed/changed skills under `## Skill catalog diff` in today's memory. |
| `memory-curator` | weekly Sat 04:00 UTC | inactivity-gated (≥7d since last + ≥1h idle) + budget guard | `chad-memory-curator` — Hermes-style consolidation pass over memory-lancedb captures + workspace MEMORY.md. **Draft-only**: writes proposals to `curator-runs/<utc>/proposals.json`. |
| `spawn-gc` | weekly Mon 02:30 UTC | n/a (gh API only) | `chad-spawn-gc` — phase 1 reconciles orphaned ledger entries (queued/running >24h → failed/done); phase 2 prunes `chad-spawn/*` branches on chad-state (done=7d, failed=30d, in-flight kept; skips itself if gh is unauthenticated). |
| `nightly-experiments` | nightly 02:00 UTC | skip if `remaining_tokens < 20000` (in-wrapper) | **(v2 2026-06-10)** `chad-experiment-cron` — deterministic observe → evaluate → design driver; experiment verdicts and new designs come from single-turn no-tools LLM calls, never a multi-turn cron loop. Per-operator concurrent budget + regression auto-retire. See `docs/operations/chad-experiments.md`. |
| `gbrain-prune` | weekly Sun 02:00 UTC | n/a (no model call) | `chad-gbrain-prune 0` — drops stale gbrain pages older than retention windows (cron passes `0` = DRY_RUN off; bare invocations still default to dry-run). |

**Plus three host-side launchd watchdogs** (no agent overhead, run every 5 min via SSH):

| Plist | Supervises | Why |
|---|---|---|
| `dev.nemoclaw.chad-gateway-watchdog` | `openclaw gateway run` on port 18789 | OOM recovery with 4 GB heap |
| `dev.nemoclaw.chad-shim-watchdog` | `chad-shim.py` on port 8901 (the `chad` model bridge) | Restart on death (BrokenPipeError etc.) |
| `dev.nemoclaw.chad-spawn-poll` | Runs `chad-spawn-poll` itself, instead of via an openclaw cron | Reclaimed ~12.7M tokens/day vs. the prior agent-turn cron. See `docs/operations/chad-devflow.md` § Host-side watchdogs. |

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

### 7.1 Wrapper-only invariant (legacy K2.5 caveat) and the hybrid Phase-2 inference path

`openclaw cron` runs in **isolated sessions** that re-tokenize the full
prompt every fire and don't inherit the interactive shell's env. Two
consequences:

1. **Cron prompts must be one-line wrapper invocations.** Originally this
   was forced by Kimi K2.5's multi-turn tool-call regression (550k input
   tokens / 691s on a single fire). Kimi K2.5 was deprecated 2026-04-29;
   the default now is `nvidia/nemotron-3-super-120b-a12b`, which is
   `reasoningSafe=true`. The wrapper-only invariant still stands because
   nemotron-3-super on the embedded path is slow, and re-tokenizing a
   long instruction every cron tick is expensive regardless of model.
   Every cron message looks like: *"Run `<wrapper>`. Confirm it printed
   `<sentinel line>`, then exit. Do not …"*
2. **Slow work goes via `nohup … & disown` inside the wrapper.** The
   wrapper returns within 1–60s; the actual work writes its result into
   `memory/<today>.md` for the next cron tick to read. `chad-workspace-backup`
   is the canonical example.
3. **Cron jobs are registered with `--no-deliver --best-effort-deliver`.**
   The chad sandbox's `messagingChannels` list is empty (no Telegram /
   Discord bound), so the gateway's default delivery path returns an
   error per fire and gates the run as `failed`. Disable delivery globally
   — the wrapper's stdout sentinel is the cron's ack, not a deliverable.
   `chad-setup.sh` registers every chad-owned cron with these flags and
   patches pre-existing crons on every run (idempotent).

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
    forbids tool use → there's nothing to round-trip, so any model's
    multi-turn tool-call regression (K2.5 was the original hazard;
    Nemotron 3 Super 120B is `reasoningSafe=true` but the no-tools
    invariant survives as cheap insurance) cannot fire.
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
a dumb harness call (thinking off, tools on, reasoning-safe model), and
the heavy thinking happens in the single-turn helper (thinking high,
tools off, no round-trip surface to fail on).

---

## 7.2 Premium escalation (Anthropic outsource)

Chad's primary inference is `nvidia/nemotron-3-super-120b-a12b` via the
NVIDIA Endpoints free tier (Kimi K2.5 was the previous default; deprecated
2026-04-29 — see [docs/inference/providers.md](docs/inference/providers.md)
for the migration note). For tasks where Nemotron's review or reasoning
depth feels shallow (multi-turn coding, deep architecture sketches), Chad
can escalate to Claude Sonnet/Opus through a tightly gated wrapper.

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
| **2. Host tarball** | `~/.nemoclaw/backups/sandbox-state-*.tar.gz` | Full `/sandbox` snapshot streamed via SSH tar | `tar -xzf` + `kubectl cp` |
| **3. Pod ephemeral fs** | container writable layer (NOT a PVC) | Live filesystem | **NOTHING — see warning below** |

Tier 1 is the "nuclear survival" path — if every tier below is lost,
`chad-setup.sh` on a blank sandbox recovers everything but the running
processes.

> ⚠ **CRITICAL — `/sandbox` is NOT on a PVC.** The chad pod mounts only
> `openshell-client-tls` (secret), `openshell-supervisor-bin`, and the
> default `kube-api-access` service-account volume. All of `/sandbox`
> (~1.2 GB: gbrain pglite, openclaw config, workspace memory, lancedb,
> credentials) lives in the container's writable layer.
>
> Running `kubectl delete pod chad -n openshell` (or anything that
> recreates the pod) **WIPES THE BRAIN.** Verify the mount situation
> with `docker exec openshell-cluster-nemoclaw kubectl get pod chad -n openshell -o jsonpath='{.spec.volumes[*].name}'`.
>
> Before any pod-recreating operation, take a Tier-2 backup:
> ```bash
> TS=$(date -u +%Y%m%dT%H%M%SZ)
> ssh openshell-chad 'cd / && tar -cf - sandbox' \
>   | gzip > ~/.nemoclaw/backups/sandbox-state-${TS}.tar.gz
> ```
> Restore is `kubectl cp` the un-tarred tree back into the new pod plus
> `chmod +x` on the wrappers. The proper fix is adding a PVC for
> `/sandbox` in the nemoclaw-blueprint StatefulSet — until that lands,
> treat the running pod as a single live copy.

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
- **Open WebUI chat front-end.** `scripts/openwebui/` ships a
  docker-compose stack exposing open-webui via a Cloudflare Tunnel. Two
  modes: `--mode=quick` (ephemeral `*.trycloudflare.com`, email/password
  auth, MVP) and tunnel mode (managed tunnel + Cloudflare Access on a
  real domain, header-trusted SSO). See [`docs/operations/openwebui.md`](docs/operations/openwebui.md).
- **Chad-as-a-model.** `scripts/openwebui/chad-shim.py` is a stdlib-only
  HTTP shim listening on `127.0.0.1:8901` inside the sandbox. It exposes
  an OpenAI-compat `/v1/chat/completions` endpoint and translates each
  turn into one `openclaw agent --json --agent main --session-id <hash>`
  invocation. open-webui sees a model called `chad`; under the hood,
  every reply benefits from gbrain context, network policies, the
  action-gate, and premium routing. The shim is reached from the host
  via `npm run webui:chad:up` (one-shot SSH port-forward) or
  `webui:chad:install` (persistent launchd LaunchAgent with
  `KeepAlive=true`). `chad-setup.sh` deploys the shim to
  `/usr/local/bin/chad-shim.py` and starts it; `chad-restore-from-github`
  and `chad-backup-to-github` each self-heal a crashed shim, so any cron
  pulse keeps it alive.

---

## 10. Phase-2 (status of follow-up work)

The orchestrator landed on this branch was intentionally a **minimum
viable contract**. Several improvements were deliberately held for
follow-up; some have since shipped. Status as of 2026-05-06:

1. ✅ **Nested-spawn isolation — shipped (gha substrate).** Sub-agents
   can now spawn onto a per-job GitHub Actions runner instead of
   sharing Chad's container. See [docs/design/spawn-as-github-run.md](docs/design/spawn-as-github-run.md)
   for the design (Phases A–C all shipped 2026-05-06). The k3s-pod
   substrate is still future work for kinds that need both L7 policy
   enforcement *and* per-spawn isolation.
2. ✅ **Async spawn — shipped.** `chad-spawn --async --substrate gha`
   returns immediately; the ledger gets `substrate` + `async` fields;
   `chad-spawn-poll` cron (every 5min) reconciles result.json back
   into `subagents/<id>/` and transitions the ledger entry. Branch
   retention via `chad-spawn-gc` weekly cron.
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
8. **Webhook-based completion.** Today `chad-spawn-poll` polls every
   5min. A real callback receiver in Chad's gateway would replace
   that with push semantics, freeing both the runner-to-Chad
   reconciliation latency and the unnecessary work when no spawns
   are in flight.

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

## 11.5 Known deploy gaps

A running sandbox can lag behind `chad-dev` if the image was built before
a wrapper was added. `chad-setup.sh` only runs at image build time, so
wrappers added to source after the most recent build won't appear in
`/usr/local/bin/` until a rebuild.

Verify what's actually installed in a live sandbox:

```bash
for w in chad-spawn-poll chad-spawn-gc chad-memory-curator; do
  ssh openshell-chad "[ -x /usr/local/bin/$w ] && echo PRESENT || echo MISSING"
done
```

If anything reports MISSING:

- **Stopgap** — deploy to a sandbox-writable path:

  ```bash
  ssh openshell-chad 'mkdir -p /sandbox/.openclaw-data/bin'
  for w in chad-spawn-poll chad-spawn-gc chad-memory-curator; do
    cat scripts/chad-cron-wrappers/$w | ssh openshell-chad \
      "cat > /sandbox/.openclaw-data/bin/$w && chmod +x /sandbox/.openclaw-data/bin/$w"
  done
  # Point cron prompts at the new path:
  ssh openshell-chad "openclaw cron edit <id> --message 'Run \`/sandbox/.openclaw-data/bin/<wrapper> ...\`'"
  ```

- **Permanent fix** — rebuild the image. `chad-setup.sh` line ~354 installs
  every wrapper under `scripts/chad-cron-wrappers/` via `install_to_usrlocal`.

Symptom of running without these wrappers: matching crons spend 8–22 min
per tick with the agent grinding through `which`/`find`/`ls`/`npx` looking
for the missing binary, burning 277k–666k input tokens before idle-timeout.
The 2026-05-11 incident traced 100% of the spawn-poll / spawn-gc /
memory-curator errors to this gap. Always check this before chasing
other cron-error hypotheses.

---

## 12. Where to look next

- **SKILL.md** — [`/.github/skills/chad-orchestrator/SKILL.md`](.github/skills/chad-orchestrator/SKILL.md) is the operator-facing doc Chad reads at invocation time.
- **Spawner** — [`/.github/skills/chad-orchestrator/scripts/chad-spawn.sh`](.github/skills/chad-orchestrator/scripts/chad-spawn.sh) is the canonical implementation of the contract.
- **Setup script** — [`/scripts/chad-setup.sh`](scripts/chad-setup.sh) is the one-command-recovery path.
- **Devflow catalog** — [`/docs/operations/chad-devflow.md`](docs/operations/chad-devflow.md) lists every wrapper, its schedule, and which symptoms point at it.
- **Workflow scenarios** — [`/docs/operations/chad-workflows.md`](docs/operations/chad-workflows.md) names the 10 expected inbound email scenarios and how each flows through the pipeline.
- **Open WebUI front-end** — [`/docs/operations/openwebui.md`](docs/operations/openwebui.md) covers the chat UI, dual-provider setup, and chad-as-a-model persistence.
- **Policies** — [`/nemoclaw-blueprint/policies/presets/subagent-*.yaml`](nemoclaw-blueprint/policies/presets/) are the kind-specific L7 rules.
- **Dockerfile** — [`/Dockerfile`](Dockerfile) lines ~115–133 wire the orchestrator helpers into the image.

For anything NemoClaw-wide (CLI, blueprint, plugin, tests), read
[`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).
