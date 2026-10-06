// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the deterministic coverage parsing behind coverage-loop.jsx.
// Run: node --test lib/coverage.test.js  (or `bun test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCoverage, uncoveredLines } from "./coverage.js";

test("parseCoverage takes the total (max) % from a report tail", () => {
  const report = `
File      | % Stmts | % Lines
lib/a.js  |   40.0  |  42.5%
lib/b.js  |   90.0  |  88.0%
All files |   72.3  |  73.1%`;
  assert.equal(parseCoverage(report), 88); // max valid line-% seen
});

test("parseCoverage returns 0 when there is no percentage (missing tooling)", () => {
  assert.equal(parseCoverage("command not found: coverage"), 0);
  assert.equal(parseCoverage(""), 0);
  assert.equal(parseCoverage(null), 0);
  assert.equal(parseCoverage(undefined), 0);
});

test("parseCoverage ignores >100 noise", () => {
  assert.equal(parseCoverage("port 8080 responded in 250% of budget; coverage 65%"), 65);
});

test("parseCoverage reads a clean single total", () => {
  assert.equal(parseCoverage("Coverage: 91.7%"), 91.7);
});

test("uncoveredLines keeps only source-file rows with a %", () => {
  const report = [
    "Running tests...",
    "lib/a.js   |  40% | 12-18",
    "some prose line without a file",
    "src/b.ts   |  55% | 3,9",
    "All files  |  72%",   // no source-file extension → excluded
  ].join("\n");
  const out = uncoveredLines(report);
  assert.ok(out.includes("lib/a.js"));
  assert.ok(out.includes("src/b.ts"));
  assert.ok(!out.includes("prose line"));
  assert.ok(!out.includes("All files"));
});

test("uncoveredLines caps the number of rows", () => {
  const many = Array.from({ length: 100 }, (_, i) => `lib/f${i}.js | 10% | 1`).join("\n");
  assert.equal(uncoveredLines(many, 5).split("\n").length, 5);
});
