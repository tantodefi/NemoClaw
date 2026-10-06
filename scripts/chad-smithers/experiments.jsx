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
import { pickAgent, pickFallback, taskOpts } from "./agents.js";
import {
  loadPopulation, savePopulation, activeCandidates, recordScore,
  select, needsExpansion, addCandidate, leaderboard, POLICY,
} from "./lib/population.js";
import { scanSignal, signalText } from "./lib/signal.js";
import { harvestFixtures } from "./lib/fixtures.js";
import { resolveDirectives, creativityKnob, inScope } from "./lib/directives.js";

const DB_PATH = process.env.CHAD_SMITHERS_DB || "./experiments.db";
const POP_PATH = process.env.CHAD_POPULATION || "./state/population.json";
const SEED_PATH = process.env.CHAD_SEED_FILE || "./state/seed-candidates.json";
const FIXTURES_PATH = process.env.CHAD_FIXTURES || "./state/fixtures.json";
const REPORT_PATH = process.env.CHAD_EXPERIMENT_REPORT || "./state/last-report.md";
// (directives are resolved via lib/directives.js — global file + per-run override)
const SIGNAL_DIR = process.env.CHAD_RUNS_DB_DIR || ".";
const DRY_RUN = process.env.DRY_RUN === "1";

// Cached run-DB signal (failures / low scorers / stale) — the trace-grounding the
// reflective mutation breeds against. Scanned at most once a minute so re-renders
// don't re-walk every DB each frame.
let _sigCache = null, _sigAt = 0;
function runSignal() {
  if (_sigCache && Date.now() - _sigAt < 60_000) return _sigCache;
  try { _sigCache = scanSignal(SIGNAL_DIR, { days: 14 }); } catch { _sigCache = null; }
  _sigAt = Date.now();
  return _sigCache;
}
// Cached harvested fixtures — REAL run inputs (messages/prompts/logs/issues) added
// to the static set so candidates are scored against live cases, not just the
// hand-written 8. CHAD_HARVEST_MAX=0 disables. Same 60s cache as the signal.
const HARVEST_MAX = Number(process.env.CHAD_HARVEST_MAX || 6);
let _fxCache = null, _fxAt = 0;
function harvestedFixtures() {
  if (_fxCache && Date.now() - _fxAt < 60_000) return _fxCache;
  try { _fxCache = HARVEST_MAX > 0 ? harvestFixtures(SIGNAL_DIR, { perKind: 2 }).slice(0, HARVEST_MAX) : []; } catch { _fxCache = []; }
  _fxAt = Date.now();
  return _fxCache;
}
// Reflective mutation — the Hermes/GEPA borrow. Each run BREEDS one new
// drafter-prompt by reflecting on WHY the leaders win (not random mutation, not
// just pulling the next static seed), and adds it to the pool to earn its place
// next round. Guardrails: drafter-prompt TEXT only (no code), capped by
// POLICY.maxActive, deduped by label, never auto-promoted (must win evaluation).
// Default on; CHAD_EXPERIMENT_MUTATE=0 disables. This is what makes the arena
// self-generating instead of selection-only.
const MUTATE = process.env.CHAD_EXPERIMENT_MUTATE !== "0";

// z.number() maps to INTEGER columns in Smithers' SQLite — so scores are 0..100
// integers here and divided to 0..1 before they hit population.js.
const schemas = {
  evaluation: z.object({
    candidateId: z.string(),
    scorePct: z.number().min(0).max(100),
    // Leanness/cost axis (0..100, LOWER = leaner) — powers Pareto selection
    // (quality↑ vs cost↓). Optional so older judges/rows still parse.
    costPct: z.number().min(0).max(100).optional(),
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
  mutation: z.object({
    label: z.string(),
    system: z.string(),
    rationale: z.string(),
  }),
};

function loadJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

const api = createSmithers(schemas, { dbPath: DB_PATH });
const { smithers, Workflow, Task, Sequence, Parallel, outputs } = api;

export const workflow = smithers((ctx) => {
  const pop = loadPopulation(POP_PATH);
  // Directives steer breeding/scoring. Resolved through lib/directives.js so a
  // per-run override (CHAD_DIRECTIVES_JSON) or global-off (CHAD_DIRECTIVES_OFF)
  // takes effect — this is what lets a run experiment ON the directives themselves.
  const directives = resolveDirectives(process.env);
  const priorities = Array.isArray(directives.priorities) ? directives.priorities : [];
  // Static curated fixtures + REAL harvested ones (live cases from the run DBs).
  // `priorities` scopes scoring to the operator's task-kinds when set (fall back to
  // the full set if nothing matches, so a stray priority can't empty the arena).
  const allFixtures = [...loadJson(FIXTURES_PATH, []), ...harvestedFixtures()];
  const scoped = priorities.length ? allFixtures.filter((f) => inScope(f.taskKind, priorities)) : allFixtures;
  const fixtures = scoped.length ? scoped : allFixtures;

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
  const priorMutation = ctx.outputs.mutation ?? [];
  // The drafter-prompt to breed from (best by rolling mean). Its presence gates
  // the mutate step — nothing to reflect on until at least one prompt has scored.
  const mutateBase = (MUTATE && !DRY_RUN)
    ? pop.candidates.filter((c) => c.kind === "drafter-prompt" && c.spec?.system && (c.trials || 0) > 0)
      .sort((a, b) => (b.rollingMean || 0) - (a.rollingMean || 0))[0]
    : null;

  // Per-candidate evaluation = produce (cheap) → judge (capable). Task ids are
  // data-derived from the candidate id so resume is stable (Smithers rule).
  const evalTasks = candidates.map((c) => (
    <Task
      key={c.id}
      id={`eval-${c.id}`}
      output={outputs.evaluation}
      agent={pickAgent("judge")}
      fallbackAgent={pickFallback("judge")}
      {...taskOpts("judge", { continueOnFail: true })}
    >
      {judgePrompt(c, fixtures, directives)}
    </Task>
  ));

  return (
    <Workflow name="chad-experiments">
      <Sequence>
        <Parallel>{evalTasks}</Parallel>

        <Task id="select" output={outputs.selection}>
          {() => {
            for (const e of priorEvals) {
              // Drop any eval row missing a usable score: continueOnFail can leave
              // a failed candidate out, and a malformed judge row must not poison
              // the rolling mean (the schemaFailFast discipline at the fan-in).
              if (!e || typeof e.scorePct !== "number" || Number.isNaN(e.scorePct)) continue;
              // Pass the leanness axis through when the judge supplied it (→ Pareto).
              const cost = typeof e.costPct === "number" && !Number.isNaN(e.costPct) ? e.costPct / 100 : null;
              recordScore(pop, e.candidateId, e.scorePct / 100, undefined, cost);
            }
            const { champions, retired } = select(pop, POLICY);
            if (!DRY_RUN) savePopulation(POP_PATH, pop);
            return { champions, retired, activeCount: activeCandidates(pop).length };
          }}
        </Task>

        {/* Reflective mutation (Hermes/GEPA): breed a new drafter-prompt by
            reasoning about WHY the leaders win. Skipped until a prompt has scored. */}
        <Task id="mutate" skipIf={!mutateBase} output={outputs.mutation} agent={pickAgent("optimize")} fallbackAgent={pickFallback("optimize")} {...taskOpts("optimize")}>
          {mutatePrompt(pop, directives, MUTATE ? signalText(runSignal()) : "")}
        </Task>

        <Task id="report" output={outputs.report}>
          {() => {
            const sel = priorSelection[priorSelection.length - 1]
              ?? { champions: [], retired: [], activeCount: 0 };
            // Breed the mutated candidate into the pool (it competes NEXT run, never
            // auto-promoted). Guardrails: only with room under POLICY.maxActive and a
            // new label. Then render so the report shows the freshly bred entry.
            let bred = null;
            if (!DRY_RUN && MUTATE) {
              const mut = priorMutation[priorMutation.length - 1];
              if (mut && mut.system && mut.label
                && activeCandidates(pop).length < POLICY.maxActive
                && !pop.candidates.some((c) => c.spec?.label === mut.label)) {
                addCandidate(pop, { kind: "drafter-prompt", spec: { label: mut.label, system: mut.system }, note: `bred (reflective mutation): ${mut.rationale || ""}`.slice(0, 200) });
                bred = mut.label;
              }
            }
            const md = renderReport(pop, sel, bred);
            if (!DRY_RUN) {
              writeReport(md);
              if (bred) savePopulation(POP_PATH, pop);
              // Value loop: export the top drafter-prompt champion so prod can adopt
              // the winning prompt instead of leaving it stranded in the leaderboard.
              try {
                const champ = pop.candidates
                  .filter((c) => c.status === "champion" && c.kind === "drafter-prompt" && c.spec?.system)
                  .sort((a, b) => (b.rollingMean || 0) - (a.rollingMean || 0))[0];
                if (champ) {
                  const { writeFileSync, mkdirSync } = require("node:fs");
                  const { dirname, join } = require("node:path");
                  mkdirSync(dirname(REPORT_PATH), { recursive: true });
                  writeFileSync(join(dirname(REPORT_PATH), "champion-prompt.json"),
                    JSON.stringify({ label: champ.spec.label, system: champ.spec.system, rollingMean: champ.rollingMean, trials: champ.trials, exportedAt: new Date().toISOString() }, null, 2) + "\n");
                }
              } catch { /* */ }
            }
            // Operator-visible OpenWebUI artifact is posted by the cron wrapper
            // (chad-experiment-smithers) via chad-webui after this returns, so
            // the post survives even if the LLM tier is down.
            return {
              path: REPORT_PATH,
              summary: `champions=${sel.champions.length} retired=${sel.retired.length} active=${sel.activeCount}${bred ? ` bred=${bred}` : ""}`,
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
function judgePrompt(candidate, fixtures, directives = {}) {
  return [
    "You are scoring one experiment candidate for Chad's nightly evolution loop.",
    directives.experiments ? `Operator directives — weight your score by these priorities:\n${directives.experiments}` : "",
    `Candidate kind: ${candidate.kind}`,
    `Candidate spec:\n${JSON.stringify(candidate.spec, null, 2)}`,
    fixtures.length
      ? `Evaluate it against these fixtures:\n${JSON.stringify(fixtures, null, 2)}`
      : "No fixtures provided; score on intrinsic quality of the spec.",
    "Also rate the candidate's LEANNESS as costPct (0-100 integer, LOWER = leaner):",
    "  how verbose/expensive its output tends to be — a tight, high-signal answer is",
    "  low cost; a padded, rambling one is high. This lets the arena keep variants that",
    "  are nearly as good but cheaper (quality vs cost trade-off), not just the top score.",
    "Return JSON: { candidateId, scorePct (0-100 integer), costPct (0-100 integer), rationale (one sentence) }.",
    `candidateId MUST be "${candidate.id}".`,
  ].filter(Boolean).join("\n\n");
}

// mutatePrompt — the reflective-mutation instruction. Hands the model the top
// drafter-prompt(s) + a weaker one with their scores and asks it to BREED a new
// variant that keeps what wins and fixes a weakness (grounded reflection, the
// GEPA pattern — not random mutation).
function mutatePrompt(pop, directives = {}, signal = "") {
  const ranked = pop.candidates
    .filter((c) => c.kind === "drafter-prompt" && c.spec?.system)
    .sort((a, b) => (b.rollingMean || 0) - (a.rollingMean || 0));
  const top = ranked.slice(0, 2).map((c) => ({ label: c.spec.label, system: c.spec.system, score: Number((c.rollingMean || 0).toFixed(3)), trials: c.trials || 0 }));
  const weak = ranked.filter((c) => (c.trials || 0) > 0).slice(-1).map((c) => ({ label: c.spec.label, system: c.spec.system, score: Number((c.rollingMean || 0).toFixed(3)) }));
  const crea = creativityKnob(directives.creativity);
  const prio = Array.isArray(directives.priorities) ? directives.priorities : [];
  return [
    "You are the reflective-mutation step of Chad's evolutionary arena. BREED one new drafter-prompt by reasoning about WHY the leaders win and the laggard lags — not random mutation.",
    directives.experiments ? `Operator directives — breed toward these:\n${directives.experiments}` : "",
    crea.hint ? `Creativity dial (${directives.creativity}): ${crea.hint}` : "",
    prio.length ? `Operator priorities — focus on these task-kinds: ${prio.join(", ")}.` : "",
    signal ? `Recent run signal (real failures + low scorers from the live system — address these, don't just chase the synthetic fixtures):\n${signal}` : "",
    `Top drafter-prompt(s) by rolling score:\n${JSON.stringify(top, null, 2)}`,
    weak.length ? `A weaker variant:\n${JSON.stringify(weak, null, 2)}` : "",
    "Propose ONE NEW system prompt that keeps what makes the top ones win, fixes a concrete weakness, and reflects the directives + recent signal above. Chad's voice: warm, specific, exactly one next step, no hedging. Keep it short.",
    "Return JSON { label (short kebab slug, DISTINCT from the ones above), system (the new system prompt text), rationale (one sentence: what you changed and why) }.",
  ].filter(Boolean).join("\n\n");
}

function renderReport(pop, sel, bred) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Chad experiments — night of ${date}`,
    "",
    `Champions: ${sel.champions.join(", ") || "—"}`,
    `Retired this run: ${sel.retired.join(", ") || "—"}`,
    `Active candidates: ${sel.activeCount}`,
  ];
  if (bred) lines.push(`Bred this run (reflective mutation): ${bred}`);
  lines.push("", "## Leaderboard", "", leaderboard(pop));
  return lines.join("\n");
}

function writeReport(md) {
  const { writeFileSync, mkdirSync } = require("node:fs");
  const { dirname } = require("node:path");
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md + "\n");
}

// `smithers up experiments.jsx` invokes the default export.
export default workflow;
