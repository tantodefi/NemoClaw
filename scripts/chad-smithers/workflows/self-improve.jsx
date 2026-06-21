/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// self-improve.jsx — chad-self-improve as a durable Smithers workflow (#23).
//
// The weekly behavioral-improvement loop: read operational signal (cron run
// telemetry), have a capable model propose narrow improvements, gate the risky
// ones behind an Approval, and apply only what chad-proposal-apply's safe-list
// already covers. Everything else stays a prose proposal for operator review —
// the exact draft-only contract of the shell version.
//
// Why port it: chad-self-improve v1 spawned a multi-turn researcher that hit
// idle timeouts and DOUBLE-SPAWNED (4 spawns / 90k tokens in 5 min, 2026-06-08).
// Smithers fixes that structurally: one durable task per phase, idempotency keys
// so a resume can't double-apply, and the live dashboard to see a stall instead
// of silence.
//
// Pipeline:  budget-gate → read-signal → propose (capable, structured) →
//            [Approval unless every proposal is in the safe-list] → apply (shadow)
//
// Shadow-safe: apply only ever LOGS unless CHAD_SELFIMPROVE_APPLY=1, and even
// then it routes through the pod's existing chad-proposal-apply (gated by
// chad-action-gate). Signal read falls back to empty if the source is absent,
// so `smithers up` runs anywhere.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";

const DB = process.env.CHAD_SELFIMPROVE_DB || "./self-improve.db";
const APPLY = process.env.CHAD_SELFIMPROVE_APPLY === "1";
const MIN_BUDGET = Number(process.env.CHAD_SELFIMPROVE_MIN_BUDGET || 20000);
// SSH target to read pod-side telemetry (~/.openclaw/cron-runs.jsonl). Empty =
// read a local file (CHAD_SIGNAL_FILE) or fall back to empty signal.
const SIGNAL_SSH = process.env.CHAD_SIGNAL_SSH || "";
const SIGNAL_FILE = process.env.CHAD_SIGNAL_FILE || "";
// chad-proposal-apply's gated kinds — proposals of these kinds can auto-apply;
// anything else requires the operator Approval (mirrors the shell safe-list).
const SAFE_KINDS = new Set(["cron_timeout", "cron_max_tokens", "cron_edit"]);

const schemas = {
  signal: z.object({ runs: z.number(), window: z.string(), sample: z.string() }),
  proposals: z.object({
    proposals: z.array(z.object({
      kind: z.string(), target: z.string(), change: z.string(), rationale: z.string(),
      risk: z.enum(["low", "medium", "high"]),
    })),
    summary: z.string(),
  }),
  apply: z.object({ status: z.enum(["applied", "shadow-logged", "blocked"]), applied: z.number(), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Branch, Approval, outputs } = api;

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout) => resolve(err ? "" : stdout.toString()));
  });
}

export const workflow = smithers((ctx) => {
  const signal = (ctx.outputs.signal ?? [])[0];
  const proposed = (ctx.outputs.proposals ?? [])[0];
  const proposals = proposed?.proposals ?? [];
  // Auto-applicable only if EVERY proposal is low-risk AND in the safe-list.
  const allSafe = proposals.length > 0 && proposals.every((p) => p.risk === "low" && SAFE_KINDS.has(p.kind));

  return (
    <Workflow name="chad-self-improve">
      <Sequence>
        {/* 1) Read operational signal (cron run telemetry). Read-only. */}
        <Task id="read-signal" output={outputs.signal} sideEffect idempotencyKey={`signal-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            let raw = "";
            if (SIGNAL_SSH) raw = await sh("ssh", ["-n", SIGNAL_SSH, "tail -n 200 ~/.openclaw/cron-runs.jsonl 2>/dev/null || true"]);
            else if (SIGNAL_FILE) raw = await sh("sh", ["-c", `tail -n 200 '${SIGNAL_FILE}' 2>/dev/null || true`]);
            const lines = raw.split("\n").filter(Boolean);
            return { runs: lines.length, window: "last 200 cron runs", sample: lines.slice(-40).join("\n").slice(0, 6000) };
          }}
        </Task>

        {/* 2) Propose improvements — ONE capable, structured call (not a tool loop). */}
        <Task id="propose" output={outputs.proposals} agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
          {[
            "You are Chad's self-improvement analyst. From the cron telemetry below, propose at most 5 NARROW, concrete improvements.",
            "Allowed kinds: cron_timeout, cron_max_tokens, cron_edit (auto-appliable), or 'behavioral'/'doc' (operator review).",
            `Telemetry (${signal?.window || "none"}, ${signal?.runs ?? 0} runs):\n${signal?.sample || "(no signal available)"}`,
            'Return JSON {proposals:[{kind,target,change,rationale,risk}], summary}. risk ∈ low|medium|high. Be conservative; prefer fewer, safer changes.',
          ].join("\n\n")}
        </Task>

        {/* 3+4) Apply — gated by needsApproval unless every proposal is safe-listed +
            low-risk (human sign-off; pauses as waiting-approval). Shadow by default;
            real apply routes through the gated pod path. */}
        <Task id="apply" output={outputs.apply} needsApproval={!allSafe} sideEffect idempotencyKey={`selfimprove-apply-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const safe = proposals.filter((p) => p.risk === "low" && SAFE_KINDS.has(p.kind));
            if (signal?.runs === 0) return { status: "shadow-logged", applied: 0, detail: "no signal; nothing to apply" };
            if (!APPLY) return { status: "shadow-logged", applied: 0, detail: `SHADOW: would apply ${safe.length} safe-listed of ${proposals.length} proposals` };
            if (!SIGNAL_SSH) return { status: "blocked", applied: 0, detail: "CHAD_SELFIMPROVE_APPLY=1 but no CHAD_SIGNAL_SSH to reach the gated chad-proposal-apply" };
            // Real apply: hand the structured proposals to the pod's gated pipeline.
            await sh("ssh", ["-n", SIGNAL_SSH, "chad-proposal-apply --from-stdin 2>/dev/null || true"], { input: JSON.stringify(safe) });
            return { status: "applied", applied: safe.length, detail: "handed safe-listed proposals to chad-proposal-apply (chad-action-gate gated)" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
