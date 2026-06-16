/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// fusion.jsx — run one prompt across MANY models in parallel, then fuse the
// responses into a single best answer. The "ensemble / mixture-of-models"
// pattern for maximum-quality results (and a model shootout as a side effect).
//
// Uses the full NVIDIA OpenAI-compatible catalog via the router's per-call model
// override (agents.js pickAgent(role,{backend:"nemotron",model})). Configure the
// roster with CHAD_FUSION_MODELS (comma-separated) and the prompt with
// CHAD_FUSION_PROMPT or ctx.input.prompt.
//
// Pipeline: candidates (Parallel — one model each) → fuse (capable synthesizer).
// Each candidate is a durable task, so a slow/failed model doesn't sink the run.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { pickAgent } from "../agents.js";

const DB = process.env.CHAD_FUSION_DB || "./fusion.db";
// Roster resolves: CHAD_FUSION_MODELS env → the daily-refreshed featured list
// (state/models.json, kept fresh by refresh-models.js) → a hardcoded fallback.
function resolveModels() {
  if (process.env.CHAD_FUSION_MODELS) return process.env.CHAD_FUSION_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  try { const f = JSON.parse(readFileSync(new URL("../state/models.json", import.meta.url), "utf8")); if (f.featured?.length) return f.featured; } catch { /* */ }
  return ["nvidia/nemotron-3-ultra-550b-a55b", "openai/gpt-oss-120b", "deepseek-ai/deepseek-v4-pro", "meta/llama-4-maverick-17b-128e-instruct", "moonshotai/kimi-k2.6", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"];
}
const MODELS = resolveModels();

const schemas = {
  response: z.object({ model: z.string(), text: z.string() }),
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

  // Fan out: the same prompt to every model, in parallel, each its own task.
  const candidates = MODELS.map((m) => (
    <Task key={m} id={`gen-${safe(m)}`} output={outputs.response}
      agent={pickAgent("draft", { backend: "nemotron", model: m })} retries={1}>
      {`${prompt}\n\nRespond directly. Then return JSON { model: "${m}", text: "<your answer>" }.`}
    </Task>
  ));

  return (
    <Workflow name="chad-fusion">
      <Sequence>
        <Parallel>{candidates}</Parallel>
        {/* Fuse: a capable synthesizer combines the N answers into the best one. */}
        <Task id="fuse" output={outputs.fusion} agent={pickAgent("judge")} retries={1}>
          {[
            "You are fusing multiple model answers to the SAME prompt into one best result.",
            `Prompt:\n${prompt}`,
            `Candidate answers (JSON):\n${JSON.stringify(priorResponses)}`,
            "Synthesize the strongest single answer (merge the best of each; fix errors).",
            'Return JSON { fused: "<best merged answer>", best_model: "<which single model was best>", rationale: "<one sentence>" }.',
          ].join("\n\n")}
        </Task>
      </Sequence>
    </Workflow>
  );
});
