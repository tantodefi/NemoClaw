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
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, symlinkSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { preflight, listLimits } from "./lib/model-limits.js";
import { scanSignal } from "./lib/signal.js";
import { harvestFixtures } from "./lib/fixtures.js";
import { canonicalModelId, isKnownModel, rosterSet } from "./lib/models.js";

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
// Per-model liveness probe written by nvidia-liveness.py (1-token probe per model,
// daily). Used to show only currently-live models in the launch drawer.
const LIVENESS_FILE = process.env.CHAD_LIVENESS_FILE || join(dirname(HOST_CREDS), "openwebui/liveness.json");
// Approval push notifications (best-effort). The default channel set comes from
// CHAD_APPROVAL_NOTIFY (comma list) but is now LIVE-EDITABLE from the Approvals
// tab → persisted to state/notify-config.json (so a change sticks without a
// service restart). `browser` is client-side; `webui`/`email` dispatch via the
// pod here; `telegram` needs an openclaw channel (advertised, not yet wired).
const NOTIFY_DEFAULT = (process.env.CHAD_APPROVAL_NOTIFY || "").split(",").map((s) => s.trim()).filter(Boolean);
const NOTIFY_CFG_PATH = join(HERE, "state", "notify-config.json");
// telegram/moshi dispatch via operator-supplied pod command templates (the
// transport is environment-specific — an openclaw channel for telegram, an
// iPhone-paired notify path for moshi — so it can't be hardcoded). The template
// is a shell command run on the pod with {text} substituted for the message; when
// set, the channel goes `ready` and the notifier actually dispatches it (no longer
// silently dropped). E.g. CHAD_TELEGRAM_NOTIFY_CMD='openclaw channels send --to telegram --text {text}'.
const POD_TELEGRAM_CMD = process.env.CHAD_TELEGRAM_NOTIFY_CMD || "";
const POD_MOSHI_CMD = process.env.CHAD_MOSHI_NOTIFY_CMD || "";
const AVAILABLE_CHANNELS = [
  { id: "browser", label: "Browser push", ready: true, note: "desktop/PWA notification — enable per-browser via the 🔔 bell" },
  { id: "webui", label: "OpenWebUI note", ready: true, note: "posts a note via the pod chad-webui" },
  { id: "email", label: "Email", ready: true, note: "emails the operator via chad-mail-send" },
  { id: "telegram", label: "Telegram / WhatsApp", ready: !!POD_TELEGRAM_CMD, note: POD_TELEGRAM_CMD ? "dispatches via CHAD_TELEGRAM_NOTIFY_CMD" : "set CHAD_TELEGRAM_NOTIFY_CMD (openclaw channel send) to enable" },
  { id: "moshi", label: "Moshi (voice/phone)", ready: !!POD_MOSHI_CMD, note: POD_MOSHI_CMD ? "dispatches via CHAD_MOSHI_NOTIFY_CMD" : "set CHAD_MOSHI_NOTIFY_CMD (needs iPhone pairing) to enable" },
];
function liveNotifyChannels() {
  try { const s = JSON.parse(readFileSync(NOTIFY_CFG_PATH, "utf8")).channels; if (Array.isArray(s)) return s; } catch { /* */ }
  return NOTIFY_DEFAULT;
}
function saveNotifyChannels(channels) {
  try { mkdirSync(dirname(NOTIFY_CFG_PATH), { recursive: true }); writeFileSync(NOTIFY_CFG_PATH, JSON.stringify({ channels, updatedAt: Date.now() }, null, 2)); return true; } catch { return false; }
}
const POD_SSH = process.env.CHAD_POD_SSH || "openshell-chad";
const POD_WEBUI = process.env.CHAD_WEBUI_POD_BIN || "/sandbox/.openclaw-data/bin/chad-webui";
const OPERATOR_EMAIL = process.env.CHAD_OPERATOR_EMAIL || "tantodefi@proton.me";
const RUNS_PUBLIC_URL = process.env.CHAD_RUNS_PUBLIC_URL || "https://runs.supachad.com";
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
  // Tag runs that belong to a workflow chain so the UI can badge + cross-link them.
  const cidx = chainRunIndex();
  for (const r of runs) { const c = cidx[r.run_id]; if (c) { r.chainId = c.chainId; r.chainStep = c.step; r.chainSteps = c.total; r.chainStatus = c.chainStatus; } }
  return runs.sort((a, b) => (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0));
}
// runId -> { chainId, step (1-based), total, chainStatus } across all chains.
function chainRunIndex() {
  const m = {};
  try {
    for (const ch of loadChains()) (ch.steps || []).forEach((s, i) => {
      if (s.runId) m[s.runId] = { chainId: ch.id, step: i + 1, total: ch.steps.length, chainStatus: ch.status };
    });
  } catch { /* */ }
  return m;
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

// Live model roster for the launch drawer: the daily catalog (state/models.json)
// annotated with the per-model liveness probe (openwebui/liveness.json). Dead
// models (status:dead or >= dead_after_fails) are dropped; unknown/new stay
// visible (the liveness script's lenient policy). Featured first.
function liveModels() {
  let cat = { featured: [], chat: [], new: [], generatedAt: null };
  try { cat = { ...cat, ...JSON.parse(readFileSync(join(HERE, "state/models.json"), "utf8")) }; } catch { /* */ }
  let live = {}, lastSweep = null;
  try { const lj = JSON.parse(readFileSync(LIVENESS_FILE, "utf8")); live = lj.models || {}; lastSweep = lj.last_sweep || null; } catch { /* */ }
  const isDead = (id) => { const e = live[id]; return !!e && (e.status === "dead" || (e.consecutive_failures || 0) >= 3); };
  const featured = new Set(cat.featured || []);
  const fresh = new Set(cat.new || []);
  const models = (cat.chat || [])
    .filter((id) => !isDead(id))
    .map((id) => ({ id, featured: featured.has(id), new: fresh.has(id), latencyMs: live[id]?.latency_ms ?? null, probed: id in live }))
    .sort((a, b) => (Number(b.featured) - Number(a.featured)) || a.id.localeCompare(b.id));
  return { models, featured: cat.featured || [], generatedAt: cat.generatedAt || null, lastSweep, total: models.length };
}

// Model x task-kind performance matrix — the "best model for which tasks" view.
// Flattens token-optimize's judge scores (table `scores`, a JSON array per run)
// across every run into (task-kind, model) -> {mean, n}, with the best model per
// task. This is the data the Experiments dashboard heatmap renders.
function modelMatrix() {
  const cell = {}; const tasks = new Set(), models = new Set();
  // Validate model ids against the live roster so hallucinated/mangled ids the
  // judge echoed (nvidia/nvidia/…, …-a1b-a12b) don't become phantom columns.
  let roster = new Set();
  try { roster = rosterSet(JSON.parse(readFileSync(join(HERE, "state/models.json"), "utf8"))); } catch { /* no roster → isKnownModel falls back to structural check */ }
  for (const path of listDbs()) {
    try {
      withDb(path, (db) => {
        if (!tableExists(db, "scores")) return;
        for (const row of db.query("SELECT scores FROM scores").all()) {
          let arr; try { arr = JSON.parse(row.scores); } catch { continue; }
          if (!Array.isArray(arr)) continue;
          for (const s of arr) {
            if (!s || typeof s.scorePct !== "number" || !s.candidate || !s.model) continue;
            // Real task-kinds are lowercase slugs; real models are namespaced ids.
            // Filters "Chad"/prose candidates and placeholder models from the matrix.
            if (!/^[a-z0-9][a-z0-9-]*$/.test(String(s.candidate))) continue;
            const model = canonicalModelId(s.model);           // nvidia/nvidia/x → nvidia/x
            if (!isKnownModel(model, roster)) continue;         // drop mangled/derostered ids
            tasks.add(s.candidate); models.add(model);
            const k = `${s.candidate}::${model}`;
            (cell[k] ??= { sum: 0, n: 0 }); cell[k].sum += s.scorePct; cell[k].n += 1;
          }
        }
      });
    } catch { /* skip */ }
  }
  const taskList = [...tasks].sort(), modelList = [...models].sort();
  const matrix = {}, best = {}, modelAvg = {};
  for (const t of taskList) {
    matrix[t] = {}; let bm = null, bs = -1;
    for (const m of modelList) {
      const c = cell[`${t}::${m}`];
      const mean = c ? Math.round(c.sum / c.n) : null;
      matrix[t][m] = c ? { mean, n: c.n } : null;
      if (mean != null && mean > bs) { bs = mean; bm = m; }
    }
    best[t] = bm;
  }
  for (const m of modelList) { let sum = 0, n = 0; for (const t of taskList) { const c = matrix[t][m]; if (c) { sum += c.mean; n++; } } modelAvg[m] = n ? Math.round(sum / n) : null; }
  return { tasks: taskList, models: modelList, matrix, best, modelAvg };
}

// rough inference-cost tier (cheaper = lower) — mirrors the dashboard's costRank.
function costRankS(m) { m = String(m); if (/nano/.test(m)) return 1; if (/super|flash|gemma|gpt-oss|mini\b/.test(m)) return 2; if (/claude-opus/.test(m)) return 5; if (/claude/.test(m)) return 4; if (/ultra|deepseek-v4-pro|397|maverick|kimi|glm-5|minimax|405|step-3/.test(m)) return 3; return 2; }

// ── Cost model (rough $/1M-token estimates) ──────────────────────────────────
// Powers the "money/tokens saved" widget. Two framings: (1) the FRONTIER
// counterfactual — what every token would cost on a top frontier model — vs the
// ~$0 we actually pay (Nemotron is free via the NVIDIA key); (2) the
// token-optimize downgrade math (from-tier vs to-tier $). All estimates, tunable
// in state/model-costs.json (tracked).
let _costs;
function costTable() {
  if (_costs) return _costs;
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(HERE, "state/model-costs.json"), "utf8")); } catch { /* */ }
  const tiers = cfg.tiers || { frontier: [15, 75], large: [3, 12], mid: [0.6, 2.4], small: [0.1, 0.4], free: [0, 0] };
  _costs = {
    tiers,
    frontier: cfg.frontier?.per1M || tiers.frontier || [15, 75],
    frontierLabel: cfg.frontier?.label || "frontier",
    patterns: (cfg.patterns || []).map(([re, tier]) => [new RegExp(re, "i"), tier]),
    defaultTier: cfg.defaultTier || "mid",
    actualTier: cfg.actualTier || "free",
  };
  return _costs;
}
function rateFor(model) {
  const c = costTable();
  for (const [re, tier] of c.patterns) if (re.test(String(model))) return c.tiers[tier] || c.tiers[c.defaultTier];
  return c.tiers[c.defaultTier] || [0.6, 2.4];
}
const dollars = (inTok, outTok, rate) => (inTok / 1e6) * rate[0] + (outTok / 1e6) * rate[1];
const blend = (rate) => rate[0] * 0.3 + rate[1] * 0.7; // ~30/70 in/out mix → one $/1M number

// Efficiency view: token volume (split in/out, by workflow + by model) across all
// runs, the FRONTIER-vs-actual cost counterfactual, the downgrade opportunities
// (with $ savings) from the model×task matrix, and which tasks are ALREADY cheap.
function efficiency() {
  const c = costTable();
  let inTok = 0, outTok = 0;
  const byWorkflow = {}, byModel = {};
  for (const r of allRuns()) {
    try {
      const tel = runTelemetry(r.run_id).tokens;
      const it = tel.inputTokens || 0, ot = (tel.outputTokens || 0) + (tel.reasoningTokens || 0);
      inTok += it; outTok += ot;
      const w = (byWorkflow[r.workflow_name] ||= { tokens: 0, inTok: 0, outTok: 0 });
      w.inTok += it; w.outTok += ot; w.tokens += it + ot;
      for (const n of Object.values(tel.byNode || {})) {
        const m = n.model || "unknown";
        const bm = (byModel[m] ||= { tokens: 0, inTok: 0, outTok: 0 });
        const ni = n.inputTokens || 0, no = (n.outputTokens || 0) + (n.reasoningTokens || 0);
        bm.inTok += ni; bm.outTok += no; bm.tokens += ni + no;
      }
    } catch { /* */ }
  }
  const totalTokens = inTok + outTok;
  const frontierCost = dollars(inTok, outTok, c.frontier);
  const actualCost = dollars(inTok, outTok, c.tiers[c.actualTier] || [0, 0]);
  // "at market rates" must cover ALL tokens: telemetry often lacks a model label
  // (agentFamily unknown for Nemotron), so price the labeled subset per-model and
  // the remainder at the default tier — else this badly undercounts vs frontier.
  let listCost = 0, knownIn = 0, knownOut = 0;
  for (const [m, b] of Object.entries(byModel)) { listCost += dollars(b.inTok, b.outTok, rateFor(m)); knownIn += b.inTok; knownOut += b.outTok; }
  listCost += dollars(Math.max(0, inTok - knownIn), Math.max(0, outTok - knownOut), c.tiers[c.defaultTier] || [0.6, 2.4]);
  for (const w of Object.values(byWorkflow)) w.frontierCost = dollars(w.inTok, w.outTok, c.frontier);
  const cost = {
    frontierLabel: c.frontierLabel, frontierRate: c.frontier,
    frontierCost, actualCost, listCost, saved: frontierCost - actualCost,
    byModel: Object.fromEntries(Object.entries(byModel)
      .map(([m, b]) => [m, { ...b, estCost: dollars(b.inTok, b.outTok, rateFor(m)), frontierCost: dollars(b.inTok, b.outTok, c.frontier) }])),
  };
  const mm = modelMatrix(); const TOL = 6; const downgrades = [];
  for (const t of mm.tasks) {
    const scored = mm.models.map((m) => ({ m, c: mm.matrix[t][m] })).filter((x) => x.c).map((x) => ({ m: x.m, score: x.c.mean }));
    if (!scored.length) continue;
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    const cheapest = scored.filter((x) => x.score >= best.score - TOL).sort((a, b) => costRankS(a.m) - costRankS(b.m))[0];
    if (cheapest && costRankS(cheapest.m) < costRankS(best.m)) {
      const bf = blend(rateFor(best.m)), bt = blend(rateFor(cheapest.m));
      downgrades.push({ task: t, from: best.m, to: cheapest.m,
        savingsPct: bf > 0 ? Math.round((1 - bt / bf) * 100) : 0,
        savedPer1M: Math.round(Math.max(0, bf - bt) * 100) / 100 });
    }
  }
  const applied = [];
  try {
    const tp = JSON.parse(readFileSync(join(HERE, "..", "task-profiles.json"), "utf8"));
    const walk = (obj, path) => { for (const [k, v] of Object.entries(obj || {})) { if (k === "model" && typeof v === "string" && costRankS(v) <= 2) applied.push({ profile: path || "(root)", model: v }); else if (v && typeof v === "object") walk(v, path ? `${path}.${k}` : k); } };
    walk(tp.profiles || {}, "");
  } catch { /* */ }
  return { totalTokens, inputTokens: inTok, outputTokens: outTok, byWorkflow, cost, downgrades, applied };
}

// ── Scheduled jobs (launchd timers) — read-only view ─────────────────────────
// Parse the host LaunchAgents plists (schedule + what each runs) and cross-ref
// `launchctl list` (loaded / running / last exit) + the workflow's last real run.
const LAUNCH_AGENTS = join(process.env.HOME || "/Users/r", "Library/LaunchAgents");
function parsePlist(path) {
  try { return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { timeout: 5000 }).toString()); }
  catch { return null; }
}
function launchctlState() {
  const map = {};
  try {
    for (const line of execFileSync("launchctl", ["list"], { timeout: 5000 }).toString().split("\n")) {
      const m = line.match(/^(\S+)\t(\S+)\t(dev\.nemoclaw\.chad-\S+)/);
      if (m) map[m[3]] = { pid: m[1] === "-" ? null : Number(m[1]), lastExit: m[2] === "-" ? null : Number(m[2]) };
    }
  } catch { /* */ }
  return map;
}
function humanSchedule(p) {
  if (p.StartInterval) { const s = Number(p.StartInterval); return s % 3600 === 0 ? `every ${s / 3600}h` : s % 60 === 0 ? `every ${s / 60}m` : `every ${s}s`; }
  const sci = p.StartCalendarInterval;
  if (sci) {
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (Array.isArray(sci) ? sci : [sci]).map((c) =>
      `${String(c.Hour ?? 0).padStart(2, "0")}:${String(c.Minute ?? 0).padStart(2, "0")}${c.Weekday != null ? " " + (wd[c.Weekday] || "wd" + c.Weekday) : ""}`).join(", ");
  }
  return p.RunAtLoad ? "at load only" : "—";
}
function classifyJob(args) {
  const a = (args || []).map(String);
  const rw = a.find((x) => x.endsWith("run-workflow.sh"));
  if (rw) return { kind: "workflow", target: a[a.indexOf(rw) + 1] || null };
  if (a.some((x) => x.endsWith("run-experiments.sh"))) return { kind: "workflow", target: "experiments.jsx", bundle: "+ token-optimize each run; bug-report/self-improve/skill-improve at 05:00" };
  if (a.some((x) => x.endsWith("serve-runs.js"))) return { kind: "service", target: "runs dashboard (this UI)" };
  if (a.some((x) => x.endsWith("refresh-models.js"))) return { kind: "ops", target: "model catalog refresh" };
  return { kind: "infra", target: basename(a.find((x) => /\.(sh|js|py)$/.test(x)) || a[a.length - 1] || "") };
}
function schedules() {
  const st = launchctlState(); const out = [];
  let files = [];
  try { files = readdirSync(LAUNCH_AGENTS).filter((f) => /^dev\.nemoclaw\.chad-.*\.plist$/.test(f)); } catch { /* */ }
  for (const f of files) {
    const p = parsePlist(join(LAUNCH_AGENTS, f)); if (!p) continue;
    const label = p.Label || f.replace(/\.plist$/, "");
    const cls = classifyJob(p.ProgramArguments);
    const s = st[label] || {};
    let lastRun = null;
    if (cls.kind === "workflow" && cls.target) {
      const db = dbForWorkflowFile(cls.target);
      if (db) { try { lastRun = withDb(db, (d) => tableExists(d, "_smithers_runs") ? d.query("SELECT created_at_ms, status FROM _smithers_runs ORDER BY created_at_ms DESC LIMIT 1").get() : null); } catch { /* */ } }
    }
    out.push({
      label: label.replace(/^dev\.nemoclaw\./, ""), kind: cls.kind, target: cls.target, bundle: cls.bundle || null,
      schedule: humanSchedule(p), runAtLoad: !!p.RunAtLoad, loaded: label in st, running: s.pid != null,
      lastExit: s.lastExit ?? null, lastRun,
    });
  }
  const order = { workflow: 0, service: 1, ops: 2, infra: 3 };
  return out.sort((a, b) => (order[a.kind] - order[b.kind]) || a.label.localeCompare(b.label));
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
// The serializable per-node control props the graph carries (agent/model are
// runtime instances and are NOT in the graph JSON — for those the run DAG reads
// the resolved model+tokens from telemetry.byNode). These are the "settings
// passed into each node" the node inspector surfaces and lets you tweak.
const NODE_CFG_KEYS = ["timeoutMs", "retries", "continueOnFail", "needsApproval",
  "skipIf", "sideEffect", "waitAsync", "heartbeatTimeoutMs", "idempotencyKey", "output"];
function nodeConfig(props = {}) {
  const cfg = {};
  for (const k of NODE_CFG_KEYS) if (props[k] !== undefined) cfg[k] = props[k];
  return cfg;
}
// Parse a `smithers graph --format json` xml tree into a task DAG (sequence =
// chain, parallel/branch = fan) for visual rendering (mermaid). Each task node
// carries its type, the enclosing group (parallel/branch), and its declared
// control config so the dashboard can inspect + tweak per-node settings.
function graphToDag(xml) {
  const nodes = [], edges = []; let auto = 0;
  const idOf = (n) => n.props?.id || n.props?.name || (n.tag.replace("smithers:", "") + "_" + (auto++));
  function walk(node, parents, group) {
    const tag = (node.tag || "").replace("smithers:", "");
    const kids = node.children || [];
    if (tag === "task") {
      const id = idOf(node);
      nodes.push({ id, label: node.props?.id || id, type: "task", group, config: nodeConfig(node.props) });
      parents.forEach((p) => edges.push({ from: p, to: id }));
      return [id];
    }
    // Fan groups: children all branch off the same parents (concurrent / conditional).
    if (tag === "parallel" || tag === "branch") {
      let outs = []; for (const k of kids) outs = outs.concat(walk(k, parents, tag)); return outs.length ? outs : parents;
    }
    // Sequential containers that carry a visible group badge. `loop` also draws a
    // back-edge (last child → first) so the repeat is visible; `saga` (compensating
    // steps) and a nested `subworkflow` chain children under their own tag.
    if (tag === "loop" || tag === "saga" || tag === "subworkflow") {
      const firstBefore = nodes.length;
      let prev = parents; for (const k of kids) prev = walk(k, prev, tag);
      if (tag === "loop" && nodes.length > firstBefore && prev.length) {
        const firstId = nodes[firstBefore]?.id;
        if (firstId) prev.forEach((p) => edges.push({ from: p, to: firstId, loop: true }));
      }
      return prev;
    }
    // sequence / workflow / wrapper: chain children, inherit group
    let prev = parents; for (const k of kids) prev = walk(k, prev, group); return prev;
  }
  walk(xml, [], null);
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
// Read: live model roster (catalog ∩ liveness) for the drawer's model picker.
app.get("/api/models", (c) => c.json(liveModels()));
// Read: model x task-kind performance matrix (best model per task) for the dashboard.
app.get("/api/model-matrix", (c) => c.json(modelMatrix()));
// Read: efficiency view — tokens by workflow + downgrade savings + applied.
app.get("/api/efficiency", (c) => c.json(efficiency()));
// Read: scheduled jobs (launchd timers) — schedule, target workflow, live status.
app.get("/api/schedules", (c) => c.json({ schedules: schedules() }));
// Read: review-worthy run signal (failed/stale/low-quality) across all DBs.
app.get("/api/signal", (c) => c.json(scanSignal(DB_DIR, { days: Number(c.req.query("days")) || 14 })));
// Read: the arena fixture set — static (curated) + harvested (real run inputs).
app.get("/api/fixtures", (c) => {
  let stat = []; try { stat = JSON.parse(readFileSync(join(HERE, "state/fixtures.json"), "utf8")); } catch { /* */ }
  let harvested = []; try { harvested = harvestFixtures(DB_DIR, { perKind: 2 }); } catch { /* */ }
  return c.json({ static: stat, harvested });
});
// Read/write: operator directives steering the self-improvement loops. Injected
// into experiment breeding/scoring (experiments.jsx) + every agent's system prompt
// (agents.js#directiveSystem). Write is Access-gated like the other mutations.
const DIRECTIVES_PATH = join(HERE, "state", "directives.json");
app.get("/api/directives", (c) => { try { return c.json(JSON.parse(readFileSync(DIRECTIVES_PATH, "utf8"))); } catch { return c.json({}); } });
app.post("/api/directives", async (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "body must be a JSON object" }, 400);
  body._updated = new Date().toISOString().slice(0, 10); body._updatedBy = op;
  try { mkdirSync(dirname(DIRECTIVES_PATH), { recursive: true }); writeFileSync(DIRECTIVES_PATH, JSON.stringify(body, null, 2) + "\n"); }
  catch (e) { return c.json({ error: "save failed: " + e.message }, 500); }
  console.error(`directives saved by ${op}`);
  return c.json({ ok: true, savedBy: op });
});
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
// Resume a paused/approved/stale run DETACHED — it may run model-calling tasks,
// so it must not block the request (unlike cliWithDb's 20s sync path). Uses
// `up <wf> --resume <id> --force`: continues from the durable checkpoint in the
// workflow's own named dbPath (no smithers.db symlink needed); --force handles
// the waiting-event state a gate-paused run is left in. This is the continuation
// after an approval is granted (granting alone only records the decision).
function resumeDetached(runId) {
  const wf = runWorkflowPath(runId);
  if (!wf || !existsSync(wf)) return false;
  const child = spawn(SMITHERS_BIN, ["up", wf, "--resume", runId, "--force"], { cwd: HERE, env: nvidiaEnv(), detached: true, stdio: "ignore" });
  child.unref();
  return true;
}
app.post("/api/runs/:runId/cancel", (c) => cliAction(c, "cancel"));
// Resume a stalled/crashed/failed run from its last durable checkpoint (detached).
app.post("/api/runs/:runId/resume", (c) => {
  const op = operator(c);
  if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const runId = c.req.param("runId");
  const ok = resumeDetached(runId);
  console.error(`resume: ${runId} by ${op}`);
  return ok ? c.json({ ok: true, resumed: true }) : c.json({ error: "run not found" }, 404);
});
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
// Approve/deny a gate, then AUTO-RESUME (detached) so the approved action actually
// executes (granting alone only records the decision; the paused run must resume).
app.post("/api/runs/:runId/approve", async (c) => {
  const op = operator(c);
  if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const b = await c.req.json().catch(() => ({}));
  const runId = c.req.param("runId");
  const db = runDbPath(runId);
  if (!db) return c.json({ error: "run not found" }, 404);
  const grant = cliWithDb(db, ["approve", runId, ...(b.node ? ["--node", b.node, "--iteration", String(b.iteration ?? 0)] : [])]);
  resumeDetached(runId);
  console.error(`approve+resume: ${runId} by ${op} ${b.node || ""}`);
  return c.json({ ok: true, output: grant.out.slice(0, 400), resumed: true });
});
app.post("/api/runs/:runId/deny", async (c) => {
  const op = operator(c);
  if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const b = await c.req.json().catch(() => ({}));
  const runId = c.req.param("runId");
  const db = runDbPath(runId);
  if (!db) return c.json({ error: "run not found" }, 404);
  const out = cliWithDb(db, ["deny", runId, ...(b.node ? ["--node", b.node, "--iteration", String(b.iteration ?? 0)] : [])]);
  resumeDetached(runId);
  console.error(`deny+resume: ${runId} by ${op} ${b.node || ""}`);
  return c.json({ ok: true, output: out.out.slice(0, 400) });
});
// Pending approval gates across all DBs (for the approvals panel).
app.get("/api/approvals", (c) => {
  const pending = [];
  for (const path of listDbs()) {
    try {
      withDb(path, (db) => {
        if (!tableExists(db, "_smithers_approvals")) return;
        // Only gates whose run is still live — a cancelled/finished run leaves its
        // approval row as 'requested', which would otherwise show as a phantom
        // pending gate (and inflate the badge) forever.
        for (const r of db.query(
          `SELECT a.run_id, a.node_id, a.iteration, a.status, a.requested_at_ms, a.request_json
           FROM _smithers_approvals a JOIN _smithers_runs r ON a.run_id = r.run_id
           WHERE a.status IN ('pending','requested')
             AND r.status NOT IN ('finished','failed','cancelled','denied','errored')`).all())
          pending.push({ ...r, db: basename(path) });
      });
    } catch { /* */ }
  }
  return c.json({ pending });
});
// Approval-notify default: the channel set the server-side notifier dispatches on
// (browser is client-side). Live-editable from the Approvals tab.
app.get("/api/notify-config", (c) => c.json({ channels: liveNotifyChannels(), available: AVAILABLE_CHANNELS, default: NOTIFY_DEFAULT }));
app.post("/api/notify-config", async (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const valid = new Set(AVAILABLE_CHANNELS.map((x) => x.id));
  const channels = (Array.isArray(body.channels) ? body.channels : []).filter((x) => valid.has(x));
  saveNotifyChannels(channels);
  console.error(`notify-config: [${channels.join(",") || "none"}] by ${op}`);
  return c.json({ ok: true, channels });
});

// ── Workflow chaining ────────────────────────────────────────────────────────
// String multiple workflows into a sequential pipeline: each step launches only
// after the prior step reaches a terminal (finished) state, optionally feeding
// the prior step's primary output in as the next step's ctx.input. A step that
// pauses at an approval gate HOLDS the chain (the runner keeps polling) until the
// operator approves in the Approvals tab — so chains compose cleanly with the
// existing gate flow. Chains persist to state/chains/<id>.json, so an in-flight
// chain survives a server restart and renders in the dashboard. Step launches
// reuse the same bounded, allowlisted path as /api/launch (no arbitrary code/env).
const CHAINS_DIR = join(HERE, "state", "chains");
function loadChains() {
  try {
    return readdirSync(CHAINS_DIR).filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(join(CHAINS_DIR, f), "utf8")); } catch { return null; } })
      .filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch { return []; }
}
function saveChain(ch) {
  try { mkdirSync(CHAINS_DIR, { recursive: true }); writeFileSync(join(CHAINS_DIR, ch.id + ".json"), JSON.stringify(ch, null, 2)); } catch { /* */ }
}
function dbForWorkflowFile(name) {
  const stem = basename(name).replace(/\.(jsx|tsx)$/, "");
  for (const p of listDbs()) { const ds = basename(p).replace(/\.db$/, ""); if (stem === ds || stem.startsWith(ds + "-")) return p; }
  return null;
}
// Newest run in the workflow's DB created since `sinceMs` — how we discover the
// runId of a detached `smithers up` we just spawned (it generates the id itself).
function findStepRun(name, sinceMs) {
  const db = dbForWorkflowFile(name); if (!db) return null;
  try {
    return withDb(db, (d) => tableExists(d, "_smithers_runs")
      ? d.query("SELECT run_id, status FROM _smithers_runs WHERE created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT 1").get(sinceMs - 2000) : null);
  } catch { return null; }
}
function findRunStatus(runId) {
  const r = findRunRow(runId);
  return r ? r.status : null;
}
// Full row (status + timing) so the chain runner can tell a live hold from a dead
// one: a run parked at an approval gate keeps its heartbeat via the supervisor,
// whereas a crashed/killed run stops beating (or never did) and its status is
// frozen forever. We use that to detect a wedged step instead of polling it for eternity.
function findRunRow(runId) {
  for (const p of listDbs()) {
    try {
      const r = withDb(p, (d) => tableExists(d, "_smithers_runs")
        ? d.query("SELECT status, created_at_ms, heartbeat_at_ms FROM _smithers_runs WHERE run_id=?").get(runId) : null);
      if (r) return r;
    } catch { /* */ }
  }
  return null;
}
// A held step is "stalled" (dead process) when it's in a non-terminal RUNNING state
// with no fresh heartbeat. waiting-approval is EXCLUDED — that's a legitimate,
// indefinite human hold and must never be auto-stalled. Threshold via env.
const CHAIN_STALL_MS = Number(process.env.CHAD_CHAIN_STALL_MS || 30 * 60 * 1000); // 30 min
function stepIsStalled(row) {
  if (!row) return false;
  const s = String(row.status || "").toLowerCase();
  if (s !== "running" && s !== "waiting-event") return false; // terminal & waiting-approval are not stalls
  const beat = row.heartbeat_at_ms || row.created_at_ms || 0;   // never-beat → age from creation
  return beat > 0 && (Date.now() - beat) > CHAIN_STALL_MS;
}
// Primary output of a finished run, to feed the next step as input. Prefer a
// report/result/synthesize/fusion table, else the last output table's last row.
function runOutputPayload(runId) {
  const d = runDetail(runId); if (!d) return null;
  const tables = Object.keys(d.outputs || {}); if (!tables.length) return null;
  const pick = ["report", "result", "synthesize", "fusion"].find((t) => tables.includes(t)) || tables[tables.length - 1];
  const rows = d.outputs[pick] || []; const row = rows[rows.length - 1] || {};
  const { run_id, node_id, iteration, ...rest } = row; void run_id; void node_id; void iteration;
  return { table: pick, ...rest };
}
function launchChainStep(ch, idx) {
  const step = ch.steps[idx];
  const wf = resolveWorkflow(step.workflow);
  if (!wf) { step.status = "error"; step.error = "unknown workflow"; ch.status = "failed"; return; }
  let input = step.input;
  if (ch.passOutput && idx > 0) {
    const prev = ch.steps[idx - 1];
    const payload = prev.runId ? runOutputPayload(prev.runId) : null;
    if (payload) input = { ...(input || {}), from: prev.workflow, output: payload };
  }
  const args = ["up", wf];
  if (input) args.push("--input", JSON.stringify(input));
  const extra = pickLaunchEnv(step.env);
  const child = spawn(SMITHERS_BIN, args, { cwd: HERE, env: { ...nvidiaEnv(), ...extra }, detached: true, stdio: "ignore" });
  child.unref();
  step.status = "launching"; step.startedAt = Date.now();
  console.error(`chain ${ch.id}: launched step ${idx} ${basename(wf)} (pid ${child.pid})`);
}
// One advance step for a running chain. Returns true if anything changed (→ save).
function advanceChain(ch) {
  if (ch.status !== "running") return false;
  const step = ch.steps[ch.current];
  if (!step) { ch.status = "finished"; ch.finishedAt = Date.now(); return true; }
  if (!step.runId) {
    if (!step.startedAt) { launchChainStep(ch, ch.current); return true; }
    const r = findStepRun(step.workflow, step.startedAt);     // discover the runId
    if (r) { step.runId = r.run_id; step.status = r.status; return true; }
    return false;                                             // not visible yet; next tick
  }
  const row = findRunRow(step.runId);
  const status = row ? row.status : null;
  let changed = false;
  if (status && status !== step.status) { step.status = status; changed = true; }
  const s = String(step.status || "").toLowerCase();
  if (s === "finished") {
    step.finishedAt = step.finishedAt || Date.now();
    if (ch.current + 1 < ch.steps.length) ch.current += 1;
    else { ch.status = "finished"; ch.finishedAt = Date.now(); }
    changed = true;
  } else if (s === "failed" || s === "cancelled" || s === "denied" || s === "errored") {
    ch.status = "failed"; ch.finishedAt = Date.now(); changed = true;   // a failed step stops the chain
  } else if (stepIsStalled(row)) {
    // The held run's process is dead (running/waiting-event, heartbeat gone stale) —
    // it will never transition, so stop polling it forever. Mark the chain "stalled"
    // (distinct from failed) so the frontend stops showing a false "running" and the
    // operator can chain-resume (re-run the step fresh) or chain-cancel.
    step.status = "stalled"; ch.status = "stalled"; ch.stalledAt = Date.now();
    ch.stallReason = `step ${ch.current} (${step.workflow}) run ${String(step.runId).slice(0, 8)} `
      + `stuck in ${s} with no heartbeat > ${Math.round(CHAIN_STALL_MS / 60000)}min`;
    console.error(`chain stalled: ${ch.id} — ${ch.stallReason}`);
    changed = true;
  } // waiting-approval (live human hold) → keep polling (chain held)
  return changed;
}
function chainTick() {
  setInterval(() => {
    for (const ch of loadChains()) { if (ch.status === "running" && advanceChain(ch)) saveChain(ch); }
  }, 4000);
}

app.get("/api/chains", (c) => c.json({ chains: loadChains() }));
app.get("/api/chains/:id", (c) => { const ch = loadChains().find((x) => x.id === c.req.param("id")); return ch ? c.json(ch) : c.json({ error: "not found" }, 404); });
// Build a fresh, runnable chain record from a step list. Steps are reduced to the
// launch-safe shape (workflow + input + allowlisted env) with all run state reset,
// so this is reused for both create and fork/clone — a forked chain is just a new
// run built from another chain's step definitions, leaving the source untouched.
function buildChain(op, steps, passOutput, extra = {}) {
  return {
    id: `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(), createdBy: op, status: "running", passOutput: !!passOutput, current: 0,
    ...extra,
    steps: steps.map((s) => ({ workflow: s.workflow, input: s.input || null, env: pickLaunchEnv(s.env), status: "pending" })),
  };
}
app.post("/api/chains", async (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length < 2) return c.json({ error: "a chain needs at least 2 steps" }, 400);
  for (const s of steps) if (!resolveWorkflow(s.workflow || "")) return c.json({ error: `unknown workflow: ${s.workflow}` }, 400);
  const ch = buildChain(op, steps, body.passOutput);
  saveChain(ch);
  console.error(`chain start: ${ch.id} by ${op} (${steps.map((s) => s.workflow).join(" → ")})`);
  return c.json({ ok: true, id: ch.id, chain: ch });
});
// Fork/clone: spin up a NEW chain run from an existing chain's step definitions —
// the source (running or finished) is left exactly as-is. The whole pipeline re-runs
// from step 0; pass {passOutput} to override the source's setting. This is the
// "copy + re-run a chain" primitive (the chain-level analogue of forking a run).
app.post("/api/chains/:id/fork", async (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const src = loadChains().find((x) => x.id === c.req.param("id"));
  if (!src) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  for (const s of src.steps) if (!resolveWorkflow(s.workflow || "")) return c.json({ error: `unknown workflow in source: ${s.workflow}` }, 400);
  const ch = buildChain(op, src.steps, body.passOutput ?? src.passOutput, { forkedFrom: src.id });
  saveChain(ch);
  console.error(`chain fork: ${ch.id} from ${src.id} by ${op}`);
  return c.json({ ok: true, id: ch.id, forkedFrom: src.id, chain: ch });
});
app.post("/api/chains/:id/cancel", (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const ch = loadChains().find((x) => x.id === c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  const cur = ch.steps[ch.current];
  if (cur && cur.runId) { const db = runDbPath(cur.runId); if (db) cliWithDb(db, ["cancel", cur.runId]); }
  ch.status = "cancelled"; ch.finishedAt = Date.now(); saveChain(ch);
  console.error(`chain cancel: ${ch.id} by ${op}`);
  return c.json({ ok: true });
});
// Resume a failed/cancelled chain: re-run the step it stopped on (fresh) and let
// the runner carry on. A step that merely paused at an approval gate is handled by
// the normal approve→resume flow, so this is for the failed/cancelled case.
// Reset a chain to re-run from step `idx` onward: clear those steps' run state and
// point the runner at idx. Steps before idx keep their finished runs (so `resume`
// continues, `run-again` with idx=0 re-runs everything).
function resetChainSteps(ch, idx) {
  for (let i = idx; i < ch.steps.length; i++) {
    const s = ch.steps[i];
    s.runId = null; s.startedAt = null; s.finishedAt = null; s.status = "pending"; delete s.error;
  }
  ch.current = idx; ch.status = "running"; delete ch.finishedAt;
}
// Resume a FAILED/STALLED chain from the first non-finished step and carry on.
// (For a fully finished chain use run-again — resume has nothing to continue.)
app.post("/api/chains/:id/resume", (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const ch = loadChains().find((x) => x.id === c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  const idx = ch.steps.findIndex((s) => !["finished"].includes(String(s.status || "").toLowerCase()));
  if (idx === -1) return c.json({ error: "chain is fully finished — use run-again to re-run it" }, 400);
  resetChainSteps(ch, idx);
  delete ch.stalledAt; delete ch.stallReason;
  saveChain(ch);
  console.error(`chain resume: ${ch.id} from step ${idx} by ${op}`);
  return c.json({ ok: true, resumedFrom: idx });
});
// Re-run a chain from a specific step (reset that step + everything after it).
app.post("/api/chains/:id/rerun-step", async (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const ch = loadChains().find((x) => x.id === c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const idx = Math.max(0, Math.min(ch.steps.length - 1, Number(body.index) || 0));
  resetChainSteps(ch, idx);
  saveChain(ch);
  console.error(`chain rerun-step: ${ch.id} from step ${idx} by ${op}`);
  return c.json({ ok: true, rerunFrom: idx });
});
// Run the WHOLE chain again in place (reset every step → re-run from 0). This is
// the intuitive "run again" for a finished/failed/stalled chain — distinct from
// resume (continue the stuck step) and fork (copy to a NEW chain). Same record.
app.post("/api/chains/:id/run-again", (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const ch = loadChains().find((x) => x.id === c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  resetChainSteps(ch, 0);
  delete ch.stalledAt; delete ch.stallReason;
  saveChain(ch);
  console.error(`chain run-again: ${ch.id} by ${op}`);
  return c.json({ ok: true, id: ch.id });
});
// Delete a chain record from the list. Guarded to terminal states so an operator
// can't yank a live chain's record out from under the runner mid-flight.
app.delete("/api/chains/:id", (c) => {
  const op = operator(c); if (!op) return c.json({ error: "forbidden (Cloudflare Access required)" }, 403);
  const ch = loadChains().find((x) => x.id === c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  if (ch.status === "running") return c.json({ error: "cancel the chain before deleting a running one" }, 400);
  try { unlinkSync(join(CHAINS_DIR, ch.id + ".json")); }
  catch (e) { return c.json({ error: "delete failed: " + e.message }, 500); }
  console.error(`chain delete: ${ch.id} (${ch.status}) by ${op}`);
  return c.json({ ok: true, deleted: ch.id });
});

// Static dashboard.
app.get("/", (c) => c.html(readFileSync(join(HERE, "public/index.html"), "utf8")));
app.get("/index.html", (c) => c.html(readFileSync(join(HERE, "public/index.html"), "utf8")));

// ── Approval notifier (best-effort push for pending gates) ───────────────────
// Polls for new pending/requested approvals and pushes via the configured
// pod-side channels. Deduped per (run,node,iteration). Browser push is separate
// (client-side). webui/email dispatch via fixed pod binaries; telegram/moshi
// dispatch via the operator-supplied command templates above (when configured).
const _notifiedApprovals = new Set();
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
function podRun(cmd) {
  try { const c = spawn("ssh", ["-n", "-o", "ConnectTimeout=15", POD_SSH, cmd], { stdio: "ignore" }); c.on("error", () => {}); c.unref(); } catch { /* */ }
}
// Run an operator-supplied template on the pod, substituting {text} (shell-quoted)
// for the message. {text} unset → append the quoted text so a bare command still works.
function podRunTemplate(tmpl, text) {
  if (!tmpl) return;
  const q = shq(text);
  const cmd = tmpl.includes("{text}") ? tmpl.replaceAll("{text}", q) : `${tmpl} ${q}`;
  podRun(`${cmd} 2>/dev/null || true`);
}
function dispatchApproval(p) {
  const channels = liveNotifyChannels();
  const title = "Chad · approval needed";
  const body = `${p.db} · ${p.node_id} (run ${String(p.run_id).slice(0, 8)}) — approve at ${RUNS_PUBLIC_URL}`;
  if (channels.includes("webui")) podRun(`${POD_WEBUI} notes create --title ${shq(title)} --content ${shq(body)} --tags chad-approvals 2>/dev/null || true`);
  if (channels.includes("email")) podRun(`chad-mail-send --to ${shq(OPERATOR_EMAIL)} --subject ${shq(title)} --body ${shq(body)} 2>/dev/null || true`);
  if (channels.includes("telegram")) podRunTemplate(POD_TELEGRAM_CMD, `${title}: ${body}`);
  if (channels.includes("moshi")) podRunTemplate(POD_MOSHI_CMD, `${title}: ${body}`);
}
function approvalNotifier() {
  // Always poll — the dispatch channel set is live-editable from the Approvals tab,
  // so a channel can be enabled after startup; dispatchApproval no-ops when none on.
  setInterval(() => {
    for (const path of listDbs()) {
      try {
        withDb(path, (db) => {
          if (!tableExists(db, "_smithers_approvals")) return;
          for (const r of db.query(
            `SELECT a.run_id, a.node_id, a.iteration FROM _smithers_approvals a
             JOIN _smithers_runs r ON a.run_id = r.run_id
             WHERE a.status IN ('pending','requested')
               AND r.status NOT IN ('finished','failed','cancelled','denied','errored')`).all()) {
            const k = `${r.run_id}:${r.node_id}:${r.iteration}`;
            if (_notifiedApprovals.has(k)) continue;
            _notifiedApprovals.add(k);
            dispatchApproval({ ...r, db: basename(path) });
          }
        });
      } catch { /* */ }
    }
  }, 20000);
}
approvalNotifier();
chainTick(); // advance any running workflow chains

console.error(`serve-runs: durable DB dashboard on http://${HOST}:${PORT}  (scanning ${DB_DIR})${liveNotifyChannels().length ? ` · approval-notify: ${liveNotifyChannels().join(",")}` : ""}`);
export default { port: PORT, hostname: HOST, fetch: app.fetch };
