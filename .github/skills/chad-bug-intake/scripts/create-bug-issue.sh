#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: create-bug-issue.sh --subject TEXT [options]

Options:
  --repo OWNER/REPO      Target repository. Defaults to the current gh repo.
  --subject TEXT         Raw chat or ProtonMail subject. Required.
  --body TEXT            Report body.
  --body-file PATH       Read report body from a file.
  --reporter TEXT        Reporter identity or email address.
  --source TEXT          Intake source. Defaults to chat.
  --sandbox TEXT         Sandbox name. Defaults to chad.
  --no-duplicate-check   Skip the title-based duplicate check.
  --dry-run              Print the generated issue instead of creating it.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

repo=""
subject=""
report_body=""
body_file=""
reporter="unknown"
source_name="chat"
sandbox_name="chad"
duplicate_check=1
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo="$2"
      shift 2
      ;;
    --subject)
      subject="$2"
      shift 2
      ;;
    --body)
      report_body="$2"
      shift 2
      ;;
    --body-file)
      body_file="$2"
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
    --sandbox)
      sandbox_name="$2"
      shift 2
      ;;
    --no-duplicate-check)
      duplicate_check=0
      shift
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

[ -n "$subject" ] || fail "--subject is required"

if [ -n "$body_file" ]; then
  [ -f "$body_file" ] || fail "Report body file not found: $body_file"
  report_body="$(<"$body_file")"
fi

if [ -z "$report_body" ]; then
  report_body="No additional report body was provided."
fi

title="$($SCRIPT_DIR/normalize-bug-title.sh "$subject")"

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

available_labels="$(gh label list --repo "$repo" --limit 200 --json name --jq '.[].name')"

label_exists() {
  printf '%s\n' "$available_labels" | grep -Fx -- "$1" >/dev/null
}

existing_issue=""
if [ "$duplicate_check" -eq 1 ]; then
  while IFS=$'\t' read -r issue_number issue_title issue_url issue_state; do
    [ -n "$issue_number" ] || continue
    target_title="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')"
    candidate_title="$(printf '%s' "$issue_title" | tr '[:upper:]' '[:lower:]')"
    if [ "$candidate_title" = "$target_title" ]; then
      existing_issue="$issue_number|$issue_title|$issue_url|$issue_state"
      break
    fi
  done < <(gh issue list \
    --repo "$repo" \
    --state all \
    --limit 20 \
    --search "$title in:title" \
    --json number,title,url,state \
    --jq '.[] | [.number, .title, .url, .state] | @tsv')
fi

if [ -n "$existing_issue" ]; then
  IFS='|' read -r issue_number issue_title issue_url issue_state <<< "$existing_issue"
  printf 'DUPLICATE_NUMBER=%s\n' "$issue_number"
  printf 'DUPLICATE_STATE=%s\n' "$issue_state"
  printf 'DUPLICATE_ISSUE=%s\n' "$issue_url"
  exit 0
fi

issue_body="$(cat <<EOF
## Description

Reported via ${source_name} by ${reporter}.

${report_body}

## Reproduction Steps

1. Review the source report captured below.
2. Reproduce the issue in Chad's sandbox or the local NemoClaw environment.
3. Replace these placeholder steps with the minimal confirmed reproduction.

## Environment

- Report source: ${source_name}
- Reporter: ${reporter}
- Sandbox: ${sandbox_name}
- NemoClaw version: unknown
- OS: unknown

## Debug Output

Not yet collected. Follow up with `nemoclaw debug --quick` or attach a debug bundle when reproduction succeeds.

## Logs

```text
${report_body}
```

## Agent Intake

- Original subject: ${subject}
- Normalized title: ${title}
- Duplicate check: passed
EOF
 )"

label_args=()
for label in bug "status: triage" "state:triage-needed"; do
  if label_exists "$label"; then
    label_args+=(--label "$label")
  fi
done

if [ "$dry_run" -eq 1 ]; then
  printf 'TITLE=%s\n' "$title"
  printf 'REPO=%s\n' "$repo"
  printf 'LABELS=%s\n' "${label_args[*]:-none}"
  printf '%s\n' "$issue_body"
  exit 0
fi

created_url="$(gh issue create --repo "$repo" --title "$title" --body "$issue_body" "${label_args[@]}")"
printf 'CREATED_ISSUE=%s\n' "$created_url"
