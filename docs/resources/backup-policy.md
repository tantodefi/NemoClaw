<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Backup & Recovery Policy

This document defines what to back up, where it lives, how to protect it, and
how to recover from common failure modes. It covers **three distinct layers**:
host-side config, in-sandbox agent identity, and the source tree itself.

---

## 1. Architecture Overview — What Can Be Lost

NemoClaw state is spread across three isolation boundaries:

| Layer | Location | Persistence | Risk |
|-------|----------|-------------|------|
| **Host config** | `~/.nemoclaw/` | Local filesystem | Laptop loss, accidental `rm`, failed onboard |
| **Sandbox workspace** | `/sandbox/.openclaw/workspace/` inside OpenShell | Ephemeral container storage | Sandbox destroy, re-onboard, cluster reset |
| **Source tree** | `~/.nemoclaw/source/` (git) | Git repo | Force push, uncommitted changes in `tmp/` |

**The existing `backup-workspace.sh` only covers the sandbox layer.** This
policy closes the gap for host config and uncommitted work.

---

## 2. Critical File Inventory

### 2.1 Host-Side Files (`~/.nemoclaw/`)

| File | Contents | Priority | Recreatable? |
|------|----------|----------|--------------|
| `credentials.json` | API keys (NVIDIA, GitHub, Proton) | **CRITICAL** | No — manual re-entry required |
| `onboard-session.json` | Onboard wizard state, sandbox name, provider config, step progress | HIGH | Partially — re-running `nemoclaw onboard` regenerates |
| `sandboxes.json` | Sandbox metadata, GPU flags, applied policy presets | HIGH | Partially — sandbox names + policy lists needed |
| `config.json` | Inference endpoint, model, provider (created during onboard) | HIGH | Yes — re-onboard recreates |
| `state/nemoclaw.json` | lastRunId, blueprintVersion, migrationSnapshot | MEDIUM | Yes — plugin rebuilds on next run |

### 2.2 Sandbox Workspace Files (`/sandbox/.openclaw/workspace/`)

| File | Contents | Priority | Recreatable? |
|------|----------|----------|--------------|
| `IDENTITY.md` | Agent name, creature type, emoji, self-presentation | **CRITICAL** | No — defines agent persona |
| `SOUL.md` | Core personality, tone, behavioral rules | **CRITICAL** | No — defines agent behavior |
| `USER.md` | User preferences and context | HIGH | Partially — reflects evolving preferences |
| `AGENTS.md` | Multi-agent coordination, memory conventions, safety rules | HIGH | Partially — long iteration history |
| `MEMORY.md` | Curated long-term memory | **CRITICAL** | No — accumulated knowledge |
| `memory/*.md` | Daily session notes (YYYY-MM-DD.md) | HIGH | No — conversation history |

### 2.3 Policies & Blueprint (`source/nemoclaw-blueprint/`)

| Path | Contents | Priority |
|------|----------|----------|
| `blueprint.yaml` | Profile definitions (default, ncp, nim-local, vllm) | HIGH |
| `policies/openclaw-sandbox.yaml` | Base sandbox policy (filesystem, process, network) | HIGH |
| `policies/presets/*.yaml` | 15 network policy presets (agent-browser, github-tools, etc.) | HIGH |

### 2.4 Skills (`reference-skills/`, `tmp/`)

| Path | Contents | Priority |
|------|----------|----------|
| `~/.nemoclaw/reference-skills/nemoclaw/` | 10 nemoclaw reference skills | MEDIUM (regenerable from docs) |
| `~/.nemoclaw/reference-skills/openshell/` | 17 openshell reference skills | MEDIUM (regenerable from docs) |
| `~/.nemoclaw/tmp/proton-calendar-skill/` | WIP Go skill (not in git) | **HIGH** — only copy |
| `~/.nemoclaw/tmp/my-assistant-policy.yaml` | Draft policy (not in git) | HIGH — only copy |
| `~/.nemoclaw/tmp/start-gateway.sh` | Gateway test script | LOW |

### 2.5 Plugin & Onboard Config

| File | Contents | Priority |
|------|----------|----------|
| `source/nemoclaw/openclaw.plugin.json` | Plugin ID, version, configSchema | HIGH (in git) |
| `source/bin/lib/onboard.js` | Onboard wizard — 7-step orchestrator | HIGH (in git) |

---

## 3. Backup Strategy

### 3.1 Automated Host-Side Backup (NEW)

The existing `scripts/backup-workspace.sh` handles sandbox-side files. A
**companion script** should handle the host side:

```bash
#!/usr/bin/env bash
# backup-host.sh — Back up ~/.nemoclaw/ host-side state
set -euo pipefail

NEMOCLAW_HOME="${HOME}/.nemoclaw"
BACKUP_BASE="${NEMOCLAW_HOME}/backups/host"
ts="$(date +%Y%m%d-%H%M%S)"
dest="${BACKUP_BASE}/${ts}"

mkdir -p "$dest"
chmod 0700 "$dest"

# --- Critical: credentials & session state ---
for f in credentials.json onboard-session.json sandboxes.json config.json; do
  [ -f "${NEMOCLAW_HOME}/${f}" ] && cp -p "${NEMOCLAW_HOME}/${f}" "${dest}/"
done

# --- State directory ---
[ -d "${NEMOCLAW_HOME}/state" ] && cp -rp "${NEMOCLAW_HOME}/state" "${dest}/state"

# --- WIP files in tmp/ (not in git) ---
[ -d "${NEMOCLAW_HOME}/tmp" ] && cp -rp "${NEMOCLAW_HOME}/tmp" "${dest}/tmp"

# --- Reference skills (regenerable but slow) ---
[ -d "${NEMOCLAW_HOME}/reference-skills" ] && \
  cp -rp "${NEMOCLAW_HOME}/reference-skills" "${dest}/reference-skills"

chmod -R go-rwx "$dest"

echo "[backup-host] Saved to ${dest}/"

# --- Prune backups older than 30 days ---
find "$BACKUP_BASE" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

### 3.2 Full Backup Workflow (Host + Sandbox)

Run both scripts together:

```bash
# Back up host-side config
bash scripts/backup-host.sh

# Back up sandbox workspace (requires running sandbox)
bash scripts/backup-workspace.sh backup <sandbox-name>
```

### 3.3 Git-Based Protection for Source Tree

The `source/` directory is a git repo. Ensure:

1. **Commit policy presets immediately** after creating/modifying them:
   ```bash
   git add nemoclaw-blueprint/policies/presets/
   git commit -m "chore(policies): update network presets"
   ```

2. **Never leave WIP skills only in `tmp/`** — promote to source:
   ```bash
   # Once stable, move skill into the source tree
   cp -r ~/.nemoclaw/tmp/proton-calendar-skill/ \
     source/nemoclaw-blueprint/skills/proton-calendar/
   git add nemoclaw-blueprint/skills/
   ```

3. **Tag releases** before destructive operations (re-onboard, cluster reset).

---

## 4. Recovery Procedures

### 4.1 Lost Credentials (`credentials.json`)

**Symptoms:** `nemoclaw` CLI fails with authentication errors; skills can't reach
external APIs.

**Recovery:**
1. Check host backups: `ls ~/.nemoclaw/backups/host/*/credentials.json`
2. Restore the most recent: `cp ~/.nemoclaw/backups/host/<latest>/credentials.json ~/.nemoclaw/`
3. Fix permissions: `chmod 600 ~/.nemoclaw/credentials.json`
4. If no backup exists, re-enter credentials manually:
   ```bash
   nemoclaw credentials set NVIDIA_API_KEY <key>
   nemoclaw credentials set GITHUB_TOKEN <token>
   nemoclaw credentials set PROTON_USERNAME <user>
   nemoclaw credentials set PROTON_PASSWORD <pass>
   ```

### 4.2 Lost Agent Identity (Sandbox Destroyed)

**Symptoms:** Sandbox re-created but agent has no personality, memory, or
preferences.

**Recovery:**
1. Check sandbox backups: `ls ~/.nemoclaw/backups/`
2. Restore: `bash scripts/backup-workspace.sh restore <sandbox-name> [timestamp]`
3. If no backup exists, reconstruct from:
   - `IDENTITY.md` / `SOUL.md` — must be rewritten (check chat history for
     agent personality descriptions)
   - `MEMORY.md` — lost permanently unless saved elsewhere
   - `memory/*.md` — daily notes are gone

**Prevention:** Run `backup-workspace.sh backup <name>` **before** any
`openshell sandbox destroy` or `nemoclaw onboard --force`.

### 4.3 Lost Onboard Session

**Symptoms:** `nemoclaw onboard` can't resume; asks to start fresh.

**Recovery:**
1. Restore from host backup: `cp ~/.nemoclaw/backups/host/<latest>/onboard-session.json ~/.nemoclaw/`
2. Or re-run onboard: `nemoclaw onboard` (safe but takes time)

### 4.4 Lost Policies (Blueprint Overwritten)

**Symptoms:** Sandbox network access broken after re-onboard; skills can't reach
APIs.

**Recovery:**
1. If in git: `git checkout -- nemoclaw-blueprint/policies/`
2. If custom presets were in `tmp/`: restore from host backup
3. Reapply policies:
   ```bash
   nemoclaw policies apply <sandbox-name>
   ```

### 4.5 Lost WIP Skills (`tmp/` Deleted)

**Symptoms:** Proton calendar skill, draft policies, test scripts gone.

**Recovery:**
1. Check host backups: `ls ~/.nemoclaw/backups/host/*/tmp/`
2. Restore: `cp -r ~/.nemoclaw/backups/host/<latest>/tmp/ ~/.nemoclaw/tmp/`

**Prevention:** Commit WIP skills to git or move them into the source tree once
they're functional.

---

## 5. Common Mistakes to Avoid

### 5.1 Destroying a sandbox without backing up workspace files

**What happens:** IDENTITY.md, SOUL.md, MEMORY.md, all daily notes — gone.
Agent personality and accumulated knowledge are irrecoverable.

**Rule:** Always run `backup-workspace.sh backup <name>` before sandbox
destroy or re-onboard.

### 5.2 Leaving custom work only in `tmp/`

**What happens:** `tmp/` is not tracked by git. A `git clean -fdx`, accidental
delete, or disk failure destroys the only copy.

**Rule:** Promote any skill, policy, or script that took >30 minutes to build
into the git-tracked source tree. Keep `tmp/` for throwaway experiments only.

### 5.3 Editing policies/presets without committing

**What happens:** `nemoclaw onboard --force` regenerates from the blueprint.
Uncommitted preset changes are overwritten.

**Rule:** `git add` and `git commit` policy changes immediately.

### 5.4 Re-running onboard without checking session state

**What happens:** `onboard-session.json` is overwritten. Previous sandbox name,
provider config, and step history are lost.

**Rule:** Back up `onboard-session.json` before re-onboard, or note the sandbox
name and applied policies.

### 5.5 Assuming credentials survive inside the sandbox

**What happens:** `credentials.json` is on the **host only**. It is NOT
synced into the sandbox. Skills that need credentials (proton-calendar) load
from `~/.nemoclaw/credentials.json` inside the sandbox, which may not exist.

**Rule:** After sandbox creation, verify credential availability inside the
sandbox. If needed, use `openshell sandbox connect` to inject credentials.

### 5.6 Forgetting that reference-skills are regenerable but slow

**What happens:** The `docs-to-skills.py` pipeline regenerates skills from
`docs/`, but the output depends on the current docs state. If docs change,
old skills are gone.

**Rule:** Keep a host backup of `reference-skills/` as a timestamp snapshot.
Regeneration command:
```bash
python3 scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw
```

### 5.7 Not backing up before cluster/infra changes

**What happens:** `openshell` cluster resets, Brev instance teardowns, or
Kubernetes reconfigurations can destroy sandbox state without warning.

**Rule:** Run the full backup (host + sandbox) before any infrastructure
operation.

---

## 6. Backup Schedule Recommendation

| Action | Frequency | Trigger |
|--------|-----------|---------|
| `backup-host.sh` | Daily (or before any onboard/destroy) | Manual or launchd/cron |
| `backup-workspace.sh backup <name>` | Before sandbox destroy, weekly | Manual |
| `git push` on source tree | After every policy/skill change | Manual |
| Credential rotation | Quarterly | Manual — update `credentials.json` then back up |

### Optional: macOS launchd Periodic Backup

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nemoclaw.backup-host</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>~/.nemoclaw/source/scripts/backup-host.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>2</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
</dict>
</plist>
```

Save to `~/Library/LaunchAgents/com.nemoclaw.backup-host.plist` and load:
```bash
launchctl load ~/Library/LaunchAgents/com.nemoclaw.backup-host.plist
```

---

## 7. File Permissions Reference

| Path | Mode | Owner | Notes |
|------|------|-------|-------|
| `~/.nemoclaw/` | 700 | user | Top-level directory |
| `credentials.json` | 600 | user | Contains secrets — never group/world readable |
| `backups/` | 700 | user | Backup destination |
| `backups/host/*/` | 700 | user | Individual backup snapshots |
| `state/` | 700 | user | Runtime state |

---

## 8. Upstream Sync & Fork-to-Sandbox Flow

NemoClaw is maintained as a fork of `NVIDIA/NemoClaw`. Changes flow through
three stages: **upstream repo → local fork → sandbox image**.

### 8.1 The Propagation Chain

```text
NVIDIA/NemoClaw (upstream/main)
        │
        │  git fetch upstream && git rebase upstream/main
        ▼
tantodefi/NemoClaw (origin/chad-dev)   ← your fork
        │
        │  nemoclaw onboard --recreate-sandbox
        │  (Docker build → image push → pod restart)
        ▼
OpenShell Sandbox (running pod)
        │
        │  setup-skills.sh (SSH post-creation)
        ▼
Live Agent (cron jobs, email checks, skills)
```

### 8.2 Syncing Upstream Changes

Run this when NVIDIA publishes new releases or fixes:

```bash
cd ~/.nemoclaw/source

# 1. Safety net — always create before rebase
git branch chad-dev-backup-$(date +%Y%m%d) && git tag pre-rebase-$(date +%Y%m%d)

# 2. Fetch and rebase
git fetch upstream
git rebase upstream/main

# 3. Resolve any conflicts, then push
git push origin chad-dev --force-with-lease
```

**Revert** if the rebase introduces problems:
```bash
git reset --hard pre-rebase-YYYYMMDD
git push origin chad-dev --force-with-lease
```

**Note:** Use `--force-with-lease` (not `--force`) — it refuses to push if
someone else pushed to `chad-dev` since your last fetch.

### 8.3 What Requires a Full Rebuild vs. Hot-Sync

| Change type | Propagation | Command |
|-------------|-------------|---------|
| Plugin code (`nemoclaw/src/`) | **Full image rebuild** | `nemoclaw onboard --recreate-sandbox` |
| Blueprint / base policies | **Full image rebuild** | `nemoclaw onboard --recreate-sandbox` |
| Startup script (`nemoclaw-start.sh`) | **Full image rebuild** | `nemoclaw onboard --recreate-sandbox` |
| `openclaw.json` (inference config) | **Immutable** — baked at build | Rebuild required |
| Skill tools (proton-tool, pi, etc.) | **SSH re-run** (no rebuild) | Re-run `setup-skills.sh` via sandbox connect |
| Skill definitions (SKILL.md, EMAIL-POLICY.md) | **SSH upload** (no rebuild) | `openshell sandbox upload <name> <local> <remote>` |
| Policy presets | **CLI apply** (no rebuild) | `nemoclaw <name> policy-add` |
| Inference provider / model | **Gateway-level** (no rebuild) | `openshell inference set` |

### 8.4 Recommended Dev Workflow

```text
┌─────────────────────────────────────────────────────────────┐
│  DAILY: iterate on skills                                    │
│  1. Edit skill files locally (SKILL.md, EMAIL-POLICY.md)     │
│  2. Upload to sandbox: openshell sandbox upload ...           │
│  3. Test via cron run or manual /nemoclaw command             │
│  4. git commit once stable                                   │
├─────────────────────────────────────────────────────────────┤
│  WEEKLY: sync upstream + rebuild                             │
│  1. bash scripts/backup-host.sh                              │
│  2. bash scripts/backup-workspace.sh backup <name>           │
│  3. git fetch upstream && git rebase upstream/main            │
│  4. git push origin chad-dev --force-with-lease              │
│  5. nemoclaw onboard --recreate-sandbox (if plugin changed)  │
│  6. Re-apply custom policies                                 │
├─────────────────────────────────────────────────────────────┤
│  BEFORE adding collaborators (e.g., supachad)                │
│  1. Switch shared branches to merge (no rebase)              │
│  2. Protect chad-dev from force-push in GitHub settings      │
│  3. Create feature branches for individual work              │
│  4. PR into chad-dev for code review                         │
└─────────────────────────────────────────────────────────────┘
```

### 8.5 Multi-Contributor Flow (Future: supachad)

When a second contributor joins:

1. **Invite** via GitHub → Settings → Collaborators
2. **Branch strategy:** `chad-dev` becomes the shared integration branch.
   Create feature branches (`feat/proton-calendar-v2`, `fix/cron-rate-limit`)
   and PR into `chad-dev`.
3. **No force-push** on shared branches — use `git merge upstream/main`
   instead of rebase.
4. **Sandbox isolation:** Each contributor runs their own sandbox.
   Sandbox images are built from the branch they check out.
5. **Credential separation:** Each contributor maintains their own
   `~/.nemoclaw/credentials.json`. Never commit credentials to the repo.

---

## 9. Quick Reference Card

```text
┌──────────────────────────────────────────────────────────────────────┐
│  BEFORE YOU DO THIS...            RUN THIS FIRST                     │
├──────────────────────────────────────────────────────────────────────┤
│  nemoclaw onboard --force         backup-host.sh                     │
│                                   backup-workspace.sh backup <name>  │
│  openshell sandbox destroy        backup-workspace.sh backup <name>  │
│  git clean / git reset --hard     git stash && backup-host.sh        │
│  Cluster reset / Brev teardown    both backup scripts                │
│  Edit a policy preset             git add + git commit first         │
│  Rotate API keys                  backup-host.sh then update creds   │
│  git rebase upstream/main         git branch backup-$(date +%Y%m%d)  │
│                                   git tag pre-rebase-$(date +%Y%m%d) │
│  Add collaborator to fork         Switch to merge workflow (no force)│
└──────────────────────────────────────────────────────────────────────┘
```
