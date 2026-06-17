// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// agents.js — Chad's Smithers model router.
//
// One place that decides which backend executes a task, with runtime
// auto-detection and intelligent per-tier defaults. Workflows never name a
// model directly; they call pickAgent(role) and get the right backend for the
// current environment (credits, CLIs present, offline, etc.).
//
// ── The cost/capability reality (verified 2026-06-13) ───────────────────────
//   • The "free Nemotron" is NVIDIA's HOSTED Nemotron 3 Super 120B
//     (nvidia/nemotron-3-super-120b-a12b) at integrate.api.nvidia.com via
//     NVIDIA_API_KEY — a frontier-tier 120B MoE, reasoningSafe=true. The local
//     chad-shim :8901 is just an OpenAI-compatible proxy in front of it.
//   • The only truly LOCAL model is google/gemma-3-4b via lmstudio — offline
//     fallback only (Jetson-class ceiling).
//   • Anthropic API key is HTTP 402 (out of credits) — so the Anthropic *API*
//     path is disabled by default, but the `claude` *CLI* (ClaudeCodeAgent)
//     authenticates via the Max subscription/OAuth and is free + strongest.
//   • The documented "Nemotron can't drive tool loops" issue was an openclaw
//     HARNESS round-trip bug, not raw model capability. Smithers' ToolLoopAgent
//     runs its own AI-SDK tool loop, so the 120B model may drive Smithers tool
//     loops fine. Treat that as an A/B question, not an assumption.
//
// ── Tiers ────────────────────────────────────────────────────────────────
//   cheap    single-turn, no-tools work (classify, draft, observe, report).
//            Default → nemotron (hosted 120B; free via NVIDIA key), low tokens.
//   capable  multi-step tool loops + evaluation/judging. Default → the best
//            AVAILABLE backend, detected at runtime in this preference order:
//            claudecode (subscription) → codex (CLI) → nemotron (AI-SDK loop)
//            → opencode (pending) → local gemma. Override with CHAD_CAPABLE_BACKEND.
//
// ── Env knobs ──────────────────────────────────────────────────────────────
//   CHAD_INFERENCE_BASE_URL   OpenAI-compatible base (default chad-shim).
//   NVIDIA_API_KEY            key for the hosted Nemotron / NIM path.
//   CHAD_NEMOTRON_MODEL       cheap-tier Nemotron id (default Ultra 550B; set to
//                             Super 120B for a latency-sensitive path).
//   CHAD_NEMOTRON_CAPABLE_MODEL  capable-tier Nemotron id (default Ultra 550B).
//   CHAD_REASONING            "off" disables Nemotron reasoning; default ON
//                             ("detailed thinking on" — max-logic by default).
//   CHAD_LOCAL_BASE_URL       lmstudio OpenAI-compatible (default 127.0.0.1:1234/v1).
//   CHAD_LOCAL_MODEL          local model id (default google/gemma-3-4b).
//   CHAD_CAPABLE_BACKEND      force the capable tier: claudecode|codex|nemotron|
//                             opencode|anthropic|local. Unset = auto-detect.
//   CHAD_CHEAP_BACKEND        force the cheap tier (default nemotron).
//   CHAD_OPENCODE_MODEL       the "big pickle" model id once confirmed (pending).
//   ANTHROPIC_API_KEY         enables the @ai-sdk/anthropic fallback (only used
//                             if present AND credits restored — API is 402 today).
//
// ── Model ids (NVIDIA hosted, OpenAI-compatible, free with NVIDIA_API_KEY) ──
//   Super 120B  nvidia/nemotron-3-super-120b-a12b  (March 2026; cheap-tier default)
//   Ultra 550B  nvidia/nemotron-3-ultra-550b-a55b  (Jun 4 2026; 55B active, hybrid
//               Mamba-Transformer MoE, built for long-running agentic/tool-loop
//               work — capable-tier default). Adopted 2026-06-13.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

// ── Optional imports (don't hard-fail if a package/CLI isn't present) ────────
let ToolLoopAgent, createOpenAICompatible, createAnthropic, ClaudeCodeAgent, CodexAgent, OpenCodeAgent;
try { ({ ToolLoopAgent } = await import("ai")); } catch { /* offline / not installed */ }
try { ({ createOpenAICompatible } = await import("@ai-sdk/openai-compatible")); } catch { /* */ }
try { ({ createAnthropic } = await import("@ai-sdk/anthropic")); } catch { /* */ }
try { ({ ClaudeCodeAgent, CodexAgent, OpenCodeAgent } = await import("@smithers-orchestrator/agents")); } catch { /* */ }

const env = process.env;

// ── Capability probe (cached) ────────────────────────────────────────────────
function binOnPath(bin) {
  try { execSync(`command -v ${bin}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}

let _probe;
export function probe() {
  if (_probe) return _probe;
  _probe = {
    nvidiaKey: Boolean(env.NVIDIA_API_KEY || env.OPENAI_API_KEY),
    anthropicKey: Boolean(env.ANTHROPIC_API_KEY),
    shimUrl: env.CHAD_INFERENCE_BASE_URL || "http://127.0.0.1:8901/v1",
    localUrl: env.CHAD_LOCAL_BASE_URL || "http://127.0.0.1:1234/v1",
    sdk: Boolean(ToolLoopAgent && createOpenAICompatible),
    claudeCli: binOnPath("claude") && Boolean(ClaudeCodeAgent),
    codexCli: binOnPath("codex") && Boolean(CodexAgent),
    opencodeCli: binOnPath("opencode") && Boolean(OpenCodeAgent),
    // Anthropic API returns 402 (no credits) as of 2026-06; set
    // CHAD_ANTHROPIC_CREDITS_OK=1 once restored to let the fallback engage.
    anthropicApi402: env.CHAD_ANTHROPIC_CREDITS_OK !== "1",
  };
  return _probe;
}

// ── OpenAI-compatible provider factory (Nemotron / NIM / local) ──────────────
function openaiCompatModel(baseURL, modelId, apiKey, name) {
  if (!createOpenAICompatible) {
    throw new Error("agents.js: @ai-sdk/openai-compatible not installed — run `bun install`");
  }
  const provider = createOpenAICompatible({ name, baseURL, apiKey: apiKey || "not-needed" });
  return provider(modelId);
}

// ── Backend constructors ─────────────────────────────────────────────────────
// Each returns a Smithers-compatible agent instance. `cheap` controls token
// ceilings so single-turn work stays frugal.
const backends = {
  // Hosted Nemotron via the chad-shim proxy (or NVIDIA directly). Default model
  // EVERYWHERE is Ultra 550B (operator directive 2026-06-13). Reasoning is ON by
  // default for both tiers — Nemotron's toggle is the "detailed thinking on"
  // system directive, verified to round-trip tool calls (registry reasoningSafe).
  // Set CHAD_REASONING=off to disable, or CHAD_NEMOTRON_MODEL to pin Super for a
  // latency-sensitive path; both Super and Ultra also run as experiment candidates
  // so the arena measures the quality/latency trade rather than us guessing.
  nemotron(opts = {}) {
    const p = probe();
    // opts.model lets a workflow/experiment request ANY model in NVIDIA's
    // OpenAI-compatible catalog (gpt-oss-120b, deepseek-v4-pro, llama-4-maverick,
    // kimi-k2.6, nemotron-nano-omni-reasoning, …) for parallel A/B + fusion.
    const modelId = opts.model
      || (opts.cheap
        ? (env.CHAD_NEMOTRON_MODEL || "nvidia/nemotron-3-ultra-550b-a55b")
        : (env.CHAD_NEMOTRON_CAPABLE_MODEL || "nvidia/nemotron-3-ultra-550b-a55b"));
    const model = openaiCompatModel(
      p.shimUrl, modelId, env.NVIDIA_API_KEY || env.OPENAI_API_KEY, "chad-nemotron",
    );
    const reasoning = opts.reasoning ?? (env.CHAD_REASONING !== "off");
    return new ToolLoopAgent({
      model,
      // "detailed thinking on" = Nemotron reasoning; prepended to any task system.
      ...(reasoning ? { instructions: "detailed thinking on", allowSystemInMessages: true } : {}),
      maxOutputTokens: opts.cheap ? 2048 : 16384, // generous for max-logic reasoning
      maxSteps: opts.cheap ? (reasoning ? 2 : 1) : (opts.maxSteps ?? 12),
      ...opts.agent,
    });
  },

  // Anthropic via the AI SDK (NOT the CLI). Distinct from claudecode: this path
  // consumes API credits and is 402 today, so it's a fallback that only engages
  // once credits are restored. ClaudeCodeAgent (subscription) is preferred.
  anthropic(opts = {}) {
    if (!createAnthropic) throw new Error("agents.js: @ai-sdk/anthropic not installed");
    if (!env.ANTHROPIC_API_KEY) throw new Error("agents.js: ANTHROPIC_API_KEY not set");
    const provider = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return new ToolLoopAgent({
      model: provider(env.CHAD_ANTHROPIC_MODEL || "claude-sonnet-4-6"),
      maxOutputTokens: opts.cheap ? 1024 : 8192,
      maxSteps: opts.cheap ? 1 : (opts.maxSteps ?? 8),
      ...opts.agent,
    });
  },

  // Truly-local lmstudio fallback (offline only).
  local(opts = {}) {
    const p = probe();
    const model = openaiCompatModel(
      p.localUrl,
      env.CHAD_LOCAL_MODEL || "google/gemma-3-4b",
      "lm-studio",
      "chad-local",
    );
    return new ToolLoopAgent({
      model,
      maxOutputTokens: opts.cheap ? 1024 : 4096,
      maxSteps: 1, // gemma-4b can't drive tool loops
      ...opts.agent,
    });
  },

  // Claude via the `claude` CLI — uses the Max subscription, NOT API credits.
  //
  // Moshi interplay: the host `claude` lifecycle hooks (installed 2026-06-13)
  // route Stop → phone notification and PermissionRequest → phone approval.
  //   • Autonomous runs (experiments) MUST NOT block waiting for a phone tap, so
  //     they skip permission prompts (default). The Stop notification still fires.
  //   • The Phase-5 autonomy ladder WANTS human approval routed to the phone, so
  //     pass { approvalRouting: true } to keep permission prompts on — each
  //     outbound action then surfaces on the operator's phone via Moshi.
  claudecode(opts = {}) {
    if (!ClaudeCodeAgent) throw new Error("agents.js: @smithers-orchestrator/agents not installed");
    return new ClaudeCodeAgent({
      model: env.CHAD_CLAUDE_MODEL || "sonnet",
      timeoutMs: opts.timeoutMs ?? 900_000,
      // Default skip = autonomous + non-blocking; flip for the approval ladder.
      dangerouslySkipPermissions: opts.approvalRouting ? false : true,
      ...opts.agent,
    });
  },

  // Codex via the `codex` CLI.
  codex(opts = {}) {
    if (!CodexAgent) throw new Error("agents.js: CodexAgent not available");
    return new CodexAgent({
      ...(env.CHAD_CODEX_MODEL ? { model: env.CHAD_CODEX_MODEL } : {}),
      skipGitRepoCheck: true,
      timeoutMs: opts.timeoutMs ?? 900_000,
      ...opts.agent,
    });
  },

  // opencode CLI via Smithers' built-in OpenCodeAgent (wraps `opencode run`,
  // which IS the non-interactive path — no custom harness needed; the earlier
  // "needs a CLI adapter" note was stale, @smithers-orchestrator/agents ships one).
  // Default model is opencode/big-pickle (the free "big pickle" 500k-context model);
  // other free ids: opencode/nemotron-3-ultra-free, deepseek-v4-flash-free,
  // mimo-v2.5-free, north-mini-code-free (`opencode models`). Override with
  // CHAD_OPENCODE_MODEL.
  opencode(opts = {}) {
    if (!OpenCodeAgent) throw new Error("agents.js: OpenCodeAgent not available — run `bun install`");
    return new OpenCodeAgent({
      model: env.CHAD_OPENCODE_MODEL || "opencode/big-pickle",
      timeoutMs: opts.timeoutMs ?? 900_000,
      ...opts.agent,
    });
  },
};

// ── Intelligent default selection ────────────────────────────────────────────
function autoCapable() {
  if (env.CHAD_CAPABLE_BACKEND) return env.CHAD_CAPABLE_BACKEND;
  const p = probe();
  if (p.claudeCli) return "claudecode";        // free (subscription) + strongest
  if (p.codexCli) return "codex";
  if (p.sdk && p.nvidiaKey) return "nemotron"; // Ultra 550B via AI-SDK loop
  if (p.opencodeCli) return "opencode";
  if (p.anthropicKey && !p.anthropicApi402) return "anthropic"; // only once credits return
  return "local";
}

function autoCheap() {
  if (env.CHAD_CHEAP_BACKEND) return env.CHAD_CHEAP_BACKEND;
  const p = probe();
  if (p.sdk && p.nvidiaKey) return "nemotron"; // hosted 120B, free, frugal tokens
  if (p.claudeCli) return "claudecode";
  return "local";
}

// Role → tier map. Add roles here as workflows grow.
const ROLE_TIER = {
  // cheap single-turn
  classify: "cheap", draft: "cheap", observe: "cheap", report: "cheap",
  summarize: "cheap", extract: "cheap", seed: "cheap",
  // capable / tool-loop / judge
  evaluate: "capable", judge: "capable", optimize: "capable",
  implement: "capable", review: "capable", refine: "capable", plan: "capable",
};

/**
 * pickAgent(role, opts) — the only function workflows should call.
 *   role  one of ROLE_TIER keys (unknown roles default to "cheap").
 *   opts  { backend?, cheap?, maxSteps?, timeoutMs?, agent? } — backend forces
 *         a specific backend; everything else is passed through.
 * Returns a constructed Smithers agent.
 */
export function pickAgent(role, opts = {}) {
  const tier = opts.tier || ROLE_TIER[role] || "cheap";
  const backend = opts.backend || (tier === "capable" ? autoCapable() : autoCheap());
  const ctor = backends[backend];
  if (!ctor) throw new Error(`agents.js: unknown backend "${backend}"`);
  return ctor({ cheap: tier === "cheap", ...opts });
}

export { backends };

// ── CLI: `node agents.js --probe` prints the resolved routing table ──────────
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--probe")) {
    const p = probe();
    const table = {
      probe: p,
      resolved: { cheapTier: autoCheap(), capableTier: autoCapable() },
      roles: Object.fromEntries(
        Object.entries(ROLE_TIER).map(([r, t]) => [
          r, { tier: t, backend: t === "capable" ? autoCapable() : autoCheap() },
        ]),
      ),
    };
    console.log(JSON.stringify(table, null, 2));
  }
}
