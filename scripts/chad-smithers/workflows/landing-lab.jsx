/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// landing-lab.jsx — generate GROUNDED landing-page variations from the repo/docs and
// compare them. Unlike a copy re-skin: nemotron reads the real technical source of
// truth (README + supachad docs) and distills a grounded FACT SHEET (claim → source);
// opencode big-pickle then writes several DISTINCT landing pages using ONLY those
// facts; nemotron compares the variants and flags any claim not backed by the docs.
//
//   factsheet  (nemotron)       read the docs → grounded claims (claim → source)
//   generate   (opencode ×N)    each variant writes index.html in its OWN dir from a
//                               distinct angle, grounded ONLY in the fact sheet
//   compare    (nemotron judge) rank on accuracy-to-facts / clarity / appeal; flag
//                               any unbacked/hallucinated claim
//   report     (ping + gate)    Moshi ping + Approval gate (never touches the live repo)
//
// Grounding rides in the PROMPT (the fact sheet), not opencode file reads — opencode
// --pure auto-rejects reading dirs outside its cwd, so each variant only writes into
// its own empty subdir under CHAD_LAB_WORKDIR. The live supachad-landing is untouched.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { runOpencodeDirect } from "../lib/opencode.js";
import { moshiPing } from "../lib/notify.js";

const DB = process.env.CHAD_LAB_DB || "./landing-lab.db";
const WORKDIR = process.env.CHAD_LAB_WORKDIR || "/tmp/landing-lab";
const NEMO_ROOT = process.env.CHAD_LAB_REPO || "/Users/r/.nemoclaw";
const SOURCES = (process.env.CHAD_LAB_SOURCES || [
  "source/README.md", "supachad-docs/docs/intro.md", "supachad-docs/docs/architecture.md",
  "supachad-docs/docs/memory.md", "supachad-docs/docs/front-ends.md", "supachad-docs/docs/self-improvement.md",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const ANGLES = (process.env.CHAD_LAB_ANGLES || "developer & technical depth|founder & outcomes")
  .split("|").map((s) => s.trim()).filter(Boolean);
const POST = process.env.CHAD_LAB_POST === "1";
const SPAWN_TIMEOUT = Number(process.env.CHAD_SPAWN_TIMEOUT_MS || 1_800_000);

const schemas = {
  facts: z.object({
    product: z.string(),
    claims: z.array(z.object({ claim: z.string(), source: z.string() })),
    differentiators: z.array(z.string()),
    audiences: z.array(z.string()),
  }),
  variant: z.object({ angle: z.string(), file: z.string(), status: z.string(), summary: z.string() }),
  comparison: z.object({
    ranking: z.array(z.object({ angle: z.string(), score: z.number(), why: z.string() })),
    unbacked_claims: z.array(z.string()),
    recommendation: z.string(),
  }),
  report: z.object({ note: z.string(), variants: z.number(), flagged: z.number() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Parallel, outputs } = api;

// Workflow-side read of the truth docs (allowed — not opencode). Capped for prompt.
function sourceDigest(cap = 60000) {
  let out = "";
  for (const rel of SOURCES) {
    try { out += `\n\n===== ${rel} =====\n` + readFileSync(join(NEMO_ROOT, rel), "utf8"); } catch { /* */ }
    if (out.length > cap) break;
  }
  return out.slice(0, cap);
}

export const workflow = smithers((ctx) => {
  const facts = (ctx.outputs.facts ?? [])[0];
  const variants = ctx.outputs.variant ?? [];
  const comparison = (ctx.outputs.comparison ?? [])[0];

  return (
    <Workflow name="chad-landing-lab">
      <Sequence>
        {/* 1) Factsheet — nemotron reads the real docs and distills grounded claims
            (each tied to a source). This is the ONLY thing variants may claim. */}
        <Task id="factsheet" output={outputs.facts}
          agent={pickAgent("optimize")} fallbackAgent={pickFallback("optimize")} {...taskOpts("optimize")}>
          {[
            "Extract a GROUNDED fact sheet for the product 'Supachad' (aka Chad) from these real docs.",
            "Every claim must be supported by the docs — cite the source file. Do NOT invent capabilities.",
            "Return JSON { product, claims:[{claim, source}], differentiators:[...], audiences:[...] }.",
            "", "SOURCE DOCS:", sourceDigest(),
          ].join("\n")}
        </Task>

        {/* 2) Generate N grounded variations. Each opencode variant writes index.html
            in its OWN empty subdir (cwd write — allowed under --pure) using ONLY the
            fact sheet passed in the prompt (no external doc reads). Distinct angles. */}
        <Parallel maxConcurrency={1}>
          {ANGLES.map((angle, i) => (
            <Task key={`v${i}`} id={`gen-${i}`} output={outputs.variant} sideEffect
              idempotencyKey={`lab-gen-${i}-${new Date().toISOString().slice(0, 10)}`}
              continueOnFail retries={0} timeoutMs={SPAWN_TIMEOUT}>
              {async () => {
                const vdir = join(WORKDIR, `variant-${i + 1}`);
                mkdirSync(vdir, { recursive: true });
                const r = await runOpencodeDirect({
                  id: `lab-v${i + 1}`, workdir: vdir, timeoutMs: SPAWN_TIMEOUT,
                  task: [
                    `Write index.html in the current directory — a standalone landing page for Supachad with this ANGLE: "${angle}".`,
                    "Write your OWN marketing copy, but state ONLY capabilities/claims present in the grounded fact sheet below. Do NOT invent features.",
                    "Single file index.html, inline CSS, dark modern design, no external dependencies. Then stop.",
                    "", "GROUNDED FACT SHEET (the only facts you may claim):", JSON.stringify(facts ?? {}, null, 2),
                  ].join("\n"),
                });
                return { angle, file: join(vdir, "index.html"), status: r.status, summary: (r.summary || "").slice(0, 300) };
              }}
            </Task>
          ))}
        </Parallel>

        {/* 3) Compare — nemotron ranks the variants and flags any claim NOT supported
            by the fact sheet (the grounding check that makes this valuable). */}
        <Task id="compare" skipIf={variants.length < 1} output={outputs.comparison}
          agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
          {[
            "Compare these Supachad landing-page variants. Score each 0-100 on: accuracy-to-facts (claims backed by the fact sheet), clarity, appeal.",
            "CRUCIAL: list any claim a variant makes that is NOT supported by the fact sheet (hallucinated/unbacked).",
            `Grounded fact sheet:\n${JSON.stringify(facts ?? {}, null, 2)}`,
            `Variants:\n${JSON.stringify(variants.map((v) => ({ angle: v.angle, status: v.status, summary: v.summary })), null, 2)}`,
            "Return JSON { ranking:[{angle, score, why}], unbacked_claims:[...], recommendation }.",
          ].join("\n\n")}
        </Task>

        {/* 4) Report — Moshi ping + Approval gate. Advisory; never publishes. */}
        <Task id="report" needsApproval output={outputs.report} sideEffect idempotencyKey={`lab-report-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const flagged = (comparison?.unbacked_claims || []).length;
            const top = comparison?.ranking?.slice().sort((a, b) => b.score - a.score)[0];
            const title = `Landing lab — ${variants.length} grounded variants`;
            const msg = `top: ${top?.angle || "?"} (${top?.score ?? "?"}) · ${flagged} unbacked claim(s) · review at the gate`;
            const body = `# ${title}\n\n${comparison?.recommendation || ""}\n\n` +
              (comparison?.ranking || []).map((r) => `- **${r.angle}** — ${r.score}: ${r.why}`).join("\n") +
              (flagged ? `\n\n**Unbacked claims:**\n` + comparison.unbacked_claims.map((c) => `- ${c}`).join("\n") : "\n\n_all claims backed by the docs_");
            await moshiPing(title, msg);
            if (POST) { try { const { postNote } = await import("../lib/note.js"); await postNote({ title, content: body, tags: "chad-landing-lab" }); } catch { /* */ } }
            return { note: body.slice(0, 500), variants: variants.length, flagged };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
