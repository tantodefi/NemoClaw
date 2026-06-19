/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// log-digest.jsx — the recurring manual cron/service-log audit, automated (#23).
//
// From the example census: "log-digest / error-clusterer → the recurring manual
// cron-log audit sessions as a scheduled workflow emitting an OpenWebUI note."
// Chad (and the operator) periodically grep the host launchd logs for the
// gateway/shim/tunnel watchdogs and the model-refresh/ingest jobs to see what
// broke overnight. This makes that a scheduled, durable workflow.
//
// Pipeline:  collect (read host *.log tails) → cluster (cheap LLM) → note (shadow)
//
// Reads host-side logs by default (no SSH, no pod) so it's useful immediately:
// ~/.nemoclaw/openwebui/*.log + *.err.log (gateway/shim/tunnel watchdogs,
// chad-models-refresh, webui-ingest, nvidia-liveness). Frugal: a single cheap
// model call. The note is shadow-logged unless CHAD_LOGDIGEST_POST=1.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_LOGDIGEST_DB || "./log-digest.db";
const LOG_DIR = process.env.CHAD_LOGDIGEST_DIR || `${homedir()}/.nemoclaw/openwebui`;
const TAIL = Number(process.env.CHAD_LOGDIGEST_TAIL || 80);
const POST = process.env.CHAD_LOGDIGEST_POST === "1";

const schemas = {
  collected: z.object({ files: z.number(), errorLines: z.number(), sample: z.string() }),
  digest: z.object({ clusters: z.array(z.object({ signature: z.string(), count: z.number(), severity: z.enum(["info", "warn", "error"]), action: z.string() })), summary: z.string() }),
  note: z.object({ status: z.enum(["posted", "shadow-logged", "quiet"]), title: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Branch, outputs } = api;

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout) => resolve(err ? "" : stdout.toString()));
  });
}

export const workflow = smithers((ctx) => {
  const collected = (ctx.outputs.collected ?? [])[0];
  const digest = (ctx.outputs.digest ?? [])[0];
  const hasSignal = (collected?.errorLines ?? 0) > 0;

  return (
    <Workflow name="chad-log-digest">
      <Sequence>
        {/* 1) Collect error/warn lines from the host service logs. Read-only. */}
        <Task id="collect" output={outputs.collected} sideEffect idempotencyKey={`logdigest-collect-${new Date().toISOString().slice(0, 13)}`}>
          {async () => {
            const list = await sh("sh", ["-c", `ls ${LOG_DIR}/*.log ${LOG_DIR}/*.err.log 2>/dev/null || true`]);
            const files = list.split("\n").filter(Boolean);
            let errors = [];
            for (const f of files) {
              const t = await sh("sh", ["-c", `tail -n ${TAIL} '${f}' 2>/dev/null | grep -iE 'error|exception|traceback|fail|fatal|refused|timeout' || true`]);
              for (const ln of t.split("\n").filter(Boolean)) errors.push(`${f.split("/").pop()}: ${ln}`);
            }
            return { files: files.length, errorLines: errors.length, sample: errors.slice(0, 120).join("\n").slice(0, 8000) };
          }}
        </Task>

        {/* 2) Cluster + summarize — one frugal cheap-tier call. Only if there's signal. */}
        <Branch if={hasSignal}>
          <Task id="cluster" output={outputs.digest} agent={pickAgent("summarize")} fallbackAgent={pickFallback("summarize")} {...taskOpts("summarize")}>
            {[
              "Cluster these host service-log error lines into distinct issues. Collapse repeats into one signature with a count.",
              `Log lines (${collected?.errorLines ?? 0} from ${collected?.files ?? 0} files):\n${collected?.sample || ""}`,
              'Return JSON {clusters:[{signature,count,severity,action}], summary}. severity ∈ info|warn|error. action = the one next step.',
            ].join("\n\n")}
          </Task>
        </Branch>

        {/* 3) Note — quiet on a clean run (fail-only ethos). Posts a real
            OpenWebUI note when CHAD_LOGDIGEST_POST=1 (reversible artifact);
            otherwise logs what it would post. */}
        <Task id="note" output={outputs.note} sideEffect idempotencyKey={`logdigest-note-${new Date().toISOString().slice(0, 13)}`}>
          {async () => {
            if (!hasSignal) return { status: "quiet", title: "log-digest: clean (no errors in window)" };
            const title = `Log digest — ${new Date().toISOString().slice(0, 16)} — ${digest?.clusters?.length ?? 0} clusters`;
            if (!POST) return { status: "shadow-logged", title: `SHADOW: ${title}` };
            const body = `# ${title}\n\n${digest?.summary || ""}\n\n` +
              (digest?.clusters || []).map((c) => `- **[${c.severity}]** ${c.signature} (×${c.count}) → ${c.action}`).join("\n");
            const res = await postNote({ title, content: body, tags: "chad-logs" });
            return { status: res.posted ? "posted" : "shadow-logged", title: res.posted ? `${title} (note ${res.id || "ok"})` : `${title} (post failed: ${res.error})` };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
