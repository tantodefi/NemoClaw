// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// fixtures.js — harvest REAL run inputs from the DBs into arena fixtures, so the
// evolution loop scores candidates against live cases (the actual messages,
// prompts, logs, and issues that flowed through Chad) instead of only the static
// hand-written 8. Closes the last "static input context" gap: the arena now tests
// against what actually happened. Non-destructive — augments state/fixtures.json.
//
// sqlite3-CLI based (no bun:sqlite dep) so it imports into both the Smithers
// workflow (experiments.jsx) and the bun dashboard (serve-runs).

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function jq(db, sql) {
  try { return JSON.parse(execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", timeout: 6000 }) || "[]"); }
  catch { return []; }
}
const has = (db, t) => jq(db, `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`).length > 0;
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h).toString(36); };

/**
 * harvestFixtures(dir, opts) — derive arena fixtures from recent real run data.
 * Returns [{ id, taskKind, input, rubric, source, harvested:true }], deduped,
 * capped per taskKind, recent-first.
 */
export function harvestFixtures(dir, { perKind = 2, maxLen = 600 } = {}) {
  let dbs = [];
  try { dbs = readdirSync(dir).filter((f) => f.endsWith(".db") && f !== "smithers.db"); } catch { /* */ }
  const find = (stem) => dbs.find((f) => f.replace(/\.db$/, "") === stem || f.startsWith(stem + "."));
  const out = []; const seen = new Set();
  const push = (taskKind, input, rubric, source) => {
    input = String(input || "").trim().replace(/\s+\n/g, "\n").slice(0, maxLen);
    if (input.length < 15 || /HOUSE-STYLE|TEST-TOKEN|smoke|^say hi$/i.test(input)) return; // skip trivial/test
    const h = hash(taskKind + "|" + input); if (seen.has(h)) return; seen.add(h);
    out.push({ id: `harvested-${h}`, taskKind, input, rubric, source, harvested: true });
  };
  const payloads = (db, n = 12) => has(join(dir, db), "input")
    ? jq(join(dir, db), `SELECT payload FROM input ORDER BY rowid DESC LIMIT ${n}`).map((r) => { try { return JSON.parse(r.payload); } catch { return null; } }).filter(Boolean)
    : [];

  // email-ladder inbound messages → draft fixtures (the operator-facing case)
  const el = find("email-ladder");
  if (el) for (const p of payloads(el)) {
    const body = p.body || (p.output && p.output.note) || "";
    if (body) push("draft", (p.subject ? `Re: ${p.subject}\n` : "") + body, "Actionable reply in Chad's voice; exactly one concrete next step; safe; no hedging.", el);
  }
  // fusion prompts → draft fixtures (real questions people fused)
  const fz = find("fusion");
  if (fz) for (const p of payloads(fz)) if (p.prompt) push("draft", p.prompt, "Direct, correct, concise answer; no hedging.", fz);
  // log-digest log samples → summarize fixtures
  const ld = find("log-digest");
  if (ld && has(join(dir, ld), "collected")) for (const r of jq(join(dir, ld), "SELECT sample FROM collected WHERE sample IS NOT NULL AND sample!='' ORDER BY rowid DESC LIMIT 4"))
    if (r.sample) push("summarize", r.sample, "Cluster the log lines into distinct issues, one next-step action each.", ld);
  // issue-triage selected issues → classify fixtures
  const it = find("issue-triage");
  if (it && has(join(dir, it), "issues")) for (const r of jq(join(dir, it), "SELECT selected FROM issues ORDER BY rowid DESC LIMIT 4")) {
    try { const titles = (JSON.parse(r.selected) || []).map((x) => `#${x.number} ${x.title}`).join("\n"); if (titles) push("classify", "Classify these GitHub issues by kind + priority:\n" + titles, "Correct kind (bug/feature/chore) + a defensible priority.", it); }
    catch { /* */ }
  }
  // cap per taskKind (recent-first; out is already DESC per source)
  const byKind = {}; const capped = [];
  for (const f of out) { byKind[f.taskKind] = (byKind[f.taskKind] || 0) + 1; if (byKind[f.taskKind] <= perKind) capped.push(f); }
  return capped;
}
