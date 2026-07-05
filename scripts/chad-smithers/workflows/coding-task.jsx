/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// coding-task.jsx — Chad (nemotron) CONTROLS a long opencode "big-pickle" build:
// plan → [ code → validate → assess ]* → ping → Approval → (optional) PR. nemotron
// is the driver (plans, validates each round against a real command, decides
// whether the acceptance criteria are met and what to fix next); opencode
// big-pickle is the hands (writes the code); a human gates anything that lands.
//
//   plan     (nemotron)  spec + acceptance criteria + a real VALIDATE command
//   BUILD LOOP until nemotron says done, or max rounds:
//     code       (opencode big-pickle spawn)  implement per spec + last feedback
//     validate   (deterministic)              run the validate cmd — real pass/fail
//     assess     (nemotron)                   acceptance met? if not, feedback → next round
//   ping     (chad-moshi-notify)  push the operator an update + validation result
//   land     (Approval-gated)     review the diff; shadow unless CHAD_CODING_APPLY=1
//   pr       (gated)              open a DRAFT PR only with approval + CHAD_CODING_PR=1
//
// Controlled + reviewable + safe by construction:
//  • the coder runs as an isolated chad-spawn (own workdir, L7 policy) — it does not
//    touch this repo; on a bare host with no transport it STUBS (shadow);
//  • validation is a REAL command (tests/build), not just an LLM opinion, so the
//    "done" signal is grounded;
//  • nothing lands without a human Approval, and the PR step is doubly gated
//    (approval AND CHAD_CODING_PR=1) to respect Chad's no-direct-git-write boundary;
//  • the operator is pushed a Moshi update when the build finishes + at the gate.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { runSpawn, spawnResultSchema } from "../lib/spawn.js";
import { postNote } from "../lib/note.js";
import { moshiPing } from "../lib/notify.js";

const DB = process.env.CHAD_CODING_DB || "./coding-task.db";
const CODER_KIND = process.env.CHAD_CODING_KIND || "opencode"; // opencode big-pickle
const SUBSTRATE = process.env.CHAD_CODING_SUBSTRATE || "local"; // local | gha (isolated)
const SPAWN_TIMEOUT = Number(process.env.CHAD_SPAWN_TIMEOUT_MS || 1_800_000); // 30 min
const MAX_ROUNDS = Number(process.env.CHAD_CODING_MAX_ROUNDS || 4); // long-build cap
const WORKDIR = process.env.CHAD_CODING_WORKDIR || process.cwd();   // where validate runs
const APPLY = process.env.CHAD_CODING_APPLY === "1";               // land the change
const OPEN_PR = process.env.CHAD_CODING_PR === "1";                // open a draft PR (gated)
const POST = process.env.CHAD_CODING_POST === "1";                 // OpenWebUI note

const schemas = {
  plan: z.object({
    summary: z.string(),
    steps: z.array(z.string()),
    acceptance: z.array(z.string()),
    validateCmd: z.string(),   // e.g. "bun test" / "npm run build" — how we verify
    files: z.array(z.string()),
  }),
  code: spawnResultSchema,     // per-round big-pickle result.json
  validate: z.object({ passed: z.boolean(), cmd: z.string(), output: z.string() }),
  assess: z.object({ done: z.boolean(), feedback: z.string(), summary: z.string() }),
  report: z.object({ summary: z.string(), validated: z.boolean(), rounds: z.number() }),
  land: z.object({ status: z.string(), detail: z.string(), prUrl: z.string().optional() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Loop, outputs } = api;

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: WORKDIR, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, out, errout) => resolve({ code: err ? (err.code ?? 1) : 0, out: (out || "") + (errout || "") }));
  });
}

export const workflow = smithers((ctx) => {
  const task = ctx.input?.task || process.env.CHAD_CODING_TASK
    || "Add a --version flag to the chad-runs CLI that prints the workspace package version.";
  const plan = (ctx.outputs.plan ?? [])[0];
  const codes = ctx.outputs.code ?? [];
  const validates = ctx.outputs.validate ?? [];
  const assessments = ctx.outputs.assess ?? [];
  const lastAssess = assessments[assessments.length - 1];
  const lastValidate = validates[validates.length - 1];
  const lastCode = codes[codes.length - 1];
  const round = codes.length;                 // rounds completed so far
  const done = !!lastAssess?.done;             // nemotron says acceptance met → stop the loop

  return (
    <Workflow name="chad-coding-task">
      <Sequence>
        {/* 1) PLAN — nemotron turns the request into a spec + acceptance criteria
            AND a concrete validate command so "done" is verifiable, not vibes. */}
        <Task id="plan" output={outputs.plan}
          agent={pickAgent("optimize")} fallbackAgent={pickFallback("optimize")} {...taskOpts("optimize")}>
          {[
            "You are the PLANNER + DRIVER for a coding task. Turn the request into a minimal spec a coding agent can execute over several rounds.",
            "Include a concrete `validateCmd` a machine can run to verify it (e.g. `bun test`, `npm run build`, a script) — this is how we'll know it's actually done.",
            `Task: ${task}`,
            "Return JSON { summary, steps:[...], acceptance:[...], validateCmd, files:[...] }.",
          ].join("\n\n")}
        </Task>

        {/* 2) BUILD LOOP — nemotron drives opencode big-pickle over multiple rounds:
            code → validate (real cmd) → assess (met? feedback). Loops until nemotron
            says done or MAX_ROUNDS. This is nemotron CONTROLLING the long session. */}
        <Loop id="build" skipIf={!plan} until={done} maxIterations={MAX_ROUNDS} onMaxReached="return-last">
          <Sequence>
            {/* code — offload the actual coding to opencode big-pickle (isolated,
                draft-only). Each round gets the spec + the prior round's validation
                output + nemotron's feedback, so the session accumulates direction. */}
            <Task id="code" output={outputs.code} sideEffect
              idempotencyKey={`coding-${task.slice(0, 40)}-r${round}`}
              continueOnFail retries={0} timeoutMs={SPAWN_TIMEOUT}>
              {() => runSpawn({
                kind: CODER_KIND, substrate: SUBSTRATE, id: `coding-r${round}-${Date.now().toString(36)}`,
                task: [
                  `Implement this coding task with opencode big-pickle — round ${round + 1}. DRAFT in your workdir; do NOT commit/push/PR.`,
                  `Spec:\n${JSON.stringify(plan ?? { task }, null, 2)}`,
                  lastValidate ? `Last validation (${lastValidate.passed ? "PASS" : "FAIL"}) output:\n${String(lastValidate.output).slice(0, 2000)}` : "",
                  lastAssess?.feedback ? `Driver feedback to address this round:\n${lastAssess.feedback}` : "",
                  "Last stdout line = result.json { status, summary, follow_ups, (diff if available) }.",
                ].filter(Boolean).join("\n\n"),
              })}
            </Task>

            {/* validate — run the plan's validateCmd for real. Deterministic pass/fail
                is the grounded signal the driver reasons over (not an LLM guess). */}
            <Task id="validate" output={outputs.validate} sideEffect
              idempotencyKey={`coding-validate-${task.slice(0, 40)}-r${round}`}>
              {async () => {
                const cmd = plan?.validateCmd?.trim();
                if (!cmd) return { passed: false, cmd: "(none)", output: "no validateCmd in plan" };
                const r = await sh("sh", ["-c", cmd]);
                return { passed: r.code === 0, cmd, output: r.out.slice(-4000) };
              }}
            </Task>

            {/* assess — nemotron decides: is acceptance met (given real validation)?
                If not, what should the coder fix next round? Drives the loop's `until`. */}
            <Task id="assess" output={outputs.assess}
              agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
              {[
                "You are the DRIVER assessing whether the coding task is DONE. Judge against the acceptance criteria AND the real validation result.",
                "Set done=true only if the acceptance criteria are met and validation passed. Otherwise give specific, actionable feedback for the next coding round.",
                `Acceptance:\n${JSON.stringify(plan?.acceptance ?? [], null, 2)}`,
                `Coder result (round ${round}):\n${JSON.stringify(lastCode ?? {}, null, 2)}`,
                `Validation: ${lastValidate?.passed ? "PASS" : "FAIL"} (cmd: ${lastValidate?.cmd || "?"})\n${String(lastValidate?.output || "").slice(0, 2000)}`,
                "Return JSON { done: boolean, feedback: string, summary: string }.",
              ].join("\n\n")}
            </Task>
          </Sequence>
        </Loop>

        {/* 3) PING — push the operator a Moshi update the moment the build settles
            (done or capped), with the validation verdict. Never blocks the run. */}
        <Task id="report" output={outputs.report} sideEffect
          idempotencyKey={`coding-report-${task.slice(0, 40)}`}>
          {async () => {
            const validated = !!lastValidate?.passed && done;
            const summary = lastAssess?.summary || lastCode?.summary || "(no result)";
            const title = `Chad coding: ${task.slice(0, 48)}`;
            const msg = `${validated ? "✅ done + validated" : done ? "⚠ done, validation NOT passing" : `⏱ ${round} rounds, not converged`} — review at ${process.env.CHAD_RUNS_PUBLIC_URL || "runs.supachad.com"}`;
            await moshiPing(title, `${msg}\n${summary.slice(0, 300)}`);
            return { summary, validated, rounds: round };
          }}
        </Task>

        {/* 4) LAND — Approval gate (auto-hold unless validated), shadow unless
            CHAD_CODING_APPLY=1. The PR is DOUBLY gated (approval + CHAD_CODING_PR=1)
            and only ever a DRAFT — Chad proposes, a human lands. */}
        <Task id="land" output={outputs.land}
          needsApproval={!(lastValidate?.passed && done)} sideEffect
          idempotencyKey={`coding-land-${task.slice(0, 40)}`}>
          {async () => {
            const findings = (lastAssess?.feedback || "").slice(0, 600);
            const title = `Coding task — ${task.slice(0, 60)} — ${done && lastValidate?.passed ? "validated" : "needs work"}`;
            const body = `# ${title}\n\n**Plan:** ${plan?.summary || ""}\n\n**Result:** ${lastAssess?.summary || lastCode?.summary || ""}\n\n` +
              `**Validation:** ${lastValidate?.passed ? "PASS" : "FAIL"} — \`${lastValidate?.cmd || "?"}\`\n\n${findings ? `**Open feedback:** ${findings}` : ""}`;
            if (POST) await postNote({ title, content: body, tags: "chad-coding" });
            if (!APPLY) return { status: "shadow-logged", detail: `SHADOW: reviewed coding proposal (${done && lastValidate?.passed ? "validated" : "needs work"}); not landed` };
            if (!OPEN_PR) return { status: "held", detail: "CHAD_CODING_APPLY=1 but CHAD_CODING_PR unset — landing (commit/PR) intentionally deferred" };
            // Draft-PR path (doubly gated). Kept minimal + shadow-real: prepare the
            // PR body; actual `gh pr create` is the operator's confirmed step so Chad
            // never writes to the source repo autonomously (autonomy boundary).
            return { status: "pr-prepared", detail: "PR body prepared; run `gh pr create --draft` to open (Chad does not auto-write the repo)", prUrl: "" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
