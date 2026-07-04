/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// code-review-loop.jsx — iterate a code review to convergence with the <Loop>
// primitive and EXPLICIT context threading.
//
// NB (why not the <ReviewLoop> composite): ReviewLoop hardcodes the reviewer's
// prompt to a fixed string and only wires the produced work via `needs`, which is
// NOT injected into an agent's prompt — so the reviewer never actually sees the
// review (it reports "no work provided") and its `until` is hardcoded false (the
// loop can't converge on `approved`). We hand-roll produce→review over <Loop>
// instead, threading ctx.outputs both ways: the produced review INTO the judge's
// prompt, and the judge's prior feedback back INTO the producer's — the same
// deterministic ctx.outputs threading our other workflows use.
//
// Pipeline:  fetch PR diff (read-only gh) →
//            Loop until approved/max [ produce/refine review → judge {approved} ] →
//            report (shadow: log; CHAD_CODEREVIEW_POST=1 → OpenWebUI note)
//
// Shadow-safe: gh access is read-only (`pr diff`/`pr view`); the loop never posts
// a PR comment or pushes — it produces a review draft. `smithers up
// workflows/code-review-loop.jsx --input '{"repo":"o/r","pr":123}'` on a bare host
// produces a visible run and a drafted review; nothing lands on GitHub.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_CODEREVIEW_DB || "./code-review-loop.db";
const REPO = process.env.CHAD_CODEREVIEW_REPO || "tantodefi/NemoClaw";
const MAX_ITERS = Number(process.env.CHAD_CODEREVIEW_MAX_ITERS || 3);
const POST = process.env.CHAD_CODEREVIEW_POST === "1"; // post the review as a note
const DIFF_CAP = Number(process.env.CHAD_CODEREVIEW_DIFF_CAP || 24000); // prompt budget

const schemas = {
  diff: z.object({ pr: z.number(), files: z.number(), patch: z.string() }),
  // producer output — a code review draft (refined each iteration).
  review: z.object({
    findings: z.array(z.object({
      severity: z.enum(["blocker", "warning", "nit"]),
      file: z.string(),
      note: z.string(),
    })),
    summary: z.string(),
  }),
  // judge output — drives the loop's `until`; MUST include `approved: boolean`.
  verdict: z.object({
    approved: z.boolean(),
    reason: z.string(),
  }),
  report: z.object({ note: z.string(), approved: z.boolean(), findings: z.number() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Loop, outputs } = api;

function gh(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout.toString()));
  });
}

export const workflow = smithers((ctx) => {
  const pr = Number(ctx.input?.pr || process.env.CHAD_CODEREVIEW_PR || 0);
  const diff = (ctx.outputs.diff ?? [])[0];
  // review/verdict accumulate one row per loop iteration — take the LATEST so the
  // judge sees the review just produced and the producer sees the last feedback.
  const review = (ctx.outputs.review ?? []).slice(-1)[0];
  const verdict = (ctx.outputs.verdict ?? []).slice(-1)[0];
  const approved = !!verdict?.approved;
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

        {/* 2) Produce → judge → refine, until the judge approves or we hit the cap.
            The producer (capable) drafts/refines the review; a distinct judge model
            decides `approved` — which drives the Loop's `until`. Both prompts get
            the context they need EXPLICITLY (the fix vs the composite): the judge is
            handed the produced review, the producer is handed the prior feedback.
            Skipped when there's no diff (bad PR ref / empty PR). */}
        <Loop id="cr" skipIf={!hasDiff} until={approved} maxIterations={MAX_ITERS} onMaxReached="return-last">
          <Sequence>
            <Task id="cr-produce" output={outputs.review}
              agent={pickAgent("implement")} fallbackAgent={pickFallback("implement")} {...taskOpts("implement")}>
              {[
                `You are reviewing ${REPO}#${pr}. Produce a rigorous code review of this diff.`,
                "Flag correctness bugs, security/trust-boundary issues, and conditional side effects first;",
                "then reuse/simplification opportunities. Be specific: cite the file and the concrete problem.",
                verdict ? `A prior judge did NOT approve your last draft — feedback: "${verdict.reason}". Address it and tighten the review.` : "",
                review ? `Your prior draft (revise it, don't start over):\n${JSON.stringify(review)}` : "",
                "Return JSON { findings:[{severity: blocker|warning|nit, file, note}], summary }.",
                "",
                `Diff (${diff?.files ?? 0} files):`,
                diff?.patch || "(no diff)",
              ].filter(Boolean).join("\n")}
            </Task>
            <Task id="cr-judge" output={outputs.verdict}
              agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
              {[
                `Judge whether this code review of ${REPO}#${pr} is COMPLETE and ACCURATE: does it catch the real issues in the diff and miss nothing important?`,
                "Approve only if it's thorough and correct. If not, say specifically what's missing so the next pass can fix it.",
                `The review to judge:\n${JSON.stringify(review ?? {})}`,
                `The diff it must cover (${diff?.files ?? 0} files):\n${diff?.patch || "(no diff)"}`,
                "Return JSON { approved: boolean, reason: string }.",
              ].join("\n")}
            </Task>
          </Sequence>
        </Loop>

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
