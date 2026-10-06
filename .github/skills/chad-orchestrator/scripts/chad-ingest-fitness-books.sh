#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-ingest-fitness-books.sh — One-time ingest of fitness reference books
# into gbrain so the `fitness` sub-agent kind can answer questions locally.
#
# Books ingested:
#   - Starting Strength, 3rd ed. (Mark Rippetoe) — archive.org item
#       mark-rippetoe-starting-strength-3rd-edition-the-aasgaard-company-2011
#   - Supple Leopard (Kelly Starrett) — archive.org item
#       pdfy-PRTcysrLI4Malz8h
#
# Usage:
#   chad-ingest-fitness-books.sh [--dry-run] [--book starting-strength|supple-leopard|both]
#
# Options:
#   --dry-run    Print what would be ingested without writing to gbrain.
#   --book BOOK  Ingest only one book (default: both).
#
# The script uses the archive.org metadata API to locate the OCR text file
# for each item, downloads it, chunks it into ~1500-char pages, and calls
# `gbrain put-page` for each chunk. Re-running is safe — gbrain put-page is
# idempotent on title.

set -euo pipefail

DRY_RUN=0
BOOK="both"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --book)
      BOOK="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "chad-ingest-fitness-books: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

command -v gbrain >/dev/null 2>&1 || {
  echo "chad-ingest-fitness-books: gbrain not found on PATH" >&2
  exit 3
}

# ---------------------------------------------------------------------------
# Python helper: fetch archive.org item text, chunk, and ingest into gbrain
# ---------------------------------------------------------------------------
ingest_item() {
  local item_id="$1"
  local book_title="$2"
  local tag="$3"
  # Optional 4th arg: regex pattern that the file name must match. archive.org
  # bundle items can hold dozens of unrelated PDFs/OCR txt files (e.g. the
  # Starting Strength 2011 item is actually a strength-training bundle with
  # 116 files). Without a pattern, the picker grabs the alphabetically-first
  # *_djvu.txt and you end up indexing FEROCIOUS FITNESS by Phil Ross instead
  # of the Mark Rippetoe book that the slug suggests.
  local name_pattern="${4:-}"

  echo "==> $book_title ($item_id)"

  DRY_RUN_FLAG="$DRY_RUN" \
    ITEM_ID="$item_id" \
    BOOK_TITLE="$book_title" \
    BOOK_TAG="$tag" \
    NAME_PATTERN="$name_pattern" \
    python3 <<'PYEOF'
import json, os, re, subprocess, sys, urllib.parse

item_id      = os.environ["ITEM_ID"]
title        = os.environ["BOOK_TITLE"]
tag          = os.environ["BOOK_TAG"]
dry_run      = os.environ["DRY_RUN_FLAG"] == "1"
name_pattern = os.environ.get("NAME_PATTERN", "") or None

CHUNK_CHARS = 1500
OVERLAP_PARAS = 1  # carry last paragraph into next chunk for context

def curl_get(url, timeout=30):
    r = subprocess.run(
        ["curl", "-sS", "-L", "--max-time", str(timeout), url],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace").strip() or f"curl exit {r.returncode}")
    return r.stdout

# 1. Fetch archive.org metadata to find the OCR text file.
meta_url = f"https://archive.org/metadata/{item_id}"
print(f"  Fetching metadata: {meta_url}")
try:
    meta = json.loads(curl_get(meta_url, timeout=30))
except Exception as exc:
    print(f"  [ERROR] metadata fetch failed: {exc}", file=sys.stderr)
    sys.exit(1)

files    = meta.get("files", [])

# Pick the OCR text file:
#   1. If NAME_PATTERN is set, prefer *_djvu.txt files whose name (case-
#      insensitive) matches the pattern. This lets us scope to a specific
#      title in a multi-book archive item.
#   2. Fall back to any *_djvu.txt with the pattern in the name (any
#      extension).
#   3. Final fallback: first *_djvu.txt at all (legacy behavior).
pattern_re = re.compile(name_pattern, re.IGNORECASE) if name_pattern else None

def _match(name, want_djvu):
    if want_djvu and not name.endswith("_djvu.txt"):
        return False
    if not want_djvu and (name.endswith("_djvu.txt") or not name.endswith(".txt")):
        return False
    if pattern_re and not pattern_re.search(name):
        return False
    return True

text_file = None
for want_djvu in (True, False):
    for f in files:
        n = f.get("name", "")
        if _match(n, want_djvu):
            text_file = n
            break
    if text_file:
        break

# Legacy fallback: first *_djvu.txt (no pattern) — keeps single-book
# items working when caller didn't pass a pattern.
if not text_file and not pattern_re:
    for f in files:
        if f.get("name", "").endswith("_djvu.txt"):
            text_file = f["name"]
            break

if not text_file:
    msg = f"  [WARN] No OCR text file found for {title}"
    if pattern_re:
        msg += f" (pattern: {name_pattern})"
    msg += " — skipping"
    print(msg, file=sys.stderr)
    sys.exit(0)

# Use canonical archive.org download URL (goes through archive.org, not CDN subdomains)
text_url = f"https://archive.org/download/{item_id}/{urllib.parse.quote(text_file)}"
print(f"  Downloading: {text_url}")

try:
    raw = curl_get(text_url, timeout=120).decode("utf-8", errors="replace")
except Exception as exc:
    print(f"  [ERROR] download failed: {exc}", file=sys.stderr)
    sys.exit(1)

print(f"  Downloaded {len(raw):,} chars")

# 2. Chunk on paragraph boundaries.
paras = [p.strip() for p in re.split(r'\n{2,}', raw) if p.strip()]

chunks = []
buf, buf_len = [], 0
for para in paras:
    if buf_len + len(para) > CHUNK_CHARS and buf:
        chunks.append("\n\n".join(buf))
        buf = buf[-OVERLAP_PARAS:]          # carry-over for context
        buf_len = sum(len(p) for p in buf)
    buf.append(para)
    buf_len += len(para)
if buf:
    chunks.append("\n\n".join(buf))

total = len(chunks)
print(f"  {total} chunks to ingest")

if dry_run:
    print(f"  [dry-run] would call: gbrain put x{total} (tags: fitness,{tag},book-chunk)")
    sys.exit(0)

# 3. Ingest via `gbrain put <slug> --content <frontmatter+body>`.
errors = 0
for i, chunk in enumerate(chunks, 1):
    chunk_title = f"{title} — chunk {i:04d}/{total:04d}"
    slug = re.sub(r"[^a-z0-9]+", "-", chunk_title.lower()).strip("-")
    content = (
        f"---\ntitle: \"{chunk_title}\"\ntags: [fitness, {tag}, book-chunk]\n---\n\n"
        + chunk
    )
    result = subprocess.run(
        ["gbrain", "put", slug, "--content", content],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        errors += 1
        print(f"  [WARN] chunk {i} failed: {result.stderr[:120]}", file=sys.stderr)
    elif i % 100 == 0 or i == total:
        print(f"  Ingested {i}/{total}...")

status = "done" if errors == 0 else f"done with {errors} errors"
print(f"  {title}: {status}")
PYEOF
}

case "$BOOK" in
  starting-strength)
    # archive item is a strength-training bundle (~116 files); pin the
    # picker to Rippetoe's Starting Strength specifically, not the
    # alphabetically-first FEROCIOUS FITNESS_djvu.txt.
    ingest_item \
      "mark-rippetoe-starting-strength-3rd-edition-the-aasgaard-company-2011" \
      "Starting Strength" \
      "starting-strength" \
      'Mark Rippetoe.*Starting Strength'
    ;;
  supple-leopard)
    ingest_item \
      "pdfy-PRTcysrLI4Malz8h" \
      "Supple Leopard" \
      "supple-leopard"
    ;;
  both)
    ingest_item \
      "mark-rippetoe-starting-strength-3rd-edition-the-aasgaard-company-2011" \
      "Starting Strength" \
      "starting-strength" \
      'Mark Rippetoe.*Starting Strength'
    ingest_item \
      "pdfy-PRTcysrLI4Malz8h" \
      "Supple Leopard" \
      "supple-leopard"
    ;;
  *)
    echo "chad-ingest-fitness-books: unknown --book value: $BOOK" >&2
    exit 2
    ;;
esac

echo ""
echo "==> Ingest complete. Verify with:"
echo "      gbrain query 'squat technique' --tags starting-strength"
echo "      gbrain query 'hip flexor mobility' --tags supple-leopard"
