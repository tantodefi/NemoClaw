#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-report-bug.sh — File a bug with Chad's state attached.
#
# Wraps chad-dump-state + gh issue create so Chad can say "this
# behavior is wrong" and produce a reproducible, actionable issue
# without the human having to ssh in and collect logs.
#
# Usage:
#   chad-report-bug --title "<title>" --body "<body>" [--repo OWNER/NAME]
#                   [--label LABEL ...] [--dry-run]
#   chad-report-bug --title "<title>" --body-file /path/to/body.md [...]
#
# Behavior:
#   1. Runs chad-dump-state to capture current runtime state.
#   2. Combines the provided body + state dump into one markdown body.
#   3. Checks for recent open issues with the same title (dedupe).
#      If an open issue exists, adds a comment instead of filing a new one.
#   4. Creates the issue via `gh issue create` with labels
#      `chad-filed`, `state-attached`, plus any --label flags.
#   5. Writes the issue URL to stdout and appends a
#      "## Bug filed" entry to today's memory/<YYYY-MM-DD>.md.
#
# SECURITY:
#   The state dump is redacted for obvious credential patterns before
#   embedding. Still, the target repo SHOULD be private — default is
#   the private chad-state repo.
#
# Exit codes:
#   0  issue filed (or comment added to existing)
#   2  usage / missing required arg
#   3  dedupe check or gh create failed

set -euo pipefail

REPO="${CHAD_BUG_REPO:-tantodefi/chad-state}"
DEDUPE_WINDOW_DAYS="${CHAD_BUG_DEDUPE_DAYS:-7}"

title=""
body=""
body_file=""
labels=(chad-filed state-attached)
dry_run=0

usage() {
  cat <<'EOF'
Usage: chad-report-bug --title TITLE (--body BODY | --body-file FILE)
                       [--repo OWNER/NAME] [--label LABEL ...]
                       [--dry-run]

Options:
  --title TITLE       Issue title (required)
  --body BODY         Issue body (required, or use --body-file)
  --body-file FILE    Read body from a file instead of --body
  --repo OWNER/NAME   Target repo (default: $CHAD_BUG_REPO or tantodefi/chad-state)
  --label LABEL       Extra label. May be repeated. Auto-adds: chad-filed, state-attached.
  --dry-run           Assemble the body and print the gh command, do not file.
EOF
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --title)     title="$2";     shift 2 ;;
    --body)      body="$2";      shift 2 ;;
    --body-file) body_file="$2"; shift 2 ;;
    --repo)      REPO="$2";      shift 2 ;;
    --label)     labels+=("$2"); shift 2 ;;
    --dry-run)   dry_run=1;      shift ;;
    -h|--help)   usage ;;
    *) echo "chad-report-bug: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$title" ] || { echo "chad-report-bug: --title is required" >&2; exit 2; }
if [ -z "$body" ] && [ -z "$body_file" ]; then
  echo "chad-report-bug: --body or --body-file is required" >&2
  exit 2
fi

if [ -n "$body_file" ]; then
  [ -f "$body_file" ] || { echo "chad-report-bug: body file not found: $body_file" >&2; exit 2; }
fi

command -v gh >/dev/null 2>&1 || {
  echo "chad-report-bug: gh not found — is github-tools policy applied?" >&2
  exit 3
}

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# 1. Capture state dump
dump_file="${workdir}/state-dump.md"
if ! chad-dump-state --out "$dump_file" >/dev/null 2>&1; then
  # If the dump fails we still want to file the bug — but note it.
  echo "_(chad-dump-state failed; filing without state)_" > "$dump_file"
fi

# 2. Assemble combined body
combined="${workdir}/body.md"
{
  if [ -n "$body_file" ]; then
    cat "$body_file"
  else
    printf '%s\n' "$body"
  fi
  printf '\n\n---\n\n'
  printf '<details><summary>Chad state snapshot</summary>\n\n'
  cat "$dump_file"
  printf '\n</details>\n'
} > "$combined"

# Guard against GitHub's 65K issue body limit. If combined body is
# over 60K chars, truncate the state dump tail and note the cutoff.
body_bytes="$(wc -c < "$combined" | tr -d ' ')"
if [ "$body_bytes" -gt 60000 ]; then
  python3 - "$combined" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text()
# Keep first 58K, tail with a truncation marker
head = text[:58000]
p.write_text(head + "\n\n... _(state dump truncated — attach the full tar via --repo release asset)_\n")
PY
fi

# 3. Dedupe check — is there already an open issue with the same title?
dedupe_url=""
if dedupe_json="$(gh issue list --repo "$REPO" --state open --search "$title in:title" \
                    --json number,title,url,updatedAt 2>/dev/null)"; then
  dedupe_url="$(python3 - "$dedupe_json" "$title" "$DEDUPE_WINDOW_DAYS" <<'PY'
import sys, json, datetime
_UTC = getattr(datetime, "UTC", datetime.timezone.utc)
try:
    items = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
title, window = sys.argv[2], int(sys.argv[3])
now = datetime.datetime.now(_UTC)
for it in items:
    if it.get("title", "").strip() == title.strip():
        try:
            updated = datetime.datetime.fromisoformat(it["updatedAt"].replace("Z", "+00:00"))
            if (now - updated).days <= window:
                print(it.get("url", ""))
                sys.exit(0)
        except Exception:
            pass
PY
)"
fi

# 4. File or comment
if [ "$dry_run" -eq 1 ]; then
  echo "[dry-run] target repo: $REPO"
  echo "[dry-run] title: $title"
  echo "[dry-run] labels: ${labels[*]}"
  echo "[dry-run] body bytes: $(wc -c < "$combined" | tr -d ' ')"
  if [ -n "$dedupe_url" ]; then
    echo "[dry-run] would comment on: $dedupe_url"
  else
    echo "[dry-run] would create new issue"
  fi
  exit 0
fi

url=""
if [ -n "$dedupe_url" ]; then
  # Add a comment with the new state snapshot
  if ! url="$(gh issue comment "$dedupe_url" --repo "$REPO" --body-file "$combined" 2>&1)"; then
    echo "chad-report-bug: gh comment failed: $url" >&2
    exit 3
  fi
  url="$dedupe_url"
  action="commented"
else
  label_args=()
  for l in "${labels[@]}"; do
    label_args+=(--label "$l")
  done
  if ! url="$(gh issue create --repo "$REPO" --title "$title" \
                --body-file "$combined" "${label_args[@]}" 2>&1)"; then
    echo "chad-report-bug: gh issue create failed: $url" >&2
    exit 3
  fi
  action="filed"
fi

# 5. Append to today's memory
today="$(date -u +%Y-%m-%d)"
memory_file="${CHAD_WORKSPACE:-/sandbox/.openclaw/workspace}/memory/${today}.md"
if [ -d "$(dirname "$memory_file")" ]; then
  {
    printf '\n## Bug %s — %s\n\n' "$action" "$(date -u +%H:%M:%SZ)"
    printf '- **Title:** %s\n' "$title"
    printf '- **Repo:** %s\n'  "$REPO"
    printf '- **URL:** %s\n'   "$url"
  } >> "$memory_file"
fi

echo "$url"
