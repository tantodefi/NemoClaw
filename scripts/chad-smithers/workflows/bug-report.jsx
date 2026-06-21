/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// bug-report.jsx — Chad catches his OWN bugs and self-reports them as GitHub issues.
//
// Collect (deterministic): scan the workspace smithers DBs for FAILED runs + failed
// task nodes (error_json) — i.e. Chad's own workflows erroring — plus host
// service-log errors. Cluster them into distinct bugs (capable model), drop ones
// already filed (gh issue list), gate behind an Approval, then `gh issue create`.
//
// Shadow by default: issues are filed only when CHAD_BUGREPORT_POST=1 AND the
// operator approves. Read-only gh (list) is always safe; create is the sole
// mutation and it's gated twice (approval + the POST flag). Repo via
// CHAD_BUGREPORT_REPO (default tantodefi/NemoClaw). Uses the sqlite3 CLI (not
// bun:sqlite) so it runs identically under node or bun.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";

const DB = process.env.CHAD_BUGREPORT_DB || "./bug-report.db";
const REPO = process.env.CHAD_BUGREPORT_REPO || "tantodefi/NemoClaw";
const POST = process.env.CHAD_BUGREPORT_POST === "1";
const LABEL = process.env.CHAD_BUGREPORT_LABEL || "chad-bug";
const MAX_BUGS = Number(process.env.CHAD_BUGREPORT_MAX || 3);
const WINDOW_H = Number(process.env.CHAD_BUGREPORT_WINDOW_H || 48); // only surface failures from the last N hours
const LOG_DIR = process.env.CHAD_LOGDIGEST_DIR || `${homedir()}/.nemoclaw/openwebui`;

const schemas = {
  collected: z.object({ failedRuns: z.number(), failedNodes: z.number(), errorLines: z.number(), sample: z.string() }),
  bugs: z.object({
    bugs: z.array(z.object({ title: z.string(), body: z.string(), severity: z.enum(["low", "medium", "high"]), signature: z.string() })),
    summary: z.string(),
  }),
  dedup: z.object({
    fresh: z.array(z.object({ title: z.string(), body: z.string(), severity: z.string(), signature: z.string() })),
    known: z.array(z.string()), summary: z.string(),
  }),
  report: z.object({ status: z.enum(["posted", "shadow-logged", "quiet", "blocked"]), posted: z.number(), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Branch, Approval, outputs } = api;

function exec(cmd, args, opts = {}) {
  return new Promise((res) => execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (e, o) => res(e ? "" : o.toString())));
}
const sqlite = (db, sql) => exec("sqlite3", [db, sql]);

async function collectFailures() {
  let failedRuns = 0, failedNodes = 0, errorLines = 0;
  const lines = [];
  let dbs = [];
  try { dbs = readdirSync(".").filter((x) => x.endsWith(".db") && x !== "smithers.db"); } catch { /* */ }
  const cutoff = Date.now() - WINDOW_H * 3600 * 1000; // recent failures only
  for (const f of dbs) {
    const runs = await sqlite(f, `SELECT substr(run_id,1,8)||' '||workflow_name||': '||COALESCE(error_json,'') FROM _smithers_runs WHERE status IN ('failed','errored') AND COALESCE(finished_at_ms,created_at_ms,0) > ${cutoff} LIMIT 20;`);
    for (const ln of runs.split("\n").filter(Boolean)) { failedRuns++; lines.push(`run ${f}: ${ln.slice(0, 220)}`); }
    const nodes = await sqlite(f, `SELECT node_id||': '||COALESCE(error_json,'') FROM _smithers_attempts WHERE state IN ('failed','errored') AND error_json IS NOT NULL AND COALESCE(finished_at_ms,started_at_ms,0) > ${cutoff} LIMIT 20;`);
    for (const ln of nodes.split("\n").filter(Boolean)) { failedNodes++; lines.push(`node ${f}: ${ln.slice(0, 220)}`); }
  }
  try {
    for (const lf of readdirSync(LOG_DIR).filter((x) => x.endsWith(".log"))) {
      try {
        for (const ln of readFileSync(`${LOG_DIR}/${lf}`, "utf8").split("\n").slice(-60)) {
          if (/error|exception|traceback|fatal|refused|unhandled/i.test(ln)) { errorLines++; if (lines.length < 200) lines.push(`${lf}: ${ln.slice(0, 200)}`); }
        }
      } catch { /* */ }
    }
  } catch { /* */ }
  return { failedRuns, failedNodes, errorLines, sample: lines.slice(0, 120).join("\n").slice(0, 8000) };
}

// crude title-similarity for dedupe (shared significant words)
function similar(a, b) {
  if (!a || !b) return false;
  const A = new Set(String(a).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let hits = 0;
  for (const w of String(b).toLowerCase().split(/\W+/)) if (w.length > 3 && A.has(w)) hits++;
  return hits >= 3;
}

export default smithers((ctx) => {
  const collected = (ctx.outputs.collected ?? [])[0];
  const bugSet = (ctx.outputs.bugs ?? [])[0];
  const deduped = (ctx.outputs.dedup ?? [])[0];
  // Smithers stores multi-word compute-output keys as snake_case columns and reads
  // them back snake_case, so accept either form.
  const num = (o, a, b) => Number(o?.[a] ?? o?.[b] ?? 0) || 0;
  const hasSignal = (num(collected, "failedRuns", "failed_runs") + num(collected, "failedNodes", "failed_nodes") + num(collected, "errorLines", "error_lines")) > 0;
  const fresh = deduped?.fresh ?? [];

  return (
    <Workflow name="chad-bug-report">
      <Sequence>
        <Task id="collect" output={outputs.collected}>
          {() => collectFailures()}
        </Task>

        {/* hasSignal/fresh gating is per-task skipIf + needsApproval — a
            `<Branch if={upstreamOutput}>` does NOT reopen once the gating task
            completes (verified), so the whole pipeline is linear with skipIf. */}
        {/* Cluster the raw failures into distinct, well-formed bug reports. */}
        <Task id="analyze" skipIf={!hasSignal} output={outputs.bugs} agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
            {[
              `You are Chad's self-diagnostics. From these failure signals (Chad's OWN smithers runs/nodes + host service logs), identify at most ${MAX_BUGS} DISTINCT bugs.`,
              "For each bug: a concise GitHub issue title, a body (symptom · where it shows up · a hypothesis + suggested next step), a severity, and a short stable kebab 'signature' for dedupe.",
              `Failure signals:\n${collected?.sample || "(none)"}`,
              "Return JSON {bugs:[{title,body,severity,signature}], summary}. Merge repeats; do NOT invent failures that aren't in the signals.",
            ].join("\n\n")}
          </Task>

          {/* Drop bugs already filed as open issues (read-only gh). */}
          <Task id="dedup" skipIf={!hasSignal} output={outputs.dedup} sideEffect idempotencyKey={`bugdedup-${new Date().toISOString().slice(0, 10)}`}>
            {async () => {
              const bugs = bugSet?.bugs ?? [];
              if (!bugs.length) return { fresh: [], known: [], summary: "no bugs to dedup" };
              const raw = await exec("gh", ["issue", "list", "--repo", REPO, "--state", "open", "--limit", "100", "--json", "title"]);
              let existing = []; try { existing = raw ? JSON.parse(raw) : []; } catch { /* */ }
              const exTitles = existing.map((i) => String(i.title || "").toLowerCase());
              const freshOnes = [], known = [];
              for (const b of bugs) {
                const dup = exTitles.some((e) => (b.signature && e.includes(String(b.signature).toLowerCase())) || similar(e, b.title));
                if (dup) known.push(b.title); else freshOnes.push(b);
              }
              return { fresh: freshOnes, known, summary: `${freshOnes.length} new, ${known.length} already filed` };
            }}
          </Task>

          {/* Post — gated by needsApproval when there are new bugs (human sign-off);
              shadow unless CHAD_BUGREPORT_POST=1. The side-effect runs only after approval. */}
          <Task id="post" skipIf={!hasSignal} needsApproval={fresh.length > 0} output={outputs.report} sideEffect idempotencyKey={`bugpost-${new Date().toISOString().slice(0, 10)}`}>
            {async () => {
              if (!fresh.length) return { status: "quiet", posted: 0, detail: `no new bugs (${deduped?.summary || "nothing to file"})` };
              if (!POST) return { status: "shadow-logged", posted: 0, detail: `SHADOW: would file ${fresh.length} issue(s): ${fresh.map((b) => b.title).join("; ").slice(0, 300)}` };
              let n = 0;
              for (const b of fresh) {
                const body = `${b.body}\n\n---\n_Auto-filed by Chad's bug-report workflow — severity ${b.severity}, signature \`${b.signature}\`. Review before acting._`;
                const out = await exec("gh", ["issue", "create", "--repo", REPO, "--title", b.title, "--body", body, "--label", LABEL]);
                if (out) n++;
              }
              return { status: n ? "posted" : "blocked", posted: n, detail: `filed ${n} of ${fresh.length} on ${REPO}` };
            }}
          </Task>
      </Sequence>
    </Workflow>
  );
});
