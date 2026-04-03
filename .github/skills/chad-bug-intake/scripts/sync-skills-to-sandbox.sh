#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sync-skills-to-sandbox.sh <sandbox-name> [options] [skill ...]

Options:
  --remote-host HOST   Override the SSH host. Defaults to openshell-<sandbox>.
  --build-proton       Run install-go.sh and build.sh for proton-calendar after sync.

If no skills are provided, syncs proton-calendar and chad-bug-intake.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

sandbox_name=""
remote_host=""
build_proton=0
skills=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote-host)
      remote_host="$2"
      shift 2
      ;;
    --build-proton)
      build_proton=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$sandbox_name" ]; then
        sandbox_name="$1"
      else
        skills+=("$1")
      fi
      shift
      ;;
  esac
done

[ -n "$sandbox_name" ] || fail "sandbox name is required"

if [ "${#skills[@]}" -eq 0 ]; then
  skills=(proton-calendar chad-bug-intake)
fi

if [ -z "$remote_host" ]; then
  remote_host="openshell-${sandbox_name}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
remote_dir="/sandbox/.openclaw-data/skills"

ssh "$remote_host" "mkdir -p '$remote_dir'"

for skill in "${skills[@]}"; do
  local_path="$repo_root/.github/skills/$skill"
  [ -d "$local_path" ] || fail "Skill directory not found: $local_path"

  ssh "$remote_host" "rm -rf '$remote_dir/$skill'"
  scp -rq "$local_path" "$remote_host:$remote_dir/"
  echo "Synced $skill to $remote_host:$remote_dir/$skill"
done

case " ${skills[*]} " in
  *" proton-calendar "*)
    if [ "$build_proton" -eq 1 ]; then
      ssh "$remote_host" "cd '$remote_dir/proton-calendar' && bash scripts/install-go.sh && bash scripts/build.sh"
      echo "Built proton-tool in $remote_dir/proton-calendar"
    fi
    ;;
esac
