// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/coerce.test.js — `node --test lib/coerce.test.js`

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { extractJson, coerceJson } from "./coerce.js";

test("parses a bare JSON object", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("parses a ```json fenced block", () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```\nthanks'), { a: 1 });
});

test("parses a bare ``` fenced array", () => {
  assert.deepEqual(extractJson("```\n[1,2,3]\n```"), [1, 2, 3]);
});

test("extracts JSON embedded in reasoning prose", () => {
  assert.deepEqual(
    extractJson('thinking about it... {"model":"x","text":"hi"} done'),
    { model: "x", text: "hi" },
  );
});

test("ignores braces inside string values", () => {
  assert.deepEqual(extractJson('{"t":"a {b} c","n":2}'), { t: "a {b} c", n: 2 });
});

test("returns undefined for non-JSON", () => {
  assert.equal(extractJson("no json here at all"), undefined);
  assert.equal(extractJson(""), undefined);
  assert.equal(extractJson(null), undefined);
});

test("coerceJson validates against a zod schema", () => {
  const S = z.object({ scorePct: z.number() });
  assert.deepEqual(coerceJson('score: ```json\n{"scorePct":85}\n```', S), { scorePct: 85 });
  assert.equal(coerceJson('{"scorePct":"bad"}', S), null); // wrong type → null
  assert.equal(coerceJson("nope", S), null); // unparseable → null
});

test("coerceJson without a schema returns the raw parsed value", () => {
  assert.deepEqual(coerceJson('{"x":1}'), { x: 1 });
});
