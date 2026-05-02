#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-shim — OpenAI-compatible HTTP shim around `openclaw agent`.
#
# Lives **inside** the OpenShell sandbox. Translates POST /v1/chat/completions
# into one `openclaw agent` invocation per turn so the reply benefits from the
# same gbrain context, network policies, action-gate, and premium routing that
# drive Chad's other channels.
#
# Reach it from the host:
#   ssh -fN -L 8901:localhost:8901 openshell-chad
# then in open-webui admin → Settings → Connections add OpenAI provider:
#   URL: http://host.docker.internal:8901/v1
#   Key: any non-empty placeholder
#
# Stdlib-only on purpose. The L7 trust boundary pins outbound HTTP by binary
# identity (/proc/self/exe), but this server only listens on localhost and
# spawns `openclaw` as a subprocess — no Python-side network calls.

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("CHAD_SHIM_PORT", "8901"))
MODEL_ID = os.environ.get("CHAD_SHIM_MODEL_ID", "chad")
AGENT_ID = os.environ.get("CHAD_SHIM_AGENT", "main")
OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "openclaw")
TIMEOUT_SEC = int(os.environ.get("CHAD_SHIM_TIMEOUT", "300"))


def _extract_json(text: str) -> str | None:
    """`openclaw agent --json` prints the JSON document on stdout. The runtime
    may interleave node UNDICI proxy warnings on stdout in some configs, so
    skip lines until we find one that begins with '{'."""
    for i, line in enumerate(text.splitlines(keepends=True)):
        if line.startswith("{"):
            offset = sum(len(s) for s in text.splitlines(keepends=True)[:i])
            return text[offset:]
    return None


def run_openclaw(session_id: str, message: str) -> str:
    proc = subprocess.run(
        [
            OPENCLAW_BIN, "agent", "--json",
            "--agent", AGENT_ID,
            "--session-id", session_id,
            "--message", message,
            "--timeout", str(TIMEOUT_SEC),
        ],
        capture_output=True, text=True, timeout=TIMEOUT_SEC + 30,
    )
    # OpenClaw 2026.4.24+ emits --json on stdout (was stderr in 2026.4.9).
    # Try stdout first, fall back to stderr for older runtimes.
    raw = _extract_json(proc.stdout or "") or _extract_json(proc.stderr or "")
    if raw is None:
        return f"[chad-shim] openclaw produced no JSON (rc={proc.returncode})\n{(proc.stderr or '')[-1500:]}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return f"[chad-shim] JSON parse failed: {e}\n{raw[:1500]}"
    # 2026.4.24+ wraps the response under "result"; older runtimes had it
    # at the root. Walk both and use whichever has payloads.
    result = data.get("result") if isinstance(data.get("result"), dict) else data
    payloads = result.get("payloads") or []
    parts = [p.get("text", "") for p in payloads if isinstance(p, dict) and p.get("text")]
    if parts:
        return "\n".join(parts)
    stop = (result.get("meta") or {}).get("stopReason")
    return f"[chad-shim] empty reply (stopReason={stop!r}); openclaw returned no text payloads."


def session_id_from(body: dict) -> str:
    """Stable session id keyed on the conversation's first message. open-webui
    sends a stable system+user[0] across turns of the same chat, so this maps
    each open-webui chat to a single openclaw session."""
    messages = body.get("messages") or []
    if not messages:
        return "webui-empty-" + uuid.uuid4().hex[:8]
    seed = json.dumps(
        [(m.get("role"), m.get("content")) for m in messages[:1]],
        sort_keys=True, default=str,
    )
    return "webui-" + hashlib.sha256(seed.encode()).hexdigest()[:16]


def last_user_text(body: dict) -> str:
    for m in reversed(body.get("messages") or []):
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                p.get("text", "") for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            )
    return ""


class Handler(BaseHTTPRequestHandler):
    server_version = "chad-shim/0.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[chad-shim {time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}\n")

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/v1/models", "/models"):
            self._send_json(200, {
                "object": "list",
                "data": [{
                    "id": MODEL_ID,
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "chad",
                }],
            })
            return
        if self.path == "/healthz":
            self._send_json(200, {"status": "ok", "agent": AGENT_ID})
            return
        self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json(404, {"error": {"message": "not found"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": {"message": "invalid json"}})
            return
        message = last_user_text(body)
        if not message:
            self._send_json(400, {"error": {"message": "no user message in body"}})
            return
        session_id = session_id_from(body)
        try:
            reply = run_openclaw(session_id, message)
        except subprocess.TimeoutExpired:
            self._send_json(504, {"error": {"message": "openclaw timed out"}})
            return
        except FileNotFoundError:
            self._send_json(500, {"error": {"message": f"openclaw binary not found ({OPENCLAW_BIN})"}})
            return

        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        now = int(time.time())
        if body.get("stream"):
            # SSE stream:
            # - Connection: close so the client knows EOF after [DONE] and
            #   stops the spinner. keep-alive made open-webui's frontend
            #   wait the full ~60s read timeout per turn.
            # - Flush each event so the chunk lands as soon as it's written
            #   instead of buffering until the connection closes (Python's
            #   BufferedWriter default behavior on BaseHTTPRequestHandler).
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            chunk = {
                "id": cid, "object": "chat.completion.chunk",
                "created": now, "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": reply}, "finish_reason": None}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            done = {
                "id": cid, "object": "chat.completion.chunk",
                "created": now, "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(done)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            # Explicitly mark connection as not-reusable so BaseHTTPRequestHandler
            # tears down the TCP socket immediately after this handler returns.
            self.close_connection = True
            return

        self._send_json(200, {
            "id": cid, "object": "chat.completion",
            "created": now, "model": MODEL_ID,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(
        f"[chad-shim] listening on 127.0.0.1:{PORT} (agent={AGENT_ID}, "
        f"openclaw={OPENCLAW_BIN}, timeout={TIMEOUT_SEC}s)\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
