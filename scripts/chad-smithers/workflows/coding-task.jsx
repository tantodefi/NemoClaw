/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// coding-task.jsx — Chad (nemotron) ORCHESTRATES a coding task and offloads the
// actual coding to opencode "big-pickle", in a controlled + reviewable pipeline.
// The point: nemotron plans and reviews (cheap, always-on), big-pickle writes the
// code (a strong free 500k-context coder), and a human gates anything that lands —
// so an experimental coding change is visible in the Runs tab and never touches the
// tree on its own.
//
// Pipeline:  plan (nemotron capable → spec + acceptance criteria) →
//            code (opencode big-pickle spawn → DRAFT patch, isolated workdir) →
//            review (nemotron judge → approved? + findings) →
//            land (Approval-gated; shadow unless CHAD_CODING_APPLY=1)
//
// Reviewable + controlled by construction:
//  • the coder runs as a chad-spawn `opencode` kind — isolated workdir, L7 policy,
//    result.json reconciled as the task output (never edits this repo directly);
//  • on a bare host with no chad-spawn transport it STUBS (shadow), so a dry
//    `smithers up workflows/coding-task.jsx --input '{"task":"…"}'` produces a
//    visible run with no real spawn; set CHAD_SPAWN_SSH=openshell-chad for real;
//  • `land` never commits / opens a PR — it's Approval-gated and shadow by default.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { runSpawn, spawnResultSchema } from "../lib/spawn.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_CODING_DB || "./coding-task.db";
const CODER_KIND = process.env.CHAD_CODING_KIND || "opencode"; // opencode big-pickle
const SUBSTRATE = process.env.CHAD_CODING_SUBSTRATE || "local"; // local | gha (isolated)
const SPAWN_TIMEOUT = Number(process.env.CHAD_SPAWN_TIMEOUT_MS || 1_800_000); // 30 min
const APPLY = process.env.CHAD_CODING_APPLY === "1"; // actually land the change
const POST = process.env.CHAD_CODING_POST === "1";

const schemas = {
  plan: z.object({
    summary: z.string(),
    steps: z.array(z.string()),
    acceptance: z.array(z.string()),   // how we'll know it's done/correct
    files: z.array(z.string()),        // likely files to touch
  }),
  code: spawnResultSchema,             // the big-pickle spawn's result.json
  review: z.object({
    approved: z.boolean(),
    findings: z.array(z.object({ severity: z.enum(["blocker", "warning", "nit"]), note: z.string() })),
    summary: z.string(),
  }),
  land: z.object({ status: z.string(), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

export const workflow = smithers((ctx) => {
  const task = ctx.input?.task || process.env.CHAD_CODING_TASK
    || "Add a --version flag to the chad-runs CLI that prints the workspace package version.";
  const plan = (ctx.outputs.plan ?? [])[0];
  const code = (ctx.outputs.code ?? [])[0];
  const review = (ctx.outputs.review ?? [])[0];

  return (
    <Workflow name="chad-coding-task">
      <Sequence>
        {/* 1) PLAN — nemotron capable turns the request into a concrete spec the
            coder can execute and the reviewer can check against. No side effects. */}
        <Task id="plan" output={outputs.plan}
          agent={pickAgent("optimize")} fallbackAgent={pickFallback("optimize")} {...taskOpts("optimize")}>
          {[
            "You are the PLANNER for a coding task. Turn the request into a concrete, minimal spec a coding agent can execute.",
            "Be specific about files and the acceptance criteria a reviewer will check. Keep scope tight — smallest change that satisfies the request.",
            `Task: ${task}`,
            "Return JSON { summary, steps:[...], acceptance:[...], files:[...] }.",
          ].join("\n\n")}
        </Task>

        {/* 2) CODE — offload to opencode big-pickle as an ISOLATED spawn. Draft
            only: it works in the spawn's workdir and returns a result.json; it does
            NOT edit this repo. continueOnFail + timeout so a stuck/absent coder
            can't sink the run (on a bare host with no transport this stubs). */}
        <Task id="code" output={outputs.code} sideEffect
          idempotencyKey={`coding-${task.slice(0, 48)}`}
          continueOnFail retries={0} timeoutMs={SPAWN_TIMEOUT}>
          {() => runSpawn({
            kind: CODER_KIND, substrate: SUBSTRATE, id: `coding-${Date.now().toString(36)}`,
            task: [
              "Implement this coding task with opencode big-pickle. DRAFT ONLY — write the change in your workdir; do NOT commit, push, or open a PR.",
              `Spec:\n${JSON.stringify(plan ?? { task }, null, 2)}`,
              "Last stdout line = result.json { status, summary, follow_ups, (diff if available) }.",
            ].join("\n\n"),
          })}
        </Task>

        {/* 3) REVIEW — nemotron judge checks the coder's output against the plan's
            acceptance criteria: correctness, safety, scope. No side effects. */}
        <Task id="review" skipIf={!code} output={outputs.review}
          agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
          {[
            "You are the REVIEWER. Judge the coder's result against the plan's acceptance criteria.",
            "Flag correctness bugs, safety/scope issues first. Approve only if it meets the acceptance criteria and is safe to land.",
            `Plan:\n${JSON.stringify(plan ?? {}, null, 2)}`,
            `Coder result:\n${JSON.stringify(code ?? {}, null, 2)}`,
            "Return JSON { approved: boolean, findings:[{severity: blocker|warning|nit, note}], summary }.",
          ].join("\n\n")}
        </Task>

        {/* 4) LAND — Approval-gated (a human signs off), shadow unless
            CHAD_CODING_APPLY=1. Even applied, landing (commit/PR) is intentionally
            deferred — this stops at a reviewed, gated proposal. */}
        <Task id="land" output={outputs.land}
          needsApproval={!(review && review.approved)} sideEffect
          idempotencyKey={`coding-land-${task.slice(0, 48)}`}>
          {async () => {
            const findings = review?.findings || [];
            const title = `Coding task — ${task.slice(0, 60)} — ${review?.approved ? "approved" : "changes requested"}`;
            const body = `# ${title}\n\n**Plan:** ${plan?.summary || ""}\n\n**Coder:** ${code?.summary || "(no result)"}\n\n` +
              `**Review:** ${review?.summary || ""}\n` + findings.map((f) => `- **[${f.severity}]** ${f.note}`).join("\n");
            if (POST) await postNote({ title, content: body, tags: "chad-coding" });
            if (!APPLY) return { status: "shadow-logged", detail: `SHADOW: reviewed coding proposal (${review?.approved ? "approved" : "needs work"}); not landed` };
            return { status: "blocked", detail: "CHAD_CODING_APPLY=1 set but live landing (commit/PR) intentionally deferred" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
