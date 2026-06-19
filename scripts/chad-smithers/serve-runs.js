// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// serve-runs.js — durable, DB-backed Smithers run dashboard for runs.supachad.com.
// Run: bun serve-runs.js
//
// Reads the Smithers SQLite DBs directly (full run HISTORY, not just live runs),
// across every *.db in the workspace, and serves a small dashboard + JSON API.
// Auto-discovers new DBs/runs on each request, so the nightly experiment runs
// (experiments.db) and the ops workflows (mcp-health.db, fail-only.db, …) all
// show up with no restart.
//
// Why custom instead of the Smithers operator console: that console is the
// react-backed Gateway UI and is LIVE-run-oriented (in-memory registry, no DB).
// We want durable history tied to the DB — like OpenWebUI — so we read the DB.
//
// Env:
//   CHAD_RUNS_PORT       listen port (default 7331)
//   CHAD_RUNS_HOST       bind host (default 0.0.0.0 — needed so the cloudflared
//                        container can reach it via host.docker.internal)
//   CHAD_RUNS_DB_DIR     dir to scan for *.db (default: this workspace)
//   CHAD_POPULATION      experiments population.json (default ./state/population.json)
//   CHAD_EXPERIMENT_REPORT  last leaderboard md (default ./state/last-report.md)
//   SMITHERS_API_KEY     if set, require it (x-smithers-key or ?key=); else open
//                        (Cloudflare Access is the real gate in prod).

import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, symlinkSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { preflight, listLimits } from "./lib/model-limits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CHAD_RUNS_PORT || 7331);
const HOST = process.env.CHAD_RUNS_HOST || "0.0.0.0";
const DB_DIR = process.env.CHAD_RUNS_DB_DIR || HERE;
const POP_PATH = process.env.CHAD_POPULATION || join(HERE, "state/population.json");
const REPORT_PATH = process.env.CHAD_EXPERIMENT_REPORT || join(HERE, "state/last-report.md");
// A run's logs/trace live under whichever .smithers/executions dir the workflow
// ran from: the workspace root (experiments.jsx) OR workflows/ (workflows/*.jsx).
// Scan both so event logs, token telemetry, and agent traces show for EVERY
// workflow, not just the root ones.
const LOG_DIRS = process.env.CHAD_RUNS_LOG_DIR
  ? [process.env.CHAD_RUNS_LOG_DIR]
  : [join(HERE, ".smithers/executions"), join(HERE, "workflows/.smithers/executions")];
function execLogDir(runId) {
  for (const d of LOG_DIRS) { const p = join(d, runId); if (existsSync(p)) return p; }
  return null;
}
const HOST_CREDS = process.env.CHAD_HOST_CREDS || "/Users/r/.nemoclaw/credentials.json";
// Machine auth for Chad: SMITHERS_API_KEY env, else SMITHERS_RUNS_API_KEY from
// host credentials.json. Gates writes (alongside Cloudflare Access email). Empty
// = writes require the Cf-Access email only (browser).
const API_KEY = process.env.SMITHERS_API_KEY
  || (() => { try { return JSON.parse(readFileSync(HOST_CREDS, "utf8")).SMITHERS_RUNS_API_KEY || ""; } catch { return ""; } })();

// Per-run event stream (live as the run executes). Tails the last N events from
// .smithers/executions/<runId>/logs/stream.ndjson written by `smithers up`.
function runLogs(runId, limit = 800) {
  const base = execLogDir(runId);
  const path = base && join(base, "logs", "stream.ndjson");
  if (!path || !existsSync(path)) return { events: [], path: null };
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  const events = tail.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return { events, total: lines.length, path: basename(path) };
}

// Token usage + agent-trace capture summaries for a run, parsed from the
// execution stream (the DB carries no per-node token counts). This is what lets
// the UI show "496 tokens generated, reasoning hidden" so a terse final answer
// reads as intentional, not a broken/placeholder run.
function runTelemetry(runId) {
  const base = execLogDir(runId);
  const path = base && join(base, "logs", "stream.ndjson");
  const tokens = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, totalTokens: 0, byNode: {} };
  const traces = {};
  if (!path || !existsSync(path)) return { tokens, traces };
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === "TokenUsageReported") {
      const it = e.inputTokens || 0, ot = e.outputTokens || 0, rt = e.reasoningTokens || 0, cr = e.cacheReadTokens || 0;
      tokens.inputTokens += it; tokens.outputTokens += ot; tokens.reasoningTokens += rt; tokens.cacheReadTokens += cr;
      tokens.totalTokens += it + ot;
      const n = (tokens.byNode[e.nodeId] ||= { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
      n.inputTokens += it; n.outputTokens += ot; n.reasoningTokens += rt; n.model = e.model; n.agent = e.agent;
    } else if (e.type === "AgentTraceSummary" && e.summary) {
      const s = e.summary;
      const unsupported = s.unsupportedEventKinds || [];
      traces[e.nodeId] = {
        captureMode: s.captureMode,
        traceCompleteness: s.traceCompleteness,
        agentFamily: s.agentFamily,
        agentId: s.agentId,
        // The dashboard's "reasoning hidden" badge: a final-only capture that
        // dropped thinking/text deltas means the visible text is the tip of a
        // larger generation (see byNode token counts), not a placeholder.
        reasoningHidden: s.traceCompleteness === "final-only"
          && unsupported.some((k) => /thinking|text\.delta/.test(k)),
        durationMs: (s.traceFinishedAtMs || 0) - (s.traceStartedAtMs || 0),
      };
    }
  }
  return { tokens, traces };
}

// Run counts per workflow DB — so the catalog can show scaffolds with 0 runs.
function workflowRunCounts() {
  const counts = {};
  for (const path of listDbs()) {
    try {
      withDb(path, (db) => {
        if (tableExists(db, "_smithers_runs")) counts[basename(path)] = db.query("SELECT count(*) n FROM _smithers_runs").get().n;
      });
    } catch { /* skip */ }
  }
  return counts;
}

const listDbs = () =>
  readdirSync(DB_DIR).filter((f) => f.endsWith(".db") && f !== "smithers.db").map((f) => join(DB_DIR, f));

// Which DB file holds a given run (the CLI commands need to target it).
function runDbPath(runId) {
  for (const p of listDbs()) {
    try { if (withDb(p, (db) => tableExists(db, "_smithers_runs")
      && db.query("SELECT 1 FROM _smithers_runs WHERE run_id=?").get(runId))) return p; } catch { /* */ }
  }
  return null;
}
// Run a smithers CLI command against a run's DB. The CLI's findSmithersDb only
// looks for a file named smithers.db, but our workflows use named DBs — so we
// exec in a temp dir with smithers.db symlinked to the real one. execFileSync
// blocks the event loop, so this is race-free for sync commands.
function cliWithDb(dbPath, args) {
  const dir = mkdtempSync(join(tmpdir(), "chad-run-"));
  try {
    symlinkSync(dbPath, join(dir, "smithers.db"));
    // Some commands (e.g. cancel) exit non-zero on SUCCESS to signal the
    // resulting run state, so capture output instead of throwing on exit code.
    try {
      return { ok: true, out: execFileSync(SMITHERS_BIN, args, { cwd: dir, env: nvidiaEnv(), timeout: 20000, maxBuffer: 8 << 20 }).toString() };
    } catch (e) {
      return { ok: false, out: String((e.stdout || "") + (e.stderr || "") || e.message || "") };
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function withDb(path, fn) {
  // Open read-write (NOT readonly): Smithers DBs are WAL-mode, and bun:sqlite
  // readonly throws "unable to open database file" on WAL (can't create -shm).
  // WAL allows concurrent readers + the live writer safely; we only ever SELECT,
  // so this reads live runs without blocking or corrupting the writer.
  const db = new Database(path);
  try { db.exec("PRAGMA busy_timeout=3000"); } catch { /* */ }
  try { return fn(db); } finally { db.close(); }
}

const tableExists = (db, name) =>
  db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;

// Every run across every DB, newest first. Each row tagged with its source db.
function allRuns() {
  const runs = [];
  for (const path of listDbs()) {
    try {
      withDb(path, (db) => {
        if (!tableExists(db, "_smithers_runs")) return;
        const rows = db.query(
          "SELECT run_id, workflow_name, status, created_at_ms, started_at_ms, finished_at_ms, heartbeat_at_ms, error_json FROM _smithers_runs",
        ).all();
        for (const r of rows) runs.push({ ...r, db: basename(path) });
      });
    } catch { /* skip unreadable/locked db */ }
  }
  return runs.sort((a, b) => (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0));
}

// Full detail for one run: the run row, its task attempts, and any workflow
// output-schema rows (evaluation/selection/report/etc.) for that run.
function runDetail(runId) {
  for (const path of listDbs()) {
    try {
      const found = withDb(path, (db) => {
        if (!tableExists(db, "_smithers_runs")) return null;
        const run = db.query("SELECT * FROM _smithers_runs WHERE run_id=?").get(runId);
        if (!run) return null;
        const attempts = tableExists(db, "_smithers_attempts")
          ? db.query(
              "SELECT node_id, iteration, attempt, state, started_at_ms, finished_at_ms, error_json, response_text FROM _smithers_attempts WHERE run_id=? ORDER BY started_at_ms",
            ).all(runId)
          : [];
        // Output-schema tables = non-internal, non-input tables that carry run_id.
        const outputs = {};
        const tables = db.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_smithers_%' AND name NOT IN ('input','sqlite_sequence')",
        ).all().map((t) => t.name);
        for (const t of tables) {
          const cols = db.query(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
          if (!cols.includes("run_id")) continue;
          const rows = db.query(`SELECT * FROM "${t}" WHERE run_id=?`).all(runId);
          if (rows.length) outputs[t] = rows;
        }
        return { run: { ...run, db: basename(path) }, attempts, outputs };
      });
      if (found) return found;
    } catch { /* skip */ }
  }
  return null;
}

function experiments() {
  const pop = existsSync(POP_PATH) ? JSON.parse(readFileSync(POP_PATH, "utf8")) : { candidates: [] };
  const report = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf8") : "";
  return { population: pop, report };
}

// ── IDE actions (launch / cancel / approve) ──────────────────────────────────
const SMITHERS_BIN = process.env.SMITHERS_BIN || join(HERE, "node_modules/.bin/smithers");
const WF_DIRS = [HERE, join(HERE, "workflows")];

// Launchable workflows = existing workspace *.jsx/*.tsx ONLY (bounded — no
// arbitrary path/code from the client).
function listWorkflows() {
  const out = [];
  for (const d of WF_DIRS) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (/\.(jsx|tsx)$/.test(f)) {
        const name = d === HERE ? f : "workflows/" + f;
        out.push({ name, mtime: statSync(join(d, f)).mtimeMs });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function resolveWorkflow(name) {
  // Validate against the discovered set so name can't escape the workspace.
  return listWorkflows().some((w) => w.name === name) ? join(HERE, name) : null;
}
// Editable workflow path: workspace-root or workflows/ *.jsx|*.tsx only, no
// traversal. Used for read + save (lets you edit existing AND create new ones).
function safeWorkflowPath(name) {
  if (!/^(?:[\w-]+|workflows\/[\w-]+)\.(?:jsx|tsx)$/.test(name || "")) return null;
  const p = join(HERE, name);
  return (p === join(HERE, name) && p.startsWith(HERE + "/")) ? p : null;
}
function nvidiaEnv() {
  let key = process.env.NVIDIA_API_KEY || "";
  try { if (!key) key = JSON.parse(readFileSync(HOST_CREDS, "utf8")).NVIDIA_API_KEY || ""; } catch { /* */ }
  return {
    ...process.env,
    NVIDIA_API_KEY: key,
    CHAD_INFERENCE_BASE_URL: process.env.CHAD_INFERENCE_BASE_URL || "https://integrate.api.nvidia.com/v1",
    CHAD_CAPABLE_BACKEND: process.env.CHAD_CAPABLE_BACKEND || "nemotron",
    CHAD_CHEAP_BACKEND: process.env.CHAD_CHEAP_BACKEND || "nemotron",
  };
}

// Allowlist for client-supplied launch settings → child env. DENY BY DEFAULT:
// only CHAD_* / DRY_RUN tuning knobs, and explicitly NOT anything that could
// redirect execution, hit a different endpoint, or leak data — binaries (_BIN),
// endpoints (_URL/BASE_URL), ssh targets (_SSH), creds (_KEY/_TOKEN/_CREDS/
// _SECRET/API_KEY), trust boundaries (_ALLOWLIST/_OPERATOR), or process internals
// (PATH/HOME/NODE_/LD_). Note _TOKEN(_|$) deliberately does NOT match _TOKENS, so
// CHAD_MAX_OUTPUT_TOKENS is allowed.
const ENV_DENY = /(^|_)(SSH|BIN|CREDS?|SECRET|PASSWORD|COOKIE|PATH|HOME|NODE|LD)(_|$)|_KEY(_|$)|_TOKEN(_|$)|_URL(_|$)|BASE_URL|ALLOWLIST|OPERATOR|API_?KEY/;
function isAllowedEnvKey(k) {
  return /^(CHAD_[A-Z0-9_]+|DRY_RUN)$/.test(k) && !ENV_DENY.test(k);
}
function pickLaunchEnv(obj) {
  const out = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (isAllowedEnvKey(k) && ["string", "number", "boolean"].includes(typeof v)) out[k] = String(v);
    }
  }
  return out;
}

// Validate a launch's requested settings against per-model limits (model-limits.js).
// Candidate models = explicit CHAD_FUSION_MODELS, else fusion's featured roster,
// plus the nemotron tier default that nearly every task uses. Checks the largest
// requested max-output (capable or cheap) against each model's ceiling/context.
function preflightLaunch(body) {
  const env = (body && body.env) || {};
  const models = [];
  if (env.CHAD_FUSION_MODELS) models.push(...String(env.CHAD_FUSION_MODELS).split(",").map((s) => s.trim()).filter(Boolean));
  else if (/fusion/.test(body?.workflow || "")) {
    try { models.push(...(JSON.parse(readFileSync(join(HERE, "state/models.json"), "utf8")).featured || [])); } catch { /* */ }
  }
  models.push(env.CHAD_NEMOTRON_CAPABLE_MODEL || "nvidia/nemotron-3-ultra-550b-a55b");
  const reqOut = Math.max(Number(env.CHAD_MAX_OUTPUT_TOKENS) || 0, Number(env.CHAD_MAX_OUTPUT_TOKENS_CHEAP) || 0) || null;
  return preflight({ models: [...new Set(models)], maxOutputTokens: reqOut, reasoning: env.CHAD_REASONING });
}

// Write-auth: cloudflared injects Cf-Access-Authenticated-User-Email after SSO,
// so only Access-authed operators can mutate. LAN-direct requests lack it. The
// SMITHERS_API_KEY (?key=/header) is the override for local/testing.
function operator(c) {
  const email = c.req.header("cf-access-authenticated-user-email");
  if (email) return email;
  if (API_KEY && (c.req.header("x-smithers-key") === API_KEY || c.req.query("key") === API_KEY)) return "key-auth";
  return null;
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = new Hono();

// Auth: allow either the machine key (Chad / chad-runs) OR a Cloudflare-Access
// authenticated browser (cloudflared injects Cf-Access-Authenticated-User-Email
// after SSO). Blocks LAN-direct requests that have neither. Writes are further
// audited by operator() in each handler.
app.use("/api/*", async (c, next) => {
  if (!API_KEY) return next(); // no key configured → rely on Access alone
  const key = c.req.header("x-smithers-key") || c.req.query("key");
  const cfEmail = c.req.header("cf-access-authenticated-user-email");
  if (key === API_KEY || cfEmail) return next();
  return c.json({ error: "unauthorized" }, 401);
});

app.get("/api/health", (c) => c.json({ ok: true, dbs: listDbs().map((p) => basename(p)) }));
app.get("/api/runs", (c) => c.json({ runs: allRuns() }));
app.get("/api/runs/:runId", (c) => {
  const d = runDetail(c.req.param("runId"));
  if (!d) return c.json({ error: "run not found" }, 404);
  return c.json({ ...d, telemetry: runTelemetry(c.req.param("runId")) });
});
app.get("/api/runs/:runId/logs", (c) =>
  c.json(runLogs(c.req.param("runId"), Number(c.req.query("limit")) || 800)));
app.get("/api/experiments", (c) => c.json(experiments()));

// Read: launchable workflows + a workflow's structure graph (no execution).
app.get("/api/workflows", (c) => c.json({ workflows: listWorkflows() }));
// Catalog = every launchable workflow file + its matched DB + run count, so the
// UI lists scaffolds that have never run (0 runs) instead of hiding them.
app.get("/api/catalog", (c) => {
  const counts = workflowRunCounts();
  const dbs = Object.keys(counts);
  const workflows = listWorkflows().map((w) => {
    const stem = basename(w.name).replace(/\.(jsx|tsx)$/, "");
    const db = dbs.find((b) => { const ds = b.replace(/\.db$/, ""); return stem === ds || stem.startsWith(ds + "-"); });
    return { ...w, db: db || null, runs: db ? counts[db] : 0 };
  });
  return c.json({ workflows });
});
// Parse a `smithers graph --format json` xml tree into a task DAG (sequence =
// chain, parallel/branch = fan) for visual rendering (mermaid).
function graphToDag(xml) {
  const nodes = [], edges = []; let auto = 0;
  const idOf = (n) => n.props?.id || n.props?.name || (n.tag.replace("smithers:", "") + "_" + (auto++));
  function walk(node, parents) {
    const tag = (node.tag || "").replace("smithers:", "");
    const kids = node.children || [];
    if (tag === "task") {
      const id = idOf(node);
      nodes.push({ id, label: node.props?.id || id });
      parents.forEach((p) => edges.push({ from: p, to: id }));
      return [id];
    }
    if (tag === "parallel" || tag === "branch") {
      let outs = []; for (const k of kids) outs = outs.concat(walk(k, parents)); return outs.length ? outs : parents;
    }
    // sequence / workflow / wrapper: chain children
    let prev = parents; for (const k of kids) prev = walk(k, prev); return prev;
  }
  walk(xml, []);
  return { nodes, edges };
}
app.get("/api/workflow-graph", (c) => {
  const wf = resolveWorkflow(c.req.query("name") || "");
  if (!wf) return c.json({ error: "unknown workflow" }, 404);
  try {
    const json = JSON.parse(execFileSync(SMITHERS_BIN, ["graph", wf, "--format", "json"], {
      cwd: HERE, env: nvidiaEnv(), timeout: 20000, maxBuffer: 4 << 20,
    }).toString());
    return c.json({ dag: graphToDag(json.xml || json), tree: json.xml || json });
  } catch (e) { return c.json({ error: String(e.stderr || e.message).slice(0, 800) }, 500); }
});
// Read/edit workflow source (the IDE editor). Bounded to workspace *.jsx/*.tsx.
app.get("/api/workflow-file", (c) => {
  const p = safeWorkflowPath(c.req.query("name") || "");
  if (!p) return c.json({ error: "invalid workflow name" }, 400);
  if (!existsSync(p)) return c.json({ name: c.req.query("name"), content: "", exists: false });
  return c.json({ name: c.req.query("name"), content: readFileSync(p, "utf8"), exists: true });
});
app.post("/api/workflow-file", async (c) => {
  const op = operator(c);
  if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const p = safeWorkflowPath(body.name || "");
  if (!p) return c.json({ error: "invalid workflow name (use [name].jsx or workflows/[name].jsx)" }, 400);
  if (typeof body.content !== "string") return c.json({ error: "content required" }, 400);
  writeFileSync(p, body.content);
  console.error(`edit: ${body.name} by ${op} (${body.content.length} bytes)`);
  return c.json({ ok: true, name: body.name, savedBy: op });
});

// Read: per-node agent trace (the reasoning/tool log for one task).
app.get("/api/runs/:runId/trace/:node", (c) => {
  const base = execLogDir(c.req.param("runId"));
  const dir = base && join(base, "logs", "agent-trace");
  if (!dir || !existsSync(dir)) return c.json({ lines: [] });
  const node = c.req.param("node");
  const files = readdirSync(dir).filter((f) => f.startsWith(node));
  const lines = [];
  for (const f of files) {
    for (const l of readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).slice(-400)) {
      try { lines.push(JSON.parse(l)); } catch { lines.push({ raw: l }); }
    }
  }
  return c.json({ lines });
});

// Read: per-model limits (registry) for the launch drawer's ceiling hints.
app.get("/api/model-limits", (c) => c.json(listLimits()));
// Read: preflight a prospective launch's settings (advisory; no side effects).
app.post("/api/preflight", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(preflightLaunch(body));
});

// Write (Access-gated): launch a known workflow, cancel a run, approve/deny a gate.
app.post("/api/launch", async (c) => {
  const op = operator(c);
  if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const wf = resolveWorkflow(body.workflow || "");
  if (!wf) return c.json({ error: "unknown workflow" }, 400);
  // Preflight: block launches with hard-unsafe settings (e.g. output > context).
  const pf = preflightLaunch(body);
  if (!pf.ok) return c.json({ error: "preflight failed — unsafe settings", preflight: pf }, 400);
  // Detached: the run executes in the background and shows up live in the list.
  const args = ["up", wf];
  if (body.input) args.push("--input", JSON.stringify(body.input)); // data, not code
  const extra = pickLaunchEnv(body.env); // allowlisted run-setting knobs only
  const child = spawn(SMITHERS_BIN, args, {
    cwd: HERE, env: { ...nvidiaEnv(), ...extra }, detached: true, stdio: "ignore",
  });
  child.unref();
  console.error(`launch: ${basename(wf)} by ${op} (pid ${child.pid})${Object.keys(extra).length ? ` env[${Object.keys(extra).join(",")}]` : ""}`);
  return c.json({ ok: true, workflow: body.workflow, launchedBy: op, env: Object.keys(extra), preflight: pf });
});
function cliAction(c, verb, extraArgs = []) {
  const op = operator(c);
  if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const runId = c.req.param("runId");
  const db = runDbPath(runId);
  if (!db) return c.json({ error: "run not found" }, 404);
  // The command's effect lands in the DB regardless of exit code; the UI reloads
  // to confirm the new status. Return the output for inspection.
  const r = cliWithDb(db, [verb, runId, ...extraArgs]);
  console.error(`${verb}: ${runId} by ${op} ${extraArgs.join(" ")}`);
  return c.json({ ok: true, output: r.out.slice(0, 600) });
}
app.post("/api/runs/:runId/cancel", (c) => cliAction(c, "cancel"));
// Fork (time-travel): branch a new run from a run's snapshot. Resolves the
// source run's workflow_path, runs detached, appears live under Runs.
function runWorkflowPath(runId) {
  for (const p of listDbs()) {
    try { const wf = withDb(p, (db) => tableExists(db, "_smithers_runs")
      ? db.query("SELECT workflow_path FROM _smithers_runs WHERE run_id=?").get(runId)?.workflow_path : null);
      if (wf) return wf; } catch { /* */ }
  }
  return null;
}
app.post("/api/runs/:runId/fork", async (c) => {
  const op = operator(c);
  if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const runId = c.req.param("runId");
  const wf = runWorkflowPath(runId);
  if (!wf) return c.json({ error: "source run / workflow not found" }, 404);
  const srcDb = runDbPath(runId);
  if (!srcDb) return c.json({ error: "source run db not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const args = ["fork", wf, "--run-id", runId];
  if (body.frame != null) args.push("--frame", String(body.frame));
  if (body.resetNode) args.push("--reset-node", body.resetNode);
  // fork reads the source via smithers.db AND writes the new run to the
  // workflow's named DB (cwd=HERE). Symlink smithers.db→srcDb for the run's
  // lifetime, remove on exit. (cliWithDb's temp-dir can't be used here — the new
  // run must land in the workspace, not a temp dir.)
  const link = join(HERE, "smithers.db");
  try { unlinkSync(link); } catch { /* */ }
  try { symlinkSync(srcDb, link); } catch (e) { return c.json({ error: "fork link failed: " + e.message }, 500); }
  const child = spawn(SMITHERS_BIN, args, { cwd: HERE, env: nvidiaEnv(), stdio: "ignore" });
  child.on("exit", () => { try { unlinkSync(link); } catch { /* */ } });
  console.error(`fork: ${runId} by ${op} (pid ${child.pid})`);
  return c.json({ ok: true, forkedFrom: runId, forkedBy: op });
});
// Read: agent chat output for a run.
app.get("/api/runs/:runId/chat", (c) => {
  const db = runDbPath(c.req.param("runId"));
  if (!db) return c.json({ chat: "", error: "run not found" });
  return c.json({ chat: cliWithDb(db, ["chat", c.req.param("runId"), "--all"]).out });
});
// Read: unified diff for a node (workflows that edit code).
app.get("/api/runs/:runId/diff/:node", (c) => {
  const db = runDbPath(c.req.param("runId"));
  if (!db) return c.json({ diff: "", error: "run not found" });
  return c.json({ diff: cliWithDb(db, ["diff", c.req.param("runId"), c.req.param("node")]).out });
});
app.post("/api/runs/:runId/approve", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return cliAction(c, "approve", b.node ? ["--node", b.node, "--iteration", String(b.iteration ?? 0)] : []);
});
app.post("/api/runs/:runId/deny", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return cliAction(c, "deny", b.node ? ["--node", b.node, "--iteration", String(b.iteration ?? 0)] : []);
});
// Pending approval gates across all DBs (for the approvals panel).
app.get("/api/approvals", (c) => {
  const pending = [];
  for (const path of listDbs()) {
    try {
      withDb(path, (db) => {
        if (!tableExists(db, "_smithers_approvals")) return;
        for (const r of db.query("SELECT run_id, node_id, iteration, status, requested_at_ms, request_json FROM _smithers_approvals WHERE status='pending'").all())
          pending.push({ ...r, db: basename(path) });
      });
    } catch { /* */ }
  }
  return c.json({ pending });
});

// Static dashboard.
app.get("/", (c) => c.html(readFileSync(join(HERE, "public/index.html"), "utf8")));
app.get("/index.html", (c) => c.html(readFileSync(join(HERE, "public/index.html"), "utf8")));

console.error(`serve-runs: durable DB dashboard on http://${HOST}:${PORT}  (scanning ${DB_DIR})`);
export default { port: PORT, hostname: HOST, fetch: app.fetch };
