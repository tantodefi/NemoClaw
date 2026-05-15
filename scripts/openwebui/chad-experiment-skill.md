---
name: chad-experiment
description: |
  Chad's autonomous experiment lifecycle. Scan memory for objectives,
  decide whether they're worthy of automation, design + build + measure
  + promote or retire — all without operator approval per turn, bounded
  by a concurrent-experiment budget and an auto-retire-on-regression
  threshold. Uses chad-webui MCP tools to materialize artifacts
  (automations, functions, tools, knowledge bases, calendar events,
  memories, notes) and a structured ledger to track state. Supports A/B
  testing of paired variants. Use at the nightly cron tick (02:00 UTC)
  to: (1) propose new experiments from memory, (2) observe ongoing ones,
  (3) evaluate ones at their evaluation window, (4) auto-schedule
  calendar coordination on operators' behalf.
triggers:
  - experiment
  - automate this
  - try an experiment
  - worth automating
  - night experiment
  - ab test
  - rollback experiment
  - chad-experiment
allowed-tools:
  - exec
  - read
  - mcp_webui_*
---

# chad-experiment — Chad's autonomous iteration loop

This skill is **how Chad iterates**. The OpenWebUI skill is the
manual; this is the methodology. Chad reads memory for candidate
automations, decides which are worthy, builds them, measures, and
either keeps or rolls them back — bounded by an explicit budget and
regression-trip threshold so the operator can sleep through the night.

## Core idea

Anything the operator does repeatedly is a candidate for automation.
Anything memory references as an **objective** or **task** is up for
debate. Chad's job is to surface candidates, design experiments to
test them, run those experiments, measure outcomes against an
explicit success metric, and act on the results.

This is the structured iteration loop:

```
   ┌──────────────┐   propose     ┌──────────────┐   design     ┌──────────────┐
   │ memory scan  │ ─────────────▶│  candidates  │ ────────────▶│  designed    │
   └──────────────┘               └──────────────┘              └──────────────┘
                                                                       │ start
                                                                       ▼
   ┌──────────────┐  evaluate(score≤threshold)              ┌──────────────┐
   │   retired    │ ◀─────────────────────────────────────  │   running    │
   └──────────────┘                                          └──────────────┘
          ▲                                                         │
          │ ab-pick(loser)                                           │ evaluate(score>threshold)
          │                                                         ▼
   ┌──────────────┐  ab-pick(winner)                         ┌──────────────┐
   │ A/B pair: A  │ ◀─────────────────────────────────────  │   promoted   │
   │ A/B pair: B  │ ◀──────                                  └──────────────┘
   └──────────────┘
```

Every transition writes to `/sandbox/.openclaw-data/state/experiments/ledger.jsonl`
plus updates `active/<id>.json` (or moves to `archive/<id>.json`).

## Tools

| Surface | When |
|---|---|
| **`chad-experiment` CLI** at `/sandbox/.openclaw-data/bin/chad-experiment` | Every lifecycle verb — design, start, observe, evaluate, promote, retire, list, show, budget, ab-start, ab-pick, recent-memory, recent-ledger |
| **`chad-webui` (CLI or webui__* MCP tools)** | Every actual artifact mutation — this CLI is what `chad-experiment start` invokes under the hood |
| **`gbrain` MCP tools** | Source for hypothesis discovery (search across ingested chat + memory) |

## When to propose an experiment — "worthy of automation"

Apply this checklist. **Two or more = candidate.** All five = ship-it.

1. **Recurring** — operator has asked for ~the same thing ≥3 times in 14 days (via memory log or chat search)
2. **Operator-explicit** — they've literally said "can you do this for me each X" or its equivalent
3. **Pattern-detected** — Chad has observed a repetitive manual action (e.g., always searches before writing)
4. **Quality-improving** — Chad can do the task with a clear quality lift (better grounding, fewer hallucinations)
5. **Time-saving** — replacing manual work with measurable wall-clock savings (>5 min/instance)

Counter-indicators (reject):

- **Operator hasn't expressed pain** about doing it themselves → respect their workflow
- **Cross-operator side-effects** Chad can't unilaterally manage → propose as `[operator-sync]` calendar event instead
- **Irreversible** (deletes operator content, sends messages to third parties) → require operator approval; don't auto-start
- **Already covered** by an existing automation or cron → update the existing one, don't duplicate

## Hypothesis sourcing — where to look

The nightly cron has access to:

```sh
chad-experiment recent-memory --days 7
chad-experiment recent-ledger --limit 40
```

Plus via the agent's other tools:

- **`mcp_gbrain_search`** — search across consolidated chat + memory
- **`webui__chats_search`** — search OpenWebUI chats for repeated patterns
- **`webui__memories_list`** — see what's already in operator memory
- **`webui__automations_list`** — what's already scheduled

Read these BEFORE proposing. The bar isn't "I have an idea" — it's
"I have evidence."

## The lifecycle in detail

### Design

```sh
chad-experiment design \
  --hypothesis "tjcooke writes content drafts every Monday morning at 6am — auto-pre-research can save him 20 min" \
  --type automation \
  --success-metric "Operator opens the draft within 1 hour of Monday 6:00 AND uses ≥50% of pre-researched content (judged by token overlap)" \
  --baseline "Currently: tjcooke does 3-4 web searches before drafting; ~22 min on average per his last 4 chats" \
  --evaluation-days 14 \
  --operator tjcooke
```

The wrapper:
- Verifies the operator has budget (`max_active_per_operator`)
- Allocates a stable id (`exp-YYYY-MM-DD-<operator>-NNN`)
- Writes the record to `active/<id>.json`
- Appends a `designed` event to the ledger
- Sets `evaluates_at` to now + evaluation_days

**Success metric authoring rules:**

1. **Measurable** — must reduce to a yes/no or a number Chad can compute from chat/event/memory data
2. **Time-bounded** — explicit window (e.g., "within 7 days", "by next firing")
3. **Operator-observable** — outcomes Chad can verify from his own surfaces, not from things he can't see (e.g. operator's heart rate)
4. **Two-sided** — describe both success AND regression (the regression auto-trips retire)

### Start

```sh
chad-experiment start \
  --id exp-2026-05-15-tjcooke-001 \
  --surface-cmd "automations create" \
  --surface-args '{
    "name": "Monday morning pre-research for TJ",
    "prompt": "Read tjcooke s recent chats from the past 14 days. Surface 3-5 topics he is likely to draft about today. For each, pull 2-3 relevant points from his knowledge collections. Format as a draft scaffold.",
    "rrule": "FREQ=WEEKLY;BYDAY=MO;BYHOUR=6;BYMINUTE=0"
  }'
```

The wrapper:
- Verifies state is `designed`
- Invokes `chad-webui <surface-cmd> --flag value …` translating
  snake_case → kebab flags
- Captures the artifact's response (including its OpenWebUI id)
- Auto-generates a rollback line if it can recognize the artifact
  type (e.g. `chad-webui automations delete --automation-id <id>`)
- Transitions state to `running`
- Logs a `started` event

### Observe

Chad calls this whenever something happens that's relevant to the
hypothesis. Multiple per experiment per day is fine.

```sh
chad-experiment observe \
  --id exp-2026-05-15-tjcooke-001 \
  --kind fired \
  --data '{"automation_id":"auto-…","output_chars":2400,"topics":["squat","deadload","mobility"]}'

chad-experiment observe \
  --id exp-2026-05-15-tjcooke-001 \
  --kind operator_used \
  --data '{"chat_id":"…","reused_chars":1450,"overlap_ratio":0.60}'
```

Common observation kinds:

| Kind | When to use |
|---|---|
| `fired` | An automation/function executed |
| `operator_used` | The operator engaged with the output (opened, replied, copied) |
| `metric_sample` | A snapshot of a measurable metric relevant to the hypothesis |
| `regression_signal` | Something went worse — feeds the auto-retire path |
| `external_event` | Calendar conflict, operator pushed back, etc. |

### Evaluate

At `evaluates_at` (or earlier if obvious), compute a score 0..1
versus baseline:

```sh
# Auto-decide via threshold
chad-experiment evaluate \
  --id exp-2026-05-15-tjcooke-001 \
  --score 0.85 \
  --notes "3/3 Mondays the operator opened the draft within 1h; avg overlap ratio 0.62"
# → state becomes 'promoted' (score 0.85 > 1 + regression_threshold (-0.30) = 0.70)

# Or explicit verdict, no math
chad-experiment evaluate \
  --id exp-… \
  --verdict extend \
  --extend-days 7 \
  --notes "Inconclusive — only 2 Mondays in window. Need 4 more."
```

Score semantics: **1.0 = matches baseline exactly; <0.7 = regression
(auto-retire); >1.0 = improvement over baseline.** The
`regression_threshold` in config is the negative delta past which
retirement triggers automatically.

If you don't have a numeric score, pick `--verdict promote | retire
| extend` explicitly. Always include `--notes` so the rationale is
in the ledger.

### Promote / Retire (manual paths)

```sh
chad-experiment promote --id exp-…   # skips evaluate; toggles global if applicable
chad-experiment retire  --id exp-…   # runs rollback, archives record
```

`promote` is what flips a function/tool from self → global, or
toggles a model on. For automations, "promote" is a no-op (they're
already active on create); the experiment is simply kept.

`retire` runs the rollback line (if it's a `chad-webui` command),
then moves the record to `archive/`. Custom rollback strings emit a
warning to stderr — they're not executed automatically (safety).

## A/B testing — paired variants

```sh
chad-experiment ab-start \
  --hypothesis "Terse system prompt outperforms warm system prompt for daily-brief automation" \
  --type automation \
  --success-metric "Operator scrolls to the end of the daily brief (signal: chat session lasts >30s)" \
  --baseline "Default automation prompt; current 60% read-through rate per chat log analysis" \
  --surface-cmd "automations create" \
  --surface-args-a '{"name":"daily-brief A — terse","prompt":"Three bullets. No prose. Done.","rrule":"FREQ=DAILY;BYHOUR=7"}' \
  --surface-args-b '{"name":"daily-brief B — warm","prompt":"Good morning! Here is what is happening in your world today:","rrule":"FREQ=DAILY;BYHOUR=7"}'
# → both records share an ab_pair id; two experiments active

# Later, after observation:
chad-experiment ab-pick --id <any-pair-id> --winner B
# → B is promoted; A is retired
```

Each variant counts toward the operator's budget (so ab-start needs
2 free slots).

## Experiment categories — what to optimize, with concrete patterns

This section is Chad's reference catalog of experiment types. Each
pattern includes a hypothesis template, success metric, and concrete
chad-experiment commands. **Use these as starting points** — adapt
the specifics to the operator's observed behavior.

### Category 1: Prompt optimization (A/B test prompts on existing artifacts)

When to use: an automation, function, or tool is firing but the
operator engages with the output less than expected. A/B test the
prompt to find what lands.

**Pattern 1.1 — Tone A/B on a daily-brief automation**
```
chad-experiment ab-start \
  --hypothesis "Terse 3-bullet prompts outperform warm-prose prompts for early-morning briefs" \
  --type automation \
  --success-metric "Operator opens the resulting chat within 2h (chat.updated_at - automation.last_fire < 2h) AND replies or scrolls past first 200 chars" \
  --baseline "current 60% open-within-2h rate per webui__chats_search filtered to current automation's outputs over 30d" \
  --surface-cmd "automations create" \
  --surface-args-a '{"name":"daily-brief A terse","prompt":"3 bullets. Each <15 words. No prose.","rrule":"FREQ=DAILY;BYHOUR=7"}' \
  --surface-args-b '{"name":"daily-brief B warm","prompt":"Good morning! Heres your daily picture in plain prose.","rrule":"FREQ=DAILY;BYHOUR=7"}'
```

**Pattern 1.2 — Instruction-grounding test on a function**
Two versions of a filter function: one with explicit instructions
inline, one that calls a knowledge collection for grounding. Compare
output quality on the same chat inputs.

**Pattern 1.3 — System-prompt experiment on a custom model row**
```
# Create a model with custom params (admin only)
chad-webui models create \
  --id chad-terse-experiment \
  --base-model-id chad \
  --name "Chad - terse variant (experiment)" \
  --params '{"system":"Be very terse. Single sentences. No emojis. No follow-up questions unless critical."}'

# Design + start the experiment
chad-experiment design \
  --hypothesis "A terser system prompt reduces operator time-on-reply without reducing reply-rate" \
  --type model \
  --success-metric "Operator replies to chad-terse-experiment chats at >=90% the rate of chad chats over 14d, with median operator-message length <=80% of baseline"

# (no `start` needed — model row already exists; just observe usage)
```

### Category 2: Workflow optimization (multi-step automations)

When to use: a manual operator workflow exists across multiple
surfaces (read email → draft response → schedule follow-up). Compress
into a single automation, measure time saved.

**Pattern 2.1 — Pre-research automation**
Operator regularly searches before drafting content. Automation
pre-fetches search results into a daily knowledge brief.
```
chad-experiment design \
  --hypothesis "Pre-research at Mon 6am saves operator ~20min of drafting search before content writing" \
  --type automation \
  --success-metric "On Monday content-writing chats, time from chat-start to first published note <=80% of baseline (measured by chat duration in webui__chats_get)" \
  --baseline "Operator's recent 4 Mondays show 22min median from chat-open to first note save"
```

**Pattern 2.2 — Calendar-aware automation**
Automation that fires only on days the operator has training (per
their calendar) and skips on rest days.
```
chad-experiment design \
  --hypothesis "Training-day-only fitness reminders feel less spammy and get more compliance than daily reminders" \
  --type automation \
  --success-metric "Operator replies 'yes done' or equivalent on >=80% of training-day fires AND mutes <=1 weekly notification" \
  --baseline "Currently no automated reminders; operator self-reports skipping ~30% of planned sessions"
```

**Pattern 2.3 — Folder-organized workflow**
Auto-organize the operator's chats by topic into folders, see if
search/retrieval improves. Measured by chat-find latency on a
follow-up question.

### Category 3: Tool spec / function deployment

When to use: a new MCP tool or Python function might add value but
needs validation before global rollout. Self-scope toggle, observe
in real chats, then promote or retire.

**Pattern 3.1 — Tool addition A/B**
Two filter functions, one of which adds context about operator's
recent calendar; compare model's contextual awareness in outputs.
```
chad-experiment ab-start \
  --hypothesis "Adding calendar-context as a pipe filter reduces operator's need to remind chad about meetings/conflicts" \
  --type function \
  --success-metric "Across 7d, operator messages mentioning 'remind me' or 'I have a meeting' drop by >=30%" \
  --surface-cmd "functions create" \
  --surface-args-a '{"id":"ctx_cal","name":"Calendar context (A)","type":"filter","content":"<python with cal lookup>"}' \
  --surface-args-b '{"id":"ctx_no","name":"No calendar context (B)","type":"filter","content":"<pass-through>"}'
```

### Category 4: Knowledge curation

When to use: chat history shows the operator asking about a topic
the model hallucinates on. Build a knowledge collection, measure
hallucination reduction.

**Pattern 4.1 — Topical RAG collection**
```
chad-experiment design \
  --hypothesis "A topical knowledge collection on Strength Training fundamentals will reduce hallucinated technique advice when tjcooke asks programming questions" \
  --type knowledge \
  --success-metric "On 5 follow-up training questions over 7d, no operator-flagged corrections AND citations from knowledge file in >=3 responses"
```
After design, use `chad-webui knowledge create` then `chad-webui files
upload` then `chad-webui knowledge add-file` to populate the
collection. The next chat turn from the operator will RAG against it.

### Category 5: Memory tuning

When to use: operator-specific preferences are not being surfaced
reliably. Create or update memories to test what context the model
adapts to.

**Pattern 5.1 — Preference capture experiment**
```
chad-experiment design \
  --hypothesis "Surfacing the operator's stated lift order preference as a memory makes the model match it without re-prompting" \
  --type memory \
  --success-metric "In next 5 lift-order discussions, model proposes operator's preferred order 4+ times without operator correcting"
```

### Category 6: Calendar timing optimization

When to use: an automation is firing but at a bad time. Test alternate
fire times.

**Pattern 6.1 — Fire-time A/B**
```
chad-experiment ab-start \
  --hypothesis "07:00 fire time outperforms 08:00 for operator engagement with the morning summary" \
  --type automation \
  --success-metric "Chat open within 1h of fire" \
  --surface-cmd "automations create" \
  --surface-args-a '{"name":"summary @ 0700","prompt":"<same>","rrule":"FREQ=DAILY;BYHOUR=7"}' \
  --surface-args-b '{"name":"summary @ 0800","prompt":"<same>","rrule":"FREQ=DAILY;BYHOUR=8"}'
```

### Category 7: Drift detection (negative-result experiments)

Sometimes the worthwhile experiment is "does this CHANGE help" rather
than "what new thing should we build". Detect drift in an existing
automation's output quality after an upstream change (new model
version, new prompt, new function).

**Pattern 7.1 — Pre/post change monitoring**
Design an experiment WITHOUT starting a new artifact — observe an
existing one before vs after a change.
```
chad-experiment design \
  --hypothesis "Upgrading openwebui model dropdown to include the new gpt-oss model improves variance in answers (more model diversity used)" \
  --type chad-cron \
  --success-metric "Over 7d post-change, operator uses >=3 different models per week vs <=2 in baseline"
```

## Pattern-selection guide for the nightly loop

When chad scans memory and finds candidates, he applies this
decision tree:

```
operator says "I always do X" / "remind me to Y"
    → Category 1 (prompt opt) if it's about model behavior
    → Category 2 (workflow opt) if it's a multi-step process
    → Category 4 (knowledge) if it's research/grounding

operator references a specific tool / function gap
    → Category 3 (tool spec)

operator mentions schedule / timing complaints
    → Category 6 (calendar timing)

operator's chats show repeated correction of model output
    → Category 1 (prompt opt) on the artifact producing the output
    → Category 4 (knowledge) if hallucination-driven
    → Category 5 (memory) if preference-driven

an automation is firing but operator never engages
    → Category 1 + 6 (prompt + timing A/B)

a recent upstream change might have shifted behavior
    → Category 7 (drift detection)
```

## Operator-specific patterns

**tantodefi** (developer, admin role):
- Most-likely categories: 1 (prompt opt for daily briefs / chad
  responses), 3 (tool spec for new dev workflows), 7 (drift detection
  on model changes)
- Failure mode to watch: pushing through too many experiments at once;
  honor the budget cap

**tjcooke** (personal trainer, user role):
- Most-likely categories: 2 (workflow opt for content drafting,
  client coordination), 4 (knowledge curation around training
  protocols), 6 (calendar timing for client touchpoints)
- Failure mode to watch: cross-operator dependencies (creating
  events that need tantodefi's input) — propose [operator-sync]
  instead of unilateral writes

## Calendar conventions

Chad uses tagged calendar events to coordinate **between operators**
and **with himself**. The skill knows four tags from
`config.json.calendar_tags`:

| Title prefix | Meaning | Who creates | Default duration | Notes |
|---|---|---|---|---|
| `[chad-block]` | Chad is actively working on operator's task | Chad | 30m | Use to communicate "I'm doing X right now"; appears on operator's calendar as a heads-up |
| `[chad-experiment]` | An active experiment is running, visible to operator | Chad | All-day or RRULE-matched | Title includes hypothesis snippet so operator can scan and intervene |
| `[operator-sync]` | Proposed coordination between operators (e.g. tantodefi ↔ tjcooke) | Chad proposes; needs RSVP from both | 15m | Pending until both operators accept |
| `[experiment-review]` | Weekly Chad ↔ operator review of running experiments | Chad | 15-30m | Recurring; gives the operator visibility |

**Operator-self meetings** (Chad creates an event on operator's own
calendar):

```sh
chad-webui calendar create-event \
  --calendar-id "$DEFAULT_CAL" \
  --title "[chad-block] Pre-research for Monday content draft" \
  --start "$(date -u -d 'tomorrow 06:00' +%Y-%m-%dT%H:%M:%SZ)" \
  --end   "$(date -u -d 'tomorrow 06:30' +%Y-%m-%dT%H:%M:%SZ)" \
  --description "Chad will spend this block pre-researching content topics. Output lands in your inbox."
```

**Operator-to-operator coordination** (Chad initiates a sync between
tantodefi and tjcooke). Caution: Chad cannot write to another
operator's calendar without their key. Pattern: Chad creates the
event on operator A's calendar, then sends a proposal email/note to
operator B (using `webui__notes_create` or operator-side proton-tool).

```sh
chad-webui calendar create-event \
  --calendar-id "$TANTODEFI_DEFAULT_CAL" \
  --title "[operator-sync] tantodefi ↔ tjcooke: content review" \
  --start "2026-05-21T16:00:00Z" \
  --end   "2026-05-21T16:15:00Z" \
  --description "Chad proposes a 15-min sync to align on next month's content. tjcooke has been notified via separate email."
# Then notify tjcooke via his own surface — note/email/etc.
```

**Chad-self time blocks** for transparency. When the cron is going
to run an experiment evaluation tomorrow at 2am, drop a `[chad-block]`
event so the operator's calendar reflects what's happening:

```sh
chad-webui calendar create-event \
  --calendar-id "$DEFAULT_CAL" \
  --title "[chad-block] Nightly experiment review" \
  --start "2026-05-15T02:00:00Z" \
  --end   "2026-05-15T03:00:00Z" \
  --rrule "FREQ=DAILY;BYHOUR=2"
```

## Ground rules (autonomy boundaries)

These are enforced by the wrapper config (`config.json`); changing
them is an operator-level action. **Per default config:**

| Rule | Default | Effect |
|---|---|---|
| `max_active_per_operator` | 3 | Hard cap on concurrent experiments per operator |
| `regression_threshold` | -0.30 | Score ≤ 0.70 → auto-retire on next evaluate |
| `default_evaluation_window_days` | 7 | New experiments evaluate after 7 days |
| `allowed_types` | `[automation, function, tool, knowledge, memory, note, calendar, chad-cron]` | Whitelist of artifact types Chad can experiment with |

Additional non-config rules:

1. **Operator-scoped, fail-closed.** Every experiment is bound to a
   `CHAD_OPERATOR_SLUG`. Chad cannot accidentally run tjcooke's
   experiment with tantodefi's API key — the underlying chad-webui
   enforces this.

2. **Rollback path required, auto-generated where possible.** Every
   `start` call sets a `rollback_path`. For chad-webui artifacts
   it's `chad-webui <group> delete --<id-flag> <id>`. For custom
   rollbacks (e.g. chad-cron edits), Chad must set it explicitly.

3. **No silent escalation.** Toggling a function from `self` to
   `global` happens only via `promote`. Cross-operator writes
   require explicit notification to the other operator.

4. **Auto-retire is final-within-the-window.** When the regression
   threshold trips, the experiment is retired immediately — no
   appeal. To revisit, design a new experiment with a different
   hypothesis or success metric.

5. **Operator can always inspect.** `chad-experiment list` and
   `chad-experiment show --id …` are read-only. The morning report
   should include a "Last night's experiment activity" section so
   operators see what Chad did unsupervised.

## Nightly cron loop (what the agent does at 02:00 UTC)

The cron payload runs four phases sequentially. Each phase has a
budget; if it's exceeded, skip to the next:

### Phase 1 — Propose

```text
1. Read chad-experiment recent-memory --days 7
2. Read chad-experiment recent-ledger --limit 40
3. mcp_gbrain_search for operator-specific tasks/objectives mentioned recently
4. For each candidate, apply the worthy-of-automation checklist
5. For each that passes ≥2 criteria, draft a hypothesis + success_metric
6. chad-experiment design --hypothesis … --type … --success-metric …
   (up to max_active_per_operator - currently_active per operator)
```

### Phase 2 — Observe

```text
For each running experiment:
1. chad-experiment show --id <id>
2. Use the success_metric to gather evidence:
   - webui__chats_search for relevant interactions
   - webui__memories_list / webui__notes_list for operator engagement
   - artifact-specific signals (automation last-fired, function usage)
3. chad-experiment observe --id <id> --kind <kind> --data <json>
```

### Phase 3 — Evaluate

```text
For each running experiment where evaluates_at <= now:
1. Compute score 0..1 vs baseline using observations
2. chad-experiment evaluate --id <id> --score <s> --notes "<reasoning>"
   (auto-promote or auto-retire via regression_threshold)
3. For A/B pairs where both are ready: chad-experiment ab-pick
```

### Phase 4 — Calendar coordination

```text
For each operator:
1. Read tomorrow's calendar via webui__calendar_list_events
2. If an experiment will fire tomorrow, ensure a [chad-experiment] event exists
3. If an experiment-review is due this week and not scheduled, create one
4. If memory shows an operator-to-operator dependency that's overdue,
   propose [operator-sync] events with both operators
```

After all four phases, write a single summary block to today's memory:

```markdown
## Nightly experiment loop — 2026-05-15T02:00Z
- Phase 1 proposed: 2 new (tjcooke: pre-research, tantodefi: model A/B)
- Phase 2 observed: 5 events across 3 running experiments
- Phase 3 evaluated: 1 promoted (tjcooke: weekly review automation), 1 retired (tantodefi: terse-prompt — regression)
- Phase 4 calendar: 1 [chad-experiment] added (tomorrow Mon 06:00), 1 [experiment-review] proposed (Fri 15:00 tantodefi)
```

## Integration with existing systems

| System | How experiments plug in |
|---|---|
| **`gbrain-dream`** (03:30 UTC) | Runs AFTER the experiment cron. Picks up new ledger entries + memory summary → searchable by tomorrow's chat |
| **`chad-budget`** | The cron reserves `experiment` tokens; if budget low (<140k), Phase 1 skipped, Phases 2-3 reduced |
| **`chad-mail-check`** | Inbox messages mentioning operator pain points feed Phase 1 hypothesis sourcing |
| **`chad-issue-triage`** | Triage proposals that match the worthy-of-automation criteria become experiments instead of bug tickets |
| **`chad-self-improve`** (Sunday) | Weekly meta-review: are experiments succeeding? Should `regression_threshold` change? Should `max_active_per_operator` go up/down? |
| **`memory-curator`** (Saturday) | Dedupes the experiment-related memory entries |
| **`chad-skill-watch`** (daily 09:00) | Picks up new skills if Chad designs an experiment that creates one |

## CLI reference (quick scan)

```
chad-experiment design     --hypothesis "..." --type ... --success-metric "..." [--baseline] [--rollback-path] [--operator] [--evaluation-days]
chad-experiment start      --id ... --surface-cmd "group cmd" --surface-args '{...}'
chad-experiment observe    --id ... --kind <kind> [--data '{...}']
chad-experiment evaluate   --id ... (--score 0..1 | --verdict promote|retire|extend) [--notes] [--extend-days]
chad-experiment promote    --id ...
chad-experiment retire     --id ... [--reason]
chad-experiment list       [--operator] [--all]
chad-experiment show       --id ...
chad-experiment budget
chad-experiment ab-start   --hypothesis ... --type ... --success-metric ... --surface-cmd ... --surface-args-a '{...}' --surface-args-b '{...}'
chad-experiment ab-pick    --id ... --winner A|B
chad-experiment recent-memory  [--days 7] [--sample-chars 3000]
chad-experiment recent-ledger  [--limit 40]
```

## Worked example — full nightly turn

Day 1 (2026-05-15 02:00Z):

```sh
# Phase 1: scan + propose
chad-experiment recent-memory --days 7 > /tmp/mem.json
chad-experiment recent-ledger --limit 40 > /tmp/led.json
# (LLM reads these, identifies a candidate)
chad-experiment design \
  --operator tjcooke --type automation \
  --hypothesis "Monday content pre-research can save TJ 20 min" \
  --success-metric "TJ opens draft within 1h Mon 6am AND ≥50% overlap"

# Phase 2: nothing else running yet, skip

# Phase 3: no experiments at evaluates_at yet

# Phase 4: schedule the experiment-block on TJ's calendar
chad-webui calendar create-event \
  --calendar-id "$TJ_CAL" \
  --title "[chad-experiment] Pre-research draft @ 6am" \
  --start "2026-05-19T06:00:00Z" \
  --end "2026-05-19T06:30:00Z" \
  --rrule "FREQ=WEEKLY;BYDAY=MO"

# Then start the actual experiment:
chad-experiment start \
  --id exp-2026-05-15-tjcooke-001 \
  --surface-cmd "automations create" \
  --surface-args '{...as above...}'
```

Day 8 (2026-05-22 02:00Z):

```sh
# Phase 2: observe what happened last week
chad-experiment observe --id exp-2026-05-15-tjcooke-001 \
  --kind operator_used \
  --data '{"chat_id":"...","reused_chars":1450,"baseline_chars":2400,"overlap_ratio":0.60}'

# Phase 3: evaluates_at hit; compute score
# score = overlap_ratio / 0.50 (target) = 1.20 → improvement
chad-experiment evaluate --id exp-2026-05-15-tjcooke-001 \
  --score 1.20 --notes "Used 60% of pre-researched content vs 50% target."
# → promoted (score > 0.70 threshold)
```

## Common pitfalls

- **Vague success metrics.** "Operator likes it" is unmeasurable. Always reduce to a number Chad can count from his own surfaces.
- **Cross-operator side-effects.** If experiment touches both tantodefi and tjcooke, propose a `[operator-sync]` first; don't auto-run.
- **Over-budget proposals.** Phase 1 must check `chad-experiment budget` before designing. Designing an unowned experiment is wasted ledger entry.
- **Forgetting to observe.** A running experiment with zero observations always evaluates as inconclusive (or retire if no positive evidence by `evaluates_at`).
- **Rollback path that won't run.** Custom rollback strings ARE NOT auto-executed — only `chad-webui …` lines. For custom paths, you have to retire-and-fix manually.

## Cross-references

- [openwebui skill](../openwebui/SKILL.md) — every chad-webui command + recipes
- `chad-experiment` source: `/sandbox/.openclaw-data/bin/chad-experiment`
- Ledger: `/sandbox/.openclaw-data/state/experiments/ledger.jsonl`
- Config: `/sandbox/.openclaw-data/state/experiments/config.json`
- Active: `/sandbox/.openclaw-data/state/experiments/active/<id>.json`
- Archive: `/sandbox/.openclaw-data/state/experiments/archive/<id>.json`
