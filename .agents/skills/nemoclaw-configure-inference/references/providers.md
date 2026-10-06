<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Inference Providers and Per-Task Routing

This page catalogs every provider NemoClaw can route through, names the model that serves each task by default, and explains how to opt into the premium (Anthropic) endpoint for flows that benefit from it. See also Inference Options (use the `nemoclaw-configure-inference` skill) for what the onboard wizard exposes.

## Provider catalog

| Provider | API type | Base URL | Credential env | Wired in |
|---|---|---|---|---|
| NVIDIA prod gateway | `openai-compat` | `https://integrate.api.nvidia.com` | `NVIDIA_API_KEY` | `src/lib/inference-config.ts` |
| NVIDIA NIM (local) | `openai-compat` | `http://localhost:8000` | (none) | `src/lib/inference-config.ts` |
| LM Studio | `openai-compat` | `http://localhost:1234` | (none) | `src/lib/inference-config.ts` |
| Anthropic (premium) | `anthropic-messages` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `scripts/generate-openclaw-config.py` (secondary) + `chad-premium-client` (direct) |

The Anthropic provider is emitted as a *secondary* provider in `openclaw.json` whenever `ANTHROPIC_API_KEY` is present in `/sandbox/.nemoclaw/credentials.json`. It does not displace the primary inference route — it sits alongside it for opt-in calls.

## Per-task model assignments

Source: `scripts/task-profiles.json` (joined with `scripts/model-registry.json`). Quality bands reflect Phase 1 review against today's traffic patterns.

| Task profile | Default model | Quality band | Premium variant |
|---|---|---|---|
| `default` | `nvidia/nemotron-3-super-120b-a12b` | GREEN | (none — covered by free gateway) |
| `code-completion` | `nvidia/nemotron-3-super-120b-a12b` | GREEN | (none) |
| `issue-triage` (orchestrator) | `nvidia/nemotron-3-super-120b-a12b` | GREEN | `issue-triage-coder-subagent-premium` (still routed for deeper code review) |
| `issue-triage-coder-subagent` | `nvidia/nemotron-3-super-120b-a12b` | YELLOW | `issue-triage-coder-subagent-premium` → `claude-sonnet-4-6` |
| `content-generation` | `nvidia/nemotron-3-super-120b-a12b` | YELLOW | `content-generation-premium` → `claude-sonnet-4-6` |
| `chad-bug-intake` | `nvidia/nemotron-3-super-120b-a12b` | YELLOW | `chad-bug-intake-premium` → `claude-sonnet-4-6` |
| `self-improve` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (embedded) | YELLOW (slow) | run via `chad-premium --opus` ad hoc |
| `mail-summarize` | `nvidia/nemotron-3-super-120b-a12b` | GREEN | (none) |
| `premium-default` | `claude-sonnet-4-6` | n/a (always premium) | — |
| `premium-opus` | `claude-opus-4-7` | n/a (always premium) | — |

GREEN = current model produces acceptable output; switching to premium would not move the needle.
YELLOW = current model frequently underperforms (truncated reasoning, dropped tool calls, shallow reviews); premium materially improves the result.

> **Migration note (2026-04-30):** Kimi K2.5 was the previous default until NVIDIA Endpoints deprecated it (returns 410 GONE). All free-tier defaults moved to `nvidia/nemotron-3-super-120b-a12b`, which has `reasoningSafe=true` so the multi-turn tool-call regression that gated Kimi behind YELLOW for several tasks no longer applies. Premium variants stayed on Sonnet/Opus for the deeper-reasoning use cases.

## When premium pays off

Use premium (Sonnet) when the task involves:

- Multi-turn tool calls with state to thread across (issue-triage coder, bug-intake review).
- Long-context synthesis (content-generation, retrospectives, multi-file refactors).
- Anything where Nemotron's review or reasoning depth feels shallow versus the cost of a premium call.

Use opus only for:

- Deep, single-shot reasoning where Sonnet's draft was unsatisfying.
- Architecture sketches that need to consider many trade-offs at once.

Anything that's a one-line summary, a classification, or a deterministic transform should stay on the free gateway.

## How to switch a single task to premium

1. Open `scripts/task-profiles.json`.
2. Find the task's profile (e.g. `content-generation`).
3. Either change its `inherits` to a `*-premium` profile or copy the premium profile keys onto it.
4. Re-run `python3 scripts/generate-openclaw-config.py` (or `bash scripts/chad-setup.sh chad`) to regenerate `openclaw.json` and redeploy.
5. Verify with `kubectl exec openshell-chad -- jq '.tasks["content-generation"].model' /sandbox/.openclaw/openclaw.json`.

## Premium gating (auth-context)

`requiresAuthContext: true` is set on every Anthropic model in `model-registry.json`. The chain:

1. A trigger (dashboard `/premium`, terminal `chad-premium`, inbound mail, GitHub mention) calls `chad-auth-context detect …` to write a per-flow AuthContext blob.
2. `chad-premium-client` refuses to call Anthropic unless `$CHAD_AUTH_CONTEXT_PATH` resolves to a blob with `allowsPremium: true`.
3. Every premium call appends one JSON line to `/tmp/chad-premium.jsonl` recording timestamp, model, in/out tokens, source, and verifiedIdentity.

Cron ticks with no inbound trigger have no AuthContext, so premium calls fail closed. See Log Locations — Premium ledger (use the `nemoclaw-manage-operations` skill) for where the audit trail lives.

## Two ways to invoke premium

**From the openclaw dashboard / TUI:** prefix any prompt with `/premium` (Sonnet) or `/premium --opus` (Opus). The `chad-route-prompt` shim detects the prefix and routes to `chad-premium`.

**From a terminal inside the sandbox:**

```bash
chad-premium "draft a Q2 retrospective for the chad-state repo"
chad-premium --opus "redesign the issue-triage state machine"
chad-premium --memory --system "Write like a release note." "summarize the week"
```

Both paths require an AuthContext that authorizes premium; the terminal path auto-attaches one when `NEMOCLAW_INVOKER_TOKEN` is set in the env.
