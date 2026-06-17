/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// content-pipeline.jsx — the research → write → review multi-spawn flow (#15).
//
// chad-spawn today does this as three separate one-shot spawns the operator
// chains by hand (researcher → writer → reviewer). As a Smithers workflow the
// chain is durable and inspectable: each stage is its own task, the reviewer's
// verdict gates an Approval, and publish is shadow-safe.
//
// Pipeline:  research (spawn) → draft (spawn) → review (spawn) →
//            [Approval unless reviewer says ship] → publish (shadow)
//
// Each stage offloads to chad-spawn via the bridge (lib/spawn.js). Heavy stages
// can run on a GH runner (substrate: "gha"); the default keeps research/draft
// local (they want gbrain) and review can go either way. Like chad-spawn's
// safety property: sub-agents DRAFT, the parent (this workflow + the operator's
// Approval) PUBLISHES.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { runSpawn, spawnResultSchema } from "../lib/spawn.js";

const DB = process.env.CHAD_CONTENT_DB || "./content-pipeline.db";
const PUBLISH = process.env.CHAD_CONTENT_PUBLISH === "1"; // shadow unless set

const schemas = {
  research: spawnResultSchema,
  draft: spawnResultSchema,
  review: spawnResultSchema,
  publish: z.object({ status: z.enum(["published", "shadow-logged", "blocked"]), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, Branch, Approval, outputs } = api;

// reviewer result.json may carry a verdict in summary/follow_ups; treat an
// explicit "ship"/"approve" token as auto-shippable, else require Approval.
function reviewerSaysShip(r) {
  const t = `${r?.summary || ""} ${(r?.follow_ups || []).join(" ")}`.toLowerCase();
  return r?.status === "done" && /\b(ship|approve|lgtm|no blockers)\b/.test(t) && !/\b(block|reject|do not|needs work)\b/.test(t);
}

export const workflow = smithers((ctx) => {
  const topic = ctx.input?.topic || process.env.CHAD_CONTENT_TOPIC
    || "Draft a short announcement note for the runs.supachad.com Smithers IDE.";
  const research = (ctx.outputs.research ?? [])[0];
  const draft = (ctx.outputs.draft ?? [])[0];
  const review = (ctx.outputs.review ?? [])[0];

  return (
    <Workflow name="chad-content-pipeline">
      <Sequence>
        <Task id="research" output={outputs.research} sideEffect idempotencyKey={`content-research-${topic.slice(0, 40)}`}>
          {() => runSpawn({ kind: "researcher", substrate: "local", id: "content-research",
            task: `Research for this content task (brain-first; gh/web if needed). Produce notes + sources.\n\n${topic}` })}
        </Task>

        <Task id="draft" output={outputs.draft} sideEffect idempotencyKey={`content-draft-${topic.slice(0, 40)}`}>
          {() => runSpawn({ kind: "writer", substrate: "local", id: "content-draft",
            task: `Write the content using these research notes. Never publish — draft to the workdir.\n\n` +
              `Topic: ${topic}\n\nResearch summary: ${research?.summary || "(none)"}` })}
        </Task>

        <Task id="review" output={outputs.review} sideEffect idempotencyKey={`content-review-${topic.slice(0, 40)}`}>
          {() => runSpawn({ kind: "reviewer", substrate: "local", id: "content-review",
            task: `Review this draft for accuracy, tone, and anything that should NOT ship. ` +
              `End your summary with "ship" if it's good to publish, or list blockers.\n\n` +
              `Draft summary: ${draft?.summary || "(none)"}` })}
        </Task>

        {/* Operator gate unless the reviewer explicitly cleared it. */}
        <Branch if={!reviewerSaysShip(review)}>
          <Approval id="publish-approval"
            prompt={`Publish "${topic.slice(0, 60)}"? reviewer=${review?.status} note=${(review?.summary || "").slice(0, 120)}`} />
        </Branch>

        <Task id="publish" output={outputs.publish} sideEffect idempotencyKey={`content-publish-${topic.slice(0, 40)}`}>
          {() => {
            if (!PUBLISH) return { status: "shadow-logged", detail: `SHADOW: would publish "${topic.slice(0, 60)}" (draft from writer spawn)` };
            // Real publish wiring (chad-webui note / gh / mail) is intentionally
            // deferred — keep this in shadow until the chain proves out.
            return { status: "blocked", detail: "CHAD_CONTENT_PUBLISH=1 set but live publish wiring intentionally deferred" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
