/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// skill-improve.jsx — Chad proposes improvements to his OWN workflows/skills.
//
// Closes the "all skills up for improvement" gap: where experiments tunes prompts/
// models, self-improve tunes cron behavior, and bug-report files defects, this
// proposes ENHANCEMENTS to the durable workflows/skills themselves (robustness,
// performance, cost, features, docs). It NEVER edits source — it drafts proposals,
// gates on operator approval, and files them as GitHub enhancement issues for
// review + implementation. Shadow unless CHAD_SKILLIMPROVE_POST=1.
//
// Signal = the workflow inventory + the latest experiment leaderboard. Runs nightly.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";

const DB = process.env.CHAD_SKILLIMPROVE_DB || "./skill-improve.db";
const REPO = process.env.CHAD_SKILLIMPROVE_REPO || "tantodefi/NemoClaw";
const POST = process.env.CHAD_SKILLIMPROVE_POST === "1";
const LABEL = process.env.CHAD_SKILLIMPROVE_LABEL || "chad-skill-improve";
const MAX = Number(process.env.CHAD_SKILLIMPROVE_MAX || 3);

const schemas = {
  inventory: z.object({ workflows: z.string(), signal: z.string() }),
  proposals: z.object({
    proposals: z.array(z.object({
      target: z.string(), kind: z.enum(["robustness", "performance", "cost", "feature", "docs"]),
      change: z.string(), rationale: z.string(),
    })),
    summary: z.string(),
  }),
  filed: z.object({ status: z.enum(["filed", "shadow-logged", "quiet", "blocked"]), count: z.number(), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;
function exec(cmd, args, opts = {}) {
  return new Promise((r) => execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (e, o) => r(e ? "" : o.toString())));
}

function gatherInventory() {
  const here = new URL("./", import.meta.url).pathname;     // workflows/
  const parent = new URL("../", import.meta.url).pathname;  // chad-smithers/
  let wf = [];
  try { wf = wf.concat(readdirSync(here).filter((f) => f.endsWith(".jsx")).map((f) => `workflows/${f}`)); } catch { /* */ }
  try { wf = wf.concat(readdirSync(parent).filter((f) => f.endsWith(".jsx"))); } catch { /* */ }
  let signal = "";
  try { const rp = new URL("../state/last-report.md", import.meta.url).pathname; if (existsSync(rp)) signal = readFileSync(rp, "utf8").slice(0, 3000); } catch { /* */ }
  return { workflows: [...new Set(wf)].sort().join(", "), signal: signal || "(no experiment report yet)" };
}

export default smithers((ctx) => {
  const inv = (ctx.outputs.inventory ?? [])[0];
  const proposed = (ctx.outputs.proposals ?? [])[0];
  const props = proposed?.proposals ?? [];

  return (
    <Workflow name="chad-skill-improve">
      <Sequence>
        <Task id="inventory" output={outputs.inventory}>
          {() => gatherInventory()}
        </Task>

        <Task id="propose" output={outputs.proposals} agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
          {[
            `You are improving Chad's OWN durable Smithers workflows/skills. Propose at most ${MAX} NARROW, concrete, high-leverage improvements.`,
            "For each: target (a workflow/skill file or area), kind (robustness/performance/cost/feature/docs), the concrete change, and why it helps. Favor low-risk, high-value changes.",
            `Workflow inventory: ${inv?.workflows || "(none)"}`,
            `Latest experiment signal:\n${inv?.signal || "(none)"}`,
            "Return JSON {proposals:[{target,kind,change,rationale}], summary}. Never propose removing anything load-bearing.",
          ].join("\n\n")}
        </Task>

        {/* File approved enhancements as GitHub issues. needsApproval gates on
            having proposals (human sign-off); shadow unless CHAD_SKILLIMPROVE_POST=1.
            Never edits source — proposals become tracked issues for review. */}
        <Task id="file" output={outputs.filed} needsApproval={props.length > 0} sideEffect idempotencyKey={`skillimprove-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            if (!props.length) return { status: "quiet", count: 0, detail: "no proposals" };
            if (!POST) return { status: "shadow-logged", count: 0, detail: `SHADOW: would file ${props.length} enhancement(s): ${props.map((p) => `${p.kind}:${p.target}`).join("; ").slice(0, 300)}` };
            let n = 0;
            for (const p of props) {
              const title = `[${p.kind}] ${p.target}: ${p.change}`.slice(0, 110);
              const body = `**Target:** ${p.target}\n**Kind:** ${p.kind}\n\n${p.change}\n\n_Rationale:_ ${p.rationale}\n\n---\n_Proposed by Chad's skill-improve workflow. Review before implementing._`;
              const out = await exec("gh", ["issue", "create", "--repo", REPO, "--title", title, "--body", body, "--label", LABEL]);
              if (out) n++;
            }
            return { status: n ? "filed" : "blocked", count: n, detail: `filed ${n} of ${props.length} on ${REPO}` };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
