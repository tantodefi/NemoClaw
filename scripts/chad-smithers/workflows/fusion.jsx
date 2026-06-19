/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// fusion.jsx — run one prompt across MANY models in parallel, then FUSE the
// responses into a single best answer. The "ensemble / mixture-of-models"
// pattern for maximum-quality results (and a model shootout as a side effect).
//
// Three-stage pipeline (matches upstream smithersai/smithers-fusions; richer than
// a single combined "fuse" task):
//
//   panel      (Parallel) the same prompt to every model, one durable task each.
//              continueOnFail → a dead/slow model is DROPPED, not fatal; per-task
//              timeout (agents.js) → a hung model can't hang the night.
//   judge      (capable) a STRUCTURED analysis of the candidates: consensus,
//              contradictions, unique insights, blind spots, best_model, confidence.
//   synthesize (capable) the final answer, grounded in the judge analysis AND the
//              raw candidates — merges the best of each and fixes flagged errors.
//
// Roster resolves: CHAD_FUSION_MODELS env → nightly-arena MODEL champions
// (experiments.jsx, via state/population.json) → the daily featured list
// (state/models.json) → a hardcoded fallback. So the arena actually SELECTS the
// production panel over time. Capped at CHAD_FUSION_MAX (default 6).

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { loadPopulation, champions, activeCandidates } from "../lib/population.js";

const DB = process.env.CHAD_FUSION_DB || "./fusion.db";
const MAX_PANEL = Number(process.env.CHAD_FUSION_MAX || 6);
const dedupe = (a) => [...new Set(a)];

// Winning MODEL candidates from the nightly arena, best (champion) first. Empty
// until experiments.jsx promotes "model"-kind candidates — then they lead the panel.
function arenaModels() {
  try {
    const pop = loadPopulation(new URL("../state/population.json", import.meta.url).pathname);
    return [...champions(pop), ...activeCandidates(pop)]
      .filter((c) => c.kind === "model")
      .map((c) => c.spec?.model || c.spec?.id || c.spec?.label)
      .filter((m) => typeof m === "string" && m.includes("/"));
  } catch { return []; }
}

function resolveModels() {
  if (process.env.CHAD_FUSION_MODELS) {
    return dedupe(process.env.CHAD_FUSION_MODELS.split(",").map((s) => s.trim()).filter(Boolean)).slice(0, MAX_PANEL);
  }
  let featured = [];
  try {
    const f = JSON.parse(readFileSync(new URL("../state/models.json", import.meta.url), "utf8"));
    if (f.featured?.length) featured = f.featured;
  } catch { /* */ }
  const fallback = ["nvidia/nemotron-3-ultra-550b-a55b", "openai/gpt-oss-120b", "deepseek-ai/deepseek-v4-pro", "meta/llama-4-maverick-17b-128e-instruct", "moonshotai/kimi-k2.6", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"];
  return dedupe([...arenaModels(), ...featured, ...fallback]).slice(0, MAX_PANEL);
}
const MODELS = resolveModels();

const schemas = {
  response: z.object({ model: z.string(), text: z.string() }),
  judgment: z.object({
    consensus: z.array(z.string()),
    contradictions: z.array(z.string()),
    uniqueInsights: z.array(z.string()),
    blindSpots: z.array(z.string()),
    best_model: z.string(),
    confidence: z.number().min(0).max(100),
  }),
  fusion: z.object({
    fused: z.string(),
    best_model: z.string(),
    rationale: z.string(),
  }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Parallel, outputs } = api;
const safe = (m) => m.replace(/[^a-zA-Z0-9]/g, "-");

export default smithers((ctx) => {
  const prompt = ctx.input?.prompt || process.env.CHAD_FUSION_PROMPT
    || "Draft a concise, warm reply telling a client their squat form looks good but to slow the descent.";
  const priorResponses = ctx.outputs.response ?? [];
  const priorJudgment = (ctx.outputs.judgment ?? []).slice(-1)[0];

  // Fan out: the same prompt to every model, each its own durable task. No
  // fallbackAgent here — we want THAT model's answer or none (continueOnFail
  // drops a failed panelist so the fusion still completes with the survivors).
  const candidates = MODELS.map((m) => (
    <Task key={m} id={`gen-${safe(m)}`} output={outputs.response}
      agent={pickAgent("draft", { backend: "nemotron", model: m })}
      {...taskOpts("draft", { backend: "nemotron", continueOnFail: true })}>
      {`${prompt}\n\nRespond directly. Then return JSON { model: "${m}", text: "<your answer>" }.`}
    </Task>
  ));

  return (
    <Workflow name="chad-fusion">
      <Sequence>
        <Parallel>{candidates}</Parallel>

        {/* Judge: structured analysis of the panel (not yet the final answer). */}
        <Task id="judge" output={outputs.judgment}
          agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
          {[
            "You are the JUDGE of a model-fusion panel. Analyze the candidate answers to the SAME prompt.",
            `Prompt:\n${prompt}`,
            `Candidate answers (JSON):\n${JSON.stringify(priorResponses)}`,
            "Identify: consensus (claims most agree on), contradictions (where they conflict), uniqueInsights (valuable points only one made), blindSpots (what they ALL missed).",
            'Return JSON { consensus:[], contradictions:[], uniqueInsights:[], blindSpots:[], best_model:"<id>", confidence:0-100 }.',
          ].join("\n\n")}
        </Task>

        {/* Synthesize: the single best answer, grounded in the judge + raw panel. */}
        <Task id="synthesize" output={outputs.fusion}
          agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
          {[
            "You are the SYNTHESIZER. Produce the single strongest answer to the prompt.",
            `Prompt:\n${prompt}`,
            `Judge analysis (JSON):\n${JSON.stringify(priorJudgment ?? {})}`,
            `Candidate answers (JSON):\n${JSON.stringify(priorResponses)}`,
            "Merge the best of each, fix the contradictions/errors the judge flagged, and cover the blind spots where you can.",
            'Return JSON { fused: "<best merged answer>", best_model: "<which single candidate was best>", rationale: "<one sentence>" }.',
          ].join("\n\n")}
        </Task>
      </Sequence>
    </Workflow>
  );
});
