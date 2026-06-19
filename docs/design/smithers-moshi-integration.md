# Smithers + Moshi: Evaluation and Integration Plan for Chad

Status: proposal (2026-06-12). Not committed to. Follows the 2026-06-11
pre-commit evaluation session; this version is grounded against the live
docs (smithers.sh/introduction, getmoshi.app/skill) and the current
wrapper inventory on `chad-dev`.

## Implementation log

**2026-06-13 — Smithers foundation built + validated (host-side).**
`scripts/chad-smithers/`:
- `agents.js` — model router, all backends, runtime auto-detection. Probes
  clean (`bun agents.js --probe`); constructs ClaudeCodeAgent / ToolLoopAgent.
- `lib/population.js` + `population.test.js` — evolutionary selection engine
  (start wide → score → rank → retire). **6/6 unit tests pass.**
- `experiments.jsx` — evolutionary nightly workflow. **Validated via
  `smithers graph` against smithers-orchestrator 0.23.0**; dry-run renders
  6 parallel candidates + select + report. Needs one live-model `smithers up`
  smoke pass before cron wiring.
- `run-experiments.sh` — host cron driver (portable mkdir lock; posts
  leaderboard to OpenWebUI best-effort).
- `bun install` succeeds (329 pkgs); `smithers` CLI present.

Not yet started: Moshi track (Phase 1–2), experiments cron cutover (Phase 4
needs the smoke pass), autonomy ladder (Phase 5). Moshi Phase 1 is blocked on
the human `moshi-hook host setup` iPhone pairing.

## Phase 4 cron — DONE 2026-06-13 (host launchd, Nemotron Ultra)

`run-experiments.sh` is wired to a launchd job (`dev.nemoclaw.chad-experiments`,
nightly 05:00 local, source plist in `scripts/chad-smithers/`). Validated
end-to-end under a launchd-like minimal env: seed → parallel eval → select →
report → OpenWebUI note. Three non-obvious findings drove the final design:

- **Cron runs on Nemotron Ultra via the NVIDIA API, not host `claude`.** Under
  launchd the `claude` CLI can't authenticate (subscription is keychain/GUI-bound
  → "Not logged in") and its user hooks (Moshi, claude-mem) pollute headless
  output (`AGENT_CLI_ERROR` from `SessionStart` hook JSON). So `run-experiments.sh`
  reads `NVIDIA_API_KEY` from host credentials at runtime and forces
  `CHAD_*_BACKEND=nemotron` + `CHAD_INFERENCE_BASE_URL=integrate.api.nvidia.com`.
  Bonus: this means the nightly loop actually exercises Ultra+reasoning (the model
  under evaluation), with no per-candidate phone spam.
- **chad-webui is pod-only**, so the note post streams the report host→pod over
  ssh and runs chad-webui there. The created note id is logged to
  `state/posted-notes.log`.
- **`chad-webui notes list` returns HTTP 500** (pre-existing — surfaced while
  verifying; note *create*/*delete*-by-id work). Worth a separate look; it means
  the operator can't browse experiment notes via the list endpoint yet.

Caveat: the launchd job's `claude`-tier fallback is unusable in cron for the
auth/hook reasons above — cron is Nemotron-only by design. Interactive/host use
still gets claudecode via the router default.

## Harness retest — Nemotron Ultra does what Super/K2.5 couldn't (2026-06-13)

**Question:** the openclaw harness couldn't round-trip tool calls when
`reasoning=true` (Kimi K2.5 → `reasoningSafe=false`; agent stalled on empty
toolUse). Does the newest Nemotron — **Ultra 550B**
(`nvidia/nemotron-3-ultra-550b-a55b`) — still hit that bug?

**Test (pod-side, against integrate.api.nvidia.com):** with reasoning ON
(system `detailed thinking on`) and a `get_weather` tool offered:
- Turn 1: emitted a **standard OpenAI `tool_call`** with valid-JSON args
  (`{"city":"Tokyo"}`) **and** reasoning content. `tool_calls=1`.
- Turn 2: fed the tool result back → `finish_reason=stop`, final answer
  reflected the result ("18°C, clear skies").
- **VERDICT: PASS.** The K2.5 failure mode (non-standard tool-call format the
  harness can't round-trip) is **absent** in Ultra.

Note on scope: this verified the *model/API* root cause (the tool-call format
under reasoning) — decisive, since the harness parses standard OpenAI tool_calls
(why Super 120B already works). A live `openclaw agent --local` canary is the
final confirmation when the production model is switched (staged, below).
Egress detail: raw `python3` is L7-blocked to NVIDIA (binary-identity policy);
`curl` is allowlisted, so the test ran via curl.

**"Ultra everywhere + reasoning on" rollout:**
- DONE (source, reviewed-before-commit): `model-registry.json` Ultra entry
  `reasoningSafe:true` w/ evidence; Smithers router defaults Ultra for both
  tiers + reasoning ON (`CHAD_REASONING=off` to disable); Dockerfile +
  blueprint **hosted** profiles (`default`, `ncp`) → Ultra. Self-hosted
  profiles (`nim-local`, `vllm`) kept on Super 120B (550B local = far bigger
  GPU footprint; no hardware regression imposed on other users).
- STAGED (needs a supervised window — restart risk, user-away safety):
  hot-swapping the **live pod** model + `NEMOCLAW_REASONING`, and flipping the
  `task-profiles.json` cron `thinking: off` entries. Those were set off for
  *latency* on the slow cron path as well as the now-disproven safety fear —
  so flipping all of them to `high` risks cron timeouts/budget. Recommend:
  enable reasoning on content/decision tasks (issue-triage, self-improve,
  memory-curator, nightly-experiments) first, watch `chad-budget-audit`, then
  widen. The live model swap needs an agent restart, so do it when someone can
  watch the gateway (bonjour-crash history).

## GHA substrate for Smithers + the two-architecture question (2026-06-16)

**Question (#24):** can Smithers runs use GitHub Actions as a substrate, the way
`chad-spawn --substrate gha` runs sub-agents on a GH runner?

**How chad-spawn-gha works** (`.github/skills/chad-orchestrator/scripts/chad-spawn-gha.sh`
+ `docs/design/spawn-as-github-run.md`): mint a task_id → push a
`chad-spawn/<id>` branch to `tantodefi/chad-state` with the task/kind/budget →
`gh workflow run agent-job.yml` → the runner installs the kind's binary, runs
the agent under a budget cap, commits `result.json` back to the branch → host
reconciles via `chad-spawn-poll` (launchd) or a gateway webhook. **The branch is
the job record** — no DB.

**Verdict: feasible and graceful, by REUSING that exact machinery — not building
a parallel GHA system.** Two shapes:

- **(A) Whole workflow on a runner** — a `smithers-job.yml` that checks out the
  chad-smithers workspace, `bun install`, `smithers up <wf>`, then ships the
  resulting SQLite DB back (commit to a `smithers-run/<id>` branch or upload as
  an artifact); a host poller drops it into the dashboard's scanned dir.
- **(B, recommended) GHA as a Smithers *task* substrate** — a `pickSpawn()` /
  `<GhaTask>` helper that dispatches `chad-spawn-gha` for ONE heavy step and
  reconciles its `result.json` as that task's output. Smithers stays the
  orchestrator on the host; only heavy/isolated steps offload to a runner.

(B) is the gentler add: it reuses chad-spawn-gha verbatim, keeps the live host
dashboard for orchestration, and lets a Smithers workflow fan a heavy step
(e.g., `npm test`, an 8-vCPU build, a big parallel eval) onto GH runners.

**Caveat:** GHA runs are **batch**, not live-streamed — the dashboard shows the
host orchestration live, but a GHA-offloaded task only updates when its
`result.json` reconciles back (runner spin-up + `bun install` ≈ 1-2 min
overhead). So: host for interactive/live; GHA for heavy/parallel/isolated.
Needs `NVIDIA_API_KEY` as a GH Actions secret on `chad-state`.

### Do we run both chad-spawn AND chad-Smithers? Yes — they're complementary.

| | chad-spawn | chad-Smithers |
|---|---|---|
| Shape | imperative one-shot sub-agents (kind manifests) | declarative durable workflows (JSX) |
| State | branch-as-record (chad-state) | SQLite + live dashboard + resume |
| Best for | isolated one-shot agents (writer/coder/reviewer), GHA offload | multi-step pipelines, experiments, autonomy ladder, anything inspectable/resumable |
| Substrate | in-container OR GHA | host (live) — **+ GHA via the bridge above** |

**Decision: keep both, bridge them.** chad-spawn remains the GHA-isolated
one-shot substrate; chad-Smithers is the durable workflow orchestrator that can
*call* chad-spawn-gha to offload heavy tasks. No wholesale migration.

### Revised plans

- **#15 (spawn-stack → Smithers) — REVISED to "bridge + selective migration."**
  Don't replace `chad-spawn`/`poll`/`gc`. Instead: (1) build the `<GhaTask>`
  bridge so Smithers workflows can offload steps via chad-spawn-gha; (2) migrate
  only the **multi-step** spawn flows (issue-triage multi-spawn, content
  multi-spawn) to Smithers workflows that use the bridge; (3) leave one-shot
  spawns on chad-spawn. The ~1,300-line stack stays; Smithers wraps it.
- **#23 (port Chad features) — clarified scope.** Port the **multi-step /
  durable / inspectable** features (self-improve, issue-triage, memory-curator)
  to Smithers `.jsx` (they gain resume + the dashboard + approvals, and can use
  `<GhaTask>` for heavy sub-steps). Leave **mechanical one-shot** crons
  (backups, prune, gc, budget-audit) as deterministic wrappers — Smithers is
  pure overhead there.

### Built (2026-06-16) — #15 bridge + #23 ports

Shipped under `scripts/chad-smithers/`. All workflows graph-validate
(`smithers graph`) and the side-effecting ones are **shadow-safe by default**
(they log what they would do unless an explicit env flag is set), mirroring the
draft-only contract of the shell wrappers.

- **`lib/spawn.js` — the bridge (keystone of #15).** `runSpawn({kind, task,
  substrate, id, …})` offloads ONE step to the existing `chad-spawn` and
  reconciles its `result.json` as the task's output. Never throws (always
  resolves to a `spawnResultSchema`-shaped object). Transport resolves per call:
  `CHAD_SPAWN_STUB=1` (shadow), `CHAD_SPAWN_SSH=<host>` (real pod spawn — task
  streamed in / result streamed back, since scp is blocked), local `chad-spawn`
  on PATH, else stub. Also ports `chad-route` → `route()` and
  `chad-issue-triage`'s scoring → `scoreIssue()`. Unit-tested
  (`lib/spawn.test.js`, 8/8). **No GHA system was rebuilt** — the bridge calls
  `chad-spawn --substrate gha` verbatim.
- **#15 migrated multi-spawn flows:** `workflows/issue-triage.jsx` (fetch →
  score+route → `Parallel` spawn per top-N issue → report; verified end-to-end
  with stub spawns against a live issue repo) and `workflows/content-pipeline.jsx`
  (research→draft→review spawns → reviewer-gated `Approval` → shadow publish).
- **#23 ported features:** `workflows/self-improve.jsx` (cron telemetry → one
  capable structured proposal → safe-list/`Approval` gate → shadow apply via the
  pod's gated `chad-proposal-apply`), `workflows/memory-curator.jsx`
  (inactivity-gate → pre-mutation snapshot → propose consolidations → `Approval`
  → shadow apply), and `workflows/log-digest.jsx` (cluster host service-log
  errors → note; quiet on a clean window; verified end-to-end on the host's 29
  service logs).
- **Left as deterministic wrappers (correctly):** backups, prune, gc,
  budget-audit — mechanical one-shots where Smithers is pure overhead.

Remaining for full parity (not blocking): the `<GhaTask>` JSX-component sugar
(today it's `runSpawn({substrate:"gha"})`), flipping a flow to real mode in the
pod (`CHAD_SPAWN_SSH` + a clean shadow week per the sunset rule), and wiring the
real publish/apply/note sinks (`chad-webui`, `chad-proposal-apply`) once each
shadow run proves out.

## Fusion audit + resilience hardening (2026-06-18)

Audited our `workflows/fusion.jsx` against upstream **`github.com/smithersai/smithers-fusions`** and the core `smithersai/smithers` `examples/`, then hardened the workspace. Findings drove a batch of changes (this entry is the rationale; the code is under `scripts/chad-smithers/`).

### Ours vs upstream — same engine, two authoring modes

| | Ours (`workflows/fusion.jsx`) | Upstream (`smithers-fusions`) |
|---|---|---|
| Package | `smithers-orchestrator` v0.23.0 (the public **JSX facade**) | `smithers` engine + `incur` (CLI/MCP) |
| Authoring | declarative **JSX** (`<Workflow><Parallel><Task>`) | imperative **TS** (`runFusion()`, `engine.start/.advance`, `h(Task,…)` hyperscript) |
| Fuse stages | **2** (panel → one combined fuse task) | **3** (panel → structured judge → synthesizer) |
| Resilience | `retries={1}` only | `continueOnFail`, retries=2, 600s timeout, `schemaFailFastAgent` coercion |
| Driver | `smithers up` + `serve-runs.js` dashboard | per-step CLI w/ approval gates (plan→implement→review→fix, ≤16 rounds) |

**Why ours is `.jsx`, theirs `.ts`:** the difference is authoring style on the *same* durable engine, not capability. Ours is a zero-build host-side bun script set — JSX gives a graph `smithers graph` can validate without running and the dashboard renders as a task tree; plain JSX + JSDoc avoids a tsconfig/compile step, and our flows are graph-shaped (fan-out→fuse; seed→eval→select→report). Theirs is a *published library + CLI for others* (compile-time types matter) whose headline flow is a *dynamic agent-driven loop* ("one command per step," human edits between phases) — awkward as a static JSX graph, natural as imperative `engine.advance()` calls.

### The "too-short responses" question — answered

The run responses on `runs.supachad.com` are **real model output, not placeholders**, but look short/empty for four structural reasons:
1. **Schema-capped.** Agent tasks return tiny structured JSON (`rationale` = "one sentence"); that *is* the whole answer by design.
2. **Compute nodes have NULL `response_text`.** `select`/`report` are thunks returning JS objects, not agent text → blank dashboard rows.
3. **Trace drops the reasoning.** The `ToolLoopAgent` (Nemotron) family is unrecognized → `captureMode:cli-text`, `traceCompleteness:final-only`, with `assistant.thinking.delta`/`assistant.text.delta` in `unsupportedEventKinds`. One eval generated **496 output tokens** but only ~60 (the final JSON) are captured/shown.
4. **5 of 6 workflow DBs are empty.** Only `experiments.db` had real runs; `fusion`/`email-ladder`/`fail-only`/`mcp-health`/`self-improve` had **zero** — those workflows were scaffolds never given a real `smithers up`, so their dashboard rows genuinely *were* empty.

### Decision: harden hand-rolled, don't migrate to the built-in `<Panel>`

v0.23.0 ships composite components (`Panel`, `GatherAndSynthesize`, `ReviewLoop`, `ContentPipeline`, `ClassifyAndRoute`, `Saga`, `TryCatchFinally`) and every `TaskProps` exposes `continueOnFail`, `timeoutMs`, `heartbeatTimeoutMs`, `fallbackAgent`. **But `<Panel>` is a thin 2-stage composition** (`Sequence > Parallel[panelist Tasks] > moderator Task`) that sets *no* `continueOnFail`/`timeout`/`retries` and whose "consensus" strategy is just an appended prompt sentence — migrating to it would *lose* resilience and the 3-stage judge. So we keep our tested hand-rolled workflows and add the verified resilience props directly. Our upgraded `fusion.jsx` (3-stage + `continueOnFail` + `fallbackAgent` + timeouts) is strictly better than `<Panel>` and matches upstream's structured judge.

### Changes shipped this pass

- **`agents.js`** — `timeoutMs` + `heartbeatTimeoutMs` defaults on the nemotron/local backends (were unset; a hung NVIDIA call had no task deadline). Env: `CHAD_TASK_TIMEOUT_MS`, `CHAD_TASK_HEARTBEAT_MS`.
- **`lib/coerce.js`** (+ test) — extract JSON from prose/code-fences and validate against a zod schema; returns `null` on permanently-bad output so callers drop the row instead of burning retries (the `schemaFailFastAgent` idea).
- **`fusion.jsx`** — 3-stage (panel → structured **judge** {consensus, contradictions, uniqueInsights, blindSpots, confidence} → **synthesize**); `continueOnFail` + `fallbackAgent` + `timeoutMs` on every panelist; reads the experiments leaderboard so the **arena selects the default panel**.
- **`experiments.jsx`** + the 8 other workflows — `continueOnFail`/`timeoutMs`/`fallbackAgent` on agent tasks; eval output run through `coerce.js`.
- **`serve-runs.js` + `public/index.html`** — per-run/-node **token usage**, a **"reasoning hidden (final-only capture)"** indicator so short outputs read as intentional, **compute-node JSON outputs** rendered (not blank), and a **workflow catalog** that lists zero-run/scaffold workflows with a Launch button.
- **Smoke passes** — real `smithers up` for the previously-empty scaffolds so their DBs carry data and the dashboard changes verify against reality.

## Next steps & hanging TODOs

### Needs operator intervention (I can't do these from here)

- **GitHub PAT — host RESOLVED 2026-06-14; pod pending.** The host
  `credentials.json` `GITHUB_TOKEN` was replaced with a new **classic** `ghp_`
  (supachad) carrying `repo` + `workflow`; verified working (chad-state HTTP 200,
  `push:true`, Actions visible). The **pod still has the OLD expired token**
  (host sha256[:12] `8d2267c78f29` ≠ pod `08ecd2c3c925`) — refresh it on the pod
  as part of the #16 Ultra cutover window (same supervised restart), then
  re-verify chad-backup / GHA spawns.
- **runs.supachad.com run dashboard — BUILT + TESTED 2026-06-14; one operator
  step left.** Decided on a **subdomain** (gateway-react/the operator console
  were headless/live-only; instead `serve-runs.js` is now a durable Hono server
  that reads the Smithers SQLite DBs directly → full run HISTORY across every
  workflow DB, auto-discovering new runs). `public/index.html` is the dashboard
  (runs list, run detail w/ task tree + outputs, experiments leaderboard).
  Verified end-to-end locally: 2 workflows across 2 DBs, detail + leaderboard
  render. Deploy: `dev.nemoclaw.chad-runs-ui.plist` (binds 0.0.0.0:7331).
  REMAINING (operator, dashboard-only): in Cloudflare Zero Trust add a
  public-hostname route **`runs.supachad.com` → `http://host.docker.internal:7331`**
  (cloudflared runs in Docker) + an Access app for that subdomain mirroring
  chad.supachad.com's policy. Exact values in
  `scripts/chad-smithers/cloudflared-runs.ingress.example.yaml`. Token tunnel =
  dashboard-only, so I can't add it. Interim still live: the nightly leaderboard
  **note** in OpenWebUI.
- **Live pod Ultra cutover (#16).** Source defaults are Ultra; the live pod
  model swap + `task-profiles.json` reasoning flips need an agent restart in a
  window you can watch the gateway (bonjour-crash history). Back up config first;
  `openclaw agent` canary after. **Also in this window:** propagate the new
  `GITHUB_TOKEN` to the pod credentials (it still has the expired one — see
  above) via chad-deploy/chad-sync, and re-verify chad-backup + a GHA spawn.
- **`chad-webui notes list` → HTTP 500.** Appears pre-existing (create/delete by
  id work). Blocks browsing experiment notes; worth a look. A couple of test
  notes titled "Chad experiments — 2026-06-13" may linger — delete at leisure.
- **Operator OpenWebUI keys.** The TJCOOKE key was a placeholder last audit;
  per-operator fail-closed scoping needs the real key for tjcooke flows.

### Buildable next (no intervention needed)

- **#15 spawn-stack → Smithers — BRIDGE BUILT 2026-06-16** (see "Built" above).
  The bridge (`lib/spawn.js`) + the two multi-step flows (issue-triage,
  content-pipeline) ship. Not done by design: the ~1,300-line one-shot stack
  (`chad-spawn`/`poll`/`gc`/`watchdog`) STAYS — Smithers wraps it rather than
  replacing it. Real-mode cutover of a flow waits on two clean shadow weeks.
- **opencode CLI-agent adapter.** `opencode/big-pickle` confirmed;
  `opencode run -m <model>` is the non-interactive path. Implement a Smithers
  agent adapter around it (opencode serve is not OpenAI-compatible).
- **meeting-briefer workflow.** Fork once calendar + fitness-RAG data hookups
  are wired (tjcooke pre-session brief).
- **pod→host Moshi bridge.** Capture the `moshi-hook claude-hook` stdin schema
  to forward pod cron events (gbrain-dream, spawns) to the phone — host `claude`
  runs already notify.
- **Live-smoke the new workflows.** `experiments.jsx` is smoke-passed;
  `mcp-health-probe`/`fail-only-report`/`email-ladder` are graph-validated only.

## TL;DR

The two projects solve Chad's two biggest *documented* problems, and they
don't overlap:

| | Smithers | Moshi skill |
|---|---|---|
| What it is | Durable JSX workflow orchestrator (SQLite checkpoints, resume, approval gates) | Agent-facing skill for tmux session management + push notifications via the Moshi iOS app |
| Chad problem it hits | LLM stalls mid-loop, duplicate spawns, lost work on crash (chad-self-improve v1 postmortem; chad-experiment-cron header) | Operator visibility — "ledger without artifacts", nohup black boxes, no notification when long work finishes |
| Layer | Inside the loop: control flow | Outside the loop: human ↔ agent interface |
| Verdict | Adopt incrementally as the orchestration backbone, starting host-side | Adopt the notification path now; tmux path host-side only; do **not** grant host-setup capabilities to the pod |

They are complements, not competitors. Smithers makes Chad's multi-step
work durable; Moshi makes it observable from tantodefi's phone (which
already runs the Moshi app against the Mac mini — see S142–S144).

## 1. What each project actually is

### Smithers (smithers.sh)

Workflows are JSX trees (`Workflow / Task / Sequence / Parallel / Branch /
Loop / Approval`) evaluated in a render loop: each pass finds ready tasks,
runs them through pluggable agents, validates outputs against Zod schemas,
and persists to `smithers.db` (SQLite) immediately. A crash resumes from
the last completed task. Key mechanics:

- **Agents are pluggable per task** — AnthropicAgent, OpenAIAgent,
  ClaudeCodeAgent. Different tasks in one workflow can use different
  models *and different tool grants* (analyst read-only, implementer
  write/bash, reviewer read/grep).
- **`Approval`** is a first-class human-in-the-loop gate.
- **Side effects** must be marked `sideEffect: true` with
  `ctx.idempotencyKey` — retries can't double-execute.
- **CLI**: `init, up, ps, inspect, logs, approve, graph, fork
  (time-travel replay), resume`.
- **Requirements**: Bun, TypeScript/JSX, SQLite. Network off by default
  per task; 60s default timeouts; 200KB output caps.
- **Gotchas**: task IDs must be data-derived (unstable IDs break resume);
  input immutable after first run unless `--hot`; frame-based, not
  streaming; wrong tool for single prompt-response jobs.

### Moshi skill (getmoshi.app/skill)

Moshi is the mosh/tmux iOS client tantodefi already uses to reach the Mac
mini over Tailscale. The skill (`npx skills add rjyo/moshi-skill`) is
agent-first documentation that teaches an agent to:

- **Host setup/validation**: `moshi-hook host setup` (Easy Pair),
  mosh-server checks, UDP 60000–61000 firewall validation. *Security
  relevant: generates/installs SSH keys, touches firewall config.*
- **tmux management**: private-socket sessions (no collision with the
  user's tmux), standard session names (`claude-py`-style), detach-safe
  patterns, **`capture-pane` inspection instead of attaching** — the
  agent can read any pane on sockets it can reach.
- **Notifications**: pair with the moshi-hook daemon via token; emit
  push notifications to the user's iPhone when long-running work
  completes.

## 2. What Chad has today, and where it hurts

Chad already *converged on* the Smithers philosophy the hard way:
deterministic control flow outside the LLM, single-turn no-tools LLM
calls inside (the chad-drafter contract). Evidence in the tree:

- `chad-experiment-cron` — replaced an 8-phase agent prompt that Nemotron
  "could not drive reliably… stalls mid-loop". Now a Python phase machine
  with flock lock, budget gate, and per-phase failure isolation.
- `chad-self-improve` — v1's multi-turn researcher sub-agent hit idle
  timeouts, broke the JSON contract, and double-spawned (4 spawns / 90k
  tokens on 2026-06-08). v2: deterministic + one single-turn call +
  flock + daily dedupe.
- `chad-spawn` / `chad-spawn-poll` — hand-rolled async ledger
  (`queue/tasks.jsonl`) with a reconciliation cron, i.e. a bespoke
  durable-task table.
- `chad-workflow-batch` — matrix runner writing its own `jobs.jsonl`
  manifest so a scorer can run in a separate pass.
- `chad-proposal-apply` → `chad-action-gate` — a hand-rolled Approval
  gate.

So the gap is not philosophy — it's that every wrapper re-implements
persistence, locking, dedupe, resume, and gating **separately**, with no
shared inspector. When a nightly run produces "ledger entries without
artifacts" there is no `inspect`/`logs`/`graph` to show which step
stalled. That is precisely the machinery Smithers ships.

The second gap is the operator side: long work goes through nohup detach
(cron-wrapper rule, because embedded Nemotron is slow), which makes it
invisible. Nothing pushes a notification when an experiment night
finishes, a backfill completes, a spawn fails, or the tunnel watchdog
fires. The experiment-night success criterion exists *because* the
operator couldn't see what ran.

## 3. What gets unlocked

### Smithers unlocks

1. **Crash-resumable nights.** A pod restart or LLM stall mid-experiment
   resumes from the last completed task instead of producing a
   half-written ledger. `smithers inspect`/`logs` answers "which step
   stalled" directly — the current #1 diagnostic blind spot.
2. **Structural de-duplication.** `sideEffect` + idempotency keys replace
   per-wrapper flock/daily-dedupe code. The 2026-06-08 quadruple-spawn
   class of bug becomes impossible by construction.
3. **The autonomy ladder as code.** The roadmap (Chad earns autonomous
   reply capability per operator) maps 1:1 to `Approval` nodes: the email
   pipeline is `triage → draft → <Approval/> → send`, and granting
   autonomy = removing/conditioning one gate per operator. Every
   autonomous decision is in SQLite with `fork` replay for audit.
4. **Per-task model routing.** `chad-premium` already exists; Smithers
   makes "evaluate with premium model, observe with embedded Nemotron"
   a per-`Task` agent assignment instead of wrapper plumbing.
5. **Matrix runs that survive.** `chad-workflow-batch` (fixture × variant
   × model × sample) is a textbook `Parallel` tree; long matrix runs
   become resumable and the scorer reads SQLite instead of a jsonl
   convention.

### Moshi unlocks

1. **Closing the visibility loop.** moshi-hook push notifications to
   tantodefi's iPhone when: nightly experiments finish (with artifact
   count — directly serving the success criterion), spawns
   complete/fail, backups fail, the tunnel watchdog kickstarts. The
   operator already has the app paired with this exact host.
2. **Attachable long work.** Host-side long jobs in named private-socket
   tmux sessions instead of nohup: from a phone, open Moshi → attach →
   watch or intervene live, mid-vacation (the S141 use case).
3. **Resilient mobile ops.** mosh's UDP roaming is inherently more
   tolerant than the SSH paths that have repeatedly wedged half-open;
   the skill's pre-connection diagnostics reduce failed-connect noise.

### What stays locked (limits to be honest about)

- Smithers does not make Nemotron better at multi-step tool use. Tasks
  must keep the single-turn, no-tools contract; Smithers replaces the
  *wrapper scaffolding*, not the LLM discipline.
- `/sandbox` is ephemeral (no PVC). `smithers.db` in the pod must live
  under the backed-up state path and be added to the backup manifest, or
  resume guarantees are void on pod recreation.
- Anthropic *API* is 402 (no credits) — but the `claude` *CLI*
  (`ClaudeCodeAgent`) authenticates via the Max subscription, not API credits,
  so the capable tier is free. The cheap tier defaults to NVIDIA's *hosted*
  Nemotron-120B. See §"Agent backends" below and
  `scripts/chad-smithers/agents.js`.

### Agent backends (verified + built 2026-06-13)

`scripts/chad-smithers/agents.js` is the single router; `pickAgent(role)`
routes by tier with runtime auto-detection so workflows never name a model:

- **cheap** (classify/draft/observe/report) → hosted Nemotron-120B via chad-shim
  if `NVIDIA_API_KEY` present (free, frugal tokens) → `claude` CLI → local gemma.
- **capable** (evaluate/judge/optimize/implement) → `claudecode` (subscription,
  free, strongest) → `codex` → Nemotron-120B via AI-SDK tool loop → `opencode`
  → local. Override via `CHAD_CAPABLE_BACKEND`.

Findings that revise the plan:
- The "free Nemotron" is NVIDIA's frontier **hosted Nemotron 3 Super 120B**
  (`integrate.api.nvidia.com`, `NVIDIA_API_KEY`); chad-shim :8901 is just its
  OpenAI-compatible proxy. Only `google/gemma-3-4b` (lmstudio) is truly local.
- The "Nemotron can't drive tool loops" lore was an **openclaw harness**
  round-trip bug; Smithers runs its own AI-SDK tool loop, so the 120B is a
  legitimate capable-tier candidate — seeded as a live experiment candidate
  rather than assumed either way.
- `opencode` IS installed on the host (the 500k-ctx / 200-req-hr path is real),
  but Smithers ships no `OpenCodeAgent`; the backend throws a clear TODO pending
  the model id ("big pickle") and opencode's serve/run invocation.

## 3b. Replacement inventory: custom orchestration vs Smithers

Scan of `scripts/chad-cron-wrappers/` + `.github/skills/chad-orchestrator/`
(2026-06-12), ranked by how much hand-rolled machinery Smithers retires:

| Rank | Component | Lines | What it re-implements | Disposition |
|---|---|---|---|---|
| 1 | chad-spawn stack (spawn.sh, spawn-poll, spawn-gc, spawn-status, spawn-gha, poll-watchdog) | ~1,300 | Durable task queue: jsonl ledger, state transitions, reconciliation cron, GC, watchdog-watching-the-poller | Replace with Smithers task table + resume; keep chad-spawn-gha dispatch as a `sideEffect` task |
| 2 | chad-proposal-apply + chad-action-gate | 638 | Approval gate via prepended-markdown sections parsed by "first match wins" regex (a DB query re-implemented in markdown, coordinated across 3 scripts) | Replace flow with `Approval` + Zod outputs; keep gate's allowed-action security semantics as domain logic |
| 3 | flock / daily-dedupe / `--detach` boilerplate (chad-self-improve ×17 hits, chad-experiment-cron, others) | ~recurring tax | Run-once semantics, overlap locks, detach re-exec — each built reactively (e.g. post-2026-06-08 duplicate spawns) | Replace with run identity + idempotency keys |
| 4 | chad-workflow-batch | 367 | `Parallel` matrix with jobs.jsonl manifest, bounded concurrency, per-cell failure isolation | Phase 3 pilot; keep chad-workflow-score |
| — | chad-drafter, chad-premium-client | 562 | Nothing — single-turn LLM contract | Keep: becomes the agent adapter tasks call |
| — | Budget gate / task-profiles | — | Nothing — domain policy | Keep: gate function at workflow start |
| — | Single-shot crons (gbrain dream/prune, memory-curator, mail-check/send, backups, log-event, auth-context) | — | Nothing — linear, no multi-step state | Keep: Smithers is pure overhead here |

Net: ~2,500–3,000 lines of scaffolding across three uncoordinated
persistence conventions (jsonl ledger, prepended-markdown sections,
per-script flocks), each of which has already produced an incident
class (duplicate spawns; stalled-night blindness) that the replacement
prevents by construction.

## 4. Security boundaries (Moshi)

Carrying forward the 2026-06-11 review: the skill's full capability set
is a real escalation if granted to the pod.

- **capture-pane** reads any pane on reachable sockets → an agent with
  host tmux access could observe the openshell TUI / policy-gated
  surfaces. Mitigation: Chad never gets bare `tmux` on the host. The pod
  has no tmux today; if added, only via a wrapper pinned to a private
  socket path (`tmux -S /sandbox/.openclaw-data/tmux/chad.sock`), and
  the L7 preset lists the wrapper + `readlink -f` of the tmux binary
  (symlink rule).
- **moshi-hook host setup** writes SSH keys and validates/changes
  firewall posture → host-side, human-run, once. Never exposed to the
  pod. The pod gets at most a notify-only bridge (below), not the
  moshi-hook binary.
- **Daemon pairing tokens** are credentials → store in host
  credentials.json, never inside /sandbox.

Smithers' security posture is additive in our favor: per-task tool
grants, network off by default, output caps — stricter than the current
"wrapper runs whatever it runs" model.

## 5. Integration plan

### Phase 1 — Moshi notifications + approval (DONE 2026-06-13, host-side)

REVISED after inspecting the real `moshi-hook` CLI: there is **no
`notify`/`push`/`send` command** — and thus no `chad-notify-bridge` as
originally sketched. Push only flows through **agent lifecycle hooks**.
The host is already paired (`moshi-hook status` → `paired: true`,
`Rs-Mac-mini`, keychain secret store).

What was done:
1. `moshi-hook install --target claude` — wrote handlers into the global
   `~/.claude/settings.json` that pipe Claude Code hook JSON to
   `moshi-hook claude-hook` for SessionStart / UserPromptSubmit / Stop /
   PermissionRequest / PostToolUse[AskUserQuestion]. Status flipped
   `stale → current`. (`npx skills add rjyo/moshi-skill` is the optional
   agent-guidance skill, separate from the hook daemon — not required for
   notifications.)
2. Result: because the Smithers capable tier runs via the `claude` CLI,
   **experiment-run completion now notifies the phone (Stop)** and
   **approval gates route to the phone (PermissionRequest)** — Phase 1 and
   the Phase-5 approval mechanism, both via configuration.
3. Router split wired in `scripts/chad-smithers/agents.js`: `claudecode`
   agents default to `dangerouslySkipPermissions` (autonomous runs notify
   but never block on a phone tap); `pickAgent(role,{approvalRouting:true})`
   keeps permissions on for the autonomy ladder.

Revert: `moshi-hook uninstall`. Caveat: this changed the operator's
**global** Claude settings, so this and all host `claude` sessions now
notify the phone — intended, but worth knowing.

Not yet covered (Phase 2 follow-up): **pod-side** events (gbrain dream,
spawns) don't run through host `claude`. Bridging them needs the
`claude-hook` stdin schema captured (no generic-emit verb exists); the
socket is `~/Library/Application Support/Moshi/moshi-hook.sock`.

### Phase 2 — Moshi tmux for host-side long work

1. Adopt the skill's private-socket + named-session conventions for
   host-side long jobs (webui-ingest, backfills, deploys): a `chad-tmux`
   helper wrapping `tmux -A -S <private socket>`.
2. Operator playbook: attach from iPhone via Moshi to any
   `chad-*` session.
3. Pod stays nohup-based for now (no tmux in image). Revisit adding
   tmux to the pod image only if Phase 1+2 prove the pattern; gate via
   the wrapper+L7 design in §4.

### Phase 3 — Smithers pilot (host-side, lowest-risk workload)

Pilot on the Mac mini (bun already installed), **not** in the pod, and
on the workload where resume pays most and side effects are nil:
`chad-workflow-batch`.

1. `smithers init` in a new `scripts/chad-smithers/` workspace;
   `smithers.db` lives under `~/.nemoclaw/` (host, backed up).
2. Agent adapter: OpenAIAgent → chad-shim :8901 (same endpoint the
   batch runner's sub-agent Chads use). Add a premium-model agent via
   chad-premium-client for evaluate-class tasks.
3. Port the batch matrix to a `Parallel` tree: one `Task` per
   (fixture × variant × model × sample) cell, **IDs derived from the
   cell tuple** (the resume-stability rule), outputs Zod-validated into
   the same JSON shape `chad-workflow-score` already consumes.
4. Acceptance: kill -9 mid-matrix → `smithers resume` completes without
   re-running finished cells; `inspect` localizes any stalled cell.

### Phase 4 — Nightly experiments on Smithers

Port `chad-experiment-cron`'s phase machine to a `Sequence`:
`budget-gate → observe (Parallel per experiment) → evaluate (premium
agent, Branch on verdict) → design (sideEffect, idempotency key =
date+operator) → report (emits the Phase-1 notification)`. Keep the
existing budget/profile logic as a plain function task. The cron line
becomes `smithers up nightly.tsx` — still one-line, still honoring the
cron-wrapper rule (Smithers itself is the detached driver).

### Phase 4b — Smithers UI / OpenWebUI surfacing

Smithers ships observability infrastructure beyond the CLI: a **Smithers
UI** for visual run state and a **Gateway** (HTTP server, MCP endpoint,
OpenTelemetry export, typed `SmithersEvent` stream) intended for
custom UIs (per smithers.sh/llms.txt). Smithers and OpenWebUI artifacts
are not substitutes: artifacts are the *product* of an experiment night
(the operator-facing success criterion, unchanged); Smithers is the
*execution record* — persisted every frame regardless of whether the
LLM cooperates, which is exactly what the "ledger without artifacts"
failure mode lacks today (a stalled run currently leaves silence on
both surfaces).

OpenWebUI has no native slot for embedding an external app, so:

1. **Side-by-side (do first):** serve the Smithers UI on the Mac mini,
   exposed via the existing Cloudflare tunnel as e.g.
   `runs.supachad.com` behind the same Cloudflare Access policy.
   Engineering surface for tantodefi; one tunnel config entry.
2. **Run-report artifact (part of the Phase 4 port):** post-run task
   reads `smithers.db`/gateway and writes a "Night of <date>" note into
   OpenWebUI — tasks run, verdicts, artifacts created (with links),
   anything stalled. Makes the execution record itself operator-visible
   even on failed nights.
3. **OpenWebUI Tool → gateway (later):** small tool so "what happened
   last night?" in chat queries live run state over the gateway
   HTTP/MCP API.

### Phase 5 — The autonomy ladder

Rebuild the email pipeline (`chad-email-check-cron → chad-drafter →
chad-autosend-replies`) as one workflow with a per-operator `Approval`
node, backed by the existing chad-action-gate semantics. Autonomy grants
from the roadmap become explicit, auditable workflow edits: replace
`<Approval/>` with a `Branch` on operator ∈ admin-allowlist. `fork`
replay gives the audit trail the trust boundary deserves.

Run in shadow mode (Smithers drafts, legacy path still sends) for ≥1
week before cutover.

### Example templates worth forking (smithersai/smithers `examples/`)

Reviewed 2026-06-12 (~100 examples). Direct fits, by phase:

- **`calendar-negotiator-with-approval.jsx`** → Phase 5 template:
  parse request → Parallel(availability, policy) → rank → draft →
  Approval → idempotent calendar+email writes. Matches the email loop,
  the OpenWebUI native-calendar target, and the tjcooke scheduling use
  case simultaneously.
- **`lead-router-with-approval.jsx`** (also `social-inbox-router`,
  `financial-inbox-guard`) → email triage shape; its
  `needsApproval: boolean` verdict field is how the per-operator
  autonomy ladder is expressed.
- **`prompt-optimizer-harness.jsx`** → Phase 3+: generate → evaluate →
  optimize → Loop. Implements the "prompt variants" mechanism
  chad-workflow-batch stubbed but never built; closes the drafter
  self-improvement loop with fixture-scored evidence.
- **`runbook-executor.jsx`** → classify steps safe/risky, auto-run safe,
  Approval on risky — action-gate philosophy applied to the cold-start
  and ops runbooks in docs/operations/.
- **`alert-suppressor.jsx`** → the missing half of the Phase 1 notify
  bridge: dedupe + expiring noise rules so moshi-hook pushes only
  novel/high-risk events (the tunnel watchdog would otherwise spam).
- **`log-digest.jsx` / `error-clusterer.jsx`** → the recurring manual
  cron-log audit sessions as a scheduled workflow emitting an
  OpenWebUI note.
- Tier 3, grab when porting: `triage.jsx`/`service-desk-dispatcher.jsx`
  (issue triage), `memory-support-agent.jsx` (recall→respond→persist
  with per-user isolation; gbrain + fail-closed operator scoping),
  `adaptive-rag-citation-loop.jsx` (fitness RAG),
  `supervisor.jsx`/`ralph-loop.jsx`, `retry-budget-manager.jsx`.

**Full census (all 97 examples, 2026-06-12):** ~25 map onto existing
Chad subsystems, ~10 are sensible new capabilities, ~30 fit NemoClaw
*development* (maintainer/CI workflows — promotable later as chad-spawn
GHA kinds; `repo-janitor` and `changelog` first), ~25 don't apply
(sales/finance/enterprise-compliance). Additions beyond the list above:

- `mcp-health-probe.jsx` — scheduled probe of gbrain/webui MCP
  surfaces; would have caught the silent three-layer gbrain embed
  failure (config clobber → missing wrapper → model EOL 410) that
  instead waited for a manual audit.
- `fail-only-report.jsx` — green runs quiet, agent only on failure;
  the token-frugal report shape most cron wrappers should adopt.
- `command-watchdog.jsx` — the recurring manual cron-health audits as
  a scheduled escalate-on-notable-change workflow.
- `friday-bot.jsx` — operator-facing weekly digest note from daily
  memory + budget audit signal.
- `trace-explainer.jsx` — token/time/failure attribution over
  smithers.db runs (automated duplicate-spawn-incident forensics).
- `support-deflector.jsx` — classify → retrieve → draft → escalate
  only on risk: the autonomy-roadmap reply pattern itself.
- `trust-safety-moderator.jsx` — repurposed as a moderation gate on
  Chad's own outbound autonomous replies; a safety layer the autonomy
  ladder currently lacks entirely.
- `meeting-briefer.jsx` — calendar trigger → fitness-RAG context →
  pre-session client brief for tjcooke; most operator-delightful new
  feature in the folder.
- `debate.jsx`/`panel.jsx` — adversarial review of self-improve
  proposals before the action gate.
- Component-level: `gate.jsx` (spawn-poll's polling), `fan-out-fan-in`
  (batch matrix), `kanban` (tasks.jsonl queue), `classifier-switchboard`
  (chad-route-prompt), `schema-conformance-gate` (drafter output
  contract enforced structurally), `canary-judge`/`smoketest`
  (chad-deploy --verify), `etl` (webui-ingest), `audit`
  (memory-curator).

Adapter notes from the example source: they use Vercel AI SDK agents
(`ToolLoopAgent` from `ai` + `@ai-sdk/anthropic`); Chad swaps in
`@ai-sdk/openai-compatible` → chad-shim :8901. `ToolLoopAgent` assumes
a model that can drive multi-step tool loops — Nemotron's documented
weakness — so ports keep the workflow *shape* but decompose tool-loops
into single-turn tasks for the embedded model, reserving real tool
loops for the premium agent.

### Decision points to settle before Phase 3

- **Pod vs host for Smithers long-term.** Pod has bun, but /sandbox is
  ephemeral and L7 allowlisting of bun + workflow files is real work.
  Recommendation: host-side until Phase 4 is stable, then decide.
- **One orchestrator or two.** Phases 3–5 leave Python wrappers and
  Smithers coexisting. Acceptable during migration; set a sunset
  criterion (e.g., a wrapper is deleted when its Smithers port survives
  two clean weeks).
- **Bun supply chain.** Smithers + deps enter the trust boundary that
  CSO scans cover; add `scripts/chad-smithers/` to the audit scope.

## 6. Effort estimate

| Phase | Size | Risk |
|---|---|---|
| 1 Moshi notify | ~1 day | Low — additive, host-side |
| 2 Moshi tmux (host) | ~½ day | Low |
| 3 Smithers batch pilot | 2–3 days | Low — no side effects |
| 4 Experiments port | 2–3 days | Medium — side effects, budget logic |
| 5 Email/autonomy | 3–5 days + shadow week | High — outward-facing sends |
