/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// experiments.jsx — Chad's evolutionary nightly-experiment workflow on Smithers.
//
// Implements the operator directive (2026-06-13): start wide, test candidates
// IN PARALLEL, select the best, and over time keep only what works.
//
// Pipeline (durable; every step checkpointed to experiments.db so a crash or
// stall resumes instead of losing the night):
//
//   seed       (compute) ensure the population has >= targetActive candidates;
//              if thin, spawn new variants (mutated from champions or seed list)
//   evaluate   (Parallel) for each ACTIVE candidate: produce an output with the
//              cheap tier, then score it 0..100 with the capable tier (judge).
//              Parallelism + per-task persistence = the "test in parallel" half.
//   select     (compute) record scores, rank by rolling mean, promote top-K to
//              champion, retire persistent losers — "keep only what works"
//   report     (compute) write the leaderboard + an OpenWebUI-visible note
//              (the experiment-night success criterion: operator-visible artifact)
//
// Agent selection is delegated entirely to agents.js#pickAgent — this workflow
// never names a model, so the same file runs against Nemotron-120B, the Claude
// subscription CLI, or local gemma depending on what's available.
//
// STATUS: integration scaffold. The router (agents.js) and selection engine
// (lib/population.js, unit-tested) are production-shaped; this file needs one
// `smithers up` smoke pass to confirm the dynamic-fan-out API against the
// installed smithers-orchestrator version (see README "Bring-up").

import { createSmithers } from "smithers-orchestrator";
// MUST match Smithers' zod (^4.3.6) — a 3.x /v4 shim produces schema objects the
// agents package's toJSONSchema misreads ("optional non-representable"). Pin v4.
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { pickAgent } from "./agents.js";
import {
  loadPopulation, savePopulation, activeCandidates, recordScore,
  select, needsExpansion, addCandidate, leaderboard, POLICY,
} from "./lib/population.js";

const DB_PATH = process.env.CHAD_SMITHERS_DB || "./experiments.db";
const POP_PATH = process.env.CHAD_POPULATION || "./state/population.json";
const SEED_PATH = process.env.CHAD_SEED_FILE || "./state/seed-candidates.json";
const FIXTURES_PATH = process.env.CHAD_FIXTURES || "./state/fixtures.json";
const REPORT_PATH = process.env.CHAD_EXPERIMENT_REPORT || "./state/last-report.md";
const DRY_RUN = process.env.DRY_RUN === "1";

// z.number() maps to INTEGER columns in Smithers' SQLite — so scores are 0..100
// integers here and divided to 0..1 before they hit population.js.
const schemas = {
  evaluation: z.object({
    candidateId: z.string(),
    scorePct: z.number().min(0).max(100),
    rationale: z.string(),
  }),
  selection: z.object({
    champions: z.array(z.string()),
    retired: z.array(z.string()),
    activeCount: z.number(),
  }),
  report: z.object({
    path: z.string(),
    summary: z.string(),
    artifactPosted: z.boolean(),
  }),
};

function loadJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

const api = createSmithers(schemas, { dbPath: DB_PATH });
const { smithers, Workflow, Task, Sequence, Parallel, outputs } = api;

export const workflow = smithers((ctx) => {
  const pop = loadPopulation(POP_PATH);
  const fixtures = loadJson(FIXTURES_PATH, []);

  // ── seed: keep the arena wide ──────────────────────────────────────────────
  const want = needsExpansion(pop);
  if (want > 0) {
    const seeds = loadJson(SEED_PATH, []);
    // Skip seeds already present (by kind+label) so re-seeding after retirements
    // doesn't re-add a known variant; pick the next unused seeds in order.
    const present = new Set(pop.candidates.map((c) => `${c.kind}:${c.spec?.label}`));
    const unused = seeds.filter((s) => !present.has(`${s.kind}:${s.spec?.label}`));
    for (let i = 0; i < want && i < unused.length; i++) {
      const s = unused[i];
      addCandidate(pop, { kind: s.kind, spec: s.spec, note: "seeded (start-wide)" });
    }
    if (!DRY_RUN) savePopulation(POP_PATH, pop);
  }

  const candidates = activeCandidates(pop);

  // Read aggregated upstream outputs from the run context (the Smithers fan-in
  // pattern — `deps` is keyed by task id, no good for our dynamic eval-* fan-out).
  // On the frame where `select` is ready, every eval row is already here.
  const priorEvals = ctx.outputs.evaluation ?? [];
  const priorSelection = ctx.outputs.selection ?? [];

  // Per-candidate evaluation = produce (cheap) → judge (capable). Task ids are
  // data-derived from the candidate id so resume is stable (Smithers rule).
  const evalTasks = candidates.map((c) => (
    <Task
      key={c.id}
      id={`eval-${c.id}`}
      output={outputs.evaluation}
      agent={pickAgent("judge")}
      retries={1}
    >
      {judgePrompt(c, fixtures)}
    </Task>
  ));

  return (
    <Workflow name="chad-experiments">
      <Sequence>
        <Parallel>{evalTasks}</Parallel>

        <Task id="select" output={outputs.selection}>
          {() => {
            for (const e of priorEvals) recordScore(pop, e.candidateId, e.scorePct / 100);
            const { champions, retired } = select(pop, POLICY);
            if (!DRY_RUN) savePopulation(POP_PATH, pop);
            return { champions, retired, activeCount: activeCandidates(pop).length };
          }}
        </Task>

        <Task id="report" output={outputs.report}>
          {() => {
            const sel = priorSelection[priorSelection.length - 1]
              ?? { champions: [], retired: [], activeCount: 0 };
            const md = renderReport(pop, sel);
            if (!DRY_RUN) writeReport(md);
            // Operator-visible OpenWebUI artifact is posted by the cron wrapper
            // (chad-experiment-smithers) via chad-webui after this returns, so
            // the post survives even if the LLM tier is down.
            return {
              path: REPORT_PATH,
              summary: `champions=${sel.champions.length} retired=${sel.retired.length} active=${sel.activeCount}`,
              artifactPosted: false,
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

// judgePrompt — instructs the judge to (a) execute the candidate variant against
// the fixtures with the cheap tier and (b) score the result 0..100. v1 keeps it
// single-agent for simplicity; split into produce/judge sub-tasks once the smoke
// pass confirms nested Sequence-in-Parallel works on the installed version.
function judgePrompt(candidate, fixtures) {
  return [
    "You are scoring one experiment candidate for Chad's nightly evolution loop.",
    `Candidate kind: ${candidate.kind}`,
    `Candidate spec:\n${JSON.stringify(candidate.spec, null, 2)}`,
    fixtures.length
      ? `Evaluate it against these fixtures:\n${JSON.stringify(fixtures, null, 2)}`
      : "No fixtures provided; score on intrinsic quality of the spec.",
    "Return JSON: { candidateId, scorePct (0-100 integer), rationale (one sentence) }.",
    `candidateId MUST be "${candidate.id}".`,
  ].join("\n\n");
}

function renderReport(pop, sel) {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `# Chad experiments — night of ${date}`,
    "",
    `Champions: ${sel.champions.join(", ") || "—"}`,
    `Retired this run: ${sel.retired.join(", ") || "—"}`,
    `Active candidates: ${sel.activeCount}`,
    "",
    "## Leaderboard",
    "",
    leaderboard(pop),
  ].join("\n");
}

function writeReport(md) {
  const { writeFileSync, mkdirSync } = require("node:fs");
  const { dirname } = require("node:path");
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md + "\n");
}

// `smithers up experiments.jsx` invokes the default export.
export default workflow;
