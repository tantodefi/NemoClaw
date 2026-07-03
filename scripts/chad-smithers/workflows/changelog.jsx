/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// changelog.jsx — auto-draft a changelog entry from recent git history. The
// counterpart to the hand-edited supachad-docs changelog: Chad drafts the entry,
// a human approves the wording, then it's optionally posted.
//
// A deliberately PLAIN Sequence (not a composite): the shape is linear —
// gather → draft → Approval → post — and forcing a ReviewLoop/Debate here would
// add ceremony without value. Composites earn their place in code-review-loop
// (ReviewLoop), dependency-update (ScanFixVerify), debate (Debate), and
// canary-judge (Poller); this one is honest as a straight chain.
//
// Pipeline:  collect (read-only git log) → draft (capable tier) →
//            Approval (human signs off the wording) → post (shadow / note)
//
// Shadow-safe: git is read-only; the draft never writes to the changelog file —
// post is Approval-gated and shadow unless CHAD_CHANGELOG_POST=1.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_CHANGELOG_DB || "./changelog.db";
const SINCE = process.env.CHAD_CHANGELOG_SINCE || "7 days ago";
const REPO_DIR = process.env.CHAD_CHANGELOG_REPO_DIR || process.cwd();
const POST = process.env.CHAD_CHANGELOG_POST === "1";

const schemas = {
  commits: z.object({ count: z.number(), log: z.string() }),
  draft: z.object({
    heading: z.string(),
    entry: z.string(),   // markdown changelog body
    highlights: z.array(z.string()),
  }),
  post: z.object({ status: z.string(), title: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

function git(args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: REPO_DIR, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => resolve(out ? out.toString() : ""));
  });
}

export const workflow = smithers((ctx) => {
  const commits = (ctx.outputs.commits ?? [])[0];
  const draft = (ctx.outputs.draft ?? [])[0];
  const hasCommits = (commits?.count ?? 0) > 0;

  return (
    <Workflow name="chad-changelog">
      <Sequence>
        {/* 1) Collect recent commits (read-only). Conventional-Commit subjects. */}
        <Task id="collect" output={outputs.commits} sideEffect idempotencyKey={`changelog-collect-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const log = await git(["log", `--since=${SINCE}`, "--pretty=format:%h %s", "--no-merges"]);
            const lines = log.split("\n").filter(Boolean);
            return { count: lines.length, log: lines.join("\n").slice(0, 8000) };
          }}
        </Task>

        {/* 2) Draft the entry (capable tier), skipped when there's nothing to write. */}
        <Task id="draft" skipIf={!hasCommits} output={outputs.draft}
          agent={pickAgent("summarize")} fallbackAgent={pickFallback("summarize")} {...taskOpts("summarize")}>
          {[
            "Draft a changelog entry from these Conventional-Commit subjects. Group by theme, lead with",
            "user-facing changes, drop pure chore/ci noise. Match a terse, builder voice — no marketing.",
            "Return JSON { heading (e.g. '2026-07-02'), entry (markdown, one ### section), highlights:[3-5 bullets] }.",
            "",
            `Commits (${commits?.count ?? 0} since ${SINCE}):`,
            commits?.log || "(none)",
          ].join("\n")}
        </Task>

        {/* 3) Post — Approval-gated (human approves the wording), shadow unless
            CHAD_CHANGELOG_POST=1. Never edits the changelog file directly. */}
        <Task id="post" skipIf={!hasCommits} needsApproval output={outputs.post} sideEffect
          idempotencyKey={`changelog-post-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const title = `Changelog draft — ${draft?.heading || new Date().toISOString().slice(0, 10)}`;
            const body = `# ${title}\n\n${draft?.entry || ""}\n\n**Highlights:**\n` +
              (draft?.highlights || []).map((h) => `- ${h}`).join("\n");
            if (POST) await postNote({ title, content: body, tags: "chad-changelog" });
            return { status: POST ? "posted" : "shadow-logged", title: POST ? `${title} (posted)` : `SHADOW: ${title}` };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
