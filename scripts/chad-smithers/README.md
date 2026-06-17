# chad-smithers

Host-side Smithers (smithers.sh) workspace for Chad — durable JSX
workflow orchestration with crash recovery, per-task model routing, and an
evolutionary nightly-experiment loop. See the full rationale in
[`docs/design/smithers-moshi-integration.md`](../../docs/design/smithers-moshi-integration.md).

Pilot scope: **host-side** (the Mac mini), not the pod. `/sandbox` is ephemeral
(no PVC), so `experiments.db` must live on the durable host filesystem for
resume guarantees to hold.

## Layout

| File | Role |
|---|---|
| `agents.js` | Model router. The only place a backend is chosen. `pickAgent(role)` auto-detects what's available and routes by tier. |
| `lib/population.js` | Evolutionary selection engine (pure, unit-tested): start wide → score → rank → retire losers. |
| `lib/population.test.js` | `node --test lib/population.test.js` — 6 tests, all green. |
| `lib/spawn.js` | The chad-spawn ⇄ Smithers bridge: `runSpawn()` (offload a step to chad-spawn, reconcile its `result.json`), `route()` (chad-route ported), `scoreIssue()`. Never throws. |
| `lib/spawn.test.js` | `bun test lib/spawn.test.js` — 8 tests, all green. |
| `experiments.jsx` | The nightly evolutionary workflow (Smithers). |
| `workflows/*.jsx` | Ported chad-spawn / cron features (issue-triage, content-pipeline, self-improve, memory-curator, log-digest) + email-ladder, fusion, mcp-health-probe, fail-only-report. All graph-validate; side-effecting ones are shadow-safe by default. |
| `state/seed-candidates.json` | Tracked. Initial variant pool to seed the arena wide. |
| `state/fixtures.json` | Tracked. Evaluation fixtures the judge scores against. |
| `state/population.json` | **Runtime** (gitignored). The evolving population + scores. |
| `experiments.db` | **Runtime** (gitignored). Smithers' SQLite checkpoint store. |

## Model routing (the "free Nemotron" question, answered)

The default cheap-tier model is NVIDIA's **hosted** Nemotron 3 Super 120B
(`integrate.api.nvidia.com`, via `NVIDIA_API_KEY`) reached through the local
`chad-shim :8901` proxy — a frontier 120B MoE, not a weak local model. The only
truly-local model is `google/gemma-3-4b` (lmstudio, offline fallback).

`pickAgent(role)` picks by tier with runtime auto-detection:

- **cheap** (classify/draft/observe/report): hosted Nemotron-120B if
  `NVIDIA_API_KEY` is set (free, frugal tokens), else `claude` CLI, else local.
- **capable** (evaluate/judge/optimize/implement): best available, preferring
  `claudecode` (Claude Max subscription, no API credits) → `codex` →
  Nemotron-120B via AI-SDK tool loop → `opencode` → local gemma.

Inspect the resolved table for the current environment:

```sh
bun agents.js --probe
```

Override with `CHAD_CAPABLE_BACKEND` / `CHAD_CHEAP_BACKEND`
(`claudecode|codex|nemotron|opencode|anthropic|local`).

The Nemotron path uses **two** hosted ids: Super 120B (`nvidia/nemotron-3-super-120b-a12b`,
fast) for the cheap tier, Ultra 550B (`nvidia/nemotron-3-ultra-550b-a55b`, agentic,
adopted 2026-06-13) for the capable tier. Both are seeded as experiment candidates
so the arena measures whether Ultra's quality justifies its latency.

### Do we need to add API keys to credentials?

**No new keys.** The `ai` SDK itself needs no key; only the *provider* does:
- **nemotron / NIM** → `NVIDIA_API_KEY` (already in the pod credentials; the
  hosted Nemotron API is free with it). This is the only key the default path needs.
- **claudecode** → none; the `claude` CLI uses the Max subscription/OAuth.
- **anthropic (`@ai-sdk/anthropic`)** → would need `ANTHROPIC_API_KEY` **and**
  restored credits. It's wired as a **fallback only**: the backend throws if the
  key is absent, and auto-detect skips it until `CHAD_ANTHROPIC_CREDITS_OK=1`
  (API is 402 today). So it's available as a fallback the moment credits return,
  with zero code change — but nothing requires adding the key now.

> The "Nemotron can't drive tool loops" lore was an **openclaw harness**
> round-trip bug, not a model limit. Smithers runs its own AI-SDK tool loop, so
> the 120B model is a candidate for the capable tier too — that's literally one
> of the seeded experiment candidates (`model:nemotron-default` vs
> `model:claudecode-subscription`). Let the arena decide.

### opencode / "big pickle" — pending

`opencode` is installed on the host, so the 500k-ctx / 200-req-hr path is real.
Smithers ships no `OpenCodeAgent`, so the backend in `agents.js` currently
throws a clear TODO. To finish it, confirm:
1. `CHAD_OPENCODE_MODEL` — the actual model id ("big pickle"), and
2. whether opencode exposes an OpenAI-compatible server (`opencode serve`) we
   can point the nemotron-style `createOpenAICompatible` at, or whether it needs
   a thin CLI adapter implementing the Smithers agent contract.

## Moshi integration (phone notifications + approval)

`moshi-hook` (running + paired on the host) has **no `notify` command** — push
only flows through agent lifecycle hooks. Installed 2026-06-13 via
`moshi-hook install --target claude`, which wrote handlers into the global
`~/.claude/settings.json` that pipe Claude Code's hook JSON to
`moshi-hook claude-hook`:

- **Stop** → phone notification when a `claude` run finishes. Since the capable
  tier runs via `claude`, **nightly experiment completion already notifies the
  phone** with no extra code.
- **PermissionRequest / PostToolUse[AskUserQuestion]** → routes an approval to
  the phone (the Phase-5 autonomy mechanism).

Because of that split, `claudecode` agents default to
`dangerouslySkipPermissions: true` so **autonomous** experiment runs notify on
finish but never block waiting for a tap. For the **autonomy ladder**, construct
with `pickAgent(role, { approvalRouting: true })` to keep permissions on and
surface each action on the operator's phone.

Pod-side events (gbrain dream, spawns) don't run through host `claude`, so they
aren't covered yet — a pod→host bridge is the Phase-2 follow-up (the socket is
`~/Library/Application Support/Moshi/moshi-hook.sock`; there is no documented
generic-emit verb, so a synthetic-event approach needs the `claude-hook` stdin
schema captured first).

**Revert:** `moshi-hook uninstall` removes the hook config. `moshi-hook status`
shows current pairing/hook state.

## Evolutionary experiments — "start wide, keep what works"

Per operator directive (2026-06-13). Each run:

1. **seed** — fill the active cohort up to `POLICY.targetActive` (start wide).
2. **evaluate** — score every active candidate **in parallel** (one durable
   Smithers task each; a crash resumes from the last scored candidate).
3. **select** — record scores, rank by rolling mean, promote top-K to
   `champion` (used in prod), **retire** candidates that stay below
   `retireBelow` after `minTrials` (kept on record, never re-explored).
4. **report** — write the leaderboard + post an OpenWebUI note (the
   experiment-night success criterion: an operator-visible artifact).

Tune the policy in `lib/population.js#POLICY`.

## Bring-up

```sh
bun install
node --test lib/population.test.js     # selection engine — should be 6/6
bun agents.js --probe                  # confirm routing for this host
smithers graph experiments.jsx         # validate the workflow WITHOUT calling a model
DRY_RUN=1 smithers up experiments.jsx  # full render, no state writes
smithers up experiments.jsx            # real run (calls the routed model)
smithers ps                            # watch run state
smithers resume                        # after any crash/stall
```

`run-experiments.sh` wraps the real run + the OpenWebUI artifact post for cron.

## Status

- `agents.js`, `lib/population.js` — production-shaped, router probes clean,
  selection engine unit-tested (6/6).
- `experiments.jsx` — **live smoke pass GREEN (2026-06-13)**: `smithers up` ran
  the full loop end-to-end (seed → parallel eval via `claude` → select → report),
  scores flow correctly (recorded trial, promoted champion, leaderboard written),
  state persisted to `experiments.db` + `state/population.json`. Ready for Phase-4
  cron wiring via `run-experiments.sh`.

### Gotchas learned during bring-up (don't regress these)

- **zod MUST be v4** (`^4.3.6`, matches Smithers). A 3.x `/v4` shim makes the
  agents package's `toJSONSchema` throw `Non-representable type: optional`.
- **Agent task prompt** is a string child (`{prompt}`), not a thunk.
- **Read upstream outputs via `ctx.outputs.<schemaName>`** in render scope (the
  fan-in pattern), not the `deps` arg — `deps` is keyed by task id, so it's empty
  for dynamic `eval-*` fan-out.
