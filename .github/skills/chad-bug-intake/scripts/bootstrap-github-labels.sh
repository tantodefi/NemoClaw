#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bootstrap-github-labels.sh [--repo owner/repo]

Creates or updates the GitHub workflow labels used by Chad bug intake and the
OpenShell reference issue workflow.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

repo=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

labels=(
  "status: triage|D4C5F9|Needs maintainer triage"
  "state:triage-needed|D4C5F9|Needs agent or maintainer triage"
  "state:review-ready|0E8A16|Ready for human review"
  "state:agent-ready|1D76DB|Human approved for agent execution"
  "state:in-progress|FBCA04|Agent work is in progress"
  "state:pr-opened|5319E7|A pull request has been opened"
  "spike|BFDADC|Needs deeper investigation before implementation"
)

existing_labels="$(gh label list --repo "$repo" --limit 200 --json name --jq '.[].name')"

label_exists() {
  printf '%s\n' "$existing_labels" | grep -Fx -- "$1" >/dev/null
}

for spec in "${labels[@]}"; do
  IFS='|' read -r name color description <<< "$spec"
  if label_exists "$name"; then
    gh label edit "$name" --repo "$repo" --color "$color" --description "$description" >/dev/null
    echo "Updated label: $name"
  else
    gh label create "$name" --repo "$repo" --color "$color" --description "$description" >/dev/null
    echo "Created label: $name"
  fi
done

echo "Label bootstrap complete for $repo"
