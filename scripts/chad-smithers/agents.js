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
//   CHAD_REASONING            on|off. Default is TIER-AWARE: capable ON, cheap OFF
//                             (cheap single-turn + reasoning + small cap → empty
//                             output). "on"/"off" forces BOTH tiers.
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
import { clampOutput } from "./lib/model-limits.js";

// ── Optional imports (don't hard-fail if a package/CLI isn't present) ────────
let ToolLoopAgent, createOpenAICompatible, createAnthropic, ClaudeCodeAgent, CodexAgent, OpenCodeAgent;
try { ({ ToolLoopAgent } = await import("ai")); } catch { /* offline / not installed */ }
try { ({ createOpenAICompatible } = await import("@ai-sdk/openai-compatible")); } catch { /* */ }
try { ({ createAnthropic } = await import("@ai-sdk/anthropic")); } catch { /* */ }
try { ({ ClaudeCodeAgent, CodexAgent, OpenCodeAgent } = await import("@smithers-orchestrator/agents")); } catch { /* */ }

const env = process.env;

// ── Task resilience defaults (timeouts / heartbeat) ──────────────────────────
// A hung NVIDIA call previously had no task deadline. Task-level `timeoutMs`
// (see taskOpts) is the authoritative cap — Smithers aborts the task; the
// agent-level `timeout` set on each ToolLoopAgent below also aborts the AI-SDK
// call so the HTTP connection is released instead of orphaned. Cheap single-turn
// work gets a short deadline; capable tool-loop work gets the 10-min cap that
// matches upstream smithers-fusions. Override via env.
const CHEAP_TIMEOUT_MS = Number(env.CHAD_TASK_TIMEOUT_MS_CHEAP || env.CHAD_TASK_TIMEOUT_MS || 120_000);
const CAPABLE_TIMEOUT_MS = Number(env.CHAD_TASK_TIMEOUT_MS || 600_000);
// Heartbeat timeout is opt-in (0 = unset): the cli-text capture path emits no
// streaming deltas, so an aggressive heartbeat could false-kill a long, healthy
// reasoning generation. Set CHAD_TASK_HEARTBEAT_MS only if you know the agent
// reports liveness.
const HEARTBEAT_MS = env.CHAD_TASK_HEARTBEAT_MS ? Number(env.CHAD_TASK_HEARTBEAT_MS) : 0;

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

// Response-length cap, env-overridable per tier (CHAD_MAX_OUTPUT_TOKENS[_CHEAP]).
// Defaults preserve each backend's prior hardcoded ceiling, so an unset env is a
// no-op; set it (e.g. from the runs IDE launch drawer) to lengthen/shorten output.
function maxOut(cheap, capDefault, cheapDefault) {
  return cheap
    ? Number(env.CHAD_MAX_OUTPUT_TOKENS_CHEAP || cheapDefault)
    : Number(env.CHAD_MAX_OUTPUT_TOKENS || capDefault);
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
    // Tier-aware reasoning default. CHEAP single-turn work defaults reasoning OFF:
    // with a small token cap, "detailed thinking on" can consume the entire budget
    // and return an EMPTY final answer (finishReason=length, textLength=0 →
    // INVALID_OUTPUT — the failure bug-report kept catching). CAPABLE tool-loop work
    // keeps reasoning on. Force either tier with opts.reasoning or CHAD_REASONING=on|off.
    const reasoning = opts.reasoning ?? (opts.cheap
      ? (env.CHAD_REASONING === "on")
      : (env.CHAD_REASONING !== "off"));
    return new ToolLoopAgent({
      model,
      // "detailed thinking on" = Nemotron reasoning; prepended to any task system.
      ...(reasoning ? { instructions: "detailed thinking on", allowSystemInMessages: true } : {}),
      // Frugal tier budget (env-overridable), CLAMPED to the model's registry
      // ceiling so a launch/override can never request more than the model supports.
      // Give reasoning runs token HEADROOM so chain-of-thought doesn't eat the whole
      // budget and leave nothing for the answer (clamped to the model's ceiling).
      maxOutputTokens: clampOutput(modelId, maxOut(opts.cheap, reasoning ? 32768 : 16384, reasoning ? 8192 : 2048)),
      maxSteps: opts.cheap ? (reasoning ? 2 : 1) : (opts.maxSteps ?? 12),
      // Abort the AI-SDK call if the hosted model hangs (connection released).
      timeout: { totalMs: opts.cheap ? CHEAP_TIMEOUT_MS : CAPABLE_TIMEOUT_MS },
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
      maxOutputTokens: clampOutput(env.CHAD_ANTHROPIC_MODEL || "claude-sonnet-4-6", maxOut(opts.cheap, 8192, 1024)),
      maxSteps: opts.cheap ? 1 : (opts.maxSteps ?? 8),
      timeout: { totalMs: opts.cheap ? CHEAP_TIMEOUT_MS : CAPABLE_TIMEOUT_MS },
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
      maxOutputTokens: clampOutput(env.CHAD_LOCAL_MODEL || "google/gemma-3-4b", maxOut(opts.cheap, 4096, 1024)),
      maxSteps: 1, // gemma-4b can't drive tool loops
      timeout: { totalMs: CAPABLE_TIMEOUT_MS }, // local can be slow; generous cap
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

// ── Backend availability (for safe fallback selection) ───────────────────────
// Mirrors the autoCapable/autoCheap probes so pickFallback never constructs a
// backend that would throw (missing key/CLI).
function backendAvailable(b) {
  const p = probe();
  switch (b) {
    case "nemotron": return p.sdk && p.nvidiaKey;
    case "claudecode": return p.claudeCli;
    case "codex": return p.codexCli;
    case "opencode": return p.opencodeCli;
    case "anthropic": return p.anthropicKey && !p.anthropicApi402;
    case "local": return true; // offline last resort; assumed reachable
    default: return false;
  }
}

/**
 * pickFallback(role, opts) — a constructed agent on a DIFFERENT available backend
 * than the primary, for a Task `fallbackAgent` (tried on retry). Returns
 * undefined when no distinct backend is available (caller just omits it).
 * Use on REQUIRED single tasks (judge/synthesize/report) — NOT on fan-out
 * panelists, where you want that specific model or nothing (use continueOnFail).
 */
export function pickFallback(role, opts = {}) {
  const tier = opts.tier || ROLE_TIER[role] || "cheap";
  const primary = opts.backend || (tier === "capable" ? autoCapable() : autoCheap());
  const order = tier === "capable"
    ? ["claudecode", "nemotron", "codex", "opencode", "local"]
    : ["nemotron", "claudecode", "local"];
  const fb = order.find((b) => b !== primary && backendAvailable(b));
  return fb ? backends[fb]({ cheap: tier === "cheap", ...opts, backend: fb }) : undefined;
}

/**
 * taskOpts(role, opts) — resilience props to spread on a <Task>:
 *   { timeoutMs, retries, [heartbeatTimeoutMs], [continueOnFail] }
 * Tier-aware timeout (cheap 2min / capable 10min, env-overridable). Pass
 * { continueOnFail: true } for fan-out members so one dead task can't sink the
 * Parallel; pass { retries } to override the default of 1, { timeoutMs } to pin.
 */
export function taskOpts(role, opts = {}) {
  const tier = opts.tier || ROLE_TIER[role] || "cheap";
  const timeoutMs = opts.timeoutMs ?? (tier === "capable" ? CAPABLE_TIMEOUT_MS : CHEAP_TIMEOUT_MS);
  const out = { timeoutMs, retries: opts.retries ?? 1 };
  const hb = opts.heartbeatTimeoutMs ?? (HEARTBEAT_MS || undefined);
  if (hb) out.heartbeatTimeoutMs = hb;
  if (opts.continueOnFail) out.continueOnFail = true;
  return out;
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
