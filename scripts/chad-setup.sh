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
fail() {
  echo -e "${RED}[setup]${NC} $1" >&2
  exit 1
}

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
  --skip-gbrain       Skip gbrain CLI configuration
  --skip-policies     Skip L7 policy preset registration
  --dry-run           Print steps without executing them
  -h, --help          Show this help

What this does:
  1. Restores workspace from latest local backup (~/.nemoclaw/backups/),
     falling back to ${CHAD_STATE_REPO}@main (github) if no local backup exists
  2. Syncs .github/skills/ into the sandbox
  3. Deploys credentials (PROTON_*, GITHUB_TOKEN, BRAVE_API_KEY, NVIDIA_API_KEY,
     ANTHROPIC_API_KEY, NEMOCLAW_INVOKER_TOKEN) to sandbox
  4. Authenticates gh CLI using GITHUB_TOKEN
  5. Clones Chad's source (${CHAD_SOURCE_REPO}) into /sandbox/source for
     local read/grep access
  6. Registers six cron jobs (email-check, workspace-backup, issue-triage,
     gbrain-dream, self-improve, chad-budget-audit)
  7. Applies required L7 policy presets (proton-calendar, github, gbrain,
     chad-premium, subagent-*, etc.)

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
skip_policies=0
dry_run=0

for arg in "${@:2}"; do
  case "$arg" in
    --skip-restore) skip_restore=1 ;;
    --skip-skills) skip_skills=1 ;;
    --skip-creds) skip_creds=1 ;;
    --skip-gh-auth) skip_gh_auth=1 ;;
    --skip-crons) skip_crons=1 ;;
    --skip-clone-source) skip_clone_source=1 ;;
    --skip-gbrain) skip_gbrain=1 ;;
    --skip-policies) skip_policies=1 ;;
    --dry-run) dry_run=1 ;;
    -h | --help) usage ;;
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
  local_restore_done=1 # treat as "don't try the fallback either"
fi

# ── Step 2: Sync skills ────────────────────────────────────────────────────

if [ "$skip_skills" -eq 0 ]; then
  step "Syncing skills to '${SANDBOX}'"
  sync_script="${REPO_ROOT}/.github/skills/chad-bug-intake/scripts/sync-skills-to-sandbox.sh"
  if [ -f "$sync_script" ]; then
    # No --build-proton: proton-tool is baked into the image at /usr/local/bin/proton-tool
    run bash "$sync_script" "$SANDBOX" proton-calendar chad-bug-intake chad-orchestrator
    # EMAIL-POLICY.md lives in the skills dir but the email-check cron reads it
    # from the workspace root — deploy it there explicitly after skill sync.
    email_policy_src="${REPO_ROOT}/.github/skills/proton-calendar/EMAIL-POLICY.md"
    if [ -f "$email_policy_src" ]; then
      if [ "$dry_run" -eq 1 ]; then
        echo "  [dry-run] Would upload EMAIL-POLICY.md to workspace root"
      else
        openshell sandbox upload "$SANDBOX" "$email_policy_src" "/sandbox/.openclaw/workspace/" 2>/dev/null \
          && info "EMAIL-POLICY.md deployed to workspace root" \
          || warn "EMAIL-POLICY.md upload failed — email-check cron will not find it"
      fi
    else
      warn "EMAIL-POLICY.md not found at $email_policy_src"
    fi
    # Sync gstack openclaw reasoning skills (text-only, no browser daemon needed).
    # Source: ~/.claude/skills/gstack/openclaw/skills/ on the host.
    # Destination: /sandbox/.openclaw-data/skills/ in the sandbox.
    gstack_skills_src="${HOME}/.claude/skills/gstack/openclaw/skills"
    if [ -d "$gstack_skills_src" ]; then
      for skill_dir in "$gstack_skills_src"/*/; do
        skill_name="$(basename "$skill_dir")"
        if [ "$dry_run" -eq 1 ]; then
          echo "  [dry-run] Would sync gstack skill: $skill_name"
        else
          tar -C "$gstack_skills_src" -cf - "$skill_name" \
            | ssh "$REMOTE_HOST" \
              "mkdir -p /sandbox/.openclaw-data/skills && \
                 tar -C /sandbox/.openclaw-data/skills -xf -" \
            && info "Synced gstack skill: $skill_name" \
            || warn "Failed to sync gstack skill: $skill_name"
        fi
      done
    else
      warn "gstack openclaw skills not found at ${gstack_skills_src}"
      warn "  Install: git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup"
    fi
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
# Keys deployed: PROTON_USERNAME, PROTON_PASSWORD, GITHUB_TOKEN, BRAVE_API_KEY, NVIDIA_API_KEY
# NVIDIA_API_KEY is passed to gbrain so it can call integrate.api.nvidia.com for embeddings.

if [ "$skip_creds" -eq 0 ]; then
  step "Deploying credentials to '${SANDBOX}'"

  [ -f "$CREDENTIALS_SRC" ] || fail "Host credentials not found: ${CREDENTIALS_SRC}"

  sandbox_creds="$(python3 -c "
import json, sys
src = json.load(open('${CREDENTIALS_SRC}'))
keep = ['PROTON_USERNAME', 'PROTON_PASSWORD', 'GITHUB_TOKEN', 'BRAVE_API_KEY', 'NVIDIA_API_KEY', 'ANTHROPIC_API_KEY', 'NEMOCLAW_INVOKER_TOKEN']
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

      # Install proton-tool credential wrapper.
      # proton-tool reads PROTON_* from env vars, but isolated cron sessions
      # don't have them injected. The wrapper loads them from credentials.json.
      #
      # The wrapper source lives at scripts/sandbox-bin/proton-tool-wrapper.sh
      # and is delivered via base64 + kubectl exec to avoid heredoc escape
      # bugs (we've been bitten by triple-escaped $ before).
      SANDBOX_POD=$(docker exec openshell-cluster-nemoclaw kubectl get pods -n openshell \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
      WRAPPER_SRC="${REPO_ROOT}/scripts/sandbox-bin/proton-tool-wrapper.sh"
      if [ -n "$SANDBOX_POD" ] && [ -f "$WRAPPER_SRC" ]; then
        WRAPPER_B64=$(base64 <"$WRAPPER_SRC" | tr -d '\n')
        docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX_POD" -- \
          sh -c "
            if [ ! -f /usr/local/bin/proton-tool-bin ]; then
              cp /usr/local/bin/proton-tool /usr/local/bin/proton-tool-bin
            fi
            echo '${WRAPPER_B64}' | base64 -d > /usr/local/bin/proton-tool
            chmod 755 /usr/local/bin/proton-tool /usr/local/bin/proton-tool-bin
            echo 'proton-tool wrapper installed'
          " 2>&1 | grep -v '^$' || warn "Could not install proton-tool wrapper (kubectl exec failed)"
      elif [ ! -f "$WRAPPER_SRC" ]; then
        warn "proton-tool wrapper source missing: ${WRAPPER_SRC}"
      else
        warn "Could not find sandbox pod — proton-tool wrapper not installed"
      fi

      # Deploy chad-dispatch (GitHub Actions worker client) and the cron
      # wrapper scripts. The sandbox SSH user can't write to /usr/local/bin
      # directly (root-owned) — stage the file in /tmp and move it via a
      # kubectl exec running as root.
      install_to_usrlocal() {
        local src="$1"
        local name
        name="$(basename "$src")"
        if [ ! -f "$src" ]; then
          warn "source missing: $src — skipping $name"
          return 0
        fi
        if [ -z "$SANDBOX_POD" ]; then
          warn "no sandbox pod — skipping $name"
          return 0
        fi
        cat "$src" | ssh "$REMOTE_HOST" \
          "cat > /tmp/${name} && chmod +x /tmp/${name}" 2>/dev/null || {
          warn "stage to /tmp failed — skipping $name"
          return 0
        }
        docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX_POD" -- \
          sh -c "cp /tmp/${name} /usr/local/bin/${name} && chmod +x /usr/local/bin/${name} && rm -f /tmp/${name}" 2>/dev/null \
          && info "${name} deployed to /usr/local/bin/${name}" \
          || warn "Could not install ${name} (kubectl exec failed)"
      }

      install_to_usrlocal "${REPO_ROOT}/scripts/chad-github-worker/chad-dispatch"
      for wrapper in chad-ensure-today-memory chad-log-event chad-gbrain-dream chad-workspace-backup chad-mail-check chad-mail-send chad-issue-triage-cron chad-email-check-cron chad-budget-audit chad-auth-context chad-premium chad-premium-client chad-dump-logs chad-route-prompt chad-drafter chad-action-gate chad-autosend-replies chad-cron-reload chad-workflow-batch; do
        install_to_usrlocal "${REPO_ROOT}/scripts/chad-cron-wrappers/${wrapper}"
      done

      # chad-shim: OpenAI-compat HTTP shim around `openclaw agent`, used by
      # open-webui's `chad` model. Listens on 127.0.0.1:8901 inside the sandbox;
      # the host reaches it via `npm run webui:chad:up` SSH port-forward.
      install_to_usrlocal "${REPO_ROOT}/scripts/openwebui/chad-shim.py"
      if [ -n "$SANDBOX_POD" ]; then
        docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX_POD" -- \
          sh -c '
            if ! pgrep -f chad-shim.py >/dev/null 2>&1; then
              HOME=/sandbox nohup /usr/local/bin/chad-shim.py >/tmp/chad-shim.log 2>&1 &
              echo "chad-shim: started"
            else
              echo "chad-shim: already running"
            fi
          ' 2>/dev/null \
          && info "chad-shim ensured running" \
          || warn "Could not start chad-shim (kubectl exec failed)"
      fi

      # Deploy registry/profile data files to /usr/local/share/chad/. Same
      # stage-then-kubectl-exec dance as install_to_usrlocal, but the dest
      # directory is for read-only data (no +x) and we must mkdir -p it.
      # Wrappers find the deployed files via env-var-override-then-default
      # paths (CHAD_PROFILES_FILE, NEMOCLAW_MODEL_REGISTRY).
      install_to_share_chad() {
        local src="$1"
        local name
        name="$(basename "$src")"
        if [ ! -f "$src" ]; then
          warn "source missing: $src — skipping $name"
          return 0
        fi
        if [ -z "$SANDBOX_POD" ]; then
          warn "no sandbox pod — skipping $name"
          return 0
        fi
        cat "$src" | ssh "$REMOTE_HOST" \
          "cat > /tmp/${name}" 2>/dev/null || {
          warn "stage to /tmp failed — skipping $name"
          return 0
        }
        docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX_POD" -- \
          sh -c "mkdir -p /usr/local/share/chad && cp /tmp/${name} /usr/local/share/chad/${name} && rm -f /tmp/${name}" 2>/dev/null \
          && info "${name} deployed to /usr/local/share/chad/${name}" \
          || warn "Could not install ${name} (kubectl exec failed)"
      }

      for data in model-registry.json task-profiles.json chad-workspace-files.txt; do
        install_to_share_chad "${REPO_ROOT}/scripts/${data}"
      done

      # _chad-paths.sh is sourced by every bash wrapper at start-up to pick
      # up the canonical paths for profiles/audit/auth-context/credentials.
      # Deploying as a data file (no +x) under /usr/local/share/chad/ keeps
      # /usr/local/bin/ free of non-executables.
      install_to_share_chad "${REPO_ROOT}/scripts/chad-cron-wrappers/_chad-paths.sh"

      # Auto-actions policy: deploy the template (always), then seed the
      # live policy at /sandbox/.openclaw-data/auto-actions.json *only if
      # it does not already exist*. Re-running setup must NOT clobber
      # tantodefi's per-target customisations (e.g. flipping a sender
      # from auto→draft after a bad reply).
      install_to_share_chad "${REPO_ROOT}/scripts/chad-cron-wrappers/auto-actions.template.json"
      if [ -n "$SANDBOX_POD" ]; then
        docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX_POD" -- \
          sh -c '
            mkdir -p /sandbox/.openclaw-data /sandbox/.openclaw-data/state
            if [ ! -f /sandbox/.openclaw-data/auto-actions.json ]; then
              cp /usr/local/share/chad/auto-actions.template.json \
                 /sandbox/.openclaw-data/auto-actions.json
              echo "auto-actions.json: seeded from template"
            else
              echo "auto-actions.json: preserved (already present)"
            fi
            chown -R sandbox:sandbox /sandbox/.openclaw-data 2>/dev/null || true
          ' 2>/dev/null \
          && info "auto-actions policy seeded/preserved" \
          || warn "Could not seed auto-actions.json (kubectl exec failed)"
      fi

      # Workflow regression fixtures: source-controlled YAML files under
      # scripts/chad-workflows/fixtures/ deployed to
      # /usr/local/share/chad/workflow-fixtures/. Read by chad-workflow-batch
      # to replay scenarios T1–T6, C1–C5 against the live drafter/spawn paths.
      WORKFLOW_FIX_DIR="${REPO_ROOT}/scripts/chad-workflows/fixtures"
      if [ -d "$WORKFLOW_FIX_DIR" ] && [ -n "$SANDBOX_POD" ]; then
        for fx in "$WORKFLOW_FIX_DIR"/*.yaml; do
          [ -f "$fx" ] || continue
          fxname="$(basename "$fx")"
          cat "$fx" | ssh "$REMOTE_HOST" \
            "cat > /tmp/${fxname}" 2>/dev/null || {
            warn "stage to /tmp failed — skipping $fxname"
            continue
          }
          docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX_POD" -- \
            sh -c "mkdir -p /usr/local/share/chad/workflow-fixtures && cp /tmp/${fxname} /usr/local/share/chad/workflow-fixtures/${fxname} && rm -f /tmp/${fxname}" 2>/dev/null \
            && info "${fxname} deployed to /usr/local/share/chad/workflow-fixtures/${fxname}" \
            || warn "Could not install ${fxname} (kubectl exec failed)"
        done
      fi
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
      # Fix ownership of PGLite files that may have been written as root
      # during a prior gbrain import/export run. Stale root-owned WAL or
      # lock files cause PGLite to abort on startup.
      docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX" -- \
        sh -c 'chown -R sandbox:sandbox /sandbox/.gbrain/brain.pglite 2>/dev/null; \
               rm -f /sandbox/.gbrain/brain.pglite/postmaster.pid \
                     /sandbox/.gbrain/brain.pglite/.gbrain-lock 2>/dev/null; true' || true
      # Pass GBRAIN_EMBED_* at init so the schema's vector(N) column matches
      # the embedder configured in step 3b. Patched gbrain (tantodefi fork)
      # reads these at module load — without them the column defaults to
      # vector(1536) and embeddings at 1024 dims fail at INSERT time.
      ssh "$REMOTE_HOST" 'HOME=/sandbox \
        GBRAIN_EMBED_MODEL=nvidia/llama-3.2-nv-embedqa-1b-v2 \
        GBRAIN_EMBED_DIMENSIONS=1024 \
        gbrain init 2>/dev/null || true'
      gbrain_status="$(ssh "$REMOTE_HOST" 'gbrain doctor 2>&1 | tail -3')"
      info "gbrain init done: ${gbrain_status}"
      # gbrain is intentionally NOT registered as an MCP server.
      # PGLite is single-process; registering it causes lock contention and
      # cold-start timeouts in isolated cron sessions. The main agent uses
      # gbrain via CLI directly. Subagents receive context in their prompt.
    else
      warn "gbrain not found in sandbox — skipping brain init (image may need rebuild)"
    fi
  fi
else
  info "Skipping gbrain init (--skip-gbrain)"
fi

# ── Step 3b: Configure gbrain embeddings ──────────────────────────────────
#
# Point gbrain at NVIDIA's hosted embedding API at integrate.api.nvidia.com.
#
# gbrain v0.14.x hardcodes `text-embedding-3-large` at 1536 dims in
# src/core/embedding.ts. The patched fork at tantodefi/gbrain honors three
# env vars (read by the wrapper from this config.json):
#   GBRAIN_EMBED_MODEL       — model id  (default: text-embedding-3-large)
#   GBRAIN_EMBED_DIMENSIONS  — vector dim (default: 1536; must match schema)
#   GBRAIN_EMBED_INPUT_TYPE  — NIM-only ("passage"/"query"), sent if non-empty
# Plus the OpenAI SDK reads OPENAI_BASE_URL / OPENAI_API_KEY directly.
#
# We pick nvidia/llama-3.2-nv-embedqa-1b-v2 at 1024 dims because:
#   - matryoshka model accepts the `dimensions` parameter (free model choice)
#   - 1024 dims keeps the vector column / HNSW index reasonably small
#   - free with the existing NVIDIA_API_KEY; no extra account or paid OpenAI
# The network policy preset gbrain.yaml already allows
# integrate.api.nvidia.com:443/v1/embeddings for the gbrain binary.

if [ "$skip_gbrain" -eq 0 ] && [ "$dry_run" -eq 0 ]; then
  nvidia_key="$(python3 -c "
import json, sys
src = json.load(open('${CREDENTIALS_SRC}'))
print(src.get('NVIDIA_API_KEY', ''))
" 2>/dev/null)"

  if [ -z "$nvidia_key" ]; then
    warn "NVIDIA_API_KEY missing in ${CREDENTIALS_SRC} — gbrain embeddings will fail"
  fi

  ssh "$REMOTE_HOST" "NVIDIA_KEY='${nvidia_key}' python3 -c \"
import json, os
cfg = {
  'engine': 'pglite',
  'database_path': '/sandbox/.gbrain/brain.pglite',
  'openai_api_key': os.environ['NVIDIA_KEY'] or 'unused',
  'openai_base_url': 'https://integrate.api.nvidia.com/v1',
  'embed_model': 'nvidia/llama-3.2-nv-embedqa-1b-v2',
  'embed_dimensions': '1024',
  'embed_input_type': 'passage',
}
with open('/sandbox/.gbrain/config.json', 'w') as f:
    json.dump(cfg, f, indent=2)
os.chmod('/sandbox/.gbrain/config.json', 0o600)
print('gbrain configured for NVIDIA NIM embeddings (llama-3.2-nv-embedqa-1b-v2 @ 1024 dims)')
\""
  info "gbrain configured to use NVIDIA NIM embeddings (llama-3.2-nv-embedqa-1b-v2 @ 1024 dims)"

  # Install gbrain wrapper that exports OPENAI_API_KEY before invoking the
  # real binary. The OpenAI Node SDK throws if OPENAI_API_KEY is empty even
  # though gbrain's config.json sets it to "unused" — cron sessions don't
  # inherit interactive env, so embeddings fail without this wrapper.
  GBRAIN_WRAPPER_SRC="${REPO_ROOT}/scripts/sandbox-bin/gbrain-wrapper.sh"
  SANDBOX_POD="${SANDBOX_POD:-$(docker exec openshell-cluster-nemoclaw kubectl get pods -n openshell \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)}"
  if [ -n "$SANDBOX_POD" ] && [ -f "$GBRAIN_WRAPPER_SRC" ]; then
    GBRAIN_WRAPPER_B64=$(base64 <"$GBRAIN_WRAPPER_SRC" | tr -d '\n')
    docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX_POD" -- \
      sh -c "
        if [ ! -f /usr/local/bin/gbrain-bin ]; then
          cp /usr/local/bin/gbrain /usr/local/bin/gbrain-bin
        fi
        echo '${GBRAIN_WRAPPER_B64}' | base64 -d > /usr/local/bin/gbrain
        chmod 755 /usr/local/bin/gbrain /usr/local/bin/gbrain-bin
        echo 'gbrain wrapper installed'
      " 2>&1 | grep -v '^$' || warn "Could not install gbrain wrapper"
  elif [ ! -f "$GBRAIN_WRAPPER_SRC" ]; then
    warn "gbrain wrapper source missing: ${GBRAIN_WRAPPER_SRC}"
  fi

  # Defensive re-write: if the user (or this script's step 3a above) ever
  # ran `gbrain init` AFTER the config block was written, init silently
  # overwrites config.json to a bare-minimum {engine, database_path} stub
  # — dropping openai_api_key and embed_* fields. The wrapper then falls
  # back to OPENAI_API_KEY=unused on next call, breaking embeddings with a
  # 401. Re-applying the full config here makes the gbrain section
  # idempotent: re-running chad-setup always leaves a working config.
  # See: feedback_gbrain_init_clobbers_config in auto-memory.
  ssh "$REMOTE_HOST" "NVIDIA_KEY='${nvidia_key}' python3 -c \"
import json, os
needs_rewrite = False
try:
    cfg = json.load(open('/sandbox/.gbrain/config.json'))
    if not cfg.get('openai_api_key') or not cfg.get('embed_dimensions'):
        needs_rewrite = True
except Exception:
    needs_rewrite = True
if needs_rewrite:
    cfg = {
      'engine': 'pglite',
      'database_path': '/sandbox/.gbrain/brain.pglite',
      'openai_api_key': os.environ['NVIDIA_KEY'] or 'unused',
      'openai_base_url': 'https://integrate.api.nvidia.com/v1',
      'embed_model': 'nvidia/llama-3.2-nv-embedqa-1b-v2',
      'embed_dimensions': '1024',
      'embed_input_type': 'passage',
    }
    with open('/sandbox/.gbrain/config.json', 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod('/sandbox/.gbrain/config.json', 0o600)
    print('gbrain config restored after init clobber')
\"" 2>&1 | grep -v '^$' || true
fi

# ── Step 3c: Make /sandbox/.openclaw subpaths writable for OpenClaw 2026.4.24 ──
#
# The image creates /sandbox/.openclaw root:root 755 and pins openclaw.json to
# 444 root:root for tamper protection. OpenClaw 2026.4.24 added writes the
# gateway (running as the sandbox user) needs to perform on every WS connect:
#   - devices/*.tmp      device-pair handler
#   - workspace/state    acpx plugin mkdir on first start
#   - identity/*         identity rotation
#   - cron/jobs.json     openclaw cron add updates
# Without these writable, every CLI WS connect closes with code 1000 (EACCES
# from the device-pair handler). The Dockerfile bakes the same chown into the
# image; this step keeps existing sandboxes working until they are rebuilt.
#
# openclaw.json itself stays root:root 444 — model routing is owned by the
# host-side gateway (`openshell inference set` from onboard step 5), never
# from inside the sandbox.

if [ "$dry_run" -eq 1 ]; then
  echo "  [dry-run] kubectl exec ${SANDBOX} -- chown sandbox /sandbox/.openclaw/{devices,workspace,workspace/state,identity,cron}"
else
  step "Ensuring /sandbox/.openclaw subpaths are sandbox-writable in '${SANDBOX}'"
  if docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$SANDBOX" -- bash -c '
    set -e
    mkdir -p /sandbox/.openclaw/workspace/state
    chown -R sandbox:sandbox /sandbox/.openclaw/devices \
                              /sandbox/.openclaw/workspace \
                              /sandbox/.openclaw/identity \
                              /sandbox/.openclaw/cron
  ' 2>&1; then
    info "openclaw subpaths chowned to sandbox:sandbox"
  else
    warn "Could not chown openclaw subpaths — gateway WS connects may fail with EACCES"
    warn "Diagnose: ssh ${REMOTE_HOST} 'tail /sandbox/.openclaw-data/logs/config-audit.jsonl'"
  fi
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
    warn "Run manually: echo \$GITHUB_TOKEN | ssh openshell-${SANDBOX} 'gh auth login --git-protocol https --with-token'"
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
  # The wrapper does the deterministic work (chad-mail-check + parse + batch
  # mark-read + memory append). Replies and chad-intake routing are deferred
  # to a human or a future agent run while the Kimi-K2.5 multi-turn tool-call
  # regression is unresolved — see project_chad_cron_pattern memory.
  email_check_message='Run `chad-email-check-cron`. The wrapper sweeps the inbox, batch-marks-read everything that does not need a human reply, drafts replies for admins via the drafter pass, and auto-sends drafts whose sender policy is `auto` in `/sandbox/.openclaw-data/auto-actions.json` (currently tantodefi + tjcooke). Confirm it printed `email-check: total=... marked-read=... pending=... drafts=... drafter=... autosend=...`, then exit. Do not write replies yourself — every memory section (`### Auto-sent replies`, `### Draft replies`, `### Drafts blocked/deferred`) is produced by the wrapper.'

  workspace_backup_message='Run `chad-workspace-backup`. The wrapper detaches the slow git push and returns in <1s. Confirm it printed a `workspace-backup detached` line, then exit. Do not poll or follow up — the result lands in todays memory file when the background job finishes.'

  # Daily issue triage: reads open issues from $CHAD_BUG_REPO, scores
  # them, routes top 2 through a researcher sub-agent. Budget-guarded
  # (will skip when <40% remaining). Runs at 10:00 UTC so the human
  # triage from the previous afternoon has time to land reactions/labels.
  issue_triage_message='Run `chad-issue-triage-cron`. The wrapper enforces the budget gate, detaches the triage run, and returns in <1s. Confirm it printed `issue-triage detached` (or `skipped: budget=...`), then exit.'

  # Weekly self-improvement: scans failed spawns + feedback memory,
  # spawns a researcher with a "propose 1-3 improvements" task. Runs
  # Sunday 03:00 UTC when the inbox is quiet and budget is fresh.
  self_improve_message='Run `chad-self-improve --days 7`. Append the stdout to todays memory file under a `## Self-improvement` heading. Do NOT apply any proposals — they land in memory/feedback-proposals.md for review later.'

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
  gbrain_dream_message='Run `chad-gbrain-dream`. The wrapper syncs workspace docs into the brain, detaches the slow embed/extract steps, and writes its own summary to todays memory. Confirm it printed `gbrain dream complete`, then exit.'

  if echo "$existing_crons" | grep -q "gbrain-dream"; then
    warn "gbrain-dream cron already registered — skipping"
  else
    info "Registering gbrain-dream cron (nightly 03:30 UTC)"
    register_cron_via_ssh "gbrain-dream" "30 3 * * *" "" "$gbrain_dream_message"
  fi

  # Weekly budget audit: compares cron telemetry (p95 in/out/dur, error rate)
  # against task-profiles.json and writes a markdown recommendation report
  # to memory/feedback-proposals.md. Light-touch — wrapper is shell+python,
  # cron payload only acks the summary line. See task-profiles.json for the
  # canonical schedule (0 4 * * 1 = Mon 04:00 UTC).
  budget_audit_message='Run `chad-budget-audit`. The wrapper computes p95 telemetry per cron, compares against task-profiles.json, and writes a recommendation block to memory/feedback-proposals.md. Confirm it printed `budget-audit: N findings, M crons, ...`, then exit. Do NOT apply any recommendations — they are reviewed by a human.'

  if echo "$existing_crons" | grep -q "chad-budget-audit"; then
    warn "chad-budget-audit cron already registered — skipping"
  else
    info "Registering chad-budget-audit cron (weekly Mon 04:00 UTC)"
    register_cron_via_ssh "chad-budget-audit" "0 4 * * 1" "" "$budget_audit_message"
  fi

  info "Cron jobs registered"
else
  info "Skipping cron registration (--skip-crons)"
fi

# ── Step 8: Ensure required L7 policies are applied ────────────────────────
#
# nemoclaw policy-add is idempotent — if a preset is already in local state,
# it's a no-op. The cron wrappers and orchestrator subagents need each of
# these to function:
#
#   email-check       → proton-calendar (proton-tool egress)
#   workspace-backup  → github, github-tools (gh CLI + git push)
#   issue-triage      → github, subagent-researcher
#   gbrain-dream      → gbrain, local-inference (NVIDIA + LM Studio fallback)
#   chad-budget-audit → no egress
#   premium escalate  → chad-premium (Anthropic Messages API)
#   bug-report        → chad-bug-report (gh issue create scoped)
#   subagent fan-out  → subagent-researcher, subagent-reviewer, subagent-writer
#
# Known drift: nemoclaw policy-list may report "(recorded locally, not active
# on gateway)" even after policy-add — the local CLI state and the L7 OPA
# gateway can diverge. Cron success is the ground-truth signal that egress
# is allowed; if a preset is silently missing on the gateway, the wrapper
# will surface a binary-pinned 403 in the cron's last error.

REQUIRED_PRESETS="proton-calendar github github-tools gbrain local-inference \
chad-premium chad-bug-report subagent-researcher subagent-reviewer \
subagent-writer huggingface openclaw-bundled"

if [ "$skip_policies" -eq 0 ]; then
  step "Ensuring L7 policies are applied to '${SANDBOX}'"
  for preset in $REQUIRED_PRESETS; do
    if [ "$dry_run" -eq 1 ]; then
      echo "  [dry-run] nemoclaw ${SANDBOX} policy-add ${preset} --yes"
    else
      out="$(nemoclaw "${SANDBOX}" policy-add "${preset}" --yes 2>&1 | tail -1 || true)"
      info "  ${preset}: ${out}"
    fi
  done
else
  info "Skipping policy registration (--skip-policies)"
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
