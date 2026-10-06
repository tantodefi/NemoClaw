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
//   CHAD_NEMOTRON_MODEL       cheap-tier Nemotron id (default Super 120B — fast,
//                             ~3s reasoning-off; Ultra is too slow for cheap work).
//   CHAD_NEMOTRON_CAPABLE_MODEL  capable-tier Nemotron id (default Ultra 550B).
//   CHAD_REASONING            on|off. Default is TIER-AWARE: capable ON, cheap OFF.
//                             Enforced via reasoning_effort/chat_template_kwargs
//                             body injection (the "detailed thinking off" system
//                             directive is a NO-OP on Nemotron-3). Reasoning-on with
//                             a small cap eats the budget → empty output, so cheap
//                             stays off. "on"/"off" forces BOTH tiers.
//   CHAD_LOCAL_BASE_URL       lmstudio OpenAI-compatible (default 127.0.0.1:1234/v1).
//   CHAD_LOCAL_MODEL          local model id (default google/gemma-3-4b).
//   CHAD_CAPABLE_BACKEND      force the capable tier: claudecode|codex|nemotron|
//                             opencode|anthropic|local. Unset = auto-detect.
//   CHAD_CHEAP_BACKEND        force the cheap tier (default nemotron).
//   CHAD_DISABLE_CLI_AGENTS   "1" removes the CLI-backed agents (claude/codex/
//                             opencode) from BOTH auto-selection and fallback.
//                             Set by the cron wrappers: under launchd the CLIs
//                             can't auth (subscription/keychain is GUI-bound) and
//                             the host `claude` hooks pollute output, so headless
//                             runs stay nemotron-only (retries re-run nemotron).
//   CHAD_CLAUDE_SETTING_SOURCES  comma list passed to `claude --setting-sources`
//                             (default "project,local"): EXCLUDES user-level
//                             settings so host lifecycle hooks (claude-mem
//                             SessionStart, …) don't inject hook events into the
//                             stream-json parser → AGENT_CLI_ERROR. Auth survives.
//   CHAD_OPENCODE_MODEL       the "big pickle" model id once confirmed (pending).
//   ANTHROPIC_API_KEY         enables the @ai-sdk/anthropic fallback (only used
//                             if present AND credits restored — API is 402 today).
//
// ── Model ids (NVIDIA hosted, OpenAI-compatible, free with NVIDIA_API_KEY) ──
//   Super 120B  nvidia/nemotron-3-super-120b-a12b  (March 2026; cheap-tier default)
//   Ultra 550B  nvidia/nemotron-3-ultra-550b-a55b  (Jun 4 2026; 55B active, hybrid
//               Mamba-Transformer MoE, built for long-running agentic/tool-loop
//               work — capable-tier default). Adopted 2026-06-13.

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { clampOutput } from "./lib/model-limits.js";
import { resolveDirectives, directiveSystemFor } from "./lib/directives.js";

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
  // Headless gate: under launchd the CLI-backed agents (claude/codex/opencode)
  // can't authenticate (subscription/keychain is GUI-bound) and the host
  // `claude` lifecycle hooks pollute the stream-json output the parser expects
  // (caused the mcp-health AGENT_CLI_ERROR via the claudecode fallback). The
  // cron wrappers set CHAD_DISABLE_CLI_AGENTS=1 so these never enter selection
  // OR fallback and a scheduled run stays nemotron-only.
  const cliOff = env.CHAD_DISABLE_CLI_AGENTS === "1";
  _probe = {
    nvidiaKey: Boolean(env.NVIDIA_API_KEY || env.OPENAI_API_KEY),
    anthropicKey: Boolean(env.ANTHROPIC_API_KEY),
    shimUrl: env.CHAD_INFERENCE_BASE_URL || "http://127.0.0.1:8901/v1",
    localUrl: env.CHAD_LOCAL_BASE_URL || "http://127.0.0.1:1234/v1",
    sdk: Boolean(ToolLoopAgent && createOpenAICompatible),
    claudeCli: !cliOff && binOnPath("claude") && Boolean(ClaudeCodeAgent),
    codexCli: !cliOff && binOnPath("codex") && Boolean(CodexAgent),
    opencodeCli: !cliOff && binOnPath("opencode") && Boolean(OpenCodeAgent),
    cliDisabled: cliOff,
    // Anthropic API returns 402 (no credits) as of 2026-06; set
    // CHAD_ANTHROPIC_CREDITS_OK=1 once restored to let the fallback engage.
    anthropicApi402: env.CHAD_ANTHROPIC_CREDITS_OK !== "1",
  };
  return _probe;
}

// ── Nemotron-3 reasoning control ─────────────────────────────────────────────
// VERIFIED 2026-06-22: the "detailed thinking on/off" SYSTEM directive is a NO-OP
// on Nemotron-3 (every model reasoned regardless). Reasoning is ON by default and
// only `reasoning_effort:"none"` / `chat_template_kwargs:{thinking:false}` actually
// disable it. The AI-SDK has no first-class field for chat_template_kwargs, so when
// reasoning should be OFF we inject both into the request body via a fetch wrapper.
// This matters because reasoning-on quietly ate the cheap 2048-token budget →
// EMPTY answers (the "empty response" bug) and pushed Ultra past the 120s cap.
function reasoningOffFetch(baseFetch = fetch) {
  return async (url, init) => {
    if (init && typeof init.body === "string" && init.body.includes('"messages"')) {
      try {
        const b = JSON.parse(init.body);
        // `reasoning_effort:"none"` + `chat_template_kwargs` are NEMOTRON-3
        // EXTENSIONS. Strict OpenAI-style validators (gpt-oss, llama-4, … via NIM)
        // REJECT reasoning_effort:"none" with a 400 (must be low|medium|high) — so
        // only inject for Nemotron models. Other models keep their default (which is
        // fine for fusion panelists); this avoids breaking the non-Nemotron panel.
        if (/nemotron/i.test(String(b.model || ""))) {
          b.reasoning_effort = "none";
          b.chat_template_kwargs = { ...(b.chat_template_kwargs || {}), thinking: false };
          init = { ...init, body: JSON.stringify(b) };
        }
      } catch { /* non-JSON body — leave as-is */ }
    }
    return baseFetch(url, init);
  };
}

// ── OpenAI-compatible provider factory (Nemotron / NIM / local) ──────────────
function openaiCompatModel(baseURL, modelId, apiKey, name, reasoningOff = false) {
  if (!createOpenAICompatible) {
    throw new Error("agents.js: @ai-sdk/openai-compatible not installed — run `bun install`");
  }
  const provider = createOpenAICompatible({
    name, baseURL, apiKey: apiKey || "not-needed",
    ...(reasoningOff ? { fetch: reasoningOffFetch() } : {}),
  });
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

// championSystem — the arena's current winning drafter system prompt, written by
// experiments.jsx to state/champion-prompt.json when a drafter-prompt champion is
// promoted. Closes the value loop: draft-tier agents adopt it automatically.
// Returns undefined if none has been exported yet.
function championSystem() {
  try { const s = JSON.parse(readFileSync(new URL("./state/champion-prompt.json", import.meta.url), "utf8")).system; return s || undefined; } catch { return undefined; }
}

// directiveSystem — operator-configured system-prompt additions injected into
// EVERY pickAgent call. Resolves through lib/directives.js so a run's per-run
// override / global-off env (CHAD_DIRECTIVES_JSON / CHAD_DIRECTIVES_OFF) is honored
// exactly like the global Directives tab file. Empty strings inject nothing (opt-in).
function directiveSystem(role) {
  try { return directiveSystemFor(resolveDirectives(process.env), role); }
  catch { return undefined; }
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
    // Tier defaults (verified 2026-06-22, speed vs quality): CHEAP single-turn →
    // Super 120B (~3s reasoning-off, frontier-tier 120B quality); CAPABLE tool-loop/
    // judge → Ultra 550B (best reasoning, ~7 tok/s is fine there). Ultra was the
    // WRONG cheap default — it generates ~1085 tok in 145-166s, blowing the 120s
    // cheap cap. Override per tier with CHAD_NEMOTRON_MODEL / _CAPABLE_MODEL.
    const modelId = opts.model
      || (opts.cheap
        ? (env.CHAD_NEMOTRON_MODEL || "nvidia/nemotron-3-super-120b-a12b")
        : (env.CHAD_NEMOTRON_CAPABLE_MODEL || "nvidia/nemotron-3-ultra-550b-a55b"));
    // Tier-aware reasoning. CHEAP → OFF (fast; leaves the whole token budget for
    // the answer — reasoning-on previously ate the 2048 cap → EMPTY answers).
    // CAPABLE → ON. Force with opts.reasoning or CHAD_REASONING=on|off. The control
    // is request-body injection (reasoningOffFetch), NOT a system directive (no-op).
    const reasoning = opts.reasoning ?? (opts.cheap
      ? (env.CHAD_REASONING === "on")
      : (env.CHAD_REASONING !== "off"));
    const model = openaiCompatModel(
      p.shimUrl, modelId, env.NVIDIA_API_KEY || env.OPENAI_API_KEY, "chad-nemotron", !reasoning,
    );
    return new ToolLoopAgent({
      model,
      // System = the arena-winning drafter prompt (opts.system, draft roles) only.
      // The reasoning directive is gone — it never worked; reasoning is controlled
      // at the request-body level (see reasoningOffFetch / openaiCompatModel).
      ...(opts.system ? { instructions: opts.system, allowSystemInMessages: true } : {}),
      // Frugal tier budget (env-overridable), CLAMPED to the model's registry
      // ceiling. With reasoning truly off, 2048 is ample for a direct answer;
      // reasoning-on tiers get headroom so chain-of-thought doesn't starve the answer.
      maxOutputTokens: clampOutput(modelId, maxOut(opts.cheap, reasoning ? 32768 : 16384, reasoning ? 8192 : 2048)),
      maxSteps: opts.cheap ? (reasoning ? 2 : 1) : (opts.maxSteps ?? 12),
      // Abort the AI-SDK call if the hosted model hangs (connection released).
      // opts.timeoutMs lets a task pin extra headroom — e.g. a cheap-tier task
      // deliberately on the slow Ultra (email draft) needs more than the 120s cap.
      timeout: { totalMs: opts.timeoutMs ?? (opts.cheap ? CHEAP_TIMEOUT_MS : CAPABLE_TIMEOUT_MS) },
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
      // Autonomous runs EXCLUDE user-level settings so host lifecycle hooks
      // (claude-mem SessionStart, …) don't inject `hook_started` events into the
      // stream-json the parser expects → AGENT_CLI_ERROR. Verified: dropping
      // "user" keeps OAuth/subscription auth (subtype:success). The approval
      // ladder WANTS the user hooks (Moshi phone), so it loads ALL sources.
      ...(opts.approvalRouting ? {} : { settingSources: env.CHAD_CLAUDE_SETTING_SOURCES || "project,local" }),
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
  // Compose the agent's system prompt: an explicit opts.system wins; otherwise the
  // arena's winning drafter prompt (draft role only) PLUS the operator's directive
  // system prompt (all roles, from the Directives tab). Either may be empty.
  const auto = [role === "draft" ? championSystem() : undefined, directiveSystem(role)].filter(Boolean).join("\n\n");
  const system = opts.system ?? (auto || undefined);
  return ctor({ cheap: tier === "cheap", ...opts, system });
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
  // Headless/cron: nemotron-only, no cross-backend fallback. Smithers' own retry
  // re-runs the primary (nemotron) — the right behavior when no other backend can
  // auth headless. Prevents escaping to claudecode (the mcp-health failure) or a
  // local lmstudio that isn't running under launchd.
  if (probe().cliDisabled) return undefined;
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
