/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// code-review-loop.jsx — iterate a code review to convergence, using Smithers'
// built-in <ReviewLoop> composite (adopted in the 0.26 upgrade — this is the
// framework's own producer→review→improve loop with a durable per-iteration
// record, not a hand-rolled Loop).
//
// Pipeline:  fetch PR diff (read-only gh) →
//            ReviewLoop[ producer drafts/refines a review → reviewer judges
//                        `approved` ; repeat until approved or maxIterations ] →
//            report (shadow: log; CHAD_CODEREVIEW_POST=1 → OpenWebUI note)
//
// Shadow-safe: gh access is read-only (`pr diff`/`pr view`); the loop never posts
// a PR comment or pushes — it produces a review draft. `smithers up
// workflows/code-review-loop.jsx --input '{"repo":"o/r","pr":123}'` on a bare host
// produces a visible run and a drafted review; nothing lands on GitHub.

import { createSmithers, ReviewLoop } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent } from "../agents.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_CODEREVIEW_DB || "./code-review-loop.db";
const REPO = process.env.CHAD_CODEREVIEW_REPO || "tantodefi/NemoClaw";
const MAX_ITERS = Number(process.env.CHAD_CODEREVIEW_MAX_ITERS || 3);
const POST = process.env.CHAD_CODEREVIEW_POST === "1"; // post the review as a note
const DIFF_CAP = Number(process.env.CHAD_CODEREVIEW_DIFF_CAP || 24000); // prompt budget

const schemas = {
  diff: z.object({ pr: z.number(), files: z.number(), patch: z.string() }),
  // ReviewLoop's producer output — a code review draft.
  review: z.object({
    findings: z.array(z.object({
      severity: z.enum(["blocker", "warning", "nit"]),
      file: z.string(),
      note: z.string(),
    })),
    summary: z.string(),
  }),
  // ReviewLoop's reviewer output — MUST include `approved: boolean`.
  verdict: z.object({
    approved: z.boolean(),
    reason: z.string(),
  }),
  report: z.object({ note: z.string(), approved: z.boolean(), findings: z.number() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

function gh(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout.toString()));
  });
}

export const workflow = smithers((ctx) => {
  const pr = Number(ctx.input?.pr || process.env.CHAD_CODEREVIEW_PR || 0);
  const diff = (ctx.outputs.diff ?? [])[0];
  const review = (ctx.outputs.review ?? [])[0];
  const verdict = (ctx.outputs.verdict ?? [])[0];
  const hasDiff = (diff?.patch || "").length > 0;

  return (
    <Workflow name="chad-code-review-loop">
      <Sequence>
        {/* 1) Fetch the PR diff. Read-only gh; deterministic, no LLM. */}
        <Task id="fetch" output={outputs.diff} sideEffect idempotencyKey={`codereview-fetch-${REPO}-${pr}`}>
          {async () => {
            if (!pr) return { pr: 0, files: 0, patch: "" };
            const patch = (await gh(["pr", "diff", String(pr), "--repo", REPO])).slice(0, DIFF_CAP);
            const files = (patch.match(/^diff --git /gm) || []).length;
            return { pr, files, patch };
          }}
        </Task>

        {/* 2) Review → judge → refine, until the reviewer approves or we hit the
            cap. The producer (capable tier) drafts/refines the review; a distinct
            reviewer model judges whether it's complete + accurate. Skipped when
            there's no diff to review (bad PR ref / empty PR). */}
        <ReviewLoop
          id="cr"
          skipIf={!hasDiff}
          producer={pickAgent("implement")}
          reviewer={pickAgent("judge")}
          produceOutput={outputs.review}
          reviewOutput={outputs.verdict}
          maxIterations={MAX_ITERS}
          onMaxReached="return-last"
        >
          {[
            `You are reviewing ${REPO}#${pr}. Produce a rigorous code review of this diff.`,
            "Flag correctness bugs, security/trust-boundary issues, and conditional side effects first;",
            "then reuse/simplification opportunities. Be specific: cite the file and the concrete problem.",
            "If a prior review draft and reviewer feedback are in context, address the feedback and tighten the review.",
            `Return JSON { findings:[{severity: blocker|warning|nit, file, note}], summary }.`,
            "",
            `Diff (${diff?.files ?? 0} files):`,
            diff?.patch || "(no diff)",
          ].join("\n")}
        </ReviewLoop>

        {/* 3) Report — shadow by default; a reversible OpenWebUI note when POST=1.
            Never comments on the PR (draft-only contract). */}
        <Task id="report" output={outputs.report} sideEffect idempotencyKey={`codereview-report-${REPO}-${pr}`}>
          {async () => {
            if (!hasDiff) return { note: `no diff for ${REPO}#${pr}`, approved: false, findings: 0 };
            const findings = review?.findings || [];
            const title = `Code review — ${REPO}#${pr} — ${verdict?.approved ? "approved" : "changes requested"}`;
            const body = `# ${title}\n\n${review?.summary || ""}\n\n` +
              findings.map((f) => `- **[${f.severity}]** \`${f.file}\` — ${f.note}`).join("\n") +
              `\n\n_verdict: ${verdict?.approved ? "approved" : "needs work"} — ${verdict?.reason || ""}_`;
            if (POST) await postNote({ title, content: body, tags: "chad-code-review" });
            return { note: POST ? `${title} (posted)` : `SHADOW: ${title}`, approved: !!verdict?.approved, findings: findings.length };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
