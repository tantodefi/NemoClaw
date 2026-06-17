// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/note.js — post an operator-visible OpenWebUI note from a host workflow.
//
// chad-webui lives ON THE POD, not the host (it needs the per-operator API key
// + the L7-MITM TLS plumbing). So a host-side Smithers workflow posts by
// streaming the note body over ssh and running chad-webui there — the exact
// pattern run-experiments.sh uses for the nightly leaderboard (verified
// 2026-06-13: `notes create --content-file` returns the note id).
//
// Best-effort: a posting failure never throws. Returns {posted, id?, error?}.

import { execFile } from "node:child_process";

const POD_SSH = process.env.CHAD_POD_SSH || "openshell-chad";
const POD_WEBUI = process.env.CHAD_WEBUI_POD_BIN || "/sandbox/.openclaw-data/bin/chad-webui";

function ssh(args, opts = {}) {
  return new Promise((resolve) => {
    execFile("ssh", ["-o", "ConnectTimeout=15", ...args], { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

/**
 * postNote({ title, content, tags }) — create an OpenWebUI note on the pod.
 * Returns { posted: boolean, id?: string, error?: string }. Never throws.
 */
export async function postNote({ title, content, tags = "" }) {
  const safeTitle = String(title || "Chad note").replace(/'/g, "");
  const tagArg = tags ? `--tags ${String(tags).replace(/'/g, "")}` : "";
  const remote = `cat > /tmp/chad-note.md && '${POD_WEBUI}' notes create --title '${safeTitle}' --content-file /tmp/chad-note.md ${tagArg}`;
  // No -n here: we pipe the note body to the remote `cat` via stdin (`input`).
  const r = await ssh([POD_SSH, remote], { input: String(content || "") });
  if (r.code !== 0) return { posted: false, error: (r.stderr || `ssh rc=${r.code}`).slice(0, 300) };
  const m = r.stdout.match(/[0-9a-f-]{8,}/i);
  return { posted: true, id: m ? m[0] : undefined };
}
