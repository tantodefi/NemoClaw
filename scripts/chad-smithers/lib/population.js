// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// population.js — evolutionary experiment state: start wide, test in parallel,
// keep only what works over time.
//
// Operator directive (2026-06-13): "test them in parallel then select the best,
// make sure that over time we only keep and use what works, but start wide."
//
// This is the deterministic core (pure functions + JSON persistence). The
// Smithers workflow (experiments.jsx) supplies the parallelism, durability, and
// the LLM scorer; this file owns the population lifecycle so the selection
// logic is unit-testable without an LLM in the loop.
//
// ── Candidate lifecycle ──────────────────────────────────────────────────────
//   active   → in the arena; evaluated every run, accrues trials/scores.
//   champion → an active candidate currently in the top cohort (used in prod).
//   retired  → pruned: consistently underperformed after enough trials. Kept on
//              record (never deleted) so we don't re-explore a known loser.
//
// A candidate:
//   { id, kind, spec, status, trials, scores:[recent...], created, lastEvaluated,
//     rollingMean, note }
//   kind   what is being varied (e.g. "drafter-prompt", "model", "params").
//   spec   the variant payload the workflow knows how to execute & score.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ── Tunable selection policy ─────────────────────────────────────────────────
export const POLICY = {
  windowSize: 7,        // rolling window: average over the last N trials
  minTrials: 3,         // don't retire a candidate before this many trials
  retireBelow: 0.45,    // rolling mean below this (after minTrials) → retired
  championTopK: 3,      // top-K active candidates promoted to champion (feed fusion panel)
  targetActive: 10,     // keep at least this many active candidates (wider arena)
  maxActive: 16,        // ceiling on simultaneous active candidates (budget)
  expandPerRun: 4,      // spawn up to N new candidates per run to fill the arena fast
};

export function loadPopulation(path) {
  if (!existsSync(path)) return { version: 1, candidates: [], history: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

export function savePopulation(path, pop) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pop, null, 2) + "\n");
}

export function activeCandidates(pop) {
  return pop.candidates.filter((c) => c.status === "active" || c.status === "champion");
}

export function rollingMean(scores, windowSize = POLICY.windowSize) {
  const w = scores.slice(-windowSize);
  if (w.length === 0) return 0;
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/**
 * recordScore — append one trial result to a candidate and recompute its mean.
 * score is a normalized 0..1 quality measure from the workflow's scorer.
 */
export function recordScore(pop, id, score, ts = new Date().toISOString()) {
  const c = pop.candidates.find((x) => x.id === id);
  if (!c) throw new Error(`population: unknown candidate ${id}`);
  c.scores = (c.scores ?? []).concat(score).slice(-POLICY.windowSize * 2);
  c.trials = (c.trials ?? 0) + 1;
  c.lastEvaluated = ts;
  c.rollingMean = rollingMean(c.scores);
  return c;
}

/**
 * select — the heart of "keep only what works":
 *   1. rank active candidates by rolling mean (desc),
 *   2. promote top-K to champion, demote the rest to active,
 *   3. retire any candidate below retireBelow once it has minTrials of evidence.
 * Returns { champions, retired } id lists for reporting.
 */
export function select(pop, policy = POLICY) {
  const ranked = activeCandidates(pop).sort(
    (a, b) => (b.rollingMean ?? 0) - (a.rollingMean ?? 0),
  );
  const retired = [];
  for (const c of ranked) {
    if ((c.trials ?? 0) >= policy.minTrials && (c.rollingMean ?? 0) < policy.retireBelow) {
      c.status = "retired";
      c.note = `retired: rollingMean ${c.rollingMean.toFixed(3)} < ${policy.retireBelow} after ${c.trials} trials`;
      retired.push(c.id);
    }
  }
  const stillActive = ranked.filter((c) => c.status !== "retired");
  const champions = [];
  stillActive.forEach((c, i) => {
    c.status = i < policy.championTopK ? "champion" : "active";
    if (c.status === "champion") champions.push(c.id);
  });
  return { champions, retired };
}

/**
 * needsExpansion — how many candidates to add to keep the arena wide. On a cold
 * or thinned population it fills straight up to targetActive ("start wide"); at
 * or above target it returns 0. (POLICY.expandPerRun throttles a *separate*,
 * not-yet-wired champion-mutation step, not this bootstrap fill.)
 */
export function needsExpansion(pop, policy = POLICY) {
  const n = activeCandidates(pop).length;
  if (n >= policy.targetActive) return 0;
  return Math.min(policy.targetActive - n, policy.maxActive - n);
}

/** addCandidate — register a new variant (from seed or from a mutated champion). */
export function addCandidate(pop, { kind, spec, note }, ts = new Date().toISOString()) {
  const id = `${kind}-${ts.replace(/[^0-9]/g, "").slice(0, 14)}-${pop.candidates.length}`;
  pop.candidates.push({
    id, kind, spec, status: "active",
    trials: 0, scores: [], rollingMean: 0,
    created: ts, lastEvaluated: null, note: note ?? "seeded",
  });
  return id;
}

/** champions — current production-selected variants. */
export function champions(pop) {
  return pop.candidates.filter((c) => c.status === "champion");
}

/** leaderboard — operator-facing markdown table, freshest scores first. */
export function leaderboard(pop) {
  const rows = [...pop.candidates]
    .sort((a, b) => (b.rollingMean ?? 0) - (a.rollingMean ?? 0))
    .map((c) =>
      `| ${c.status === "champion" ? "🏆" : c.status === "retired" ? "🪦" : "  "} | ${c.id} | ${c.kind} | ${(c.rollingMean ?? 0).toFixed(3)} | ${c.trials ?? 0} | ${c.status} |`,
    );
  return [
    "| | candidate | kind | rolling | trials | status |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
