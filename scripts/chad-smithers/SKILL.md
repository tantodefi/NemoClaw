<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
# Smithers skill — Chad's durable workflow IDE

Chad's interface to **Smithers** (durable JSX workflow orchestration) via the
runs IDE at `runs.supachad.com` and the `chad-runs` CLI. This is to Smithers
what the `openwebui` skill is to Open WebUI: how to launch, inspect, edit, and
steer Smithers runs programmatically.

Use this when Chad needs to: run or manage an experiment, launch any workflow,
inspect a run's tasks/logs/agent-chat, approve an autonomy gate, edit a workflow,
fork a run, or check the evolutionary leaderboard.

## The two surfaces

- **Web IDE** (operators): `https://runs.supachad.com` behind Cloudflare Access.
  Seven tabs: **Runs** (live + history, task tree with **per-node token counts** + a
  **"reasoning hidden" badge** so a terse final answer reads as intentional not
  broken, event log, agent trace, diff, fused/report output rendered inline),
  **Workflows** (**full catalog incl. scaffolds with run counts**; edit `.jsx` w/
  syntax highlighting, visual DAG, **Launch settings drawer**: input JSON +
  reasoning / timeouts / max-output-tokens / backend / dry-run / fusion-panel,
  plus **Re-run ⟳** on a finished run), **Approvals** (pending gates + notify-channel
  config), **Chains** (compose workflows into a pipeline; resume/rerun a failed
  step), **Schedules** (launchd timers + live status), **Experiments** (evolutionary
  leaderboard + cost-savings), and **Directives** (operator free-text + DB-signal
  digest + arena fixtures that steer the self-improvement loop). Per-launch settings
  post to `/api/launch` as an **allowlisted** env map (CHAD_*/DRY_RUN only); the
  drawer shows each model's output/context ceiling (`/api/model-limits`) and
  **preflights** settings (`/api/preflight` blocks output > context window, warns +
  clamps over a model's max-output).
- **CLI** (Chad / scripts / cron): `chad-runs` — full API access. Outputs JSON.

## chad-runs — how Chad drives it

Auth + endpoint resolve from `credentials.json` automatically:
- Host-local: hits `http://127.0.0.1:7331` with `SMITHERS_RUNS_API_KEY`.
- Pod: set `CHAD_RUNS_URL=https://runs.supachad.com`; it adds the Cloudflare
  Access service token (`CF_ACCESS_CLIENT_ID/SECRET`) to pass Access + the key.

`chad-runs` mirrors **every** `serve-runs.js` endpoint (run it with no args for
grouped help). Output is JSON — pipe to `jq`.

```sh
# Runs + inspect
chad-runs health                      # {ok, dbs}
chad-runs runs                        # all runs (live + history), newest first
chad-runs get <runId>                 # run detail: tasks, states, outputs, telemetry
chad-runs logs <runId> [--limit N]    # event stream (NodeStarted/Finished…)
chad-runs chat <runId>                # agent chat output for the run
chad-runs trace <runId> <node>        # one task's reasoning/tool trace
chad-runs diff <runId> <node>         # unified diff for a code-editing node

# Lifecycle
chad-runs launch <wf> [--input '<json>'] [--env '<json>']  # detached; appears live
chad-runs preflight <wf> [--env '<json>']  # advisory: is this launch safe? (no run)
chad-runs cancel <runId>
chad-runs resume <runId>              # resume a stalled/crashed run from checkpoint
chad-runs fork <runId> [--frame N --reset-node X]   # time-travel branch

# Autonomy gates
chad-runs approvals                   # pending gates across all DBs
chad-runs approve <runId> [--node N --iteration I]
chad-runs deny <runId> [--node N --iteration I]

# Workflows + catalog
chad-runs workflows                   # launchable *.jsx
chad-runs catalog                     # every workflow + matched DB + run count (incl. 0-run scaffolds)
chad-runs graph <wf>                  # workflow structure (DAG json)
chad-runs cat <wf>                    # read a workflow's source
chad-runs save <wf> <localfile>       # write/replace a workflow's source

# Models + cost
chad-runs models                      # live model roster (catalog ∩ liveness)
chad-runs model-limits                # per-model output/context ceilings
chad-runs model-matrix                # best model per task-kind (performance grid)
chad-runs efficiency                  # tokens by workflow + downgrade savings
chad-runs schedules                   # scheduled jobs (launchd timers) + live status

# Self-improvement loop  →  see "Steering the loop" below
chad-runs experiments                 # evolutionary leaderboard + report
chad-runs signal [--days N]           # review-worthy runs (failed/stale/low-quality)
chad-runs fixtures                    # arena fixture set (static + harvested)
chad-runs directives                  # read the operator directives steering the loop
chad-runs set-directives <file.json>  # write them (Access-gated mutation)

# Approval-notify channels
chad-runs notify-config               # which channels the server pushes gates on
chad-runs set-notify webui,email      # set them (webui,email,telegram,moshi)

# Workflow chaining  →  see "Driving a chain" below
chad-runs chains                      # list chains (live + history)
chad-runs chain <id>                  # one chain's step states
chad-runs chain-create <file.json>    # start a chain: {steps:[{workflow,input,env}], passOutput}
chad-runs chain-again <id>            # re-run the WHOLE chain in place (finished/failed/stalled → from step 0)
chad-runs chain-resume <id>           # continue a FAILED/STALLED chain from the step it stopped on
chad-runs chain-rerun <id> --index N  # re-run from step N (resets N..end)
chad-runs chain-fork <id>             # copy into a NEW chain run (source untouched)
chad-runs chain-cancel <id>           # cancel a running/stalled chain
chad-runs chain-delete <id>           # remove a terminal chain from the list
```
Chain lifecycle at a glance: **again** (whole chain, same record) vs **resume**
(continue the stuck step) vs **fork** (copy → new record) vs **rerun --index N**
(from a chosen step). A chain whose current step's run dies (crashed / killed —
no heartbeat > `CHAD_CHAIN_STALL_MS`, default 30min) is auto-marked **`stalled`**
(not left falsely "running"); `waiting-approval` is never auto-stalled.

### Worked examples

Run an experiment on demand and watch it:
```sh
chad-runs launch experiments.jsx
RID=$(chad-runs runs | jq -r '.runs[0].run_id')
chad-runs logs "$RID" --limit 40
chad-runs get "$RID" | jq '.attempts[] | {node:.node_id, state}'
```

Approve Chad's pending email reply (autonomy ladder):
```sh
chad-runs approvals | jq '.pending[]'
chad-runs approve <runId> --node human-approval --iteration 0
```

Edit + validate + launch a workflow from the CLI:
```sh
chad-runs cat workflows/mcp-health-probe.jsx > /tmp/wf.jsx
#   …edit /tmp/wf.jsx…
chad-runs save workflows/mcp-health-probe.jsx /tmp/wf.jsx
chad-runs graph workflows/mcp-health-probe.jsx     # validate it parses
chad-runs launch workflows/mcp-health-probe.jsx
```

**Steering the self-improvement loop.** Directives are the **global** default
(`state/directives.json`) resolved through `lib/directives.js` and consumed by the
arena (breeding + scoring) and every agent's system prompt. All four fields are
live: `experiments` (free-text steer), `creativity` (low|moderate|high → how boldly
the mutate step explores), `priorities` (task-kinds → scopes which fixtures score),
`systemPrompts.{all,<role>}` (injected into agent calls). `signal` is the
trace-grounded DB scan that feeds the next generation. Read the signal, then steer:
```sh
chad-runs signal --days 7 | jq '{failed:.failedRuns|length, low:.lowScorers|length}'
chad-runs directives > /tmp/d.json
#   …edit /tmp/d.json (experiments/creativity/priorities/systemPrompts)…
chad-runs set-directives /tmp/d.json     # global — lands in the next arena run + agent prompts
```

**Experiment ON the directives (per-run override).** A run can disable the global
set and/or supply its own directives, so you can A/B a directive. Resolution:
`CHAD_DIRECTIVES_OFF=1` ignores the global file; `CHAD_DIRECTIVES_JSON='{…}'` is a
per-run override (merges over global; used alone when global is off). Both ride the
allowlisted launch env (drawer: Workflows → Launch → Directives):
```sh
# breed the arena under a bolder directive for ONE run, without touching the global:
chad-runs launch experiments.jsx --directives '{"creativity":"high","experiments":"try a radically terser voice"}'
# or test a directive in isolation (ignore the global set):
chad-runs launch experiments.jsx --no-global --directives '{"experiments":"…"}'
```

**Driving a chain.** String workflows into a pipeline; each step launches when the
prior reaches `finished`, optionally feeding its output forward (`passOutput`). A
step that pauses at a gate HOLDS the chain until you `approve` it.
```sh
cat > /tmp/chain.json <<'JSON'
{ "passOutput": true, "steps": [
  { "workflow": "issue-triage.jsx" },
  { "workflow": "content-pipeline.jsx" } ] }
JSON
chad-runs chain-create /tmp/chain.json
chad-runs chains | jq '.chains[0] | {id, status, current}'
#   if a step fails:  chad-runs chain-resume <id>   (or chain-rerun <id> --index 0)
```

## Model routing (agents.js)

Workflows never name a model — they call `pickAgent(role)`. The router
auto-detects and routes by tier:
- **cheap** (classify/draft/observe/report): NVIDIA-hosted Nemotron 120B if
  `NVIDIA_API_KEY`, else claude CLI, else local.
- **capable** (evaluate/judge/optimize/implement): claudecode (subscription) →
  codex → **Nemotron 3 Ultra 550B** (reasoning on) → opencode → local.
Override per call: `pickAgent(role, { backend, model, reasoning })`. Force tiers
with `CHAD_CAPABLE_BACKEND` / `CHAD_CHEAP_BACKEND` / `CHAD_REASONING=off`.

**Resilience props** (agents.js): spread `{...taskOpts(role, { continueOnFail })}`
on a `<Task>` for a tier-aware `timeoutMs` + `retries`; add
`fallbackAgent={pickFallback(role)}` so a required task retries on a *different*
backend; use `continueOnFail` on fan-out members (panelists/evals) so one dead
model can't sink the run. Timeouts: `CHAD_TASK_TIMEOUT_MS` (capable, default
10min), `CHAD_TASK_TIMEOUT_MS_CHEAP` (2min). Response length:
`CHAD_MAX_OUTPUT_TOKENS[_CHEAP]` (frugal tier defaults, clamped to the model's
`model-registry.json` ceiling — those defaults are budgets, not model limits).
Agent `<Task output={outputs.x}>` results are parsed + zod-validated by Smithers'
structured-output layer — you do NOT hand-parse a model task's JSON. `coerceJson(text,
schema)` from `../lib/coerce.js` is for **raw subprocess/tool stdout** you read
yourself (e.g. `runSpawn` parsing a `chad-spawn` result.json in `lib/spawn.js`):
it strips fences/prose, validates a zod schema, and returns null on bad output so you
drop the row instead of throwing.

## Writing a workflow (the shape)

```jsx
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";              // MUST be zod v4 (^4.x), not the 3.x /v4 shim
import { pickAgent } from "../agents.js";
const api = createSmithers({ result: z.object({ summary: z.string() }) }, { dbPath: "./my.db" });
const { smithers, Workflow, Task, Sequence, Parallel, outputs } = api;
export default smithers((ctx) => (
  <Workflow name="my-flow">
    <Sequence>
      <Task id="step" output={outputs.result} agent={pickAgent("draft")}>
        {"Prompt text. Return JSON { summary }."}
      </Task>
    </Sequence>
  </Workflow>
));
```
Gotchas that bite: zod **v4** (v3 `/v4` shim throws `toJSONSchema: optional`);
agent-task prompt is a **string child** (not a thunk); read upstream outputs via
`ctx.outputs.<schema>` in render scope (not the `deps` arg); each workflow needs
its **own** `dbPath` (different schemas can't share one DB).

## Workflow catalog

Launchable workflows (all auto-discovered by the runs IDE and `chad-runs
workflows`). Side-effecting ones are **shadow-safe by default** — they log what
they would do unless an explicit env flag is set.

| Workflow | What it does | Make it real |
|---|---|---|
| `experiments.jsx` | Evolutionary drafter-prompt arena (start wide → score → keep) | runs live nightly |
| `fusion.jsx` | One prompt across N models in parallel → structured **judge** (consensus/contradictions/blind-spots/confidence) → **synthesize**. Panel auto-selected from arena champions + featured list; panelists are `continueOnFail`. | `CHAD_FUSION_MODELS`, `CHAD_FUSION_MAX`, `--input '{"prompt":"…"}'` |
| `mcp-health-probe.jsx` | Probe gbrain/webui MCP surfaces, escalate on failure | runs as-is |
| `fail-only-report.jsx` | Quiet on green; report only on failure | runs as-is |
| `email-ladder.jsx` | Autonomy ladder: triage→draft→moderate→Approval→send | `CHAD_EMAIL_SEND=1` + admin allowlist |
| `issue-triage.jsx` | Fetch issues → score → Parallel spawn fixes → report | `CHAD_SPAWN_SSH=openshell-chad` |
| `content-pipeline.jsx` | research→draft→review (spawns) → Approval → publish | `CHAD_CONTENT_PUBLISH=1` |
| `self-improve.jsx` | Cron telemetry → propose tunings → gate → apply | `CHAD_SELFIMPROVE_APPLY=1` + `CHAD_SIGNAL_SSH` |
| `memory-curator.jsx` | Inactivity-gate → snapshot → propose consolidations → Approval | `CHAD_CURATOR_APPLY=1` + `CHAD_MEM_SSH` |
| `log-digest.jsx` | Cluster host service-log errors → note (quiet if clean) | `CHAD_LOGDIGEST_POST=1` |
| `token-optimize.jsx` | "Tokenmaxxing": probe whether a cheaper model matches a task's quality → Approval-gated downgrade; on approval+`APPLY=1` writes the cheaper model into `../task-profiles.json` (snapshot-first, dot-path). Runs nightly (shadow); feeds the Experiments **model × task** matrix. | `state/downgrade-candidates.json`, `CHAD_TOKENOPT_BAR/TOLERANCE`, `CHAD_TOKENOPT_APPLY=1` |
| `bug-report.jsx` | Chad catches his OWN failures (failed runs/nodes across the DBs + host logs) → clusters into distinct bugs → Approval → `gh issue create` (dedups open issues). Shadow unless `CHAD_BUGREPORT_POST=1`. Runs nightly. | `CHAD_BUGREPORT_REPO`, `CHAD_BUGREPORT_POST=1`, `CHAD_BUGREPORT_LABEL` |
| `skill-improve.jsx` | Chad proposes ENHANCEMENTS to his own workflows/skills (robustness/perf/cost/feature/docs) → Approval → files GitHub enhancement issues (never edits source). Shadow unless `CHAD_SKILLIMPROVE_POST=1`. Runs nightly. | `CHAD_SKILLIMPROVE_REPO`, `CHAD_SKILLIMPROVE_POST=1` |
| `code-review-loop.jsx` | Iterate a PR review to convergence with the **`<Loop>`** primitive + EXPLICIT ctx.outputs threading — producer drafts/refines, a distinct judge decides `approved` (drives `until`), repeat until clean or max iters. (NOT the `<ReviewLoop>` composite — it doesn't inject the produced work into the reviewer's prompt; see below.) Read-only `gh pr diff`; draft-only. | `--input '{"repo":"o/r","pr":N}'`, `CHAD_CODEREVIEW_POST=1` |
| `dependency-update.jsx` | Keep deps current via **`<ScanFixVerify>`** — scanner triages `npm outdated` into safe/review/risky, fixer drafts the bump set, verifier sanity-checks. Proposal only; pins the smithers line at review. | `CHAD_DEPUPDATE_APPLY=1`, `CHAD_DEPUPDATE_POST=1` |
| `debate.jsx` | Adversarial reasoning via **`<Debate>`** — two models argue for/against across N rounds, a judge rules. The counterpart to fusion (argue-to-consensus vs parallel-synthesize) for contested calls. | `--input '{"topic":"…"}'`, `CHAD_DEBATE_ROUNDS`, `CHAD_DEBATE_POST=1` |
| `canary-judge.jsx` | Post-deploy verification via **`<Poller>`** — polls a health endpoint (deterministic HTTP check fn) until stably healthy or timeout, then a judge rules promote/hold/rollback. Advisory only. | `--input '{"url":"…/health"}'`, `CHAD_CANARY_POST=1` |
| `changelog.jsx` | Draft a changelog entry from recent git log → Approval → note. A plain Sequence (linear shape; no composite forced). | `CHAD_CHANGELOG_SINCE`, `CHAD_CHANGELOG_POST=1` |
| `pr-shepherd.jsx` | Keep open PRs moving: fetch → **deterministic** per-PR action (`lib/pr.js#prAction`, no LLM) → one cheap-tier digest of "what's blocked on whom". Read-only `gh pr list`; advisory. | `CHAD_PRSHEP_REPO`, `CHAD_PRSHEP_STALE_DAYS`, `CHAD_PRSHEP_POST=1` |
| `coverage-loop.jsx` | Raise test coverage toward a target via **`<Loop>`** — measure (read-only) → draft focused tests → re-measure, until target or max iters. Draft-only unless `APPLY=1` (exits after one pass in shadow). | `CHAD_COVERAGE_CMD/TARGET/DIR`, `CHAD_COVERAGE_APPLY=1` |
| `coding-task.jsx` | Chad (nemotron) orchestrates a coding task, offloading the coding to **opencode big-pickle** (isolated spawn, draft-only): plan → code (spawn) → review (nemotron judge) → `Approval`. Never edits the repo / commits; stubs on a bare host. | `--input '{"task":"…"}'`, `CHAD_CODING_SUBSTRATE=gha`, `CHAD_SPAWN_SSH`, `CHAD_CODING_APPLY=1` |

The composite-based rows (added with the Smithers 0.26 upgrade) lean on Smithers'
**built-in composite components** — `ScanFixVerify`, `Debate`, `Poller`, `Loop` —
imported directly from `smithers-orchestrator` (they are top-level exports, NOT part
of the `createSmithers()` return, which only carries the primitives). **Caveat on
`<ReviewLoop>`:** it hardcodes the reviewer's prompt and only wires the produced work
via `needs`, which is NOT injected into an agent's prompt — so the reviewer never sees
the work ("no work provided") and its `until` is hardcoded false (can't converge on
`approved`). `code-review-loop` therefore uses the raw `<Loop>` with EXPLICIT
`ctx.outputs` threading instead (produced review → judge prompt, prior feedback →
producer prompt) — verified against a live PR. Prefer a composite when the shape
matches (scan-fix/debate/poll/iterate-to-target); hand-roll over `<Loop>` when a
composite can't thread the context you need; use a plain `Sequence` when it doesn't
loop (changelog); and keep routing **deterministic**
where you can (`pr-shepherd`'s `lib/pr.js`, `issue-triage`'s `scoreIssue`) so the model
is spent on the summary, not the decision. Fan-outs (`fusion`, `token-optimize`) cap
concurrency with `<Parallel maxConcurrency={N}>` so a big panel can't hammer the API.

## chad-spawn bridge (lib/spawn.js)

The decision (#24) was **keep both orchestrators and bridge them**, not rebuild
chad-spawn's GHA machinery. `lib/spawn.js` is that bridge — a Smithers workflow
offloads ONE step to the existing chad-spawn substrate and reconciles its
`result.json` as that task's output:

```jsx
import { runSpawn, route, scoreIssue, spawnResultSchema } from "../lib/spawn.js";

<Task id="fix" output={outputs.spawn} sideEffect idempotencyKey={`spawn-${n}`}>
  {() => runSpawn({ kind: "researcher", substrate: "gha", id: `iss-${n}`, task: "…" })}
</Task>
```

`runSpawn` never throws — it always resolves to a `result.json`-shaped object
(`spawnResultSchema`). Transport resolves per call:

- `CHAD_SPAWN_STUB=1` → shadow result, no real spawn (host dry run / tests).
- `CHAD_SPAWN_SSH=<host>` → ssh into the pod and run the real `chad-spawn` there
  (keeps L7 policy + budget + manifest; task streamed in, result streamed back,
  since scp is blocked in the sandbox).
- `chad-spawn` on PATH → exec locally (Smithers running inside the pod).
- none of the above → stub (safe host default; never a hard failure).

`route(body, {default})` is chad-route ported to JS (deterministic keyword
router); `scoreIssue(issue)` is chad-issue-triage's signal score. Both are
unit-tested in `lib/spawn.test.js` (`bun test lib/spawn.test.js`).

## Smithers docs (for agents)

- `smithers docs` → prints the concise `llms.txt` for the installed version.
- `smithers docs-full` → the full `llms-full.txt` doc bundle.
- `smithers <command> --help` for any command.
- Upstream: smithers.sh (introduction, JSX surface, components, recipes).

## Design + status

Full design, decisions, and the next-steps/TODO list:
`docs/design/smithers-moshi-integration.md`. Operator runbook:
`docs/operations/chad-experiments.md`.
