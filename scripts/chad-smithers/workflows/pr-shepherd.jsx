/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// pr-shepherd.jsx — keep open PRs moving. Tracks every open PR, decides the ONE
// next action per PR deterministically (lib/pr.js — no LLM for routing, cheap +
// reliable, the same principle as issue-triage's scoreIssue), then writes ONE
// human-readable digest ("what's blocked on whom"). Completes the issue→PR half of
// the self-improvement loop alongside issue-triage.
//
// Pipeline:  fetch open PRs (read-only gh) → triage (deterministic prAction) →
//            digest (one cheap-tier summary) → report (shadow / OpenWebUI note)
//
// Shadow-safe: read-only `gh pr list`; never comments, labels, merges, or closes.
// The digest is advisory. `smithers up workflows/pr-shepherd.jsx` on a bare host
// produces a visible run + a drafted digest with nothing written to GitHub.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { prAction, shepherdSummary, PR_ACTIONS } from "../lib/pr.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_PRSHEP_DB || "./pr-shepherd.db";
const REPO = process.env.CHAD_PRSHEP_REPO || "tantodefi/NemoClaw";
const STALE_DAYS = Number(process.env.CHAD_PRSHEP_STALE_DAYS || 3);
const POST = process.env.CHAD_PRSHEP_POST === "1";

const schemas = {
  triage: z.object({
    open: z.number(),
    decisions: z.array(z.object({
      number: z.number(), title: z.string(),
      action: z.enum(PR_ACTIONS), reason: z.string(),
    })),
    counts: z.record(z.string(), z.number()),
  }),
  digest: z.object({ headline: z.string(), body: z.string() }),
  report: z.object({ note: z.string(), open: z.number(), mergeReady: z.number() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

function gh(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout.toString()));
  });
}

export const workflow = smithers((ctx) => {
  const triage = (ctx.outputs.triage ?? [])[0];
  const digest = (ctx.outputs.digest ?? [])[0];
  const hasOpen = (triage?.open ?? 0) > 0;

  return (
    <Workflow name="chad-pr-shepherd">
      <Sequence>
        {/* 1) Fetch + triage. Read-only gh; the per-PR action is DETERMINISTIC
            (lib/pr.js), so no model is spent deciding — only summarizing later. */}
        <Task id="triage" output={outputs.triage} sideEffect idempotencyKey={`prshep-${REPO}-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const raw = await gh(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "50",
              "--json", "number,title,isDraft,mergeable,reviewDecision,statusCheckRollup,updatedAt"]);
            let prs = []; try { prs = raw ? JSON.parse(raw) : []; } catch { prs = []; }
            const decisions = prs.map((p) => prAction(p, { staleDays: STALE_DAYS }));
            return { open: prs.length, decisions, counts: shepherdSummary(decisions) };
          }}
        </Task>

        {/* 2) Digest — one cheap-tier call turns the deterministic decisions into a
            readable "what's blocked on whom". Skipped when there are no open PRs. */}
        <Task id="digest" skipIf={!hasOpen} output={outputs.digest}
          agent={pickAgent("summarize")} fallbackAgent={pickFallback("summarize")} {...taskOpts("summarize")}>
          {[
            `Summarize the state of ${REPO}'s ${triage?.open ?? 0} open PRs for the operator.`,
            "Lead with what's merge-ready and what's blocked on the operator (changes-requested, stale-nudge).",
            "Group by action; be terse; name PR numbers. No fluff.",
            `Counts by action: ${JSON.stringify(triage?.counts || {})}`,
            `Decisions:\n${JSON.stringify(triage?.decisions || [], null, 1)}`,
            "Return JSON { headline (one line), body (markdown) }.",
          ].join("\n\n")}
        </Task>

        {/* 3) Report — advisory. Shadow by default; reversible note when POST=1.
            Never touches the PRs themselves. */}
        <Task id="report" output={outputs.report} sideEffect idempotencyKey={`prshep-report-${REPO}-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const mergeReady = triage?.counts?.["merge-ready"] || 0;
            if (!hasOpen) return { note: `no open PRs in ${REPO}`, open: 0, mergeReady: 0 };
            const title = `PR shepherd — ${REPO} — ${triage.open} open, ${mergeReady} merge-ready`;
            const body = `# ${title}\n\n**${digest?.headline || ""}**\n\n${digest?.body || ""}`;
            if (POST) await postNote({ title, content: body, tags: "chad-pr-shepherd" });
            return { note: POST ? `${title} (posted)` : `SHADOW: ${title}`, open: triage.open, mergeReady };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
