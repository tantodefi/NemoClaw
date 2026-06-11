<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Log Locations

NemoClaw and the chad sandbox emit logs across several layers. This page is the canonical inventory and shows how to bulk-fetch them with one command.

## Bulk dump

```bash
# Host + sandbox combined dump → ~/.nemoclaw/log-dumps/<TS>/
bash scripts/dump-logs.sh chad

# Sandbox-only (run inside the pod or via SSH)
chad-dump-logs --tail 200 --category gateway,cron,subagent,memory,tui,system,premium
```

Defaults: tail 200 lines per file, all categories, secrets redacted. Pass `--no-redact` only when troubleshooting redaction itself.

## Inventory

### Host (macOS)

| Stream | Path | How to read live |
|---|---|---|
| Claude IDE / coworkd / native host | `~/Library/Logs/Claude/*.log` | `tail -f ~/Library/Logs/Claude/*.log` |
| Recent Claude sessions (top 3) | `~/.claude/sessions/<id>/` | `ls -t ~/.claude/sessions \| head` |
| NemoClaw sandbox state | `~/.nemoclaw/sandboxes.json` | `jq . ~/.nemoclaw/sandboxes.json` |
| NemoClaw onboard config | `~/.nemoclaw/onboard-session.json` | `jq . ~/.nemoclaw/onboard-session.json` |
| Shields audit ledger | `~/.nemoclaw/state/shields-audit.jsonl` | `tail -f ~/.nemoclaw/state/shields-audit.jsonl` |

### Gateway (sandbox)

| Stream | Path inside pod | Category |
|---|---|---|
| OpenClaw inference gateway | `/tmp/gateway.log` | `gateway` |
| DNS proxy | `/tmp/dns-proxy.log` | `gateway` |
| Auto-pair (TUI ↔ gateway pairing) | `/tmp/auto-pair.log` | `gateway` |
| OpenClaw config (resolved) | `/sandbox/.openclaw/openclaw.json` | `gateway` |

### Cron + queue

| Stream | Path inside pod | Category |
|---|---|---|
| Cron run ledger (jsonl) | `/sandbox/.openclaw-data/queue/tasks.jsonl` | `cron` |
| Token budget snapshot | `/sandbox/.openclaw-data/budget.json` | `cron` |
| `openclaw cron list/runs` snapshots | (captured from CLI) | `cron` |
| Detached cron output (most recent 10) | `/tmp/chad-*-<TS>.log` | `cron` |
| **Agent inbox** (host-watchdog events → cron agent turns) | `/sandbox/.openclaw-data/state/agent-inbox.jsonl` | `cron` |

### Experiments (autonomous lifecycle, 2026-05-14+)

| Stream | Path inside pod | Category |
|---|---|---|
| Experiment config (budget, regression threshold, allowed types) | `/sandbox/.openclaw-data/state/experiments/config.json` | `experiments` |
| Append-only event log | `/sandbox/.openclaw-data/state/experiments/ledger.jsonl` | `experiments` |
| Active experiment records (one per running) | `/sandbox/.openclaw-data/state/experiments/active/<id>.json` | `experiments` |
| Archived experiment records (promoted/retired) | `/sandbox/.openclaw-data/state/experiments/archive/<id>.json` | `experiments` |

### Host-side watchdogs (logs live on the host, not the pod)

| Stream | Path on host | Category |
|---|---|---|
| Gateway watchdog | `~/.nemoclaw/openwebui/chad-gateway-watchdog.log` | `watchdog` |
| Shim watchdog | `~/.nemoclaw/openwebui/chad-shim-watchdog.log` | `watchdog` |
| Spawn-poll watchdog | `~/.nemoclaw/openwebui/chad-spawn-poll-watchdog.log` | `watchdog` |
| Tunnel | `/tmp/chad-tunnel.{out,err}.log` | `watchdog` |
| Per-launchd stdout/stderr | `~/.nemoclaw/openwebui/chad-*.{out,err}.log` | `watchdog` |

### Sub-agents

| Stream | Path inside pod | Category |
|---|---|---|
| Sub-agent run dirs (most recent 10) | `/sandbox/.openclaw-data/subagents/<id>/{result.json,stderr.log,stdout.log,prompt.txt}` | `subagent` |

### Memory + TUI ack

| Stream | Path inside pod | Category |
|---|---|---|
| Today's memory file | `/sandbox/.openclaw/workspace/memory/<UTC-date>.md` | `memory` |
| Yesterday's memory file | `/sandbox/.openclaw/workspace/memory/<UTC-date-1>.md` | `memory` |
| Feedback proposal queue | `/sandbox/.openclaw-data/memory/feedback-proposals.md` | `memory` |
| Mail-handled ledger | `/sandbox/.openclaw/workspace/state/mail-handled.jsonl` | `tui` |
| Shields audit (synced from host) | `~/.nemoclaw/state/shields-audit.jsonl` | `tui` |

### System

| Stream | Source | Category |
|---|---|---|
| `uname -a`, `df -h`, `free -h`, top `ps` | `chad-dump-logs` snapshot | `system` |
| `journalctl --no-pager -n N` (if available) | `chad-dump-logs` snapshot | `system` |

### Premium (Anthropic) ledger

| Stream | Path inside pod | Category |
|---|---|---|
| Premium call audit (jsonl) | `/tmp/chad-premium.jsonl` | `premium` |
| Current AuthContext blob | resolved via `chad-auth-context show` | `premium` |
| Per-message email AuthContext | `/sandbox/.openclaw-data/state/auth-context-mail/<msgid>.json` | `premium` |
| Per-issue github AuthContext | `/sandbox/.openclaw-data/state/auth-context-issue/issue-<n>.json` | `premium` |

## Redaction

`chad-dump-logs` and `dump-logs.sh` rewrite well-known secret shapes in place before tarballing:

- `sk-ant-…` (Anthropic)
- `nvapi-…` (NVIDIA)
- `github_pat_…`, `ghp_…` (GitHub)
- JSON keys named `apiKey`, `api_key`, `token`, `password`, `PROTON_PASSWORD`, `NEMOCLAW_INVOKER_TOKEN`

Pass `--no-redact` only when troubleshooting the redaction logic itself; redacted dumps are safe to attach to issues.

## Adding a new stream

1. Pick or add a category in `scripts/chad-cron-wrappers/chad-dump-logs`.
2. Use `copy_tail <category> <src>` for log files or `snapshot <category> <name> <command>` for command output.
3. Add a row to the inventory table above.
4. If the stream contains a new secret shape, extend the `redact()` regex in `chad-dump-logs` and the host `redact_inplace()` in `scripts/dump-logs.sh`.
