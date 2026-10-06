// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/pr.js — deterministic PR triage for pr-shepherd.jsx. Given a PR's public
// state (from `gh pr list --json`), decide the ONE next action — no LLM, so the
// shepherd's routing is cheap, reliable, and unit-testable (the same
// deterministic-first principle as scoreIssue in spawn.js). The workflow only
// spends a model on the human-readable nudge text, not on the decision.

// Rank order matters: the FIRST matching rule wins, most-blocking first, so a PR
// with conflicts AND failing checks reports "conflicts" (the thing to fix first).
export const PR_ACTIONS = [
  "draft",              // still a draft — not ready for anyone
  "conflicts",          // merge conflicts — author must rebase
  "checks-failing",     // CI red — author must fix
  "changes-requested",  // a reviewer blocked it — author must address
  "merge-ready",        // approved + mergeable + green — land it
  "stale-nudge",        // review-requested but untouched for STALE_DAYS — poke reviewers
  "needs-review",       // awaiting first review, still fresh
  "waiting",            // none of the above (e.g. unknown mergeability, in-flight CI)
];

// Did the status-check rollup fail? gh returns either a rollup array of
// {state|conclusion} or a summary string; treat any FAILURE/ERROR/TIMED_OUT as red.
export function checksFailing(pr = {}) {
  const roll = pr.statusCheckRollup;
  if (Array.isArray(roll)) {
    return roll.some((c) => /FAIL|ERROR|TIMED_OUT|CANCELLED/i.test(String(c.conclusion || c.state || "")));
  }
  return /FAIL|ERROR/i.test(String(roll || ""));
}

function checksPassing(pr = {}) {
  const roll = pr.statusCheckRollup;
  if (Array.isArray(roll)) {
    if (roll.length === 0) return true; // no checks configured = not blocking
    return roll.every((c) => /SUCCESS|NEUTRAL|SKIPPED/i.test(String(c.conclusion || c.state || "")));
  }
  return !/FAIL|ERROR|PENDING/i.test(String(roll || ""));
}

/**
 * prAction(pr, opts) — the single next action for one PR. Pure + deterministic.
 * @param pr    a `gh pr list --json` row: { number, title, isDraft, mergeable,
 *              reviewDecision, statusCheckRollup, updatedAt }
 * @param opts  { staleDays=3, now=Date.now() }
 * @returns { number, title, action, reason }
 */
export function prAction(pr = {}, opts = {}) {
  const staleDays = opts.staleDays ?? 3;
  const now = opts.now ?? Date.now();
  const mergeable = String(pr.mergeable || "").toUpperCase();
  const review = String(pr.reviewDecision || "").toUpperCase();
  const idleDays = pr.updatedAt ? (now - new Date(pr.updatedAt).getTime()) / 86400000 : 0;

  let action, reason;
  if (pr.isDraft) { action = "draft"; reason = "still a draft"; }
  else if (mergeable === "CONFLICTING") { action = "conflicts"; reason = "merge conflicts — rebase needed"; }
  else if (checksFailing(pr)) { action = "checks-failing"; reason = "CI is red"; }
  else if (review === "CHANGES_REQUESTED") { action = "changes-requested"; reason = "a reviewer requested changes"; }
  else if (review === "APPROVED" && mergeable === "MERGEABLE" && checksPassing(pr)) { action = "merge-ready"; reason = "approved, mergeable, green"; }
  else if ((review === "REVIEW_REQUIRED" || review === "") && idleDays >= staleDays) { action = "stale-nudge"; reason = `awaiting review ${Math.floor(idleDays)}d`; }
  else if (review === "REVIEW_REQUIRED" || review === "") { action = "needs-review"; reason = "awaiting first review"; }
  else { action = "waiting"; reason = "in flight (checks/mergeability pending)"; }

  return { number: pr.number, title: pr.title || "", action, reason };
}

/** Summarize a batch of PR decisions into counts by action (for the report). */
export function shepherdSummary(decisions = []) {
  const counts = {};
  for (const d of decisions) counts[d.action] = (counts[d.action] || 0) + 1;
  return counts;
}
