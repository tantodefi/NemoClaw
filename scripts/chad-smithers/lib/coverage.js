// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/coverage.js — deterministic parsing for coverage-loop.jsx. Pulling this out
// of the workflow makes the one bit of real logic (reading a coverage % out of a
// test-runner's noisy report) pure and unit-testable, the same way lib/pr.js and
// scoreIssue keep routing deterministic + tested.

/**
 * parseCoverage(text) — the total coverage % from a coverage report tail.
 * Tolerant: takes the max valid "NN%" / "NN.N%" in the text (the total line is the
 * highest aggregate), ignores >100 noise, returns 0 when there's nothing to read
 * (missing tooling → loop exits cleanly rather than looping on a phantom gap).
 */
export function parseCoverage(text) {
  const pcts = [...String(text ?? "").matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  return pcts.length ? Math.max(...pcts) : 0;
}

/**
 * uncoveredLines(text) — the per-file rows of a coverage report (lines that name a
 * source file AND carry a %), capped, as context for the test-writer. Deterministic.
 */
export function uncoveredLines(text, max = 40) {
  return String(text ?? "")
    .split("\n")
    .filter((l) => /\.(js|jsx|ts|tsx)\b/.test(l) && /%/.test(l))
    .slice(0, max)
    .join("\n");
}
