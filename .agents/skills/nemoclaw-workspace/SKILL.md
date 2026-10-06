---
name: "nemoclaw-workspace"
description: "Backs up and restores OpenClaw workspace files before destructive operations such as sandbox rebuilds. Use when downloading workspace files from a sandbox, uploading restored files into a new sandbox, or preserving sandbox state across rebuilds. Trigger keywords - nemoclaw backup, nemoclaw restore, workspace backup, openshell sandbox download upload, nemoclaw workspace files, soul.md, user.md, identity.md, agents.md, sandbox persistence."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Backup and Restore Workspace Files

Workspace files define your agent's personality, memory, and user context.
They persist across sandbox restarts but are **permanently deleted** when you run `nemoclaw <name> destroy`.

This guide covers five backup mechanisms; pick the one that matches the failure you're protecting against.

## Step 1: Pick the right mechanism

| Mechanism | Recovery scenario | Cadence | Storage |
|---|---|---|---|
| `nemoclaw <name> snapshot` | Pre-destroy or pre-rebuild snapshot, fastest path | Manual / before destroy | `~/.nemoclaw/rebuild-backups/<name>/` (host) |
| `scripts/backup-workspace.sh` | Cross-host migration, manifest-gap workaround, explicit file-list | Manual | `~/.nemoclaw/backups/<timestamp>/` (host) |
| `scripts/backup-host.sh` | Host laptop dies — onboard config, sandbox metadata, draft policies | Manual | `~/.nemoclaw/backups/host/<timestamp>/` (host) |
| `chad-backup-to-github.sh` (cron, Chad agent only) | Sandbox dies but the host is fine — continuous remote durability | Every 6h | `tantodefi/chad-state` GitHub repo (private) |
| `npm run chad:sync` / `scripts/chad-sync.sh` | One-command orchestrator: dump + push + cron audit | Manual / on-demand | Local dump + GitHub state repo |

**Rule of thumb:** for everyday "I'm about to destroy", use `nemoclaw snapshot`. For Chad specifically, `chad-sync` is the single command that wraps the dump, the GitHub push, and a cron-disk-vs-memory audit — use it before any pod reset and any time you've made meaningful changes you want durably stored. The two `scripts/backup-*.sh` helpers cover layers `snapshot` does not (host config, explicit file-list migrations).

The state list backed up by `backup-workspace.sh` and `chad-backup-to-github.sh` is canonical at `scripts/chad-workspace-files.txt`, which uses a sectioned manifest format (use the `nemoclaw-workspace` skill). Both scripts read it, so adding `MY-NEW-FILE.md` (or a runtime path under `[runtime]`) makes it automatically round-trip through both.

## Step 2: chad-sync — one-command snapshot orchestrator

`scripts/chad-sync.sh` (also exposed as `npm run chad:sync`) wraps the four moving parts of Chad's persistence pipeline into a single idempotent command:

1. **Local triage dump** — `chad-dump-state` snapshot saved to `~/.nemoclaw/dumps/state-<sandbox>-<timestamp>.md`. Local-only, never pushed; useful for diffing across resets.
2. **Push to chad-state** — runs `chad-backup-to-github` inside the sandbox, which pushes everything in the manifest's `[workspace]`, `[runtime]`, `[runtime-dirs]` sections plus the gbrain export.
3. **Cron audit** — compares cron jobs on disk (`cron/jobs.json`) against the gateway's in-memory list. A mismatch is the failure mode that silently dropped six cron jobs after a pod restart; surfacing it inline lets you run `ssh openshell-chad chad-cron-reload` to fix it without hunting.
4. **Summary** — file counts, dump path, and any errors.

```console
$ npm run chad:sync
==> chad-sync starting (sandbox='chad', state-repo='tantodefi/chad-state')
    ✓ ssh reachable
==> Capturing local triage dump
    ✓ dump saved → ~/.nemoclaw/dumps/state-chad-20260429T144500Z.md (218 lines)
==> Pushing state to tantodefi/chad-state
    ✓ Pushed 14 files, skipped 11 unchanged, 0 errors
==> Auditing cron jobs (disk vs gateway memory)
    ✓ cron jobs: 6 on disk = 6 in gateway
==> Sync complete
```

Useful flags:

```console
$ npm run chad:sync:dry              # show what would run, no remote calls
$ bash scripts/chad-sync.sh --no-dump  # skip the local dump (faster)
$ bash scripts/chad-sync.sh --sandbox foo  # target a non-default sandbox name
```

## Step 3: Restore: cold boot from chad-state

`chad-setup.sh` runs `chad-restore-from-github` automatically when no local backup is found in `~/.nemoclaw/backups/`. The restore script reads the same sectioned manifest as backup, so anything backed up rounds-trips back: workspace markdown, `memory/`, queue files, runtime state files, and the runtime directories.

After restoring `cron/jobs.json` to disk, the gateway's in-memory list is still empty — restoration to disk is necessary but not sufficient. The script then calls `chad-cron-reload`, which diffs `jobs.json` against `openclaw cron list --json` and re-registers any missing entries via `openclaw cron add`. Without this step, the sandbox boots back up with cron disabled silently.

If you ever observe "0 jobs in gateway, N on disk" without doing a full restore, run the helper directly:

```console
$ ssh openshell-chad 'chad-cron-reload'
[cron-reload] added: email-check
[cron-reload] added: workspace-backup
…
[cron-reload] added=6 skipped=0 errors=0
```

## Step 4: When to Back Up

- **Before running `nemoclaw <name> destroy`**
- Before major NemoClaw version upgrades
- Periodically, if you've invested time customizing your agent

## Step 5: Snapshot Commands

The fastest way to back up and restore sandbox state is with the built-in snapshot commands.
Snapshots capture all workspace state directories defined in the agent manifest and store them in `~/.nemoclaw/rebuild-backups/<name>/`.

```console
$ nemoclaw my-assistant snapshot create
$ nemoclaw my-assistant snapshot list
$ nemoclaw my-assistant snapshot restore
```

`snapshot list` prints a table of version, name, timestamp, and path. Versions (`v1`, `v2`, ..., `vN`) are computed from the timestamp order, so `vN` is always the newest snapshot.

To tag a snapshot with a human-readable label, pass `--name`:

```console
$ nemoclaw my-assistant snapshot create --name before-upgrade
```

To restore a specific snapshot instead of the latest, pass a version, name, or timestamp prefix:

```console
$ nemoclaw my-assistant snapshot restore v3
$ nemoclaw my-assistant snapshot restore before-upgrade
$ nemoclaw my-assistant snapshot restore 2026-04-14T
```

The `nemoclaw <name> rebuild` command uses the same snapshot mechanism automatically.
Snapshot restore accepts symlinks that resolve to NemoClaw-managed sandbox data paths such as `/sandbox/.openclaw-data/`.
Symlinks that point outside the known sandbox data paths are still rejected during extraction.
For full details, see the Commands reference (use the `nemoclaw-reference` skill).

## Step 6: Manual Backup

Use `openshell sandbox download` to copy files from the sandbox to your host.

```console
$ SANDBOX=my-assistant
$ BACKUP_DIR=~/.nemoclaw/backups/$(date +%Y%m%d-%H%M%S)
$ mkdir -p "$BACKUP_DIR"

$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/SOUL.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/USER.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/IDENTITY.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/AGENTS.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/MEMORY.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/memory/ "$BACKUP_DIR/memory/"
```

## Step 7: Manual Restore

Use `openshell sandbox upload` to push files back into a sandbox.

```console
$ SANDBOX=my-assistant
$ BACKUP_DIR=~/.nemoclaw/backups/20260320-120000  # pick a timestamp

$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/SOUL.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/USER.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/IDENTITY.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/AGENTS.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/MEMORY.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/memory/" /sandbox/.openclaw/workspace/memory/
```

## Step 8: Using the Backup Script

The repository includes a convenience script at `scripts/backup-workspace.sh`.

### Backup

```console
$ ./scripts/backup-workspace.sh backup my-assistant
Backing up workspace from sandbox 'my-assistant'...
Backup saved to /home/user/.nemoclaw/backups/20260320-120000/ (6 items)
```

### Restore

Restore from the most recent backup:

```console
$ ./scripts/backup-workspace.sh restore my-assistant
```

Restore from a specific timestamp:

```console
$ ./scripts/backup-workspace.sh restore my-assistant 20260320-120000
```

## Step 9: Verifying a Backup

List backed-up files to confirm completeness:

```console
$ ls -la ~/.nemoclaw/backups/20260320-120000/
AGENTS.md
IDENTITY.md
MEMORY.md
SOUL.md
USER.md
memory/
```

## Step 10: Multi-Agent Deployments

When OpenClaw is configured with multiple named agents, each agent has its own
workspace directory (`workspace-main/`, `workspace-support/`, `workspace-ops/`,
and so on — see Multi-Agent Deployments (use the `nemoclaw-workspace` skill)).

`nemoclaw <name> snapshot create` automatically discovers every `workspace-*/`
directory under the sandbox state tree and includes it in the snapshot bundle
alongside the default `workspace/`. `snapshot restore` re-applies the full
per-agent set. No manual per-workspace backup pattern is needed.

The sandbox entrypoint ensures every per-agent workspace is backed by the
persistent `.openclaw-data/` tree (via a symlink from
`.openclaw/workspace-<name>/`) so state also survives `openshell sandbox restart`.

### Shared files across agents

Files that operators typically want consistent across every per-agent workspace
(`AGENTS.md`, shared skills, common templates) are **not** synced automatically.
Each workspace is independent; changes in one don't propagate. Operators that
need this either copy the shared files explicitly to each workspace after
editing, or maintain a host-side sync layer. Tracking shared-file tooling
(shared mount, `workspaces list` command) in
[#1260](https://github.com/NVIDIA/NemoClaw/issues/1260).

## References

- **Load [references/workspace-files.md](references/workspace-files.md)** when users ask about `SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, or other workspace files, or when preparing to back up or restore workspace state. Explains what workspace personality and configuration files are, where they live, and how they persist across sandbox restarts.

## Related Skills

- `nemoclaw-reference` — Commands reference (use the `nemoclaw-reference` skill)
