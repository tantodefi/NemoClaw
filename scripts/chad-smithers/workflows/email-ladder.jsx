/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// email-ladder.jsx — the autonomy ladder as a Smithers workflow (Phase 5).
// Pattern (from calendar-negotiator / support-deflector / lead-router):
//   triage → draft → moderate → Approval → send
//
// SHADOW MODE BY DEFAULT: the `send` task is a no-op that only LOGS what it
// would send. Real sending requires CHAD_EMAIL_SEND=1 AND the operator being on
// the admin allowlist — and even then it routes through the existing
// chad-mail-send. Run in shadow ≥1 week (Smithers drafts, legacy path still
// sends) before any cutover. This file is a SCAFFOLD — graph-validated; wire
// the real inbox source + chad-mail-send before use.
//
// The approval gate maps to Moshi: construct the agent with approvalRouting so
// the per-operator gate surfaces on the phone (see agents.js claudecode notes).

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { pickAgent, pickFallback, taskOpts } from "../agents.js";

const DB = process.env.CHAD_EMAIL_DB || "./email-ladder.db";
const SEND = process.env.CHAD_EMAIL_SEND === "1";
// Per-operator autonomy: only these may be auto-approved (the trust boundary).
const ADMIN_ALLOWLIST = (process.env.CHAD_EMAIL_ADMIN_ALLOWLIST || "").split(",").filter(Boolean);

const schemas = {
  triage: z.object({
    operator: z.string(),
    category: z.enum(["reply", "fyi", "spam", "needs-human"]),
    urgency: z.enum(["low", "medium", "high"]),
    summary: z.string(),
  }),
  draft: z.object({ subject: z.string(), body: z.string(), confidence: z.number().min(0).max(100) }),
  moderation: z.object({ safe: z.boolean(), issues: z.array(z.string()) }),
  send: z.object({ status: z.enum(["sent", "shadow-logged", "blocked", "queued-for-human"]), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Branch, Approval, outputs } = api;

export const workflow = smithers((ctx) => {
  const inbound = ctx.input ?? {};
  const triage = (ctx.outputs.triage ?? [])[0];
  const draft = (ctx.outputs.draft ?? [])[0];
  const moderation = (ctx.outputs.moderation ?? [])[0];
  const operator = triage?.operator ?? inbound.operator ?? "unknown";
  const autoApprovable = ADMIN_ALLOWLIST.includes(operator);

  return (
    <Workflow name="chad-email-ladder">
      <Sequence>
        <Task id="triage" output={outputs.triage} agent={pickAgent("classify")} fallbackAgent={pickFallback("classify")} {...taskOpts("classify")}>
          {`Triage this inbound message. Return JSON {operator, category, urgency, summary}.\n\n${JSON.stringify(inbound).slice(0, 4000)}`}
        </Task>

        {/* category gating is per-task skipIf — a `<Branch if={upstreamOutput}>`
            does not reopen once triage completes (verified). Draft only for replies. */}
        <Task id="draft" skipIf={triage?.category !== "reply"} output={outputs.draft} agent={pickAgent("draft")} fallbackAgent={pickFallback("draft")} {...taskOpts("draft")}>
            {`Draft a reply in the operator's voice. Return JSON {subject, body, confidence}.\n\nContext: ${triage?.summary ?? ""}\nOriginal: ${JSON.stringify(inbound).slice(0, 4000)}`}
          </Task>

          {/* Trust & safety gate on outbound (the layer the ladder lacked). */}
          <Task id="moderation" skipIf={triage?.category !== "reply"} output={outputs.moderation} agent={pickAgent("judge")} fallbackAgent={pickFallback("judge")} {...taskOpts("judge")}>
            {`Screen this draft for anything that should NOT be auto-sent (PII leak, commitments, tone, hallucinated facts). Return JSON {safe, issues}.\n\n${draft?.body ?? ""}`}
          </Task>

          {/* Send — gated by needsApproval unless an allowlisted operator with a
              clean moderation pass (human-in-the-loop; pauses as waiting-approval).
              Surfaces on the phone via Moshi when constructed with approvalRouting. */}
          <Task id="send" skipIf={triage?.category !== "reply"} needsApproval={!(autoApprovable && moderation?.safe)} output={outputs.send} sideEffect idempotencyKey={`send-${inbound.messageId ?? "unknown"}`}>
            {() => {
              if (!moderation?.safe) return { status: "queued-for-human", detail: `moderation flagged: ${(moderation?.issues || []).join("; ")}` };
              if (!SEND) return { status: "shadow-logged", detail: `SHADOW: would send "${draft?.subject}" to ${operator}` };
              // Real send goes through the existing gated chad-mail-send (pod).
              // Intentionally not invoked here until the shadow period proves out.
              return { status: "blocked", detail: "CHAD_EMAIL_SEND=1 set but live send wiring intentionally deferred to chad-mail-send" };
            }}
          </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
