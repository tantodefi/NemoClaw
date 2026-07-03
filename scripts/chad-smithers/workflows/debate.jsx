/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// debate.jsx — adversarial multi-agent reasoning via Smithers' built-in <Debate>
// composite (adopted in the 0.26 upgrade). The counterpart to fusion.jsx: where
// fusion runs N models in PARALLEL and synthesizes, debate has two models ARGUE
// opposite sides across rounds and a judge rules — better for contested calls
// (design trade-offs, "should we ship X", risk assessments) where the friction of
// a rebuttal surfaces blind spots a parallel panel misses.
//
// Pipeline:  Debate[ proposer argues FOR → opponent argues AGAINST → repeat
//                    `rounds` times → judge returns a verdict ] → report
//
// Shadow-safe: pure reasoning, no side effects except the optional report note.
// `smithers up workflows/debate.jsx --input '{"topic":"..."}'` runs anywhere.

import { createSmithers, Debate } from "smithers-orchestrator";
import { z } from "zod";
import { pickAgent } from "../agents.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_DEBATE_DB || "./debate.db";
const ROUNDS = Number(process.env.CHAD_DEBATE_ROUNDS || 2);
const POST = process.env.CHAD_DEBATE_POST === "1";

const schemas = {
  argument: z.object({
    side: z.enum(["for", "against"]),
    round: z.number(),
    points: z.array(z.string()),
  }),
  verdict: z.object({
    winner: z.enum(["for", "against", "tie"]),
    decision: z.string(),
    key_reasons: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  }),
  report: z.object({ note: z.string(), winner: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

export const workflow = smithers((ctx) => {
  const topic = ctx.input?.topic || process.env.CHAD_DEBATE_TOPIC
    || "Should chad-smithers migrate the dashboard from SQLite polling to the Smithers gateway event stream?";
  const verdict = (ctx.outputs.verdict ?? [])[0];

  return (
    <Workflow name="chad-debate">
      <Sequence>
        {/* Two capable models argue opposite sides for `rounds`, then a distinct
            judge rules. proposer/opponent get the capable tier; the judge is a
            separate agent so it isn't grading its own argument. */}
        <Debate
          id="dbt"
          proposer={pickAgent("optimize")}
          opponent={pickAgent("evaluate")}
          judge={pickAgent("judge")}
          rounds={ROUNDS}
          argumentOutput={outputs.argument}
          verdictOutput={outputs.verdict}
          topic={[
            `Debate this proposition: "${topic}"`,
            "proposer: argue FOR, concretely, with trade-offs and evidence.",
            "opponent: argue AGAINST, attacking the strongest version of the other side.",
            "Each round: return JSON { side, round, points:[...] } — sharp, non-repetitive points.",
            "judge: weigh both sides and return JSON { winner: for|against|tie, decision, key_reasons:[...], confidence }.",
          ].join("\n")}
        />

        {/* Report the ruling. Shadow by default; reversible note when POST=1. */}
        <Task id="report" output={outputs.report} sideEffect idempotencyKey={`debate-report-${topic.slice(0, 40)}`}>
          {async () => {
            const title = `Debate — ${topic.slice(0, 60)} — winner: ${verdict?.winner || "?"}`;
            const body = `# ${title}\n\n**Decision:** ${verdict?.decision || ""}\n\n` +
              (verdict?.key_reasons || []).map((r) => `- ${r}`).join("\n") +
              `\n\n_confidence: ${verdict?.confidence ?? "?"}_`;
            if (POST) await postNote({ title, content: body, tags: "chad-debate" });
            return { note: POST ? `${title} (posted)` : `SHADOW: ${title}`, winner: verdict?.winner || "?" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
