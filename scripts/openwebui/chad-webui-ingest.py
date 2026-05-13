#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-webui-ingest — daily push of OpenWebUI chat history into sandbox gbrain.
#
# OpenWebUI's webui.db lives on the host (~/.nemoclaw/openwebui/data/webui.db),
# disconnected from the sandbox's gbrain. Without this script, chats users
# have with the agent via OpenWebUI never reach the long-term memory consolidation
# pipeline — chad-gbrain-dream sees the agent's session log but not the
# human-facing transcript / title / structure.
#
# This script reads chats updated since LOOKBACK_HOURS, formats each as
# markdown, and ships it to the sandbox via SSH for `gbrain put chat/<id>`.
# Idempotent — `gbrain put` upserts by slug.
#
# Schedule: ~/Library/LaunchAgents/dev.nemoclaw.chad-webui-ingest.plist,
# 04:30 UTC (1h after chad-gbrain-dream so the dream digest reflects today).

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HOME = Path(os.environ["HOME"])
DB = Path(os.environ.get("WEBUI_DB", HOME / ".nemoclaw/openwebui/data/webui.db"))
SSH_HOST = os.environ.get("CHAD_SSH_HOST", "openshell-chad")
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "25"))
LOG_FILE = Path(os.environ.get("WEBUI_INGEST_LOG", HOME / ".nemoclaw/openwebui/webui-ingest.log"))
PUT_TIMEOUT = int(os.environ.get("PUT_TIMEOUT", "60"))


def log(msg: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"
    sys.stderr.write(line)
    with LOG_FILE.open("a") as f:
        f.write(line)


def normalize_messages(chat_obj: dict) -> list[dict]:
    """OpenWebUI stores messages either as an ordered list or a dict keyed by
    id, depending on schema version. Normalize to a chronological list."""
    msgs = chat_obj.get("messages")
    if isinstance(msgs, list):
        return msgs
    if isinstance(msgs, dict):
        # Fall back to dict-by-id with parent_id chains, but lists are most
        # common. Use timestamp ordering when available.
        items = list(msgs.values())
        items.sort(key=lambda m: m.get("timestamp") or m.get("created_at") or 0)
        return items
    history = chat_obj.get("history", {})
    if isinstance(history, dict) and history.get("messages"):
        return normalize_messages({"messages": history["messages"]})
    return []


def extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            p.get("text", "") for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return ""


def render_chat(chat_id: str, user_id: str, title: str, created_at, updated_at, chat_obj: dict) -> str:
    lines = [
        "---",
        f"chat_id: {chat_id}",
        f"user_id: {user_id}",
        f"title: {json.dumps(title or '(untitled)')}",
        f"created_at: {created_at}",
        f"updated_at: {updated_at}",
        "source: openwebui",
        "---",
        "",
        f"# {title or '(untitled)'}",
        "",
    ]
    for i, m in enumerate(normalize_messages(chat_obj), start=1):
        if not isinstance(m, dict):
            continue
        role = (m.get("role") or "?").title()
        ts = m.get("timestamp") or m.get("created_at")
        head = f"## {i}. {role}"
        if ts:
            head += f" — {ts}"
        lines.append(head)
        lines.append("")
        body = extract_text(m.get("content")).strip()
        lines.append(body or "_(empty)_")
        lines.append("")
    return "\n".join(lines)


def push_to_sandbox(slug: str, markdown: str) -> tuple[bool, str]:
    # gbrain put takes --content <string>; passing megabytes through argv
    # risks E2BIG. Stream the content to a temp file inside the sandbox
    # via SSH stdin, then invoke gbrain put against the temp.
    remote_script = (
        'set -eu; tmp=$(mktemp); '
        'cat >"$tmp"; '
        f'gbrain put {slug!r} --content "$(cat \"$tmp\")"; '
        'rm -f "$tmp"'
    )
    try:
        result = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", SSH_HOST, remote_script],
            input=markdown.encode("utf-8"),
            capture_output=True,
            timeout=PUT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except FileNotFoundError:
        return False, "ssh not found on host"
    if result.returncode != 0:
        return False, (result.stderr.decode("utf-8", "replace")[:240] or f"exit {result.returncode}")
    return True, "ok"


def main() -> None:
    if not DB.exists():
        log(f"webui.db missing at {DB}; nothing to ingest")
        return
    cutoff_ts = time.time() - LOOKBACK_HOURS * 3600
    con = sqlite3.connect(str(DB))
    rows = con.execute(
        "SELECT id, user_id, title, created_at, updated_at, chat "
        "FROM chat WHERE archived = 0 AND updated_at > ? "
        "ORDER BY updated_at DESC",
        (cutoff_ts,),
    ).fetchall()
    con.close()

    log(f"sweep start — db={DB} lookback={LOOKBACK_HOURS}h candidates={len(rows)}")
    pushed = skipped = failed = 0
    for chat_id, user_id, title, created_at, updated_at, chat_json in rows:
        try:
            chat_obj = json.loads(chat_json or "{}")
        except json.JSONDecodeError as e:
            log(f"skip {chat_id}: bad JSON ({e})")
            skipped += 1
            continue
        if not normalize_messages(chat_obj):
            log(f"skip {chat_id}: no messages")
            skipped += 1
            continue
        md = render_chat(chat_id, user_id, title, created_at, updated_at, chat_obj)
        ok, detail = push_to_sandbox(f"chat/{chat_id}", md)
        if ok:
            pushed += 1
        else:
            failed += 1
            log(f"FAIL chat/{chat_id}: {detail}")
    log(f"sweep done — pushed={pushed} skipped={skipped} failed={failed}")


if __name__ == "__main__":
    main()
