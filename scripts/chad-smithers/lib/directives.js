// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/directives.js — resolve the operator directives that steer a run. Directives
// have a GLOBAL default (state/directives.json, edited in the Directives tab) but a
// run can DISABLE the global set and/or supply a per-run OVERRIDE, so directives
// themselves can be A/B-experimented on. Resolution (all via env, so it rides the
// same allowlisted launch-env path as every other run knob):
//
//   CHAD_DIRECTIVES_OFF=1        → ignore the global file (start from {})
//   CHAD_DIRECTIVES_JSON='{…}'   → per-run override (partial or full)
//   CHAD_DIRECTIVES=<path>       → override the global file path (existing; tests)
//
// Semantics: global-on + override → MERGE (override wins per-field); global-off +
// override → the override ALONE (replace); global-off + none → {} (no directives);
// global-on + none → the global file (today's behavior). agents.js + experiments.jsx
// both resolve through here so the rules live in one tested place.

import { readFileSync } from "node:fs";

const DEFAULT_PATH = new URL("../state/directives.json", import.meta.url).pathname;

/** Deep-ish merge: override wins per top-level field; systemPrompts merged by role. */
export function mergeDirectives(base = {}, override = {}) {
  const out = { ...base, ...override };
  if (base.systemPrompts || override.systemPrompts) {
    out.systemPrompts = { ...(base.systemPrompts || {}), ...(override.systemPrompts || {}) };
  }
  // arrays (priorities) replace wholesale when the override provides one
  if (override.priorities) out.priorities = override.priorities;
  return out;
}

/** Pure core: given the loaded global `base` + an env-shaped object, resolve. */
export function resolveFrom(base, env = {}) {
  const globalOn = String(env.CHAD_DIRECTIVES_OFF || "") !== "1";
  let override = null;
  if (env.CHAD_DIRECTIVES_JSON) {
    try { const o = JSON.parse(env.CHAD_DIRECTIVES_JSON); if (o && typeof o === "object") override = o; } catch { /* bad json → ignore */ }
  }
  const start = globalOn ? (base || {}) : {};
  return override ? mergeDirectives(start, override) : start;
}

/** Resolve the effective directives for this process (reads the global file). */
export function resolveDirectives(env = process.env, opts = {}) {
  const path = env.CHAD_DIRECTIVES || opts.path || DEFAULT_PATH;
  let base = {};
  if (String(env.CHAD_DIRECTIVES_OFF || "") !== "1") {
    try { base = JSON.parse(readFileSync(path, "utf8")) || {}; } catch { base = {}; }
  }
  return resolveFrom(base, env);
}

/** systemPrompts additions for a role (global `all` + the role-specific one). */
export function directiveSystemFor(directives, role) {
  const sp = directives?.systemPrompts || {};
  const s = [sp.all, sp[role]].filter((x) => x && String(x).trim()).join("\n\n");
  return s || undefined;
}

/**
 * creativityKnob(creativity) — turn the operator's low|moderate|high dial into
 * concrete arena behavior: how many new variants to breed per run (a multiplier on
 * POLICY.expandPerRun) and a one-line steer for the mutate prompt. Unknown/empty →
 * moderate (the neutral default), so an unset dial changes nothing.
 */
export function creativityKnob(creativity) {
  switch (String(creativity || "").trim().toLowerCase()) {
    case "low":  return { expandMultiplier: 0.5, hint: "Refine conservatively: make a small, safe change to the leader — do not diverge." };
    case "high": return { expandMultiplier: 2,   hint: "Explore boldly: try a genuinely different angle, not a tweak — divergence is wanted." };
    default:     return { expandMultiplier: 1,   hint: "" }; // moderate / unset
  }
}

/** Does the arena care about this task-kind, given the operator's priorities list?
 *  Empty priorities → everything is in scope (no filtering). */
export function inScope(taskKind, priorities) {
  if (!Array.isArray(priorities) || priorities.length === 0) return true;
  return priorities.map((p) => String(p).toLowerCase()).includes(String(taskKind || "").toLowerCase());
}
