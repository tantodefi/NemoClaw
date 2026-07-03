/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// coverage-loop.jsx — raise test coverage toward a target, iterating with the
// built-in <Loop> composite (adopted in the 0.26 upgrade — the same pattern as
// upstream examples/coverage-loop): measure → write focused tests → re-measure,
// until coverage ≥ target or maxIterations.
//
// Pipeline:  Loop until coverage≥target [ measure (run coverage, parse uncovered)
//            → fix (draft focused tests for the gaps) ] → report
//
// Shadow-safe: `measure` runs a configurable, read-only coverage command and
// tolerates missing tooling (returns 0%, loop exits). `fix` DRAFTS test files
// (logs what it would add) unless CHAD_COVERAGE_APPLY=1 — so a bare
// `smithers up workflows/coverage-loop.jsx` does one measure + one draft and
// stops (coverage can't move without applying), never writing to disk.

import { createSmithers, Loop } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { parseCoverage, uncoveredLines } from "../lib/coverage.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_COVERAGE_DB || "./coverage-loop.db";
const REPO_DIR = process.env.CHAD_COVERAGE_DIR || process.cwd();
// Command that prints coverage; parsed for a "NN%" total. Read-only by default.
const COV_CMD = process.env.CHAD_COVERAGE_CMD || "bun test --coverage 2>&1 | tail -40";
const TARGET = Number(process.env.CHAD_COVERAGE_TARGET || 90);
const MAX_ITERS = Number(process.env.CHAD_COVERAGE_MAX_ITERS || 5);
const APPLY = process.env.CHAD_COVERAGE_APPLY === "1"; // actually write test files
const POST = process.env.CHAD_COVERAGE_POST === "1";

const schemas = {
  measure: z.object({ coverage: z.number(), uncovered: z.string(), ran: z.boolean() }),
  fix: z.object({ status: z.string(), files: z.array(z.string()), detail: z.string() }),
  report: z.object({ note: z.string(), coverage: z.number(), hitTarget: z.boolean() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

function sh(cmd) {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd: REPO_DIR, maxBuffer: 16 * 1024 * 1024 }, (_e, out, err) =>
      resolve((out || "").toString() + (err || "").toString()));
  });
}

export const workflow = smithers((ctx) => {
  const measures = ctx.outputs.measure ?? [];
  const last = measures[measures.length - 1];
  const coverage = last?.coverage ?? 0;
  const hitTarget = coverage >= TARGET;
  // In shadow (no APPLY) coverage can't change, so exit after the first pass
  // instead of burning identical iterations; in APPLY mode, loop to the target.
  const done = hitTarget || (!APPLY && measures.length >= 1);

  return (
    <Workflow name="chad-coverage-loop">
      <Sequence>
        <Loop until={done} maxIterations={MAX_ITERS} onMaxReached="return-last">
          <Sequence>
            {/* Measure: run the coverage command (read-only), parse the total. */}
            <Task id="measure" output={outputs.measure} sideEffect
              idempotencyKey={`coverage-measure-${new Date().toISOString().slice(0, 13)}-${measures.length}`}>
              {async () => {
                const out = await sh(COV_CMD);
                const cov = parseCoverage(out);
                // Keep the uncovered-files tail as context for the fixer.
                return { coverage: cov, uncovered: uncoveredLines(out).slice(0, 4000), ran: out.length > 0 };
              }}
            </Task>

            {/* Fix: draft focused tests for the gaps. Draft-only unless APPLY=1 —
                the fixer never writes here; it proposes what to add. */}
            <Task id="fix" skipIf={hitTarget} output={outputs.fix}
              agent={pickAgent("implement")} fallbackAgent={pickFallback("implement")} {...taskOpts("implement")}>
              {[
                `Coverage is ${coverage}% (target ${TARGET}%). Propose 2-3 focused test files for the biggest gaps.`,
                "For each: the file path, what to test, and the test skeleton. Prefer the lowest-coverage units.",
                APPLY ? "These will be written to disk — make them runnable." : "DRAFT ONLY — do not assume they'll be written.",
                `Uncovered (from the coverage report):\n${last?.uncovered || "(none captured)"}`,
                "Return JSON { status, files:[paths], detail (the proposed tests, markdown) }.",
              ].join("\n\n")}
            </Task>
          </Sequence>
        </Loop>

        {/* Report — coverage delta + the proposal. Shadow note unless POST=1. */}
        <Task id="report" output={outputs.report} sideEffect idempotencyKey={`coverage-report-${new Date().toISOString().slice(0, 13)}`}>
          {async () => {
            const title = `Coverage loop — ${coverage}% / ${TARGET}% target ${hitTarget ? "✓ hit" : "(gap)"}`;
            const fix = (ctx.outputs.fix ?? []).slice(-1)[0];
            const body = `# ${title}\n\nRan ${measures.length} measure pass(es).\n\n` +
              (hitTarget ? "_Target met._" : `**Proposed tests:**\n${fix?.detail || "_none_"}`);
            if (POST) await postNote({ title, content: body, tags: "chad-coverage" });
            return { note: POST ? `${title} (posted)` : `SHADOW: ${title}`, coverage, hitTarget };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
