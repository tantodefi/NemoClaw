#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-setup.sh — Full post-reset setup for the Chad sandbox.
#
# Run this after any sandbox reset or fresh onboard to bring Chad back to a
# known-good operating state. Steps:
#   1. Restore workspace files (SOUL/USER/IDENTITY/MEMORY + memory logs)
#   2. Sync skill directories into the sandbox
#   3. Deploy credentials (PROTON_*, GITHUB_TOKEN, BRAVE_API_KEY)
#   4. Authenticate gh CLI using GITHUB_TOKEN
#   5. Re-register cron jobs
#
# proton-tool is now baked into the sandbox image at /usr/local/bin/proton-tool.
# No binary deploy step is needed — it's present after every build.
#
# This script is the canonical source of truth for Chad's runtime config.
# Every cron job and credential path lives here — not in the sandbox's internal
# state — so a reset is a one-command recovery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SANDBOX="${1:-chad}"
REMOTE_HOST="openshell-${SANDBOX}"
CREDENTIALS_SRC="${HOME}/.nemoclaw/credentials.json"
BACKUP_BASE="${HOME}/.nemoclaw/backups"
CHAD_STATE_REPO="${CHAD_STATE_REPO:-tantodefi/chad-state}"
CHAD_SOURCE_REPO="${CHAD_SOURCE_REPO:-tantodefi/NemoClaw}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}==>${NC} $1"; }
info() { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} $1"; }
fail() { echo -e "${RED}[setup]${NC} $1" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [sandbox-name] [options]

Arguments:
  sandbox-name   Target sandbox (default: chad)

Options:
  --skip-restore      Skip workspace restore step (use if sandbox already has memory)
  --skip-skills       Skip skill sync
  --skip-creds        Skip credential deployment
  --skip-gh-auth      Skip gh authentication
  --skip-crons        Skip cron job registration
  --skip-clone-source Skip cloning Chad's own source into the sandbox
  --dry-run           Print steps without executing them
  -h, --help          Show this help

What this does:
  1. Restores workspace from latest local backup (~/.nemoclaw/backups/),
     falling back to ${CHAD_STATE_REPO}@main (github) if no local backup exists
  2. Syncs .github/skills/ into the sandbox
  3. Deploys credentials (PROTON_*, GITHUB_TOKEN, BRAVE_API_KEY) to sandbox
  4. Authenticates gh CLI using GITHUB_TOKEN
  5. Clones Chad's source (${CHAD_SOURCE_REPO}) into /sandbox/source for
     local read/grep access
  6. Registers the email-check and workspace-backup cron jobs

proton-tool, gh, and chad-{backup,restore,clone}-* helpers are baked into
the image — no post-create deploy step needed for binaries or scripts.

Run after: sandbox reset, nemoclaw destroy+recreate, or fresh onboard.
EOF
  exit 0
}

skip_restore=0
skip_skills=0
skip_creds=0
skip_gh_auth=0
skip_crons=0
skip_clone_source=0
skip_gbrain=0
dry_run=0

for arg in "${@:2}"; do
  case "$arg" in
    --skip-restore)      skip_restore=1 ;;
    --skip-skills)       skip_skills=1 ;;
    --skip-creds)        skip_creds=1 ;;
    --skip-gh-auth)      skip_gh_auth=1 ;;
    --skip-crons)        skip_crons=1 ;;
    --skip-clone-source) skip_clone_source=1 ;;
    --skip-gbrain)       skip_gbrain=1 ;;
    --dry-run)           dry_run=1 ;;
    -h|--help)           usage ;;
    *) fail "Unknown argument: $arg" ;;
  esac
done

run() {
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# ── Step 1: Restore workspace (local backups) ─────────────────────────────
#
# Tries ~/.nemoclaw/backups/ first. If none exist, we leave a flag so a
# later step (after credentials are deployed) can try restoring from the
# chad-state GitHub repo as a disaster-recovery fallback.

local_restore_done=0

if [ "$skip_restore" -eq 0 ]; then
  step "Restoring workspace files to '${SANDBOX}' (local backup)"
  if [ ! -f "${SCRIPT_DIR}/backup-workspace.sh" ]; then
    warn "backup-workspace.sh not found — will try github fallback"
  elif [ ! -d "$BACKUP_BASE" ] || [ -z "$(ls -A "$BACKUP_BASE" 2>/dev/null)" ]; then
    info "No local backups in ${BACKUP_BASE} — will try github fallback"
  else
    if [ "$dry_run" -eq 1 ]; then
      echo "  [dry-run] bash ${SCRIPT_DIR}/backup-workspace.sh restore $SANDBOX"
      local_restore_done=1
    else
      if bash "${SCRIPT_DIR}/backup-workspace.sh" restore "$SANDBOX"; then
        local_restore_done=1
      else
        warn "Local restore failed — will try github fallback"
      fi
    fi
  fi
else
  info "Skipping workspace restore (--skip-restore)"
  local_restore_done=1  # treat as "don't try the fallback either"
fi

# ── Step 2: Sync skills ────────────────────────────────────────────────────

if [ "$skip_skills" -eq 0 ]; then
  step "Syncing skills to '${SANDBOX}'"
  sync_script="${REPO_ROOT}/.github/skills/chad-bug-intake/scripts/sync-skills-to-sandbox.sh"
  if [ -f "$sync_script" ]; then
    # No --build-proton: proton-tool is baked into the image at /usr/local/bin/proton-tool
    run bash "$sync_script" "$SANDBOX" proton-calendar chad-bug-intake chad-orchestrator
  else
    warn "sync-skills-to-sandbox.sh not found — skipping skill sync"
  fi
else
  info "Skipping skill sync (--skip-skills)"
fi

# ── Step 3: Deploy credentials ─────────────────────────────────────────────
#
# The sandbox has no access to host credentials at runtime. This step writes
# a filtered credentials file to /sandbox/.nemoclaw/credentials.json so
# proton-tool and other tools can read PROTON_* and service tokens.
#
# Keys deployed: PROTON_USERNAME, PROTON_PASSWORD, GITHUB_TOKEN, BRAVE_API_KEY
# Keys NOT deployed: NVIDIA_API_KEY (managed by OpenClaw inference config)

if [ "$skip_creds" -eq 0 ]; then
  step "Deploying credentials to '${SANDBOX}'"

  [ -f "$CREDENTIALS_SRC" ] || fail "Host credentials not found: ${CREDENTIALS_SRC}"

  sandbox_creds="$(python3 -c "
import json, sys
src = json.load(open('${CREDENTIALS_SRC}'))
keep = ['PROTON_USERNAME', 'PROTON_PASSWORD', 'GITHUB_TOKEN', 'BRAVE_API_KEY']
out = {k: src[k] for k in keep if k in src}
print(json.dumps(out, indent=2))
")"

  if [ -z "$sandbox_creds" ] || [ "$sandbox_creds" = "{}" ]; then
    warn "No deployable credentials found in ${CREDENTIALS_SRC} — skipping"
  else
    if [ "$dry_run" -eq 1 ]; then
      echo "  [dry-run] Would deploy credentials: $(echo "$sandbox_creds" | python3 -c "import json,sys; print(list(json.load(sys.stdin).keys()))")"
    else
      # Write via SSH stdin — avoids secrets on the command line and prevents
      # openshell-upload from creating a directory instead of a file when the
      # destination path doesn't exist yet.
      echo "$sandbox_creds" | ssh "$REMOTE_HOST" \
        'cat > /sandbox/.nemoclaw/credentials.json && chmod 600 /sandbox/.nemoclaw/credentials.json'
      info "Credentials deployed to /sandbox/.nemoclaw/credentials.json"
    fi
  fi
else
  info "Skipping credential deployment (--skip-creds)"
fi

# ── Step 3a: Initialise / restore gbrain ──────────────────────────────────
#
# gbrain stores its PGLite brain at GBRAIN_DIR=/sandbox/.openclaw-data/gbrain/
# (set in the Dockerfile ENV). After a reset the directory exists but may be
# empty. `gbrain init` is idempotent — it applies any pending migrations and
# is safe to run against an existing populated brain.
# If a brain backup was included in the chad-state GitHub restore, init is
# still needed to verify the schema version and apply any new migrations.

if [ "$skip_gbrain" -eq 0 ]; then
  step "Initialising gbrain in '${SANDBOX}'"
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] ssh $REMOTE_HOST 'gbrain init 2>/dev/null || true'"
    echo "  [dry-run] ssh $REMOTE_HOST 'gbrain doctor 2>&1 | tail -5'"
  else
    if ssh "$REMOTE_HOST" 'command -v gbrain >/dev/null 2>&1'; then
      ssh "$REMOTE_HOST" 'gbrain init 2>/dev/null || true'
      gbrain_status="$(ssh "$REMOTE_HOST" 'gbrain doctor 2>&1 | tail -3')"
      info "gbrain init done: ${gbrain_status}"
    else
      warn "gbrain not found in sandbox — skipping brain init (image may need rebuild)"
    fi
  fi
else
  info "Skipping gbrain init (--skip-gbrain)"
fi

# ── Step 4: Authenticate gh ───────────────────────────────────────────────

if [ "$skip_gh_auth" -eq 0 ]; then
  step "Authenticating gh CLI in '${SANDBOX}'"

  GITHUB_TOKEN="$(python3 -c "
import json
try:
    d = json.load(open('${CREDENTIALS_SRC}'))
    print(d.get('GITHUB_TOKEN', ''))
except Exception:
    print('')
" 2>/dev/null)"

  if [ -z "$GITHUB_TOKEN" ]; then
    warn "GITHUB_TOKEN not found in credentials.json — gh auth skipped"
    warn "Run manually: echo \$GITHUB_TOKEN | nemoclaw ${SANDBOX} exec -- gh auth login --git-protocol https --with-token"
  else
    if [ "$dry_run" -eq 1 ]; then
      echo "  [dry-run] Would run: echo <token> | gh auth login --git-protocol https --with-token"
    else
      echo "$GITHUB_TOKEN" | ssh "$REMOTE_HOST" 'gh auth login --git-protocol https --with-token'
      info "gh authenticated ($(ssh "$REMOTE_HOST" 'gh auth status 2>&1 | head -1'))"
    fi
  fi
else
  info "Skipping gh auth (--skip-gh-auth)"
fi

# ── Step 4a: Fallback restore from chad-state GitHub repo ─────────────────
#
# If the local restore had nothing to apply, ask the sandbox to pull the
# latest snapshot from ${CHAD_STATE_REPO}@main via the baked-in helper.
# This is the disaster-recovery path (host disk loss, fresh machine, etc.)
# and is a no-op if the chad-state repo doesn't exist yet.

if [ "$skip_restore" -eq 0 ] && [ "$local_restore_done" -eq 0 ]; then
  step "Falling back to github restore from '${CHAD_STATE_REPO}'"
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] ssh $REMOTE_HOST 'chad-restore-from-github'"
  else
    if ssh "$REMOTE_HOST" 'chad-restore-from-github' 2>&1; then
      info "Github restore complete"
    else
      warn "Github restore failed or had nothing to restore — continuing"
      warn "This is expected for a brand-new setup with no prior backups"
    fi
  fi
fi

# ── Step 4b: Clone Chad's own source for read access ─────────────────────

if [ "$skip_clone_source" -eq 0 ]; then
  step "Cloning Chad's source (${CHAD_SOURCE_REPO}) into '${SANDBOX}'"
  if [ "$dry_run" -eq 1 ]; then
    echo "  [dry-run] ssh $REMOTE_HOST 'chad-clone-source'"
  else
    if ssh "$REMOTE_HOST" "CHAD_SOURCE_REPO='${CHAD_SOURCE_REPO}' chad-clone-source" 2>&1; then
      info "Source clone complete"
    else
      warn "Source clone failed — Chad will not be able to read its own code"
    fi
  fi
else
  info "Skipping source clone (--skip-clone-source)"
fi

# ── Step 5: Register cron jobs ─────────────────────────────────────────────
#
# nemoclaw CLI has no `exec` action, so we run `openclaw cron add` over ssh.
# The --message strings contain both single and double quotes, which is too
# fragile to pass as a command-line argument. Instead we base64-encode each
# message locally and decode it on the remote side via `$(echo ... | base64
# -d)` — this keeps the message literal regardless of quoting.

if [ "$skip_crons" -eq 0 ]; then
  step "Registering cron jobs in '${SANDBOX}'"

  existing_crons="$(ssh "$REMOTE_HOST" 'openclaw cron list' 2>/dev/null || echo "")"

  # Email-check message is deliberately terse. The detailed step-by-step
  # used to live in this string (~1300 chars tokenized every cron fire);
  # it now lives in EMAIL-POLICY.md alongside the rules. Terse message
  # + reference saves ~25k tokens/day at the new daytime-hourly cadence.
  # The budget guard at the top short-circuits the whole run when
  # remaining tokens are below 30000, so a bad day can't drain the pool.
  email_check_message='Run mail check. First: `chad-budget show --field remaining_tokens` — if <30000, append "## Mail check skipped (low budget)" to memory/<today-UTC>.md and exit. Otherwise follow EMAIL-POLICY.md from the workspace root. Always log follow-ups and awaiting responses to memory/<today-UTC>.md.'

  workspace_backup_message='Run workspace backup. Execute /usr/local/bin/chad-backup-to-github and capture its stdout+stderr. On success (exit 0), append a "## Workspace Backup" section to memory/<today-UTC>.md with the timestamp and the reported file count. On failure (non-zero exit), append the same section with the error output and flag it as "BACKUP FAILED" so the next cron run sees it.'

  # Daily issue triage: reads open issues from $CHAD_BUG_REPO, scores
  # them, routes top 2 through a researcher sub-agent. Budget-guarded
  # (will skip when <40% remaining). Runs at 10:00 UTC so the human
  # triage from the previous afternoon has time to land reactions/labels.
  issue_triage_message='Run `chad-issue-triage --top 2` and log its output to memory/<today-UTC>.md under "## Issue triage". Do not manually review the issues — the helper handles budget checks and spawning. If it reports "no issues with positive score", that is the expected quiet-day state.'

  # Weekly self-improvement: scans failed spawns + feedback memory,
  # spawns a researcher with a "propose 1-3 improvements" task. Runs
  # Sunday 03:00 UTC when the inbox is quiet and budget is fresh.
  self_improve_message='Run `chad-self-improve --days 7` and log its output to memory/<today-UTC>.md under "## Self-improvement". Do NOT apply the proposals — they land in memory/feedback-proposals.md for review on a later wake. If the helper reports "skipped: budget too low", note it and move on.'

  register_cron_via_ssh() {
    local name="$1"
    local schedule="$2"
    local extra_flags="$3"
    local message="$4"
    # base64 without newlines (-w0 on Linux; macOS base64 has no newlines by default)
    local b64
    if base64 --help 2>&1 | grep -q -- '-w'; then
      b64="$(printf '%s' "$message" | base64 -w0)"
    else
      b64="$(printf '%s' "$message" | base64 | tr -d '\n')"
    fi
    if [ "$dry_run" -eq 1 ]; then
      echo "  [dry-run] ssh $REMOTE_HOST 'openclaw cron add --name $name --cron \"$schedule\" --session isolated $extra_flags --message <base64 decoded>'"
      return 0
    fi
    # shellcheck disable=SC2029
    ssh "$REMOTE_HOST" "msg=\"\$(echo '$b64' | base64 -d)\" && openclaw cron add --name '$name' --cron '$schedule' --session isolated $extra_flags --message \"\$msg\""
  }

  # Email-check: hourly during daytime UTC (06:00–23:00) + one overnight
  # sweep at 02:00. 19 runs/day instead of the old 48 × */30 schedule —
  # ~60% fewer cron fires, and each fire is itself much cheaper thanks
  # to the terser message above.
  if echo "$existing_crons" | grep -q "email-check"; then
    warn "email-check cron already registered — skipping"
  else
    info "Registering email-check cron (hourly 06-23 UTC + 02:00 overnight)"
    register_cron_via_ssh "email-check" "0 2,6-23 * * *" "--announce --channel last" "$email_check_message"
  fi

  if echo "$existing_crons" | grep -q "workspace-backup"; then
    warn "workspace-backup cron already registered — skipping"
  else
    info "Registering workspace-backup cron (every 6 hours)"
    register_cron_via_ssh "workspace-backup" "0 */6 * * *" "" "$workspace_backup_message"
  fi

  if echo "$existing_crons" | grep -q "issue-triage"; then
    warn "issue-triage cron already registered — skipping"
  else
    info "Registering issue-triage cron (daily 10:00 UTC)"
    register_cron_via_ssh "issue-triage" "0 10 * * *" "" "$issue_triage_message"
  fi

  if echo "$existing_crons" | grep -q "self-improve"; then
    warn "self-improve cron already registered — skipping"
  else
    info "Registering self-improve cron (weekly Sun 03:00 UTC)"
    register_cron_via_ssh "self-improve" "0 3 * * 0" "" "$self_improve_message"
  fi

  # GBrain nightly dream cycle: embed stale pages, extract entity links, run
  # doctor. Runs at 03:30 UTC (after self-improve) so the brain is fresh each
  # morning. Budget-guarded by gbrain itself — safe to run even on low-token days.
  gbrain_dream_message='Run gbrain maintenance: `gbrain embed --stale` then `gbrain doctor`. Log summary to memory/<today-UTC>.md under "## Brain maintenance". If doctor reports errors, flag them for human review.'

  if echo "$existing_crons" | grep -q "gbrain-dream"; then
    warn "gbrain-dream cron already registered — skipping"
  else
    info "Registering gbrain-dream cron (nightly 03:30 UTC)"
    register_cron_via_ssh "gbrain-dream" "30 3 * * *" "" "$gbrain_dream_message"
  fi

  info "Cron jobs registered"
else
  info "Skipping cron registration (--skip-crons)"
fi

# ── Done ───────────────────────────────────────────────────────────────────

step "Setup complete for sandbox '${SANDBOX}'"
echo ""
echo "  Verify:"
echo "    ssh ${REMOTE_HOST} '/usr/local/bin/proton-tool --help 2>&1 | head -3'"
echo "    ssh ${REMOTE_HOST} 'gh auth status'"
echo "    ssh ${REMOTE_HOST} 'openclaw cron list'"
echo "    ssh ${REMOTE_HOST} 'ls /sandbox/source/.github/skills/ 2>/dev/null && echo ok'"
echo "    ssh ${REMOTE_HOST} 'gbrain doctor'"
echo ""
echo "  Test the backup pipeline manually:"
echo "    ssh ${REMOTE_HOST} 'chad-backup-to-github'"
echo ""
echo "  One-time repo bootstrap (if ${CHAD_STATE_REPO} does not exist yet):"
echo "    gh repo create ${CHAD_STATE_REPO} --private \\"
echo "      --description 'Chad workspace state backups'"
echo ""
echo "  If local workspace restore failed:"
echo "    bash scripts/backup-workspace.sh restore ${SANDBOX}"
