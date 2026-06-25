// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// signal.js — scan every run DB for stale/failed/low-quality data worth reviewing
// and feeding into the next improvement round. This is the trace-grounding
// mechanism (the Hermes "read traces → understand WHY → improve" pattern): the
// arena's reflective mutation and the dashboard both consume it, so experiments
// react to what actually broke instead of only static synthetic fixtures.
//
// sqlite3-CLI based (no bun:sqlite dep) so it imports cleanly into both the
// Smithers workflow context (experiments.jsx) and the bun dashboard (serve-runs).

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function jq(db, sql) {
  try { return JSON.parse(execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", timeout: 6000 }) || "[]"); }
  catch { return []; }
}
const has = (db, t) => jq(db, `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`).length > 0;
const errMsg = (j) => { try { const o = JSON.parse(j); return o.message || o.code || ""; } catch { return String(j || "").slice(0, 160); } };
const clusterKey = (m) => String(m).replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, "<id>").replace(/\d+/g, "N").trim().slice(0, 90);
const shortModel = (m) => String(m).split("/").pop();

/**
 * scanSignal(dir, opts) — review-worthy state across all *.db in `dir`.
 * Returns { scannedDbs, failedRuns, staleRuns, lowScorers, errorClusters, generatedAt }.
 */
export function scanSignal(dir, { days = 7, perDb = 8 } = {}) {
  const since = Date.now() - days * 864e5;
  const staleBefore = Date.now() - 2 * 3600e3; // non-terminal older than 2h = stale
  let dbs = [];
  try { dbs = readdirSync(dir).filter((f) => f.endsWith(".db") && f !== "smithers.db"); } catch { /* */ }
  const failedRuns = [], staleRuns = [], lowScorers = [], clusters = {};
  for (const f of dbs) {
    const db = join(dir, f);
    if (!has(db, "_smithers_runs")) continue;
    for (const r of jq(db, `SELECT run_id, workflow_name, created_at_ms, error_json FROM _smithers_runs WHERE status='failed' AND created_at_ms>=${since} ORDER BY created_at_ms DESC LIMIT ${perDb}`)) {
      const msg = errMsg(r.error_json);
      failedRuns.push({ db: f, runId: r.run_id, workflow: r.workflow_name, at: r.created_at_ms, error: msg.slice(0, 160) });
      const k = clusterKey(msg); if (k) clusters[k] = (clusters[k] || 0) + 1;
    }
    for (const r of jq(db, `SELECT run_id, workflow_name, status, created_at_ms FROM _smithers_runs WHERE status NOT IN ('finished','failed','cancelled','denied') AND created_at_ms < ${staleBefore} ORDER BY created_at_ms DESC LIMIT ${perDb}`))
      staleRuns.push({ db: f, runId: r.run_id, workflow: r.workflow_name, status: r.status, at: r.created_at_ms });
    if (has(db, "scores")) {
      for (const row of jq(db, "SELECT scores FROM scores")) {
        let arr; try { arr = JSON.parse(row.scores); } catch { continue; }
        if (!Array.isArray(arr)) continue;
        for (const s of arr) {
          if (!s || typeof s.scorePct !== "number") continue;
          if (/^[a-z0-9][a-z0-9-]*$/.test(String(s.candidate)) && String(s.model).includes("/") && s.scorePct < 60)
            lowScorers.push({ task: s.candidate, model: shortModel(s.model), score: s.scorePct, why: String(s.rationale || "").slice(0, 120) });
        }
      }
    }
  }
  lowScorers.sort((a, b) => a.score - b.score);
  const errorClusters = Object.entries(clusters).sort((a, b) => b[1] - a[1]).map(([error, count]) => ({ error, count }));
  return { scannedDbs: dbs.length, failedRuns, staleRuns, lowScorers: lowScorers.slice(0, 12), errorClusters, generatedAt: Date.now() };
}

// Compact text digest for injecting into an improvement prompt (mutate / self-improve).
export function signalText(sig) {
  if (!sig) return "";
  const lines = [];
  if (sig.errorClusters?.length) lines.push("Recent failure clusters: " + sig.errorClusters.slice(0, 5).map((e) => `${e.error} (x${e.count})`).join("; "));
  if (sig.lowScorers?.length) lines.push("Lowest-scoring candidates: " + sig.lowScorers.slice(0, 6).map((l) => `${l.task} on ${l.model}=${l.score}${l.why ? ` (${l.why})` : ""}`).join("; "));
  if (sig.staleRuns?.length) lines.push(`Stale non-terminal runs needing review: ${sig.staleRuns.length}`);
  return lines.join("\n");
}
