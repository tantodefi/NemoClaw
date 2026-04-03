#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: create-child-issues.sh --parent NUMBER --tasks-file PATH [options]

Task file format:
  One task per line.
  Use "Title | Description" when you want a custom description.
  Blank lines and lines starting with # are ignored.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

repo=""
parent_issue=""
tasks_file=""
reporter="chad-bug-intake"
source_name="issue-breakdown"
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo="$2"
      shift 2
      ;;
    --parent)
      parent_issue="$2"
      shift 2
      ;;
    --tasks-file)
      tasks_file="$2"
      shift 2
      ;;
    --reporter)
      reporter="$2"
      shift 2
      ;;
    --source)
      source_name="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
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

[ -n "$parent_issue" ] || fail "--parent is required"
[ -n "$tasks_file" ] || fail "--tasks-file is required"
[ -f "$tasks_file" ] || fail "Task file not found: $tasks_file"

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

available_labels="$(gh label list --repo "$repo" --limit 200 --json name --jq '.[].name')"

label_exists() {
  printf '%s\n' "$available_labels" | grep -Fx -- "$1" >/dev/null
}

label_args=()
for label in "state:review-ready" "status: triage"; do
  if label_exists "$label"; then
    label_args+=(--label "$label")
  fi
done

created_issues=()

while IFS= read -r line || [ -n "$line" ]; do
  trimmed="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -n "$trimmed" ] || continue
  case "$trimmed" in
    \#*)
      continue
      ;;
  esac

  if printf '%s' "$trimmed" | grep -q '|'; then
    title_part="${trimmed%%|*}"
    desc_part="${trimmed#*|}"
  else
    title_part="$trimmed"
    desc_part="$trimmed"
  fi

  title_part="$(printf '%s' "$title_part" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  desc_part="$(printf '%s' "$desc_part" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

  if ! printf '%s' "$title_part" | grep -Eqi '^(feat|fix|docs|chore|refactor|test|perf|task):'; then
    title_part="task: $title_part"
  fi

  issue_body="$(cat <<EOF
## Description

${desc_part}

## Context

- Parent issue: #${parent_issue}
- Source: ${source_name}
- Reporter: ${reporter}

## Definition of Done

- [ ] Change implemented
- [ ] Tests added or updated as needed
- [ ] Parent issue updated with progress
EOF
 )"

  if [ "$dry_run" -eq 1 ]; then
    printf 'TITLE=%s\n' "$title_part"
    printf '%s\n' "$issue_body"
    printf '%s\n' '---'
    continue
  fi

  created_url="$(gh issue create --repo "$repo" --title "$title_part" --body "$issue_body" "${label_args[@]}")"
  created_issues+=("$created_url")
done < "$tasks_file"

if [ "$dry_run" -eq 1 ]; then
  exit 0
fi

if [ "${#created_issues[@]}" -eq 0 ]; then
  fail "No child issues were created. Check the task file contents."
fi

summary_body='> **chad-bug-intake**

Created child tasks:
'
for issue_url in "${created_issues[@]}"; do
  summary_body+="- ${issue_url}"$'\n'
done

gh issue comment "$parent_issue" --repo "$repo" --body "$summary_body" >/dev/null

for issue_url in "${created_issues[@]}"; do
  printf 'CREATED_CHILD_ISSUE=%s\n' "$issue_url"
done
