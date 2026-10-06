// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/models.js — model-id hygiene for the experiments matrix + anywhere that
// aggregates scores keyed by a model the JUDGE echoed as free text. Models
// routinely mangle their own id in JSON output (double vendor prefix
// `nvidia/nvidia/…`, invented suffixes like `…-a1b-a12b`), which then pollute the
// model×task matrix headers with phantom "duplicate" columns. This canonicalizes
// the id and validates it against the live roster so the matrix shows real models.

/**
 * canonicalModelId(id) — collapse a repeated leading vendor segment
 * (`nvidia/nvidia/x` → `nvidia/x`), trim, lowercase the vendor. Structural only —
 * it does NOT invent a correct suffix for a mangled tail (that's what roster
 * validation is for). Idempotent.
 */
export function canonicalModelId(id) {
  let s = String(id || "").trim();
  // collapse any run of the SAME leading segment: "a/a/a/x" -> "a/x"
  s = s.replace(/^([^/]+)\/(?:\1\/)+/, "$1/");
  return s;
}

/**
 * isKnownModel(id, roster) — is the canonical id present in the roster Set?
 * When the roster is empty/absent we can't validate, so we accept any id that at
 * least looks like a namespaced model (`vendor/name`) — resilience over strictness
 * so a missing roster never blanks the whole matrix.
 */
export function isKnownModel(id, roster) {
  const c = canonicalModelId(id);
  if (roster && roster.size) return roster.has(c);
  return c.includes("/") && !/\s/.test(c);
}

/** Build a Set of known model ids from a state/models.json-shaped object. */
export function rosterSet(modelsJson = {}) {
  const all = [
    ...(modelsJson.featured || []),
    ...(modelsJson.chat || []),
    ...(modelsJson.new || []),
    ...(modelsJson.removed || []),
  ].map(canonicalModelId);
  return new Set(all);
}
