#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Back up ~/.nemoclaw/ host-side state (session, sandboxes, config, tmp/).
# Companion to backup-workspace.sh which handles in-sandbox files.

set -euo pipefail

NEMOCLAW_HOME="${HOME}/.nemoclaw"
BACKUP_BASE="${NEMOCLAW_HOME}/backups/host"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[backup-host]${NC} $1"; }
warn()  { echo -e "${YELLOW}[backup-host]${NC} $1"; }
fail()  { echo -e "${RED}[backup-host]${NC} $1" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [backup|list|restore [timestamp]]

Commands:
  backup   Create a timestamped backup of host-side NemoClaw config (default).
  list     List available host backups.
  restore  Restore host config from a backup. Uses latest if no timestamp given.

Backup location: ${BACKUP_BASE}/<timestamp>/

Files backed up:
  onboard-session.json  Onboard wizard state and progress
  sandboxes.json        Sandbox metadata and policy mappings
  config.json           Inference provider/model/endpoint config
  state/                Runtime state (lastRunId, blueprintVersion)
  tmp/                  Work-in-progress files (skills, draft policies)
  reference-skills/     Generated skill files (regenerable but cached)
EOF
  exit 0
}

do_backup() {
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local dest="${BACKUP_BASE}/${ts}"

  mkdir -p "${BACKUP_BASE}"
  chmod 0700 "${NEMOCLAW_HOME}" "${BACKUP_BASE}" 2>/dev/null || true
  mkdir -p "${dest}"
  chmod 0700 "${dest}"

  local count=0

  # --- Critical config files (credentials.json excluded — stays localhost-only) ---
  for f in onboard-session.json sandboxes.json config.json; do
    if [ -f "${NEMOCLAW_HOME}/${f}" ]; then
      cp -p "${NEMOCLAW_HOME}/${f}" "${dest}/"
      count=$((count + 1))
    else
      warn "Skipped ${f} (not found)"
    fi
  done

  # --- State directory ---
  if [ -d "${NEMOCLAW_HOME}/state" ]; then
    cp -rp "${NEMOCLAW_HOME}/state" "${dest}/state"
    count=$((count + 1))
  fi

  # --- WIP files (tmp/) ---
  if [ -d "${NEMOCLAW_HOME}/tmp" ]; then
    cp -rp "${NEMOCLAW_HOME}/tmp" "${dest}/tmp"
    count=$((count + 1))
    info "Backed up tmp/ (WIP skills, draft policies)"
  fi

  # --- Reference skills ---
  if [ -d "${NEMOCLAW_HOME}/reference-skills" ]; then
    cp -rp "${NEMOCLAW_HOME}/reference-skills" "${dest}/reference-skills"
    count=$((count + 1))
    info "Backed up reference-skills/ (regenerable cache)"
  fi

  if [ "$count" -eq 0 ]; then
    fail "No files found to back up. Is ${NEMOCLAW_HOME} set up?"
  fi

  # Ensure backup is private
  chmod -R go-rwx "${dest}"

  info "Backup saved to ${dest}/ (${count} items)"

  # --- Prune backups older than 30 days ---
  local pruned=0
  while IFS= read -r old_dir; do
    [ -z "$old_dir" ] && continue
    rm -rf "$old_dir"
    pruned=$((pruned + 1))
  done <<< "$(find "${BACKUP_BASE}" -mindepth 1 -maxdepth 1 -type d -mtime +30 2>/dev/null)"
  if [ "$pruned" -gt 0 ]; then
    info "Pruned ${pruned} backup(s) older than 30 days"
  fi
}

do_list() {
  if [ ! -d "${BACKUP_BASE}" ]; then
    info "No backups found."
    return
  fi
  info "Available host backups:"
  echo ""
  for d in $(find "${BACKUP_BASE}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | xargs -I{} basename {} | sort -r); do
    local files
    files=$(find "${BACKUP_BASE}/${d}" -maxdepth 1 -type f -name '*.json' 2>/dev/null | xargs -I{} basename {} | tr '\n' ' ' || true)
    local has_tmp=""
    [ -d "${BACKUP_BASE}/${d}/tmp" ] && has_tmp=" +tmp/"
    local has_skills=""
    [ -d "${BACKUP_BASE}/${d}/reference-skills" ] && has_skills=" +skills/"
    echo "  ${d}  [${files}${has_tmp}${has_skills}]"
  done
}

do_restore() {
  local ts="${1:-}"

  if [ -z "$ts" ]; then
    ts="$(find "${BACKUP_BASE}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | xargs -I{} basename {} | sort -r | head -n1 || true)"
    [ -n "$ts" ] || fail "No backups found in ${BACKUP_BASE}/"
    info "Using most recent backup: ${ts}"
  fi

  local src="${BACKUP_BASE}/${ts}"
  [ -d "$src" ] || fail "Backup directory not found: ${src}"

  info "Restoring host config from ${src}..."

  local count=0

  for f in onboard-session.json sandboxes.json config.json; do
    if [ -f "${src}/${f}" ]; then
      cp -p "${src}/${f}" "${NEMOCLAW_HOME}/${f}"
      count=$((count + 1))
    fi
  done

  if [ -d "${src}/state" ]; then
    cp -rp "${src}/state" "${NEMOCLAW_HOME}/state"
    count=$((count + 1))
  fi

  if [ -d "${src}/tmp" ]; then
    # Merge, don't overwrite — avoid losing newer WIP
    cp -rp --no-clobber "${src}/tmp/" "${NEMOCLAW_HOME}/tmp/" 2>/dev/null \
      || cp -rnp "${src}/tmp/" "${NEMOCLAW_HOME}/tmp/" 2>/dev/null \
      || {
        # Fallback for macOS cp (no --no-clobber)
        rsync -a --ignore-existing "${src}/tmp/" "${NEMOCLAW_HOME}/tmp/"
      }
    count=$((count + 1))
    info "Merged tmp/ (existing files preserved)"
  fi

  if [ -d "${src}/reference-skills" ]; then
    cp -rp "${src}/reference-skills" "${NEMOCLAW_HOME}/reference-skills"
    count=$((count + 1))
  fi

  if [ "$count" -eq 0 ]; then
    fail "No files to restore from ${src}"
  fi

  info "Restored ${count} items from backup ${ts}"
}

# --- Main ---
action="${1:-backup}"

case "$action" in
  backup)  do_backup ;;
  list)    do_list ;;
  restore) shift; do_restore "$@" ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
