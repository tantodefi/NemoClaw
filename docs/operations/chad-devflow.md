---
title:
  page: "Chad Devflow Reference"
  nav: "Chad Devflow"
description:
  main: "Catalog of every script in the Chad sandbox toolchain — what each does, when to run it, and the primary commands you'll actually type."
  agent: "Reference catalog of host-side and in-sandbox scripts under scripts/ and scripts/chad-cron-wrappers/. Use when the user asks `which command does X` or wants the canonical list of devflow commands."
keywords: ["chad devflow", "chad scripts", "chad-sync", "chad-backup", "chad-restore", "cron wrappers"]
topics: ["operations", "devflow"]
tags: ["openclaw", "openshell", "nemoclaw", "chad", "operations"]
content:
  type: reference
  difficulty: technical_intermediate
  audience: ["developer", "engineer", "operator"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad Devflow Reference

This page is the canonical catalog of every script in the Chad sandbox toolchain. Use the **Primary Commands** section below for the 90% case; jump to **Script Catalog** when you need to know exactly what a particular wrapper does.

## Primary Commands

The four commands you'll actually type day-to-day:

```console
# One-time host-side bootstrap (or after major changes):
$ bash scripts/chad-setup.sh chad

# Snapshot everything and push to chad-state (run before pod resets, after meaningful changes):
$ npm run chad:sync

# Pull state back into a fresh sandbox (auto-runs during chad-setup if no local backup):
$ ssh openshell-chad 'chad-restore-from-github'

# Local triage snapshot — markdown dump for sharing or diffing, no remote calls:
$ ssh openshell-chad 'chad-dump-state' > state-$(date -u +%Y%m%dT%H%M%SZ).md
```

For more granular operations, see the categorized catalog below.

## Architecture at a Glance

Chad's persistence pipeline crosses three boundaries:

```text
┌─────────────────────────────────────────────────────────────┐
│  HOST (~/.nemoclaw/)                                         │
│   • chad-setup.sh, chad-sync.sh, backup-host.sh,             │
│     backup-workspace.sh                                      │
│   • Reads/writes ~/.nemoclaw/{credentials,backups,dumps}/    │
└────────────────────┬────────────────────────────────────────┘
                     │ ssh openshell-chad
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  SANDBOX (/sandbox/)                                         │
│   • chad-cron-wrappers/* installed at /usr/local/bin/        │
│   • Cron pipeline drives email, issue triage, backup, dream  │
│   • State at /sandbox/.openclaw-data/                        │
└────────────────────┬────────────────────────────────────────┘
                     │ gh api PUT (private repo)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  CHAD-STATE (private GitHub: tantodefi/chad-state)           │
│   • workspace/, memory/, queue/, cron/, brain/               │
│   • Last-write-wins snapshot, never source code              │
└─────────────────────────────────────────────────────────────┘
```

Source code lives in a separate repo (`tantodefi/NemoClaw`, public). See [Backup Policy §1.1](../resources/backup-policy.md) for the full source-vs-state split.

## Script Catalog

### Host-side: setup & sync

| Script | What it does | When to run |
|---|---|---|
| `chad-setup.sh` | One-shot host-side bootstrapper. Restores workspace from local backup or chad-state, syncs skills, deploys credentials, installs cron wrappers + `chad-shim.py`, registers cron jobs, applies network policies, clones source. | First-time setup, after major upgrades, after a sandbox rebuild. |
| `chad-sync.sh` (`npm run chad:sync`) | Single-command snapshot orchestrator: dump → backup → cron audit → summary. | Before pod resets, after meaningful changes you want durably stored, on demand. |
| `chad-clone-source.sh` | Clones `tantodefi/NemoClaw` into `/sandbox/source/` for in-sandbox read/grep access. | Auto-invoked by `chad-setup.sh`. Standalone if you need to refresh the source clone. |
| `backup-host.sh` | Snapshots `~/.nemoclaw/` (credentials, onboard session, sandbox metadata, draft policies, WIP skills) to `~/.nemoclaw/backups/host/<ts>/`. | Before re-onboarding, before destructive host operations, weekly. |
| `backup-workspace.sh` | Manual workspace download/restore via `openshell sandbox download`. Uses the same sectioned manifest as the cron-driven backup. | Cross-host migrations, manifest-gap workarounds. |
| `chad-dump-state.sh` | Generates a markdown state-dump (memory tail, ledger, sub-agent results, env). Local-only by default; `--tar` bundles raw logs. | Bug reports, before destructive ops, ad-hoc triage. |
| `chad-report-bug.sh` | Files a GitHub issue with optional state-dump attachment in the chad-state repo. | When Chad behaves wrong and you want it on record. |

### Host-side: open-webui front-end (chad-as-a-model)

| Script | What it does | When to run |
|---|---|---|
| `openwebui-setup.sh` (`npm run webui:up` / `webui:up:quick`) | Brings up the open-webui container and (in tunnel mode) the Cloudflare tunnel + Access policy. | First-time setup of the chat UI. |
| `openwebui-down.sh` (`npm run webui:down`) | Stops the open-webui stack. | Maintenance windows. |
| `openwebui-chad-tunnel.sh` (`npm run webui:chad:{up,down,status,install,uninstall}`) | SSH port-forward `localhost:8901 → openshell-chad:8901` so the open-webui container can reach `chad-shim` via `host.docker.internal`. `install` registers a per-user launchd agent (`KeepAlive=true`) so the tunnel survives logout/reboot. | `up` for a one-shot session; `install` for always-on. |

### In-sandbox: backup & restore

| Script | What it does | When to run |
|---|---|---|
| `chad-backup-to-github.sh` | Pushes the manifest's `[workspace]` + `[runtime]` + `[runtime-dirs]` sections plus the gbrain export to `${CHAD_STATE_REPO}`. SHA-skip optimisation avoids redundant PUTs. Also self-heals `chad-shim` if it isn't running. | Cron `workspace-backup` (every 6h). Manual via `ssh openshell-chad chad-backup-to-github`. |
| `chad-restore-from-github.sh` | Pulls `${CHAD_STATE_REPO}` and restores workspace + runtime files/dirs. Calls `chad-cron-reload` after restoring `cron/jobs.json` to re-register entries with the gateway. Also self-heals `chad-shim` if it isn't running. | Auto-invoked by `chad-setup.sh` step 4a when no local backup exists. Manual fallback after a fresh pod. |
| `chad-cron-reload` | Diffs `cron/jobs.json` against the gateway's in-memory list (`openclaw cron list --json`) and re-registers any missing entries via `openclaw cron add`. Idempotent. | Whenever cron count differs between disk and gateway. `chad-sync` flags the divergence in its audit step. |
| `chad-shim.py` | OpenAI-compat HTTP shim around `openclaw agent`. Listens on `127.0.0.1:8901` inside the sandbox; open-webui's `chad` model talks to it via the host SSH tunnel + `host.docker.internal`. Stdlib-only. | Started by `chad-setup.sh` install step; restart blocks in `chad-restore-from-github.sh` and `chad-backup-to-github.sh` re-launch it if it crashes. |

### Cron pipeline (auto-scheduled)

These run unattended via `openclaw cron`. Schedules and budgets live in [`scripts/task-profiles.json`](https://github.com/NVIDIA/NemoClaw/blob/main/scripts/task-profiles.json). Every wrapper appends its result to the day's memory file (`memory/<YYYY-MM-DD>.md`).

| Wrapper | Schedule | What it does |
|---|---|---|
| `chad-email-check-cron` | `0 2,6-23 * * *` | Sweeps the inbox via `chad-mail-check`, batch-marks-read low-signal mail, parks remainder under `### Pending replies` for human review. Optionally invokes `chad-drafter` (single-turn LLM, K2.5-safe) and routes drafts through `chad-autosend-replies`. |
| `chad-issue-triage-cron` | `0 10 * * *` | Reads top-N open issues from `${CHAD_BUG_REPO}`, runs the drafter for triage decisions (skip/comment-draft/close-stale), then detaches researcher/coder sub-agents for the highest-priority items. |
| `chad-workspace-backup` | `0 */6 * * *` | Wraps `chad-backup-to-github` and detaches the slow git push so the cron payload returns in <1s. |
| `chad-gbrain-dream` | `30 3 * * *` | Nightly embed-stale + extract-graph + extract-timeline against the gbrain. Detached. |
| `chad-budget-audit` | `0 4 * * 1` | Weekly Monday: computes p95 telemetry per task vs. `task-profiles.json` and writes recommendations to `memory/feedback-proposals.md`. |
| `chad-self-improve` | `0 3 * * 0` | Weekly Sunday: runs `chad-self-improve --days 7` and pastes proposals under `## Self-improvement`. |

### Inference / drafting / sending

| Wrapper | What it does | Invoked by |
|---|---|---|
| `chad-route-prompt` | Routes a prompt to the appropriate model (K2.5 default via NVIDIA free inference; premium via Anthropic when account funded). | All cron wrappers that talk to the LLM. |
| `chad-drafter` | Single-turn LLM drafter — no MCP, no tools, K2.5-safe even with `thinking=high`. Drafts emails, triage decisions, etc. into the day's memory file. **Never auto-sends.** | `chad-email-check-cron`, `chad-issue-triage-cron`. |
| `chad-action-gate` | Policy + budget gate. Decides whether a queued action (auto-send, auto-comment) should run. Returns one of `auto`, `draft`, `block`, `budget`, `killed`. | `chad-autosend-replies`. |
| `chad-autosend-replies` | Routes drafter outputs through the action gate; sends `auto` immediately, leaves `draft` for human review, marks `block`/`deferred` accordingly. Mutates the drafter output in place. | Tail end of `chad-email-check-cron`. |
| `chad-mail-check` / `chad-mail-send` | Direct Proton inbox sweep / send (via `proton-tool`). | `chad-email-check-cron`, `chad-autosend-replies`. |
| `chad-premium` / `chad-premium-client` | Invokes the premium (Sonnet/Opus) path when explicitly asked or when the inbound email is from a premium-allowed sender. Requires Anthropic API key and AuthContext. | `/premium` slash command, premium-eligible cron paths. |

### Utilities

| Script | What it does |
|---|---|
| `chad-ensure-today-memory` | Ensures `workspace/memory/<YYYY-MM-DD>.md` exists, returns its path. Used by every wrapper that appends to today's memory. |
| `chad-auth-context` | Manages the AuthContext token used to elevate cron-spawned sub-agents to premium / privileged paths. |
| `chad-dump-logs` | Tarball of recent gateway/cron/sub-agent logs. See [Log Locations](log-locations.md). |
| `_chad-paths.sh` | Sourced by every wrapper. Defines `OPENCLAW_DATA`, `WORKSPACE`, `CRED_FILE`, etc. Single source of truth for filesystem paths. |
| `auto-actions.template.json` | Template `auto-actions.json` deployed when `chad-setup.sh` finds no existing one. Holds per-channel daily counters and the kill-switch. |

## State Locations Cheat-Sheet

When something looks wrong, the file you want is usually one of:

| Path | What's in it | Backed up? |
|---|---|---|
| `/sandbox/.openclaw/workspace/` | Persona prose: `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, `EMAIL-POLICY.md`, `TOOLS.md`, `HEARTBEAT.md` | ✅ `[workspace]` |
| `/sandbox/.openclaw/workspace/memory/<YYYY-MM-DD>.md` | Daily session notes — every cron wrapper appends here | ✅ recursive |
| `/sandbox/.openclaw-data/cron/jobs.json` | Registered cron jobs — gateway loads at startup | ✅ `[runtime]` (and `chad-cron-reload` reconciles) |
| `/sandbox/.openclaw-data/auto-actions.json` | Action-gate state | ✅ `[runtime]` |
| `/sandbox/.openclaw-data/exec-approvals.json` | Approved-exec list | ✅ `[runtime]` |
| `/sandbox/.openclaw-data/queue/tasks.jsonl` | Sub-agent task ledger | ✅ `[runtime]` |
| `/sandbox/.openclaw-data/queue/budget.json` | Token budget across cron tasks | ✅ `[runtime]` |
| `/sandbox/.openclaw-data/agents/` | Custom agent registrations | ✅ `[runtime-dirs]` |
| `/sandbox/.openclaw-data/identity/` | Device keypair + operator tokens | ❌ excluded (regenerable, sensitive) |
| `/sandbox/.openclaw-data/credentials/` | Bearer token cache | ❌ excluded |
| `/sandbox/.gbrain/` | PGLite knowledge brain | ✅ via `gbrain export` → `brain/` |

See [Workspace Files §Sectioned Manifest](../workspace/workspace-files.md#sectioned-manifest) for the complete manifest format and [Backup Policy §1.2](../resources/backup-policy.md) for the rationale behind exclusions.

## Failure Modes & First Steps

| Symptom | First thing to check |
|---|---|
| Cron jobs disappeared from the OpenClaw dashboard | `ssh openshell-chad 'openclaw cron status'` — if `jobs: 0` but `cron/jobs.json` has entries, run `chad-cron-reload`. |
| Pod just got reset and Chad lost memory | `ssh openshell-chad 'chad-restore-from-github'` (auto-runs during `chad-setup.sh`). |
| Mail draft was sent without you asking | Check `auto-actions.json` and the action-gate decision log. The kill-switch is in the same file. |
| `gbrain` queries return nothing or `Aborted()` | PGLite single-process lock — confirm `gbrain serve` is running and no other process holds the lock. |
| `chad-sync` reports "cron drift" | Disk and gateway disagree. Run `ssh openshell-chad 'chad-cron-reload'`. |
| open-webui `chad` model errors / 502 | `npm run webui:chad:status` checks both the SSH tunnel and the in-sandbox shim. Tunnel down → `webui:chad:up` (or `install` for persistence). Tunnel up but `/healthz` fails → shim crashed; the next `workspace-backup` cron will self-heal it, or `ssh openshell-chad 'HOME=/sandbox nohup /usr/local/bin/chad-shim.py >/tmp/chad-shim.log 2>&1 &'`. |
| `openclaw` CLI commands fail with `gateway closed (1000): no close reason` (dashboard still works) | The gateway can't write its device-pair tmp files. Check `tail /sandbox/.openclaw-data/logs/config-audit.jsonl` for `EACCES` on `/sandbox/.openclaw/devices/*.tmp`. Re-run `bash scripts/chad-setup.sh chad --skip-restore` (step 3c chowns the writable subpaths). Permanent fix is baked into the Dockerfile — only resurfaces on sandboxes built before that change. |

## Next Steps

- [Backup and Restore](../workspace/backup-restore.md) — the canonical persistence guide
- [Workspace Files](../workspace/workspace-files.md) — what each file does and the sectioned manifest format
- [Backup Policy](../resources/backup-policy.md) — full inventory across all four state layers
- [Open WebUI Front-End](openwebui.md) — chat UI exposed via Cloudflare Tunnel + Access
- [Workflow Scenarios](chad-workflows.md) — named email scenarios + regression spec
- [Log Locations](log-locations.md) — where each log stream lives
