// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/model-limits.test.js — `node --test lib/model-limits.test.js`

import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsFor, clampOutput, preflight } from "./model-limits.js";

test("verified registry model returns real ceilings", () => {
  const l = limitsFor("nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(l.contextWindow, 262144);
  assert.equal(l.maxOutputTokens, 32768);
  assert.equal(l.source, "registry");
  assert.equal(l.estimated, false);
});

test("roster model is flagged estimated", () => {
  const l = limitsFor("openai/gpt-oss-120b");
  assert.equal(l.source, "registry");
  assert.equal(l.estimated, true);
  assert.equal(l.maxOutputTokens, 32768);
});

test("unknown model falls back to conservative default", () => {
  const l = limitsFor("totally/made-up-model");
  assert.equal(l.contextWindow, 131072);
  assert.equal(l.maxOutputTokens, 8192);
  assert.equal(l.source, "default");
});

test("clampOutput caps at the model ceiling", () => {
  assert.equal(clampOutput("nvidia/nemotron-3-ultra-550b-a55b", 999999), 32768);
  assert.equal(clampOutput("nvidia/nemotron-3-ultra-550b-a55b", 4096), 4096);
  assert.equal(clampOutput("totally/made-up-model", 999999), 8192);
  assert.equal(clampOutput("nvidia/nemotron-3-ultra-550b-a55b", "bad"), 32768); // invalid → ceiling
});

test("preflight warns + clamps when output exceeds max-output", () => {
  const r = preflight({ models: ["nvidia/nemotron-3-ultra-550b-a55b"], maxOutputTokens: 100000 });
  assert.equal(r.ok, true); // 100k < 262k context, so no hard error
  assert.equal(r.clamped["nvidia/nemotron-3-ultra-550b-a55b"], 32768);
  assert.ok(r.warnings.some((w) => /clamp/.test(w)));
});

test("preflight errors when output exceeds context window", () => {
  const r = preflight({ models: ["nvidia/nemotron-3-ultra-550b-a55b"], maxOutputTokens: 500000 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /context window/.test(e)));
});

test("preflight errors on non-positive token request", () => {
  assert.equal(preflight({ models: [], maxOutputTokens: 0 }).ok, false);
  assert.equal(preflight({ models: [], maxOutputTokens: -5 }).ok, false);
});

test("preflight warns on estimated + unknown models", () => {
  const r = preflight({ models: ["openai/gpt-oss-120b", "totally/made-up-model"] });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /estimated/.test(w)));
  assert.ok(r.warnings.some((w) => /not in the model registry/.test(w)));
});
