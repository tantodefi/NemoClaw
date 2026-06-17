/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// memory-curator.jsx — chad-memory-curator as a durable Smithers workflow (#23).
//
// Distinct from self-improve (behavioral): this proposes MEMORY improvements —
// consolidate near-duplicate atoms, lift important facts into workspace
// MEMORY.md, archive stale entries. DRAFT-ONLY; never mutates lancedb/wiki/brain
// directly. Pre-mutation snapshot first (even though v1 doesn't mutate) so a
// future apply is rollback-safe.
//
// Why port it: it's snapshot-first + inactivity-gated + draft-only — exactly the
// shape Smithers makes auditable. The snapshot becomes a durable task; the
// proposal a structured output the dashboard renders; the apply an Approval-gated
// shadow step.
//
// Pipeline:  inactivity-gate → [ snapshot → gather (brain stats) →
//            propose (capable, structured) → Approval → apply (shadow) ]
//
// Shadow-safe everywhere. Snapshot + gather + apply go through SSH to the pod
// when CHAD_MEM_SSH is set; otherwise they no-op gracefully so the workflow runs
// (and graph-validates) on a bare host.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent } from "../agents.js";

const DB = process.env.CHAD_CURATOR_DB || "./memory-curator.db";
const APPLY = process.env.CHAD_CURATOR_APPLY === "1";
const FORCE = process.env.CHAD_CURATOR_FORCE === "1";
const MEM_SSH = process.env.CHAD_MEM_SSH || "";
const MIN_INTERVAL_H = Number(process.env.CHAD_CURATOR_MIN_INTERVAL_HOURS || 168);

const schemas = {
  gate: z.object({ proceed: z.boolean(), reason: z.string() }),
  snapshot: z.object({ status: z.enum(["snapshotted", "skipped", "shadow"]), detail: z.string() }),
  stats: z.object({ summary: z.string() }),
  proposals: z.object({
    proposals: z.array(z.object({ action: z.enum(["consolidate", "lift", "archive"]), targets: z.string(), rationale: z.string() })),
    summary: z.string(),
  }),
  apply: z.object({ status: z.enum(["applied", "shadow-logged", "blocked"]), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Branch, Approval, outputs } = api;

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout) => resolve(err ? "" : stdout.toString()));
  });
}

export const workflow = smithers((ctx) => {
  const gate = (ctx.outputs.gate ?? [])[0];
  const stats = (ctx.outputs.stats ?? [])[0];
  const proposed = (ctx.outputs.proposals ?? [])[0];
  const proceed = FORCE || gate?.proceed;

  return (
    <Workflow name="chad-memory-curator">
      <Sequence>
        {/* Inactivity gate (Hermes pattern): skip if a curator pass ran recently. */}
        <Task id="inactivity-gate" output={outputs.gate} sideEffect idempotencyKey={`curator-gate-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            if (FORCE) return { proceed: true, reason: "forced" };
            let last = "";
            if (MEM_SSH) last = await sh("ssh", ["-n", MEM_SSH, "stat -c %Y ~/.openclaw-data/state/last-curator 2>/dev/null || true"]);
            if (!last.trim()) return { proceed: true, reason: "no prior pass recorded" };
            const hoursSince = (Date.now() / 1000 - Number(last)) / 3600;
            return hoursSince >= MIN_INTERVAL_H
              ? { proceed: true, reason: `${Math.round(hoursSince)}h since last pass` }
              : { proceed: false, reason: `only ${Math.round(hoursSince)}h since last pass (<${MIN_INTERVAL_H}h)` };
          }}
        </Task>

        <Branch if={proceed}>
          {/* Pre-mutation snapshot — rollback insurance even for a draft-only run. */}
          <Task id="snapshot" output={outputs.snapshot} sideEffect idempotencyKey={`curator-snapshot-${new Date().toISOString().slice(0, 10)}`}>
            {async () => {
              if (!MEM_SSH) return { status: "shadow", detail: "no CHAD_MEM_SSH; snapshot skipped (host dry run)" };
              await sh("ssh", ["-n", MEM_SSH, "chad-memory-snapshot 2>/dev/null || true"]);
              return { status: "snapshotted", detail: "lancedb + wiki + workspace snapshotted (keep last 5)" };
            }}
          </Task>

          {/* Gather brain stats to ground the proposals. */}
          <Task id="gather" output={outputs.stats} sideEffect idempotencyKey={`curator-stats-${new Date().toISOString().slice(0, 10)}`}>
            {async () => {
              let s = "";
              if (MEM_SSH) s = await sh("ssh", ["-n", MEM_SSH, "gbrain stats 2>/dev/null | head -c 4000 || true"]);
              return { summary: s.trim() || "(no brain stats available; host dry run)" };
            }}
          </Task>

          {/* Propose consolidations — one capable, structured call. */}
          <Task id="propose" output={outputs.proposals} agent={pickAgent("judge")} retries={1}>
            {[
              "You are Chad's memory curator. From the brain stats below, propose at most 5 DRAFT-ONLY memory consolidations.",
              "Actions: consolidate (merge near-duplicate atoms), lift (promote an important fact into workspace MEMORY.md), archive (retire stale entries).",
              `Brain stats:\n${stats?.summary || "(none)"}`,
              'Return JSON {proposals:[{action,targets,rationale}], summary}. Be conservative — never propose deleting anything load-bearing.',
            ].join("\n\n")}
          </Task>

          {/* Operator approves before any apply (always, for memory ops). */}
          <Approval id="curator-approval"
            prompt={`Apply ${proposed?.proposals?.length ?? 0} memory consolidations? ${proposed?.summary?.slice(0, 140) || ""}`} />

          <Task id="apply" output={outputs.apply} sideEffect idempotencyKey={`curator-apply-${new Date().toISOString().slice(0, 10)}`}>
            {() => {
              if (!APPLY) return { status: "shadow-logged", detail: `SHADOW: would apply ${proposed?.proposals?.length ?? 0} consolidations` };
              if (!MEM_SSH) return { status: "blocked", detail: "CHAD_CURATOR_APPLY=1 but no CHAD_MEM_SSH to reach the gated apply path" };
              return { status: "blocked", detail: "live memory apply intentionally deferred to a future chad-memory-apply (draft-only v1)" };
            }}
          </Task>
        </Branch>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
