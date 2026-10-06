/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// canary-judge.jsx — post-deploy canary verification via Smithers' built-in
// <Poller> composite (adopted in the 0.26 upgrade). Polls a health endpoint until
// it's stably healthy or a timeout, then a judge rules promote / hold / rollback.
//
// Pipeline:  Poller[ GET health endpoint until `satisfied` (healthy) or timeout ] →
//            judge (assess the outcome → promote|hold|rollback) → report
//
// The poll check is a DETERMINISTIC compute fn (an HTTP GET) — no model burned on
// the probe itself; only the final promote/rollback judgement uses an agent.
//
// Shadow-safe: read-only HTTP; never promotes or rolls back anything (advisory
// verdict + optional note). `smithers up workflows/canary-judge.jsx --input
// '{"url":"https://.../health"}'` runs anywhere.

import { createSmithers, Poller } from "smithers-orchestrator";
import { z } from "zod";
import { pickAgent } from "../agents.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_CANARY_DB || "./canary-judge.db";
const DEFAULT_URL = process.env.CHAD_CANARY_URL || "http://127.0.0.1:7331/api/health";
const MAX_ATTEMPTS = Number(process.env.CHAD_CANARY_MAX_ATTEMPTS || 6);
const INTERVAL_MS = Number(process.env.CHAD_CANARY_INTERVAL_MS || 5000);
const POST = process.env.CHAD_CANARY_POST === "1";

const schemas = {
  // Poller checkOutput — MUST include `satisfied: boolean`.
  probe: z.object({
    satisfied: z.boolean(),
    httpStatus: z.number(),
    detail: z.string(),
  }),
  verdict: z.object({
    action: z.enum(["promote", "hold", "rollback"]),
    reason: z.string(),
  }),
  report: z.object({ note: z.string(), action: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

export const workflow = smithers((ctx) => {
  const url = ctx.input?.url || DEFAULT_URL;
  const probe = (ctx.outputs.probe ?? []).slice(-1)[0]; // last poll result
  const verdict = (ctx.outputs.verdict ?? [])[0];
  const healthy = !!probe?.satisfied;

  return (
    <Workflow name="chad-canary-judge">
      <Sequence>
        {/* 1) Poll the canary health endpoint until healthy or timeout. The check
            is a plain async fn — a bounded HTTP GET — so no model is spent probing. */}
        <Poller
          id="canary"
          checkOutput={outputs.probe}
          maxAttempts={MAX_ATTEMPTS}
          intervalMs={INTERVAL_MS}
          backoff="linear"
          onTimeout="return-last"
          check={async () => {
            try {
              const ac = new AbortController();
              const t = setTimeout(() => ac.abort(), 8000);
              const r = await fetch(url, { signal: ac.signal });
              clearTimeout(t);
              const body = (await r.text()).slice(0, 400);
              const ok = r.ok && /\bok\b|healthy|"ok"\s*:\s*true/i.test(body);
              return { satisfied: ok, httpStatus: r.status, detail: ok ? "healthy" : `unexpected: ${body.slice(0, 120)}` };
            } catch (e) {
              return { satisfied: false, httpStatus: 0, detail: `unreachable: ${String(e.message).slice(0, 120)}` };
            }
          }}
        >
          {`Polling canary health at ${url} — satisfied when it returns 2xx + a healthy body.`}
        </Poller>

        {/* 2) Judge the outcome → promote | hold | rollback. Cheap tier: this is a
            small rule-like call over the final probe. */}
        <Task id="judge" output={outputs.verdict} agent={pickAgent("classify")}>
          {[
            `A canary at ${url} was polled ${MAX_ATTEMPTS}× (interval ${INTERVAL_MS}ms).`,
            `Final probe: healthy=${healthy}, httpStatus=${probe?.httpStatus ?? "?"}, detail="${probe?.detail || ""}".`,
            "Decide the action: `promote` (stably healthy), `hold` (flaky/inconclusive), `rollback` (failing).",
            "Return JSON { action: promote|hold|rollback, reason }.",
          ].join("\n")}
        </Task>

        {/* 3) Report — advisory only. Never promotes/rolls back; posts a note when POST=1. */}
        <Task id="report" output={outputs.report} sideEffect idempotencyKey={`canary-report-${url.slice(0, 60)}-${new Date().toISOString().slice(0, 13)}`}>
          {async () => {
            const title = `Canary — ${url} — ${verdict?.action || (healthy ? "healthy" : "unhealthy")}`;
            const body = `# ${title}\n\nFinal probe: \`${probe?.httpStatus ?? "?"}\` ${probe?.detail || ""}\n\n` +
              `**Recommended action: ${verdict?.action || "?"}** — ${verdict?.reason || ""}`;
            if (POST) await postNote({ title, content: body, tags: "chad-canary" });
            return { note: POST ? `${title} (posted)` : `SHADOW: ${title}`, action: verdict?.action || "?" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
