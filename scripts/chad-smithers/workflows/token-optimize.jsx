/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// token-optimize.jsx — "tokenmaxxing": find tasks that run fine on a CHEAPER model.
//
// For each downgrade candidate (a task + its fixture + current vs cheaper model),
// answer the fixture with BOTH models in parallel, have a capable judge score
// every answer, and if the cheaper model clears the quality bar AND stays within
// tolerance of the current one, PROPOSE downgrading that task to the cheaper tier
// — Approval-gated, draft-only. The point: stop paying premium inference for tasks
// a smaller model handles, with evidence + an operator gate.
//
// Shadow-safe: it never edits task-profiles.json (the real apply is intentionally
// deferred, like the other workflows) — it proposes; the operator/Chad applies.
//
// Candidates: state/downgrade-candidates.json (tracked seed); falls back to a
// built-in ultra->super drafter probe so it graph-validates + smoke-runs anywhere.
// Tune the bar/tolerance with CHAD_TOKENOPT_BAR / CHAD_TOKENOPT_TOLERANCE.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";

const DB = process.env.CHAD_TOKENOPT_DB || "./token-optimize.db";
const CAND_PATH = process.env.CHAD_TOKENOPT_CANDIDATES || new URL("../state/downgrade-candidates.json", import.meta.url).pathname;
const BAR = Number(process.env.CHAD_TOKENOPT_BAR || 75);          // min cheaper score to consider a downgrade
const TOLERANCE = Number(process.env.CHAD_TOKENOPT_TOLERANCE || 6); // cheaper may be at most this far below current
const APPLY = process.env.CHAD_TOKENOPT_APPLY === "1";            // shadow unless set
const TASK_PROFILES = new URL("../../task-profiles.json", import.meta.url).pathname; // scripts/task-profiles.json

const DEFAULT_CANDIDATES = [
  {
    task: "drafter",
    fixture: "Draft a concise, warm reply telling a client their squat depth looks good but to brace harder before the descent.",
    current: "nvidia/nemotron-3-ultra-550b-a55b",
    cheaper: "nvidia/nemotron-3-super-120b-a12b",
  },
];

function loadCandidates() {
  try { if (existsSync(CAND_PATH)) { const j = JSON.parse(readFileSync(CAND_PATH, "utf8")); if (Array.isArray(j) && j.length) return j; } } catch { /* */ }
  return DEFAULT_CANDIDATES;
}
const CANDIDATES = loadCandidates();
const safe = (s) => String(s).replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40);

// Set a dot-path value inside a parsed object (e.g. "profiles.email-check.drafter.model").
function setPath(obj, path, value) {
  const keys = String(path).split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (o == null || typeof o !== "object") return false; o = o[keys[i]]; }
  if (o == null || typeof o !== "object") return false;
  o[keys[keys.length - 1]] = value;
  return true;
}

const schemas = {
  result: z.object({ candidate: z.string(), tier: z.enum(["current", "cheaper"]), model: z.string(), text: z.string() }),
  scores: z.object({
    scores: z.array(z.object({
      candidate: z.string(), tier: z.enum(["current", "cheaper"]), model: z.string(),
      scorePct: z.number().min(0).max(100), rationale: z.string(),
    })),
  }),
  decision: z.object({
    downgrades: z.array(z.object({ task: z.string(), from: z.string(), to: z.string(), currentScore: z.number(), cheaperScore: z.number(), applyTo: z.string().nullable().optional() })),
    held: z.array(z.string()),
    summary: z.string(),
  }),
  apply: z.object({ status: z.enum(["applied", "shadow-logged", "blocked"]), applied: z.number(), detail: z.string() }),
  report: z.object({ proposed: z.number(), summary: z.string(), applied: z.boolean() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Parallel, Branch, Approval, outputs } = api;

export default smithers((ctx) => {
  const results = ctx.outputs.result ?? [];
  const allScores = (ctx.outputs.scores ?? []).slice(-1)[0]?.scores ?? [];
  const decisions = ctx.outputs.decision ?? [];
  const lastDecision = decisions[decisions.length - 1];
  const proposeCount = lastDecision?.downgrades?.length ?? 0;

  // Phase 1 (Parallel, static from candidates): answer each fixture with both the
  // current and the cheaper model. continueOnFail → one dead model can't sink it.
  const produce = [];
  CANDIDATES.forEach((c, i) => {
    for (const tier of ["current", "cheaper"]) {
      const model = c[tier];
      produce.push(
        <Task key={`p-${i}-${tier}`} id={`gen-${i}-${tier}-${safe(model)}`} output={outputs.result}
          agent={pickAgent("draft", { backend: "nemotron", model })}
          {...taskOpts("draft", { continueOnFail: true })}>
          {`${c.fixture}\n\nRespond directly. Then return JSON { candidate: "${c.task}", tier: "${tier}", model: "${model}", text: "<your answer>" }.`}
        </Task>,
      );
    }
  });

  return (
    <Workflow name="chad-token-optimize">
      <Sequence>
        <Parallel>{produce}</Parallel>

        {/* Single capable judge scores EVERY produced answer (the fan-in pattern,
            like fusion's judge) — avoids dynamic fan-out after a phase. */}
        <Task id="judge" output={outputs.scores}
          agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
          {[
            "You are deciding whether a CHEAPER model is good enough to replace a pricier one for a task.",
            "Score EACH answer below 0-100 on quality (correctness, tone, completeness). Judge the answer, not the model name.",
            `Answers (JSON):\n${JSON.stringify(results)}`,
            'Return JSON { scores: [{ candidate, tier, model, scorePct (0-100 integer), rationale (one sentence) }] } — one entry per input answer.',
          ].join("\n\n")}
        </Task>

        {/* Decide: a downgrade is proposed when cheaper >= BAR and within TOLERANCE
            of current. Deterministic + auditable (no LLM). */}
        <Task id="decide" output={outputs.decision}>
          {() => {
            const byCand = {};
            for (const s of allScores) {
              if (!s || typeof s.scorePct !== "number" || Number.isNaN(s.scorePct)) continue;
              (byCand[s.candidate] ??= {})[s.tier] = s.scorePct;
            }
            const downgrades = [], held = [];
            for (const c of CANDIDATES) {
              const cur = byCand[c.task]?.current, ch = byCand[c.task]?.cheaper;
              if (cur == null || ch == null) { held.push(`${c.task} (incomplete scores)`); continue; }
              if (ch >= BAR && ch >= cur - TOLERANCE) downgrades.push({ task: c.task, from: c.current, to: c.cheaper, currentScore: cur, cheaperScore: ch, applyTo: c.applyTo || null });
              else held.push(`${c.task} (cheaper ${ch} vs current ${cur}; bar ${BAR})`);
            }
            return { downgrades, held, summary: `${downgrades.length} downgrade(s) proposed, ${held.length} held` };
          }}
        </Task>

        {/* Apply — gated by needsApproval when downgrades are proposed (human
            sign-off; pauses the run as waiting-approval). Shadow unless
            CHAD_TOKENOPT_APPLY=1; snapshots task-profiles.json first; writes only
            downgrades that carry an applyTo dot-path (advisory candidates logged). */}
        <Task id="apply" output={outputs.apply} needsApproval={proposeCount > 0} sideEffect idempotencyKey={`tokenopt-apply-${new Date().toISOString().slice(0, 10)}`}>
          {() => {
            const d = decisions[decisions.length - 1] ?? { downgrades: [] };
            const appliable = (d.downgrades || []).filter((x) => x.applyTo);
            if (!appliable.length) return { status: "shadow-logged", applied: 0, detail: `no downgrades with an applyTo path (${(d.downgrades || []).length} proposed)` };
            if (!APPLY) return { status: "shadow-logged", applied: 0, detail: `SHADOW: would set ${appliable.map((x) => `${x.applyTo}=${x.to.split("/").pop()}`).join("; ")} (set CHAD_TOKENOPT_APPLY=1 to write)` };
            try {
              const tp = JSON.parse(readFileSync(TASK_PROFILES, "utf8"));
              copyFileSync(TASK_PROFILES, `${TASK_PROFILES}.bak.${Date.now()}`); // snapshot before mutate
              let n = 0;
              for (const x of appliable) { if (setPath(tp, x.applyTo, x.to)) n++; }
              writeFileSync(TASK_PROFILES, JSON.stringify(tp, null, 2) + "\n");
              return { status: "applied", applied: n, detail: `set ${appliable.map((x) => `${x.applyTo}→${x.to.split("/").pop()}`).join("; ")} (snapshot saved alongside)` };
            } catch (e) { return { status: "blocked", applied: 0, detail: `apply failed: ${String(e.message || e).slice(0, 200)}` }; }
          }}
        </Task>

        <Task id="report" output={outputs.report}>
          {() => {
            const d = decisions[decisions.length - 1] ?? { downgrades: [], summary: "no decision" };
            const ap = (ctx.outputs.apply ?? []).slice(-1)[0];
            return { proposed: d.downgrades?.length ?? 0, summary: `${d.summary} · apply: ${ap?.status || "n/a"} (${ap?.applied || 0})`, applied: ap?.status === "applied" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
