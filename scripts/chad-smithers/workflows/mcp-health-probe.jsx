/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// mcp-health-probe.jsx — periodic health probe of Chad's MCP/inference surfaces,
// escalating ONLY on a material change. Adapted from the Smithers
// mcp-health-probe example to Chad's router + real endpoints.
//
// Motivation: the gbrain embed pipeline failed silently across three layers
// (config clobber → missing wrapper → model EOL 410) and only a manual audit
// caught it. This workflow turns that audit into a scheduled check that pages
// only when something actually changed.
//
// Pipeline: probe (compute; gather signals) → check (cheap agent; material
// change vs last snapshot?) → report (compute; write note + snapshot only if
// material). Snapshot persists to state/mcp-health-last.json so quiet runs stay
// quiet (the fail-only discipline).
//
// STATUS: scaffold — graph-validated; needs a live smoke pass + the snapshot
// diff wired before cron scheduling.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";

const DB = process.env.CHAD_HEALTH_DB || "./mcp-health.db";
const SNAPSHOT = process.env.CHAD_HEALTH_SNAPSHOT || "./state/mcp-health-last.json";
const POD = process.env.CHAD_POD_SSH || "openshell-chad";

const schemas = {
  probe: z.object({
    signals: z.string(),          // JSON-encoded array of {server,healthy,detail}
    healthyCount: z.number(),
    unhealthyCount: z.number(),
  }),
  check: z.object({
    materialChange: z.boolean(),
    unhealthy: z.array(z.string()),
    summary: z.string(),
  }),
  report: z.object({ reported: z.boolean(), summary: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

// Deterministic signal gathering — never let one probe failure abort the run.
function gatherSignals() {
  const sig = [];
  const tryProbe = (server, fn) => {
    try { sig.push({ server, healthy: true, detail: fn() }); }
    catch (e) { sig.push({ server, healthy: false, detail: String(e.message || e).slice(0, 200) }); }
  };
  // gbrain health (pod). Unhealthy or 0% coverage = the silent-failure signal.
  tryProbe("gbrain", () =>
    execSync(`ssh -n -o ConnectTimeout=15 ${POD} 'gbrain get-health 2>&1 | head -c 400'`, { encoding: "utf8" }).trim());
  // NVIDIA inference reachability (host has the key + egress).
  tryProbe("nvidia-nim", () =>
    execSync(`curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://integrate.api.nvidia.com/v1/models -H "Authorization: Bearer $NVIDIA_API_KEY"`, { encoding: "utf8" }).trim());
  // chad-shim liveness (pod 8901).
  tryProbe("chad-shim", () =>
    execSync(`ssh -n -o ConnectTimeout=15 ${POD} 'curl -sS -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:8901/v1/models'`, { encoding: "utf8" }).trim());
  return sig;
}

function loadSnapshot() {
  return existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : { unhealthy: [] };
}

export const workflow = smithers((ctx) => {
  const priorCheck = ctx.outputs.check ?? [];
  return (
    <Workflow name="chad-mcp-health-probe">
      <Sequence>
        <Task id="probe" output={outputs.probe}>
          {() => {
            const signals = gatherSignals();
            return {
              signals: JSON.stringify(signals),
              healthyCount: signals.filter((s) => s.healthy).length,
              unhealthyCount: signals.filter((s) => !s.healthy).length,
            };
          }}
        </Task>

        {/* Cheap agent decides "material change vs last snapshot" — fail-only. */}
        <Task id="check" output={outputs.check} agent={pickAgent("classify")} fallbackAgent={pickFallback("classify")} {...taskOpts("classify")}>
          {[
            "You are the change detector for Chad's MCP/inference health probe.",
            `Current signals (JSON): ${JSON.stringify((ctx.outputs.probe ?? [])[0]?.signals ?? "[]")}`,
            `Last known unhealthy set: ${JSON.stringify(loadSnapshot().unhealthy)}`,
            "Return JSON { materialChange (bool), unhealthy (string[] of unhealthy server names), summary (one sentence) }.",
            "materialChange = true ONLY if the unhealthy set differs from last known, or any HTTP code is not 200, or gbrain reports 0% / error.",
          ].join("\n\n")}
        </Task>

        <Task id="report" output={outputs.report}>
          {() => {
            const c = priorCheck[priorCheck.length - 1] ?? { materialChange: false, unhealthy: [], summary: "no change" };
            if (c.materialChange) {
              mkdirSync(dirname(SNAPSHOT), { recursive: true });
              writeFileSync(SNAPSHOT, JSON.stringify({ unhealthy: c.unhealthy, at: new Date().toISOString() }, null, 2));
            }
            // Quiet runs stay quiet; only material changes get reported/posted by the wrapper.
            return { reported: Boolean(c.materialChange), summary: c.summary };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
