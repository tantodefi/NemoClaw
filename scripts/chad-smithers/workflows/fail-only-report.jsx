/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// fail-only-report.jsx — run a set of Chad health commands and only spend an LLM
// turn when something failed/regressed. Green runs stay cheap and silent; red
// runs get a root-cause summary. Adapted from the Smithers fail-only-report
// example to Chad's router.
//
// The token-frugal reporting shape most Chad crons should adopt: deterministic
// command runs (compute) → notable-event gate → agent only on red.
//
// STATUS: scaffold — graph-validated; tune the command set + sink before cron.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execSync } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";

const DB = process.env.CHAD_FAILREPORT_DB || "./fail-only.db";
const POD = process.env.CHAD_POD_SSH || "openshell-chad";

// Health commands: nonzero exit OR a matching red-pattern = notable.
const CHECKS = [
  { name: "gbrain-coverage", cmd: `ssh -n -o ConnectTimeout=15 ${POD} 'gbrain get-health 2>&1 | head -c 300'`, red: /0%|error|unhealthy/i },
  { name: "cron-errors-today", cmd: `ssh -n -o ConnectTimeout=15 ${POD} 'grep -ric error /sandbox/.openclaw/workspace/memory/events-$(date -u +%Y-%m-%d).jsonl 2>/dev/null || echo 0'`, red: /^[1-9]/ },
];

const schemas = {
  runs: z.object({ results: z.string(), notableCount: z.number() }), // results = JSON array
  report: z.object({ reported: z.boolean(), summary: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Branch, outputs } = api;

function runChecks() {
  return CHECKS.map((c) => {
    let exitCode = 0, out = "";
    try { out = execSync(c.cmd, { encoding: "utf8" }).trim(); }
    catch (e) { exitCode = e.status ?? 1; out = String(e.stdout || e.message || "").trim(); }
    const notable = exitCode !== 0 || (c.red && c.red.test(out));
    return { name: c.name, exitCode, out: out.slice(0, 400), notable };
  });
}

export const workflow = smithers((ctx) => {
  const runs = (ctx.outputs.runs ?? [])[0];
  const notable = runs ? JSON.parse(runs.results).filter((r) => r.notable) : [];
  return (
    <Workflow name="chad-fail-only-report">
      <Sequence>
        <Task id="runs" output={outputs.runs}>
          {() => {
            const results = runChecks();
            return { results: JSON.stringify(results), notableCount: results.filter((r) => r.notable).length };
          }}
        </Task>

        {/* Only invoke the agent when there's something red — green stays silent. */}
        <Branch if={(runs?.notableCount ?? 0) > 0}>
          <Task id="report" output={outputs.report} agent={pickAgent("summarize")} fallbackAgent={pickFallback("summarize")} {...taskOpts("summarize")}>
            {[
              "Chad health check found notable results. Give a one-paragraph root-cause summary and the single next command to run.",
              `Notable results (JSON): ${JSON.stringify(notable)}`,
              "Return JSON { reported: true, summary: string }.",
            ].join("\n\n")}
          </Task>
        </Branch>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
