// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for model-id hygiene (the experiments matrix header cleanup).
// Run: node --test lib/models.test.js  (or `bun test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalModelId, isKnownModel, rosterSet } from "./models.js";

test("canonicalModelId collapses a repeated vendor prefix", () => {
  assert.equal(canonicalModelId("nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
  assert.equal(canonicalModelId("nvidia/nvidia/nvidia/x"), "nvidia/x");
});

test("canonicalModelId leaves a clean id unchanged + trims", () => {
  assert.equal(canonicalModelId("nvidia/nemotron-3-ultra-550b-a55b"), "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(canonicalModelId("  openai/gpt-oss-120b  "), "openai/gpt-oss-120b");
});

test("canonicalModelId does NOT touch a distinct second segment", () => {
  // only a REPEATED same segment collapses; vendor/name stays
  assert.equal(canonicalModelId("meta/llama-4-maverick-17b-128e-instruct"), "meta/llama-4-maverick-17b-128e-instruct");
});

test("canonicalModelId is idempotent", () => {
  const once = canonicalModelId("nvidia/nvidia/x");
  assert.equal(canonicalModelId(once), once);
});

const roster = rosterSet({
  featured: ["nvidia/nemotron-3-ultra-550b-a55b"],
  chat: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
});

test("isKnownModel keeps roster members (after canonicalization)", () => {
  assert.equal(isKnownModel("nvidia/nemotron-3-super-120b-a12b", roster), true);
  assert.equal(isKnownModel("nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", roster), true); // canon → known
});

test("isKnownModel drops mangled/derostered ids", () => {
  assert.equal(isKnownModel("nvidia/nemotron-3-super-120b-a1b-a12b", roster), false); // invented suffix
  assert.equal(isKnownModel("nvidia/nemotron-3-nano-30b-a3b-reasoning", roster), false); // not in roster (non-omni)
});

test("isKnownModel falls back to a structural check when roster is empty", () => {
  const empty = new Set();
  assert.equal(isKnownModel("some-vendor/some-model", empty), true);
  assert.equal(isKnownModel("not-a-model", empty), false); // no vendor prefix
  assert.equal(isKnownModel("bad id/with space", empty), false);
});

test("rosterSet canonicalizes its own entries", () => {
  const r = rosterSet({ chat: ["nvidia/nvidia/x"] });
  assert.equal(r.has("nvidia/x"), true);
});
