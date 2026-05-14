---
title:
  page: "Workspace Files"
  nav: "Workspace Files"
description:
  main: "What workspace personality and configuration files are, where they live, and how they persist across sandbox restarts."
  agent: "Explains what workspace personality and configuration files are, where they live, and how they persist across sandbox restarts. Use when users ask about `SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, or other workspace files, or when preparing to back up or restore workspace state."
keywords: ["nemoclaw workspace files", "soul.md", "user.md", "identity.md", "agents.md", "sandbox persistence"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "workspace", "persistence"]
content:
  type: concept
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Workspace Files

OpenClaw stores its personality, user context, and behavioral configuration in a set of Markdown files inside the sandbox.
These files live at `/sandbox/.openclaw/workspace/` and are collectively called **workspace files**.

## File Reference

| File | Purpose |
|---|---|
| `SOUL.md` | Defines the agent's persona, tone, and communication style. |
| `USER.md` | Stores information about the human the agent assists. |
| `IDENTITY.md` | Short identity card — name, language, emoji, creature type. |
| `AGENTS.md` | Behavioral rules, memory conventions, safety guidelines, and session workflow. |
| `MEMORY.md` | Curated long-term memory distilled from daily notes. |
| `memory/` | Directory of daily note files (`YYYY-MM-DD.md`) for session continuity. |

### Runtime state (Chad agent)

The Chad agent persists additional orchestration state under `/sandbox/.openclaw-data/`. This is separate from the workspace files above — workspace defines *who Chad is*; runtime state captures *what Chad has scheduled or recently decided*.

| Path | Purpose |
|---|---|
| `cron/jobs.json` | Registered cron jobs (email-check, workspace-backup, gbrain-dream, etc.). The gateway reads this at startup; loss of this file silently empties the schedule. |
| `auto-actions.json` | Action-gate state: per-channel daily counters and the kill-switch. |
| `exec-approvals.json` | Approved-exec list — decisions made by `chad-action-gate` that persist across restarts. |
| `queue/tasks.jsonl` | Sub-agent task ledger. |
| `queue/budget.json` | Token budget across cron tasks. |
| `agents/`, `flows/`, `hooks/` | Custom agent registrations, workflow definitions, and hook configs added at runtime. |
| `identities/<slug>.md` | Per-operator persona files prepended by `chad-shim` to user messages from open-webui (since 2026-05-13). One file per operator slug (email local-part), plus `default.md` for unknown senders. See `scripts/openwebui/chad-shim.py`. |
| `bin/` | Sandbox-writable patched copies of chad CLI tools (`chad-issue-triage`, `chad-issue-triage-cron`, `chad-mail-check`, `chad-email-check-cron`, `chad-webui`, `chad-webui-mcp`, `chad-experiment`). Lets fixes deploy without touching root-RO `/usr/local/bin/` in the image. |
| `skills/openwebui/SKILL.md`, `skills/chad-experiment/SKILL.md` | Runtime-synced chad-managed skills (added 2026-05-13/14). The `openwebui` skill documents the chad-webui CLI + MCP tools; the `chad-experiment` skill documents the autonomous experiment lifecycle. |
| `state/experiments/{config.json,ledger.jsonl,active/,archive/}` | Autonomous experiment lifecycle state (since 2026-05-14): config (budget, regression threshold, allowed types), append-only event log, and per-experiment records. |
| `state/agent-inbox.jsonl` | Append-only structured event stream from host-side watchdogs (chad-gateway-watchdog, chad-shim-watchdog, chad-spawn-poll-watchdog). Cron agent turns tail this on startup to surface state changes between turns. |

These are tracked alongside workspace files in the [sectioned manifest](#sectioned-manifest) below so backup tooling round-trips them automatically.

(sectioned-manifest)=
## Sectioned Manifest

`scripts/chad-workspace-files.txt` is the single source of truth for what backup tooling round-trips. It uses a sectioned format that both `chad-backup-to-github.sh` and `chad-restore-from-github.sh` parse:

```
[workspace]                  ← persona prose under /sandbox/.openclaw/workspace/
SOUL.md
USER.md
…

[runtime]                    ← orchestration state under /sandbox/.openclaw-data/
cron/jobs.json
auto-actions.json
exec-approvals.json
queue/tasks.jsonl
queue/budget.json

[runtime-dirs]               ← recursive directories under /sandbox/.openclaw-data/
agents/
flows/
hooks/

[exclude]                    ← documentation only — never backed up
identity/                    # device keypair + operator tokens (regenerable, sensitive)
devices/                     # paired peer tokens
credentials/                 # bearer token cache
subagents/, logs/            # ephemeral
gbrain/                      # PGLite raw — backed up via `gbrain export` instead
```

Adding new state to track? Append it under `[runtime]` (single file) or `[runtime-dirs]` (recursive directory), then re-run `scripts/chad-setup.sh` to redeploy the manifest. Both backup scripts pick it up on the next invocation — no script edits needed.

### Why `identity/` is in `[exclude]`

The directory `/sandbox/.openclaw-data/identity/` holds the device's Ed25519 signing keypair and operator bearer tokens — not persona data. Persona prose lives in `[workspace]`. Backing up the keypair would (a) leak a long-lived signing key into git history, even in a private repo, and (b) cause identity collisions if two sandboxes restored from the same snapshot. OpenShell regenerates the keypair on first boot via device pairing.

## Where They Live

All workspace files reside inside the sandbox filesystem:

```text
/sandbox/.openclaw/workspace/
├── AGENTS.md
├── IDENTITY.md
├── MEMORY.md
├── SOUL.md
├── USER.md
└── memory/
    ├── 2026-03-18.md
    └── 2026-03-19.md
```

## Multi-Agent Deployments

A single NemoClaw sandbox can host more than one OpenClaw agent.
When OpenClaw is configured with multiple named agents (e.g., a shared `main` agent
plus per-user agents for a Teams-integrated deployment), each agent gets its own
workspace directory alongside the default `workspace/`:

```text
/sandbox/.openclaw/
├── workspace/           # default agent (single-agent deployments)
├── workspace-main/      # named agent "main"
├── workspace-support/   # named agent "support"
└── workspace-ops/       # named agent "ops"
```

Each per-agent workspace contains the same Markdown file structure as the default
(`SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, `MEMORY.md`, `memory/`).
Files are per-agent — changes in `workspace-main/AGENTS.md` are not visible to
`workspace-support/`.

Persistence and snapshots are handled automatically for per-agent workspaces:
the sandbox entrypoint provisions each `workspace-<name>/` as a symlink into the
writable `.openclaw-data/` tree so state survives sandbox restart, and
`nemoclaw <name> snapshot create` discovers every `workspace-<name>/` directory
and includes it in the snapshot bundle alongside the default `workspace/`.

:::{note}
Files that operators typically want consistent across every agent workspace
(`AGENTS.md`, shared skills, common templates) are not synced automatically.
Each workspace is independent; changes in one don't propagate. Tracking
shared-file tooling (shared mount, `workspaces list` command) in
[#1260](https://github.com/NVIDIA/NemoClaw/issues/1260).
:::

## Persistence Behavior

Understanding when these files persist and when they are lost is critical.

### Survives: In-process Gateway Restart

A graceful `openclaw gateway restart` (where the pod stays up and only
the gateway process is recycled) preserves workspace files — they live
on the pod's writable filesystem, not in the gateway's memory.

### Lost: Pod Recreate or Sandbox Destroy

:::{warning}
**`/sandbox` is on the pod's writable container layer — there is no PVC
backing it.** Any operation that recreates the pod (`kubectl delete pod
chad -n openshell`, `nemoclaw <name> destroy`, a node-level reschedule)
**permanently deletes ~1.2 GB of state**: gbrain pglite, openclaw
config, workspace memory, lancedb plugin cache, credentials.

Always back up first:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
ssh openshell-chad 'cd / && tar -cf - sandbox' \
  | gzip > ~/.nemoclaw/backups/sandbox-state-${TS}.tar.gz
```

Verify mount situation: `docker exec openshell-cluster-nemoclaw kubectl
get pod chad -n openshell -o jsonpath='{.spec.volumes[*].name}'` — if
the only volumes are `openshell-client-tls`, `openshell-supervisor-bin`,
and `kube-api-access-*`, /sandbox is ephemeral.

The proper fix is a PVC binding for `/sandbox` in the
nemoclaw-blueprint StatefulSet. See [Backup and Restore](backup-restore.md)
and `chad-readme.md` § 8.
:::

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it** — Ask your agent to update its persona, memory, or user context.
2. **Edit manually** — Use `openshell sandbox shell` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

## Next Steps

- [Set Up Task-Specific Sub-Agents](../inference/set-up-sub-agent.md)
- [Backup and Restore workspace files](backup-restore.md)
- [Commands reference](../reference/commands.md)
