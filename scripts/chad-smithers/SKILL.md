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
  Tabs: Runs (live + history, task tree with **per-node token counts** + a
  **"reasoning hidden" badge** so a terse final answer reads as intentional not
  broken, event log, agent trace, diff, fused/report output rendered inline),
  Workflows (**full catalog incl. scaffolds with run counts**; edit `.jsx` w/
  syntax highlighting, visual DAG, **Launch settings drawer**: input JSON +
  reasoning / timeouts / max-output-tokens / backend / dry-run / fusion-panel,
  plus **Re-run ⟳** on a finished run), Approvals, Experiments. Per-launch settings
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

```sh
chad-runs health                      # {ok, dbs}
chad-runs workflows                   # launchable *.jsx
chad-runs runs                        # all runs (live + history), newest first
chad-runs get <runId>                 # run detail: tasks, states, outputs
chad-runs logs <runId> [--limit N]    # event stream (NodeStarted/Finished…)
chad-runs chat <runId>                # agent chat output for the run
chad-runs trace <runId> <node>        # one task's reasoning/tool trace
chad-runs graph <wf>                  # workflow structure (DAG json)
chad-runs cat <wf>                    # read a workflow's source
chad-runs save <wf> <localfile>       # write/replace a workflow's source
chad-runs launch <wf> [--input '<json>']   # run detached; appears live under Runs
chad-runs cancel <runId>
chad-runs fork <runId> [--frame N --reset-node X]   # time-travel branch
chad-runs approve <runId> [--node N --iteration I]  # resolve an autonomy gate
chad-runs deny <runId> [--node N --iteration I]
chad-runs approvals                   # pending gates
chad-runs experiments                 # evolutionary leaderboard + report
```

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
Parse loose model/tool JSON with
`coerceJson(text, schema)` from `../lib/coerce.js` (strips fences/prose, validates
a zod schema, returns null on bad output — drop the row instead of burning retries).

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
