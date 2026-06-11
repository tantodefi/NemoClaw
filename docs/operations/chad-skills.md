---
title:
  page: "Chad Skills Catalog"
  nav: "Chad Skills"
description:
  main: "Catalog of every skill registered into Chad's sandbox: chad-managed skills plus the canonical 40-skill gstack OpenClaw bundle, with one-line descriptions and the registration mechanism."
  agent: "Reference table of skills the chad agent can discover via skills.load.extraDirs. Use when the user asks `which skills does chad have` or wants to know the difference between chad-* and gstack-* skills."
keywords: ["chad skills", "gstack openclaw skills", "skills.load.extraDirs", "skill discovery", "openclaw skills"]
topics: ["operations", "skills"]
tags: ["openclaw", "openshell", "nemoclaw", "chad", "gstack", "skills"]
content:
  type: reference
  difficulty: technical_intermediate
  audience: ["developer", "engineer", "operator"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad Skills Catalog

This page enumerates every skill registered into Chad's sandbox: three
chad-managed skills shipped from this repo (`.github/skills/chad-*`),
two runtime-synced chad-managed skills (`openwebui` and
`chad-experiment` — added 2026-05-13/14), plus the canonical 40-skill
gstack OpenClaw-adapter bundle. All land in
`/sandbox/.openclaw-data/skills/`. Together they're the
`<available_skills>` block presented to the agent on every spawn.

**Current total: ~45 skills.** Breakdown: 3 repo-shipped chad-managed,
2 runtime-synced chad-managed (see "Runtime-synced chad-managed skills"
section below), ~40 gstack.

## Registration mechanism

Skills land in `/sandbox/.openclaw-data/skills/` (sandbox-writable,
survives openclaw upgrades) and are registered with OpenClaw's skill
discovery via:

```bash
openclaw config set skills.load.extraDirs --strict-json \
  '["/sandbox/.openclaw-data/skills"]'
```

`chad-setup.sh` runs this on every invocation (idempotent). Without the
`extraDirs` registration, OpenClaw's `loadSkillEntries` only scans the
managed dirs (`/sandbox/.openclaw/skills/`,
`/sandbox/.agents/skills/`, workspace `.agents/skills/`,
workspace `skills/`). Skills exist on disk but never appear in
`openclaw skills list`, the dashboard, or the agent's prompt block.

The script also prunes legacy `gstack-openclaw-*` directories on every
sync, so the canonical names below are the only ones present.

## Chad-managed skills, repo-shipped (3)

Source: `.github/skills/chad-*/` and `.github/skills/proton-calendar/`.
Synced by `bash scripts/chad-bug-intake/scripts/sync-skills-to-sandbox.sh`
(invoked from `chad-setup.sh` step 2).

| Skill | One-line description |
|---|---|
| `chad-bug-intake` | Create GitHub issues from trusted bug reports reaching Chad via chat or ProtonMail; duplicate-check, normalize, optionally break into child tasks |
| `chad-orchestrator` | Spawn typed sub-agents (coder/researcher/writer/reviewer/fitness/brain) with bounded budget, structured `result.json`, and memory merge |
| `proton-calendar` | List + read mail and calendar events via `proton-tool`; the building block for `chad-mail-check` and the email-check cron |

## Runtime-synced chad-managed skills (2)

Source: `scripts/openwebui/openwebui-skill.md` and
`scripts/openwebui/chad-experiment-skill.md`. Deployed at runtime to
`/sandbox/.openclaw-data/skills/<name>/SKILL.md` (and backed up under
`skills/` via the workspace manifest). Added 2026-05-13/14.

| Skill | One-line description |
|---|---|
| `openwebui` | Chad's complete control surface for the OpenWebUI deployment at `chad.supachad.com` — 60 CLI sub-commands across 10 groups (calendar/notes/automations/memories/chats/knowledge/models/functions/tools/folders) with worked examples, recipes, and a failure-mode table. Also indexes the matching `webui__*` MCP tools. See `docs/operations/openwebui.md`. |
| `chad-experiment` | Autonomous experiment lifecycle methodology: scan memory for objectives, decide what's worthy of automation, design + start + observe + evaluate + promote-or-retire experiments, A/B test paired variants. Documents the 13-verb CLI, success-metric authoring rules, calendar tag conventions (`[chad-block]`, `[chad-experiment]`, `[operator-sync]`, `[experiment-review]`), worthy-of-automation checklist, ground rules. See `docs/operations/chad-experiments.md`. |

## GStack engineering skills (≈18)

Source: `~/.claude/skills/gstack/.openclaw/skills/` (canonical
host-adapter dir kept current by `gstack-upgrade`). Run-the-codebase
workflows that don't need a browser daemon.

| Skill | One-line description |
|---|---|
| `gstack-investigate` | Systematic root-cause debugging — investigate → analyze → hypothesize → implement, no fix without diagnosis |
| `gstack-qa` | Tiered QA pass that fixes bugs as it finds them; produces before/after health scores |
| `gstack-qa-only` | Report-only QA: structured bug report with screenshots and repro, never edits source |
| `gstack-review` | Pre-landing PR review against base branch — SQL safety, LLM trust boundaries, conditional side effects |
| `gstack-ship` | Ship workflow: detect base, run tests, review diff, bump VERSION, update CHANGELOG, commit, push, PR |
| `gstack-land-and-deploy` | Merge the PR, wait for CI/deploy, verify production via canary checks |
| `gstack-canary` | Post-deploy canary monitoring — watches for console errors, performance regressions, page failures |
| `gstack-cso` | Chief Security Officer audit: secrets archaeology, supply chain, CI/CD, OWASP, STRIDE |
| `gstack-codex` | OpenAI Codex CLI wrapper — review / challenge / consult mode for second opinions |
| `gstack-document-release` | Post-ship doc update: cross-reference diff, update README/ARCHITECTURE/CHANGELOG to match what shipped |
| `gstack-health` | Code quality dashboard: type/lint/test/dead-code, weighted 0-10 score, trend tracking |
| `gstack-retro` | Weekly engineering retrospective from commit history with persistent trends |
| `gstack-context-save` | Save working context (git state, decisions, remaining work) for cross-session resume |
| `gstack-context-restore` | Restore the most recent saved context — pair with `gstack-context-save` |
| `gstack-freeze` | Restrict Edit/Write to a specific directory for the session |
| `gstack-unfreeze` | Clear the freeze boundary, allow edits everywhere again |
| `gstack-careful` | Safety guardrails: warn before `rm -rf`, `DROP TABLE`, force-push, `git reset --hard`, etc. |
| `gstack-guard` | Combined `freeze` + `careful` — maximum safety for prod debugging |

## GStack planning + design skills (≈14)

| Skill | One-line description |
|---|---|
| `gstack-plan-ceo-review` | CEO/founder-mode plan review — rethink, expand or hold scope, find landmines |
| `gstack-plan-eng-review` | Eng manager plan review — architecture, data flow, edge cases, test coverage |
| `gstack-plan-design-review` | Designer's eye plan review — rate dimensions 0-10, fix to a 10 |
| `gstack-plan-devex-review` | Developer experience plan review — personas, magical moments, friction points |
| `gstack-plan-tune` | Self-tuning question sensitivity for gstack — never-ask / always-ask preferences |
| `gstack-autoplan` | Auto-review pipeline: runs CEO/design/eng/DX reviews sequentially with auto-decisions |
| `gstack-design-consultation` | Design consultation: research landscape, propose system, generate previews, write `DESIGN.md` |
| `gstack-design-html` | Generate production-quality Pretext-native HTML/CSS from approved mockups |
| `gstack-design-shotgun` | Generate multiple AI design variants, comparison board, structured feedback, iterate |
| `gstack-design-review` | Live designer's-eye QA: visual inconsistency, hierarchy, AI-slop patterns, fix and re-verify |
| `gstack-devex-review` | Live DX audit via browse: try the onboarding, time TTHW, evaluate help text |
| `gstack-office-hours` | YC-style forcing questions for new product ideas; design-thinking brainstorming for builds |
| `gstack-ceo-review` | Standalone CEO/founder lens (companion to `plan-ceo-review`) |
| `gstack-make-pdf` | Turn a markdown file into a publication-quality PDF |

## GStack browser + utility skills (≈8)

These rely on the gstack browse daemon, which is **not** present in
Chad's sandbox (no Bun, no Chromium). They appear in the catalog because
the SKILL.md files sync regardless, but the agent will hit a "browser not
available" sentinel if invoked. They're useful only on the host.

| Skill | One-line description |
|---|---|
| `gstack-browse` | Headless browser for QA testing and dogfooding — navigate, interact, screenshot, diff |
| `gstack-open-gstack-browser` | Launch a visible Chromium with the gstack sidebar baked in |
| `gstack-pair-agent` | Pair a remote AI agent with your browser; one command generates a setup key |
| `gstack-setup-browser-cookies` | Import cookies from a real Chromium browser into the headless session |
| `gstack-benchmark` | Page-load / Core Web Vitals regression detection via the browse daemon |
| `gstack-benchmark-models` | Cross-model benchmark for gstack skills (Claude vs GPT vs Gemini) |
| `gstack-learn` | Manage project learnings — review, search, prune, export across sessions |
| `gstack-setup-deploy` | Configure deploy settings for `gstack-land-and-deploy` (writes to CLAUDE.md) |

## NemoClaw user / maintainer skills (auto-loaded)

Separate from `extraDirs`: skills under `.agents/skills/nemoclaw-*/` are
auto-loaded by OpenClaw's managed scan when the workspace `.agents/`
symlink is present (or the repo is checked out as `/sandbox/source`).
Catalog them in `nemoclaw-skills-guide` (at
`.agents/skills/nemoclaw-skills-guide/SKILL.md` in the repo)
rather than restating here — those skills are aimed at users + maintainers
of the NemoClaw repo itself, not at Chad's runtime workflow.

## Cross-reference

- [chad-devflow.md](chad-devflow.md#skill-discovery-and-mcp-wiring) — registration mechanism in context.
- [chad-autonomy.md](chad-autonomy.md) — skill-discovery as autonomy loop #5.
- `~/.claude/skills/gstack/.openclaw/skills/` — host-side source of truth for the gstack rows above.
- `.github/skills/chad-*/SKILL.md` — source of truth for the chad-managed rows.
