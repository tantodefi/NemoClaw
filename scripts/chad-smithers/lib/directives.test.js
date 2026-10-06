// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for directive resolution — the global/override/gate semantics that
// let a run experiment ON the directives. Run: node --test lib/directives.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDirectives, resolveFrom, directiveSystemFor, creativityKnob, inScope } from "./directives.js";

const BASE = { experiments: "global steer", creativity: "moderate", priorities: ["draft"], systemPrompts: { all: "house", judge: "be strict" } };

test("no override + global on → the global base unchanged", () => {
  assert.deepEqual(resolveFrom(BASE, {}), BASE);
});

test("global off + no override → empty (no directives)", () => {
  assert.deepEqual(resolveFrom(BASE, { CHAD_DIRECTIVES_OFF: "1" }), {});
});

test("global on + override → MERGE, override wins per field", () => {
  const r = resolveFrom(BASE, { CHAD_DIRECTIVES_JSON: JSON.stringify({ creativity: "high", experiments: "override steer" }) });
  assert.equal(r.creativity, "high");
  assert.equal(r.experiments, "override steer");
  assert.equal(r.systemPrompts.all, "house"); // untouched base field survives
});

test("global off + override → the override ALONE (replace)", () => {
  const r = resolveFrom(BASE, { CHAD_DIRECTIVES_OFF: "1", CHAD_DIRECTIVES_JSON: JSON.stringify({ creativity: "low" }) });
  assert.deepEqual(r, { creativity: "low" });
  assert.equal(r.experiments, undefined); // base is NOT merged when global is off
});

test("bad override JSON is ignored (falls back to base)", () => {
  assert.deepEqual(resolveFrom(BASE, { CHAD_DIRECTIVES_JSON: "{not json" }), BASE);
});

test("mergeDirectives deep-merges systemPrompts by role + replaces priorities array", () => {
  const r = mergeDirectives(
    { systemPrompts: { all: "a", judge: "j" }, priorities: ["draft", "summarize"] },
    { systemPrompts: { judge: "j2", draft: "d" }, priorities: ["classify"] });
  assert.deepEqual(r.systemPrompts, { all: "a", judge: "j2", draft: "d" });
  assert.deepEqual(r.priorities, ["classify"]);
});

test("directiveSystemFor joins all + role, skips empties", () => {
  assert.equal(directiveSystemFor({ systemPrompts: { all: "A", judge: "J" } }, "judge"), "A\n\nJ");
  assert.equal(directiveSystemFor({ systemPrompts: { all: "A" } }, "draft"), "A");
  assert.equal(directiveSystemFor({ systemPrompts: {} }, "draft"), undefined);
  assert.equal(directiveSystemFor({}, "draft"), undefined);
});

test("creativityKnob maps the dial; unknown/empty → moderate (neutral)", () => {
  assert.equal(creativityKnob("low").expandMultiplier, 0.5);
  assert.equal(creativityKnob("high").expandMultiplier, 2);
  assert.ok(/explore/i.test(creativityKnob("high").hint));
  assert.ok(/refine/i.test(creativityKnob("low").hint));
  assert.equal(creativityKnob("moderate").expandMultiplier, 1);
  assert.equal(creativityKnob("").hint, "");       // unset → no steer injected
  assert.equal(creativityKnob(undefined).expandMultiplier, 1);
  assert.equal(creativityKnob("weird").expandMultiplier, 1);
});

test("inScope: empty priorities = everything in scope; otherwise membership", () => {
  assert.equal(inScope("draft", []), true);
  assert.equal(inScope("draft", undefined), true);
  assert.equal(inScope("draft", ["draft", "summarize"]), true);
  assert.equal(inScope("classify", ["draft", "summarize"]), false);
  assert.equal(inScope("DRAFT", ["draft"]), true); // case-insensitive
});
