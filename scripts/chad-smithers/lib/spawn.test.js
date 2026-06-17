// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the chad-spawn ⇄ Smithers bridge. Pure-logic only (route,
// scoreIssue, stub spawn) — the real local/ssh transports are integration
// surface covered by `smithers graph` validation of the workflows that use them.
//
// Run: bun test lib/spawn.test.js   (or: node --test lib/spawn.test.js)

import { test, expect } from "bun:test";
import { route, scoreIssue, runSpawn, spawnResultSchema } from "./spawn.js";

test("route classifies coder tasks", () => {
  expect(route("please refactor this function and fix the failing pytest")).toBe("coder");
});

test("route classifies fitness tasks", () => {
  expect(route("form check on my squat depth and hip hinge")).toBe("fitness");
});

test("route classifies brain/memory tasks above researcher", () => {
  expect(route("remember this preference and store it in gbrain")).toBe("brain");
});

test("route classifies reviewer for PR audits", () => {
  expect(route("audit the diff in PR #42 for security issues")).toBe("reviewer");
});

test("route falls back to the default on no match", () => {
  expect(route("the weather is nice today", { default: "researcher" })).toBe("researcher");
  expect(route("xyzzy", { default: "writer" })).toBe("writer");
});

test("scoreIssue rewards high-signal issues", () => {
  const hot = scoreIssue({ labels: ["needs-chad", "bug"], reactions: { total_count: 4 }, createdAt: new Date().toISOString() });
  const cold = scoreIssue({ labels: ["wontfix"], reactions: { total_count: 0 }, createdAt: "2020-01-01T00:00:00Z", pull_request: {} });
  expect(hot).toBeGreaterThan(cold);
});

test("runSpawn stub never throws and returns a valid result shape", async () => {
  process.env.CHAD_SPAWN_STUB = "1";
  const r = await runSpawn({ kind: "researcher", substrate: "gha", task: "anything", id: "t1" });
  expect(() => spawnResultSchema.parse(r)).not.toThrow();
  expect(r.status).toBe("shadow-logged");
  expect(r.kind).toBe("researcher");
  delete process.env.CHAD_SPAWN_STUB;
});

test("runSpawn rejects a missing kind without throwing", async () => {
  const r = await runSpawn({ task: "no kind here" });
  expect(r.status).toBe("failed");
});
