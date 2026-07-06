// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/opencode.js — run opencode big-pickle DIRECTLY on the host (the fallback coder
// path for coding-task when there's no chad-spawn transport). The pod/GHA spawn
// (lib/spawn.js) stays the DEFAULT — isolated workdir + L7 policy — but on a host
// where `opencode` is installed + authed, this lets the coding pipeline actually run
// end-to-end. Still draft-only + isolated: opencode runs inside a fresh temp workdir
// (mkdtemp), never the live repo. Returns a spawnResultSchema-shaped object so the
// workflow's `code` output is identical whichever coder path ran. Never throws.

import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Base for the isolated coder workdir. Default /tmp (not macOS $TMPDIR/var/folders):
// opencode's write tool operates reliably under /tmp but was observed to no-op in a
// bare $TMPDIR dir. Override with CHAD_CODING_TMPBASE.
const TMP_BASE = process.env.CHAD_CODING_TMPBASE || "/tmp";

const OPENCODE_BIN = process.env.CHAD_OPENCODE_BIN || "opencode";
const MODEL = process.env.CHAD_OPENCODE_MODEL || "opencode/big-pickle";
// Default `--pure` (no external plugins): the coder runs AUTONOMOUSLY — it doesn't
// register a Moshi agent session (no per-run "WORKING" card clutter) and doesn't
// route each write to a per-action phone approval that would block a long unattended
// build. Human review happens once, at the workflow's Approval gate. Set
// CHAD_CODING_INTERACTIVE=1 to keep plugins (per-action Moshi approve/deny buttons).
const PURE = process.env.CHAD_CODING_INTERACTIVE !== "1";

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cp = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, out, errout) => resolve({ code: err ? (err.code ?? 1) : 0, out: (out || "").toString() + (errout || "").toString() }));
    // CRITICAL: close the child's stdin. execFile leaves it an OPEN pipe, and
    // `opencode run` blocks waiting on stdin — it only proceeds on EOF. Without
    // this the coder hangs until the timeout (the demo-build wedge).
    try { cp.stdin && cp.stdin.end(); } catch { /* */ }
  });
}

// Shallow list of files opencode created/touched in the workdir (the "diff").
function listFiles(dir, base = dir, acc = [], depth = 0) {
  if (depth > 4) return acc;
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) listFiles(p, base, acc, depth + 1);
    else acc.push(p.slice(base.length + 1));
  }
  return acc;
}

/**
 * runOpencodeDirect({ task, id, workdir?, timeoutMs? }) — run opencode big-pickle
 * non-interactively in an isolated temp workdir. Resolves to a spawnResultSchema-
 * shaped object { status, summary, kind, substrate, task_id, exit_code, artifacts,
 * workdir }. Never throws (a coder failure must not sink the run).
 */
export async function runOpencodeDirect({ task = "", id, workdir, timeoutMs } = {}) {
  const shape = (o) => ({ kind: "opencode", substrate: "direct", task_id: id || `oc-${Date.now().toString(36)}`, follow_ups: [], ...o });
  const okBin = await exec(OPENCODE_BIN, ["--version"]);
  if (okBin.code !== 0) return shape({ status: "failed", exit_code: 2, summary: `opencode not runnable (${okBin.out.slice(0, 120)}) — use the spawn coder or install opencode` });

  const dir = workdir || mkdtempSync(join(TMP_BASE, "chad-coding-"));
  const t = Number(timeoutMs || process.env.CHAD_SPAWN_TIMEOUT_MS || 1_800_000);
  const runArgs = ["run", task, "-m", MODEL, "--print-logs"];
  if (PURE) runArgs.push("--pure");
  const r = await exec(OPENCODE_BIN, runArgs, { cwd: dir, timeout: t });
  const files = existsSync(dir) ? listFiles(dir) : [];
  const tail = r.out.slice(-1500);
  return shape({
    status: r.code === 0 ? "done" : "failed",
    exit_code: r.code,
    summary: (r.code === 0 ? "opencode big-pickle wrote " + files.length + " file(s)" : "opencode run exited " + r.code) + (tail ? ` — ${tail.split("\n").slice(-3).join(" ").slice(0, 240)}` : ""),
    artifacts: files.slice(0, 50),
    workdir: dir,
  });
}
