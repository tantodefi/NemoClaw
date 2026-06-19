// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/coerce.js — tolerant JSON extraction for model/tool output.
//
// Reasoning models (Nemotron "detailed thinking on") and CLI agents frequently
// wrap their JSON answer in prose or ```json fences, or prefix it with chain-of-
// thought. This extracts the first valid JSON value and (optionally) validates it
// against a zod schema, returning null on permanently-bad output so a caller can
// DROP the row instead of throwing or burning retries — the schemaFailFastAgent
// idea from smithers-fusions, as a pure, never-throwing function.

// extractJson(text) → parsed value | undefined. Tries, in order: the whole
// string, a fenced ```json block, then the first balanced {…}/[…] span in prose.
export function extractJson(text) {
  if (text == null) return undefined;
  const s = String(text).trim();
  if (!s) return undefined;

  const direct = tryParse(s);
  if (direct !== undefined) return direct;

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const v = tryParse(fence[1].trim());
    if (v !== undefined) return v;
  }

  const span = firstBalanced(s);
  if (span !== undefined) {
    const v = tryParse(span);
    if (v !== undefined) return v;
  }
  return undefined;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// First balanced {…} or […] region, string/escape aware (so braces inside JSON
// string values don't throw off the depth count).
function firstBalanced(s) {
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return undefined;
}

/**
 * coerceJson(text, schema?) — extract JSON and optionally validate against a zod
 * schema. Returns the validated value, or null if it can't be parsed/validated.
 * Never throws — callers can `const row = coerceJson(t, S); if (!row) skip;`.
 */
export function coerceJson(text, schema) {
  const v = extractJson(text);
  if (v === undefined) return null;
  if (!schema) return v;
  try {
    const r = schema.safeParse(v);
    return r.success ? r.data : null;
  } catch { return null; }
}
