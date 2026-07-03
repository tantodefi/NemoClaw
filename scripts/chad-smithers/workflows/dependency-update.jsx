/** @jsxImportSource smithers-orchestrator */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// dependency-update.jsx — keep chad-smithers' deps current, safely, using
// Smithers' built-in <ScanFixVerify> composite (adopted in the 0.26 upgrade).
// Timely because we just pinned `smithers-orchestrator` — this is the loop that
// proposes the next bump instead of letting the pin rot.
//
// Pipeline:  collect (deterministic `npm outdated` + read pins) →
//            ScanFixVerify[ scanner triages outdated deps into safe/risky →
//                           fixer drafts the bump set → verifier sanity-checks ] →
//            apply (Approval-gated; shadow unless CHAD_DEPUPDATE_APPLY=1)
//
// Shadow-safe: collect is read-only; the scan/fix/verify agents only PROPOSE a
// bump set (never edit package.json); apply is gated and shadow by default, so a
// bare `smithers up workflows/dependency-update.jsx` produces a visible run and a
// drafted bump plan with nothing written. Mirrors skill-improve's propose-only
// contract.

import { createSmithers, ScanFixVerify } from "smithers-orchestrator";
import { z } from "zod";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickAgent } from "../agents.js";
import { postNote } from "../lib/note.js";

const DB = process.env.CHAD_DEPUPDATE_DB || "./dependency-update.db";
const HERE = new URL(".", import.meta.url).pathname;
const PKG = join(HERE, "..", "package.json");
const APPLY = process.env.CHAD_DEPUPDATE_APPLY === "1"; // actually write the bumps
const POST = process.env.CHAD_DEPUPDATE_POST === "1"; // post the plan as a note

const schemas = {
  deps: z.object({ outdated: z.number(), sample: z.string() }),
  // ScanFixVerify scanOutput — MUST expose `issues: Array`.
  scan: z.object({
    issues: z.array(z.object({
      name: z.string(),
      from: z.string(),
      to: z.string(),
      risk: z.enum(["safe", "review", "risky"]),
    })),
    summary: z.string(),
  }),
  fix: z.object({ name: z.string(), bump: z.string(), rationale: z.string() }),
  verify: z.object({ name: z.string(), ok: z.boolean(), note: z.string() }),
  report: z.object({ plan: z.string(), safe: z.number(), risky: z.number() }),
  apply: z.object({ status: z.string(), detail: z.string() }),
};

const api = createSmithers(schemas, { dbPath: DB });
const { smithers, Workflow, Task, Sequence, outputs } = api;

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: join(HERE, ".."), maxBuffer: 8 * 1024 * 1024 }, (_e, out) => resolve(out ? out.toString() : ""));
  });
}

export const workflow = smithers((ctx) => {
  const deps = (ctx.outputs.deps ?? [])[0];
  const scan = (ctx.outputs.scan ?? [])[0];
  const report = (ctx.outputs.report ?? [])[0];
  const hasOutdated = (deps?.outdated ?? 0) > 0;

  return (
    <Workflow name="chad-dependency-update">
      <Sequence>
        {/* 1) Collect outdated deps + current pins. Read-only, deterministic. */}
        <Task id="collect" output={outputs.deps} sideEffect idempotencyKey={`depupdate-collect-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            // `npm outdated` exits non-zero when anything is outdated — sh() ignores exit code.
            const raw = await sh("npm", ["outdated", "--json"]);
            let obj = {}; try { obj = raw ? JSON.parse(raw) : {}; } catch { obj = {}; }
            let pins = {}; try { pins = JSON.parse(readFileSync(PKG, "utf8")).dependencies || {}; } catch { /* */ }
            const rows = Object.entries(obj).map(([name, v]) =>
              `${name}: ${v.current} → ${v.latest} (pinned ${pins[name] || "?"})`);
            return { outdated: rows.length, sample: rows.join("\n").slice(0, 6000) };
          }}
        </Task>

        {/* 2) Triage → propose → sanity-check the bump set. The scanner classifies
            each outdated dep safe/review/risky; the fixer drafts the bump; the
            verifier sanity-checks (semver jump, known-breaking). Proposal only —
            no file is written here. Skipped when everything's current. */}
        <ScanFixVerify
          id="dep"
          skipIf={!hasOutdated}
          scanner={pickAgent("evaluate")}
          fixer={pickAgent("implement")}
          verifier={pickAgent("judge")}
          scanOutput={outputs.scan}
          fixOutput={outputs.fix}
          verifyOutput={outputs.verify}
          reportOutput={outputs.report}
          maxConcurrency={3}
          maxRetries={1}
        >
          {[
            "Triage these outdated npm dependencies for chad-smithers into a safe bump set.",
            "Classify each: `safe` (patch/minor, no known breaking), `review` (minor with notable changes),",
            "`risky` (major version jump — needs a human). Propose bumps for safe ones only; flag the rest.",
            "Never bump `smithers-orchestrator` or `@smithers-orchestrator/agents` past a minor without `review` —",
            "the workspace was validated against a specific line.",
            "Return JSON { issues:[{name, from, to, risk}], summary }.",
            "",
            `Outdated (${deps?.outdated ?? 0}):`,
            deps?.sample || "(none)",
          ].join("\n")}
        </ScanFixVerify>

        {/* 3) Apply — Approval-gated (a human signs off on the bump set), shadow
            unless CHAD_DEPUPDATE_APPLY=1. Even applied, it stops at writing the
            pins + a note; the actual `bun install` + test run is the operator's. */}
        <Task id="apply" output={outputs.apply} needsApproval sideEffect idempotencyKey={`depupdate-apply-${new Date().toISOString().slice(0, 10)}`}>
          {async () => {
            const safe = (scan?.issues || []).filter((i) => i.risk === "safe");
            const risky = (scan?.issues || []).filter((i) => i.risk !== "safe");
            const title = `Dependency update — ${new Date().toISOString().slice(0, 10)} — ${safe.length} safe, ${risky.length} flagged`;
            const body = `# ${title}\n\n${report?.plan || scan?.summary || ""}\n\n` +
              `**Safe:**\n${safe.map((i) => `- ${i.name} ${i.from} → ${i.to}`).join("\n") || "_none_"}\n\n` +
              `**Needs review:**\n${risky.map((i) => `- [${i.risk}] ${i.name} ${i.from} → ${i.to}`).join("\n") || "_none_"}`;
            if (POST) await postNote({ title, content: body, tags: "chad-deps" });
            if (!APPLY) return { status: "shadow-logged", detail: `SHADOW: would bump ${safe.length} safe deps` };
            // Live wiring (edit package.json pins + trigger bun install) is
            // intentionally deferred — proposal + note only until the loop proves out.
            return { status: "blocked", detail: "CHAD_DEPUPDATE_APPLY=1 set but live pin-write intentionally deferred" };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

export default workflow;
