/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// issue-triage.jsx — chad-issue-triage as a durable Smithers workflow (#15/#23).
//
// The "high-quality bug signal" loop: Chad reports bugs with state attached,
// humans triage + react/label, Chad picks the high-signal ones the next day and
// spawns sub-agents to PROPOSE fixes (draft-only — never opens a PR here).
//
// Why port it: it's the canonical MULTI-STEP, MULTI-SPAWN flow. As a Smithers
// workflow it gains: a durable record per spawn (resume after a crash without
// re-running finished spawns), the live dashboard task tree, and the ability to
// fan the per-issue spawns onto GH runners via the bridge (substrate: "gha").
//
// Pipeline:  fetch (read-only gh) → score+select (deterministic) →
//            Parallel[ spawn researcher per top-N issue ]  → report (OpenWebUI note)
//
// Shadow-safe: gh access is read-only (list/view); the spawns route through
// lib/spawn.js's bridge, which stubs when no chad-spawn transport is present, so
// `smithers up workflows/issue-triage.jsx` on a bare host produces a visible run
// with no real spawns. Set CHAD_SPAWN_SSH=openshell-chad to run real pod spawns,
// or CHAD_SPAWN_STUB=1 to force shadow.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { runSpawn, scoreIssue, route, spawnResultSchema } from "../lib/spawn.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_TRIAGE_DB || "./issue-triage.db";
const REPO = process.env.CHAD_TRIAGE_REPO || "tantodefi/NemoClaw";
const TOP = Number(process.env.CHAD_TRIAGE_TOP || 2);
const LABEL = process.env.CHAD_TRIAGE_LABEL || ""; // optional filter
const SUBSTRATE = process.env.CHAD_TRIAGE_SUBSTRATE || "gha"; // heavy/isolated → GH runner
const POST = process.env.CHAD_TRIAGE_POST === "1"; // post the report as an OpenWebUI note
// Cap a wedged spawn: runSpawn has no internal ssh timeout, and the chad tunnel
// has a half-open history — so bound each spawn task and don't auto-retry it.
const SPAWN_TIMEOUT = Number(process.env.CHAD_SPAWN_TIMEOUT_MS || 1_800_000); // 30 min

const schemas = {
  issues: z.object({ fetched: z.number(), selected: z.array(z.object({
    number: z.number(), title: z.string(), score: z.number(), kind: z.string(),
  })) }),
  spawn: spawnResultSchema,
  report: z.object({ note: z.string(), spawned: z.number() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Parallel, outputs } = api;

function gh(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });
}

export const workflow = smithers((ctx) => {
  const selected = (ctx.outputs.issues ?? [])[0]?.selected ?? [];
  const spawnResults = ctx.outputs.spawn ?? [];

  return (
    <Workflow name="chad-issue-triage">
      <Sequence>
        {/* 1) Fetch + score + select. Deterministic, read-only, no LLM. */}
        <Task id="select" output={outputs.issues} sideEffect idempotencyKey={`triage-${REPO}-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const args = ["issue", "list", "--repo", REPO, "--state", "open", "--limit", "50",
              "--json", "number,title,labels,reactionGroups,createdAt"];
            if (LABEL) args.push("--label", LABEL);
            const raw = await gh(args);
            let issues = [];
            try { issues = raw ? JSON.parse(raw) : []; } catch { issues = []; }
            const scored = issues.map((i) => {
              const reactions = (i.reactionGroups || []).reduce((n, g) => n + (g.users?.totalCount || 0), 0);
              const s = scoreIssue({ labels: i.labels, reactions: { total_count: reactions }, createdAt: i.createdAt });
              return { number: i.number, title: i.title || "", score: s, kind: route(`${i.title}\n${(i.labels || []).map((l) => l.name).join(" ")}`, { default: "researcher" }) };
            }).sort((a, b) => b.score - a.score).slice(0, TOP);
            return { fetched: issues.length, selected: scored };
          }}
        </Task>

        {/* 2) Spawn one sub-agent per selected issue, in parallel, each durable.
            Routed kind (coder/researcher/...) decides the binary; substrate gha
            fans the work onto a fresh GH runner via the chad-spawn bridge. */}
        <Parallel>
          {selected.map((iss) => (
            <Task key={`iss-${iss.number}`} id={`spawn-${iss.number}`} output={outputs.spawn}
              sideEffect idempotencyKey={`spawn-iss-${iss.number}`}
              continueOnFail retries={0} timeoutMs={SPAWN_TIMEOUT}>
              {() => runSpawn({
                kind: iss.kind,
                substrate: SUBSTRATE,
                id: `triage-iss-${iss.number}`,
                task: `Propose a fix for ${REPO}#${iss.number}: ${iss.title}\n\n` +
                  `Read the issue with: gh issue view ${iss.number} --repo ${REPO}\n` +
                  `Draft a patch + explanation. DO NOT open a PR or comment — draft only; ` +
                  `write your proposal to the workdir. Last stdout line = result.json.`,
              })}
            </Task>
          ))}
        </Parallel>

        {/* 3) Report: a single OpenWebUI-ready note summarizing what was spawned. */}
        <Task id="report" output={outputs.report} sideEffect idempotencyKey={`triage-report-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const lines = spawnResults.map((r) => `- ${r.kind} [${r.status}] ${r.summary || ""}`.trim());
            const note = `# Issue triage — ${new Date().toISOString().slice(0, 10)}\n\n` +
              `Repo: ${REPO} · selected ${selected.length} of top ${TOP}\n\n` +
              (lines.length ? lines.join("\n") : "_no spawns_");
            if (POST) await postNote({ title: `Issue triage — ${REPO} — ${new Date().toISOString().slice(0, 10)}`, content: note, tags: "chad-triage" });
            return { note, spawned: spawnResults.length };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
