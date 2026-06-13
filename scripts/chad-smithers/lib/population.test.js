// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the evolutionary selection engine. Verifies the core directive:
// "over time we only keep and use what works, but start wide." Pure logic, no
// LLM. Run with: node --test lib/population.test.js  (or `bun test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rollingMean, recordScore, select, needsExpansion, addCandidate,
  activeCandidates, champions, POLICY,
} from "./population.js";

function freshPop() {
  return { version: 1, candidates: [], history: [] };
}

test("rollingMean averages only the last windowSize scores", () => {
  const scores = [0, 0, 0, 1, 1, 1, 1]; // window 7 → mean 4/7
  assert.ok(Math.abs(rollingMean(scores, 7) - 4 / 7) < 1e-9);
  // window shrinks to last 3 → all 1s → 1.0
  assert.equal(rollingMean(scores, 3), 1);
});

test("start wide: needsExpansion fills straight to targetActive on cold start", () => {
  const pop = freshPop();
  assert.equal(needsExpansion(pop), POLICY.targetActive); // empty → fill the arena
  for (let i = 0; i < POLICY.targetActive; i++) {
    addCandidate(pop, { kind: "drafter-prompt", spec: { label: `v${i}` } });
  }
  assert.equal(needsExpansion(pop), 0); // at target → stop expanding
});

test("keep only what works: persistent loser is retired after minTrials", () => {
  const pop = freshPop();
  const winner = addCandidate(pop, { kind: "model", spec: { label: "good" } });
  const loser = addCandidate(pop, { kind: "model", spec: { label: "bad" } });
  for (let i = 0; i < POLICY.minTrials; i++) {
    recordScore(pop, winner, 0.9);
    recordScore(pop, loser, 0.1);
  }
  const { champions: champs, retired } = select(pop);
  assert.ok(champs.includes(winner), "winner promoted to champion");
  assert.ok(retired.includes(loser), "loser retired below threshold");
  assert.equal(pop.candidates.find((c) => c.id === loser).status, "retired");
});

test("a loser is NOT retired before it has minTrials of evidence", () => {
  const pop = freshPop();
  const c = addCandidate(pop, { kind: "model", spec: { label: "unlucky" } });
  recordScore(pop, c, 0.0); // one bad trial only
  const { retired } = select(pop);
  assert.equal(retired.length, 0, "no retirement before minTrials");
});

test("only top-K active candidates become champions", () => {
  const pop = freshPop();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(addCandidate(pop, { kind: "model", spec: { label: `m${i}` } }));
  }
  // descending quality m0 best .. m4 worst, all above retire threshold
  ids.forEach((id, i) => {
    for (let t = 0; t < POLICY.minTrials; t++) recordScore(pop, id, 0.9 - i * 0.05);
  });
  select(pop);
  assert.equal(champions(pop).length, POLICY.championTopK);
  assert.ok(activeCandidates(pop).length >= POLICY.championTopK);
});

test("retired candidates are never silently deleted (no re-exploration)", () => {
  const pop = freshPop();
  const loser = addCandidate(pop, { kind: "model", spec: { label: "bad" } });
  for (let i = 0; i < POLICY.minTrials; i++) recordScore(pop, loser, 0.05);
  select(pop);
  assert.equal(pop.candidates.length, 1, "record retained");
  assert.equal(pop.candidates[0].status, "retired");
});
