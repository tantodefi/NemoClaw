// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the deterministic PR triage that powers pr-shepherd.jsx.
// Pure logic, no LLM, no gh. Run: node --test lib/pr.test.js  (or `bun test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { prAction, shepherdSummary, checksFailing, PR_ACTIONS } from "./pr.js";

const NOW = new Date("2026-07-03T00:00:00Z").getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const base = { number: 1, title: "t", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], updatedAt: daysAgo(0) };

test("draft PRs report draft, whatever else is true", () => {
  assert.equal(prAction({ ...base, isDraft: true, mergeable: "CONFLICTING" }, { now: NOW }).action, "draft");
});

test("conflicts outrank failing checks and reviews (most-blocking first)", () => {
  const r = prAction({ ...base, mergeable: "CONFLICTING", statusCheckRollup: [{ conclusion: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED" }, { now: NOW });
  assert.equal(r.action, "conflicts");
});

test("failing checks beat a changes-requested review", () => {
  const r = prAction({ ...base, statusCheckRollup: [{ conclusion: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED" }, { now: NOW });
  assert.equal(r.action, "checks-failing");
});

test("changes-requested is surfaced when not conflicted/red", () => {
  assert.equal(prAction({ ...base, reviewDecision: "CHANGES_REQUESTED" }, { now: NOW }).action, "changes-requested");
});

test("approved + mergeable + green = merge-ready", () => {
  const r = prAction({ ...base, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }, { now: NOW });
  assert.equal(r.action, "merge-ready");
});

test("approved but conflicting is NOT merge-ready", () => {
  const r = prAction({ ...base, reviewDecision: "APPROVED", mergeable: "CONFLICTING" }, { now: NOW });
  assert.equal(r.action, "conflicts");
});

test("awaiting review, fresh → needs-review; stale → stale-nudge", () => {
  assert.equal(prAction({ ...base, reviewDecision: "REVIEW_REQUIRED", updatedAt: daysAgo(1) }, { now: NOW, staleDays: 3 }).action, "needs-review");
  assert.equal(prAction({ ...base, reviewDecision: "REVIEW_REQUIRED", updatedAt: daysAgo(5) }, { now: NOW, staleDays: 3 }).action, "stale-nudge");
});

test("empty reviewDecision is treated as awaiting review", () => {
  assert.equal(prAction({ ...base, reviewDecision: "", updatedAt: daysAgo(5) }, { now: NOW, staleDays: 3 }).action, "stale-nudge");
});

test("every action returned is in the known PR_ACTIONS set", () => {
  const cases = [
    { ...base, isDraft: true },
    { ...base, mergeable: "CONFLICTING" },
    { ...base, statusCheckRollup: [{ state: "ERROR" }] },
    { ...base, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] },
    { ...base, mergeable: "UNKNOWN", reviewDecision: "APPROVED" }, // waiting
  ];
  for (const c of cases) assert.ok(PR_ACTIONS.includes(prAction(c, { now: NOW }).action));
});

test("checksFailing handles array rollup and string summary", () => {
  assert.equal(checksFailing({ statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }] }), true);
  assert.equal(checksFailing({ statusCheckRollup: [{ conclusion: "SUCCESS" }] }), false);
  assert.equal(checksFailing({ statusCheckRollup: "1 failing" }), true);
  assert.equal(checksFailing({ statusCheckRollup: [] }), false);
});

test("empty check rollup is not blocking (merge-ready when approved)", () => {
  const r = prAction({ ...base, reviewDecision: "APPROVED", statusCheckRollup: [] }, { now: NOW });
  assert.equal(r.action, "merge-ready");
});

test("shepherdSummary counts by action", () => {
  const decisions = [{ action: "merge-ready" }, { action: "merge-ready" }, { action: "needs-review" }];
  assert.deepEqual(shepherdSummary(decisions), { "merge-ready": 2, "needs-review": 1 });
  assert.deepEqual(shepherdSummary([]), {});
});
