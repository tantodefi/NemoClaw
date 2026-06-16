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
  Tabs: Runs (live + history, task tree, event log, agent trace, diff), Workflows
  (edit `.jsx` w/ syntax highlighting, visual DAG, launch), Approvals, Experiments.
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

## Smithers docs (for agents)

- `smithers docs` → prints the concise `llms.txt` for the installed version.
- `smithers docs-full` → the full `llms-full.txt` doc bundle.
- `smithers <command> --help` for any command.
- Upstream: smithers.sh (introduction, JSX surface, components, recipes).

## Design + status

Full design, decisions, and the next-steps/TODO list:
`docs/design/smithers-moshi-integration.md`. Operator runbook:
`docs/operations/chad-experiments.md`.
