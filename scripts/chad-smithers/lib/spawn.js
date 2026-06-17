// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/spawn.js — the chad-spawn ⇄ Smithers bridge.
//
// The design-doc decision (#24) was: DON'T rebuild chad-spawn's GHA machinery.
// Instead let a Smithers workflow offload ONE step to the existing chad-spawn
// substrate and reconcile its `result.json` as that task's output. This module
// is that bridge. A workflow uses it as a durable, idempotent sideEffect task:
//
//   <Task id="fix-issue" output={outputs.spawn} sideEffect
//         idempotencyKey={`spawn-${issue.number}`}>
//     {() => runSpawn({ kind: "researcher", substrate: "gha", task, id: `iss-${issue.number}` })}
//   </Task>
//
// runSpawn NEVER throws — like chad-spawn itself, it always resolves to a
// result.json-shaped object (synthesizing a `failed`/`shadow-logged` result on
// any plumbing error) so a single bad spawn can't sink a durable run.
//
// ── Transports (resolved per call, in this order) ───────────────────────────
//   CHAD_SPAWN_STUB=1      → synthesize a shadow result, no real spawn. The
//                            default on a host with no SSH target + no local
//                            chad-spawn, so `smithers up` produces a visible
//                            dashboard run without burning GHA minutes.
//   CHAD_SPAWN_SSH=<host>  → ssh into the pod and run the real chad-spawn there
//                            (keeps L7 policy, budget, manifest semantics).
//                            scp is blocked in the sandbox, so the task is
//                            streamed in over stdin and the result streamed back
//                            via `ssh <host> cat` (see memory: sandbox scp).
//   (chad-spawn on PATH)   → exec locally (Smithers running inside the pod, or
//                            a host with the wrappers installed).
//
// Everything else is read from the kind manifest by chad-spawn itself; this
// bridge only passes through the few per-spawn overrides chad-spawn accepts.

import { z } from "zod";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── chad-route, ported verbatim from chad-route.sh ───────────────────────────
// Deterministic keyword router (NOT an LLM) so kind selection stays auditable
// and free. Highest weight wins; ties fall back to the default. Mirror any tune
// here back to chad-route.sh (and vice-versa) — they're meant to stay in sync.
export const ROUTE_PATTERNS = [
  ["brain", [
    /\b(remember|recall|what do you know|brain query|knowledge graph|entity|extract entities|store in brain|gbrain|put.?page|what.?know.?about)\b/i,
    /\b(summaris?e for memory|add to memory|memory entry|timeline|link entities)\b/i,
  ]],
  ["fitness", [
    /\b(squat|deadlift|bench press|overhead press|barbell|powerlifting|novice linear progression)\b/i,
    /\b(starting strength|supple leopard|rippetoe|starrett|hip hinge|brace|thoracic)\b/i,
    /\b(mobility|stretch|warmup|warm.?up|tissue|fascia|foam roll|lacrosse ball)\b/i,
    /\b(lift|lifting|form check|technique|cue|programming|sets?|reps?|load)\b/i,
  ]],
  ["coder", [
    /\b(implement|refactor|patch|fix|bug|diff|write code|rewrite|unit test|pytest|vitest|compile|build fail)\b/i,
    /\b(?:function|class|module|method)\s+\w+/i,
  ]],
  ["researcher", [
    /\b(research|find out|look ?up|search|investigate|what is|who is|when did|compare)\b/i,
    /\b(docs?|documentation|rfc|spec)\b/i,
  ]],
  ["writer", [
    /\b(draft|compose|write (?:an? )?(?:email|reply|comment|post|message|doc))\b/i,
    /\b(reply to|respond to)\b/i,
  ]],
  ["reviewer", [
    /\b(review|audit|checklist|inspect|evaluate|security scan|lint)\b/i,
    /\bPR\s*#?\d+/i,
  ]],
];

export function route(body, { default: def = "researcher" } = {}) {
  const text = String(body || "");
  let best = null;
  let bestScore = 0;
  for (const [kind, rxs] of ROUTE_PATTERNS) {
    let score = 0;
    for (const rx of rxs) {
      const m = text.match(new RegExp(rx.source, "gi"));
      if (m) score += m.length;
    }
    if (score > bestScore) { bestScore = score; best = kind; }
  }
  return bestScore === 0 ? def : best;
}

// ── result.json schema (chad-spawn's structured contract) ────────────────────
export const spawnResultSchema = z.object({
  status: z.enum(["done", "failed", "shadow-logged"]).catch("failed"),
  task_id: z.string().optional(),
  kind: z.string().optional(),
  exit_code: z.number().optional(),
  substrate: z.string().optional(),
  summary: z.string().optional(),
  files_touched: z.array(z.string()).optional(),
  follow_ups: z.array(z.string()).optional(),
}).passthrough();

const SPAWN_BIN = process.env.CHAD_SPAWN_BIN || "chad-spawn";

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, err, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

function binOnPath(bin) {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function resolveTransport() {
  if (process.env.CHAD_SPAWN_STUB === "1") return "stub";
  if (process.env.CHAD_SPAWN_SSH) return "ssh";
  if (binOnPath(SPAWN_BIN)) return "local";
  return "stub"; // safe host default: shadow, never a hard failure
}

function spawnArgs({ kind, substrate, id, timeout, budgetTokens, binaryOverride, taskFile, resultFile, async: asyncMode }) {
  const a = ["--kind", kind, "--task-file", taskFile, "--result-file", resultFile];
  if (substrate) a.push("--substrate", substrate);
  if (id) a.push("--id", id);
  if (timeout) a.push("--timeout", String(timeout));
  if (budgetTokens) a.push("--budget-tokens", String(budgetTokens));
  if (binaryOverride) a.push("--binary-override", binaryOverride);
  if (asyncMode) a.push("--async");
  return a;
}

/**
 * runSpawn(opts) — offload one step to chad-spawn and return its result.json.
 *
 *   kind           sub-agent kind (coder|researcher|writer|reviewer|fitness|brain|codex|opencode)
 *   task           string|object — the task body (object is JSON-stringified)
 *   substrate      "local" | "gha"   (default: kind manifest's default)
 *   id             stable task id (use a workflow-derived value for idempotency)
 *   timeout        seconds override
 *   budgetTokens   token budget override
 *   binaryOverride absolute binary path (must be in the kind's L7 allowlist)
 *
 * Always resolves to a spawnResultSchema-shaped object. Never throws.
 */
export async function runSpawn(opts = {}) {
  const { kind, task = "", substrate, id } = opts;
  if (!kind) return spawnResultSchema.parse({ status: "failed", summary: "runSpawn: kind is required", exit_code: 2 });
  const taskStr = typeof task === "string" ? task : JSON.stringify(task, null, 2);
  const transport = resolveTransport();

  if (transport === "stub") {
    return spawnResultSchema.parse({
      status: "shadow-logged",
      kind, substrate: substrate || "local", task_id: id || `stub-${Date.now()}`, exit_code: 0,
      summary: `STUB (no chad-spawn transport): would spawn ${kind} on ${substrate || "default"} substrate`,
      stub: true,
    });
  }

  const dir = mkdtempSync(join(tmpdir(), "chad-spawn-"));
  const taskFile = join(dir, "task.txt");
  const resultFile = join(dir, "result.json");
  writeFileSync(taskFile, taskStr);

  try {
    if (transport === "local") {
      const args = spawnArgs({ ...opts, taskFile, resultFile });
      const r = await execFileP(SPAWN_BIN, args, { cwd: dir });
      if (existsSync(resultFile)) return spawnResultSchema.parse(JSON.parse(readFileSync(resultFile, "utf8")));
      return spawnResultSchema.parse({ status: "failed", kind, exit_code: r.code, summary: `chad-spawn wrote no result.json (rc=${r.code}): ${r.stderr.slice(0, 400)}` });
    }

    // ssh transport: stream task up, run remote chad-spawn, stream result back.
    const host = process.env.CHAD_SPAWN_SSH;
    const rid = id || `s${Date.now()}`;
    const rtask = `/tmp/chad-spawn-${rid}.task`;
    const rresult = `/tmp/chad-spawn-${rid}.result.json`;
    // 1) write task to the pod via stdin (scp is blocked in the sandbox).
    await execFileP("ssh", [host, `cat > ${rtask}`], { input: taskStr });
    // 2) run the real chad-spawn on the pod (-n: no stdin, so parallel calls don't steal each other's pipe).
    const remoteArgs = spawnArgs({ ...opts, taskFile: rtask, resultFile: rresult });
    const remoteCmd = `${SPAWN_BIN} ${remoteArgs.map((x) => `'${String(x).replace(/'/g, "'\\''")}'`).join(" ")}`;
    const r = await execFileP("ssh", ["-n", host, remoteCmd]);
    // 3) read the result back.
    const back = await execFileP("ssh", ["-n", host, `cat ${rresult} 2>/dev/null || true`]);
    if (back.stdout.trim()) {
      try { return spawnResultSchema.parse(JSON.parse(back.stdout)); } catch { /* fall through */ }
    }
    return spawnResultSchema.parse({ status: "failed", kind, exit_code: r.code, substrate: substrate || "gha", summary: `remote chad-spawn produced no parseable result (rc=${r.code}): ${r.stderr.slice(0, 400)}` });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// scoreIssue — chad-issue-triage's deterministic signal score, ported so the
// pick is predictable from the source (label + reactions + age + linked PR).
export function scoreIssue(issue = {}) {
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name || "")).map((s) => s.toLowerCase());
  const reactions = issue.reactions?.total_count ?? issue.reactionsCount ?? 0;
  const ageDays = issue.createdAt ? (Date.now() - new Date(issue.createdAt).getTime()) / 86400000 : 0;
  let score = 0;
  if (labels.includes("needs-chad") || labels.includes("chad")) score += 5;
  if (labels.includes("bug")) score += 3;
  if (labels.includes("good first issue")) score += 2;
  if (labels.includes("wontfix") || labels.includes("invalid")) score -= 5;
  score += Math.min(reactions, 10);
  if (ageDays < 7) score += 2; else if (ageDays > 90) score -= 2; // fresh signal > stale
  if (issue.linkedPr || issue.pull_request) score -= 4; // already being worked
  return score;
}
