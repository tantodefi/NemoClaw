// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/model-limits.js — per-model capability ceilings (context window + max
// output tokens) and a launch preflight.
//
// Source of truth is scripts/model-registry.json (../../ from here). The NVIDIA
// /v1/models API exposes NO limits (only id/object/created/owned_by), so values
// can't be auto-pulled — the registry is the curated record, with a conservative
// `defaults.unknownModel` fallback for anything not listed.
//
// IMPORTANT distinction: the per-tier maxOutputTokens in agents.js (cheap 2048 /
// capable 16384) are deliberate FRUGALITY BUDGETS, not model limits (Super/Ultra
// actually do 32768 out / 262144 ctx). These functions are the SAFETY CEILING —
// they clamp a request so it can never exceed what the model supports, and warn
// at launch — NOT a mechanism to inflate the frugal defaults.

import { readFileSync } from "node:fs";

function loadJson(rel) {
  try { return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")); } catch { return null; }
}

let _reg, _cat;
const registry = () => (_reg ??= (loadJson("../../model-registry.json") || { models: {}, defaults: {} }));
const catalog = () => (_cat ??= (loadJson("../state/models.json") || { chat: [], featured: [] }));

const FALLBACK = { contextWindow: 131072, maxOutputTokens: 8192 };

/**
 * limitsFor(modelId) → { contextWindow, maxOutputTokens, estimated, source,
 *   reasoningSupported?, reasoningSafe?, displayName? }
 * source: "registry" (curated) | "catalog-default" (in the live catalog but not
 * the registry) | "default" (unknown entirely). Both non-registry cases use the
 * conservative unknownModel fallback.
 */
export function limitsFor(modelId) {
  const reg = registry();
  const e = reg.models?.[modelId];
  if (e && typeof e === "object" && (e.contextWindow || e.maxOutputTokens)) {
    return {
      contextWindow: e.contextWindow ?? FALLBACK.contextWindow,
      maxOutputTokens: e.maxOutputTokens ?? FALLBACK.maxOutputTokens,
      estimated: !!e._estimated,
      source: "registry",
      reasoningSupported: e.reasoningSupported,
      reasoningSafe: e.reasoningSafe,
      displayName: e.displayName,
    };
  }
  const unk = reg.defaults?.unknownModel || FALLBACK;
  const inCatalog = (catalog().chat || []).includes(modelId);
  return {
    contextWindow: unk.contextWindow ?? FALLBACK.contextWindow,
    maxOutputTokens: unk.maxOutputTokens ?? FALLBACK.maxOutputTokens,
    estimated: true,
    source: inCatalog ? "catalog-default" : "default",
  };
}

/** clampOutput(modelId, requested) → requested bounded to [1, model max]. An
 * invalid request falls back to the model's max (never returns null/NaN). */
export function clampOutput(modelId, requested) {
  const max = limitsFor(modelId).maxOutputTokens;
  const n = Number(requested);
  return Math.min(Number.isFinite(n) && n > 0 ? n : max, max);
}

/**
 * preflight({ models:[id…], maxOutputTokens?, reasoning? }) →
 *   { ok, errors:[], warnings:[], clamped:{ modelId: ceiling } }
 * errors = hard-unsafe (block launch): non-positive tokens, or output > a model's
 * context window. warnings = soft (proceed): output > a model's max-output (will
 * clamp), estimated/unknown limits, reasoning on an unsupported model.
 */
export function preflight(opts = {}) {
  const models = (opts.models || []).filter(Boolean);
  const errors = [], warnings = [], clamped = {};
  const reqOut = opts.maxOutputTokens != null && opts.maxOutputTokens !== "" ? Number(opts.maxOutputTokens) : null;

  if (reqOut != null && (!Number.isFinite(reqOut) || reqOut <= 0)) {
    errors.push("max output tokens must be a positive number.");
  }
  for (const m of models) {
    const lim = limitsFor(m);
    if (lim.source !== "registry") warnings.push(`"${m}" is not in the model registry — using conservative ${lim.contextWindow} ctx / ${lim.maxOutputTokens} out.`);
    else if (lim.estimated) warnings.push(`"${m}" limits are estimated (${lim.contextWindow} ctx / ${lim.maxOutputTokens} out) — verify the model card.`);
    if (reqOut != null && Number.isFinite(reqOut) && reqOut > 0) {
      if (reqOut > lim.contextWindow) errors.push(`max output ${reqOut} exceeds "${m}" context window ${lim.contextWindow}.`);
      else if (reqOut > lim.maxOutputTokens) { warnings.push(`max output ${reqOut} exceeds "${m}" ceiling ${lim.maxOutputTokens} → will clamp.`); clamped[m] = lim.maxOutputTokens; }
    }
    if (opts.reasoning === "on" && lim.reasoningSupported === false) warnings.push(`"${m}" does not support reasoning; the toggle will be ignored.`);
  }
  return { ok: errors.length === 0, errors, warnings, clamped };
}

/** listLimits() → { modelId: {contextWindow,maxOutputTokens,estimated,displayName}, _default } for the UI. */
export function listLimits() {
  const reg = registry();
  const out = {};
  for (const [k, v] of Object.entries(reg.models || {})) {
    if (k.startsWith("_") || typeof v !== "object") continue;
    out[k] = { contextWindow: v.contextWindow, maxOutputTokens: v.maxOutputTokens, estimated: !!v._estimated, displayName: v.displayName };
  }
  out._default = reg.defaults?.unknownModel || FALLBACK;
  return out;
}
