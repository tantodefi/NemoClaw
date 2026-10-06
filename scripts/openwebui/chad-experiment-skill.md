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
  testing of paired variants. The nightly tick (02:00 UTC) is driven by
  the deterministic `chad-experiment-cron` wrapper (observe → evaluate →
  design); use this skill when an operator asks about experiments, when
  designing/evaluating one interactively, or for calendar coordination
  on operators' behalf (not automated by the wrapper).
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

Hypothesis discovery draws on:

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

## Models chad can experiment with

The OpenWebUI model dropdown currently exposes **10 active models**.
Every experiment that touches model behavior (Categories 1, 3, 7)
should pick the right model for the test. Snapshot from `webui.db
SELECT id, name FROM model WHERE is_active=1` — chad can re-query at
any time via `webui__models_list` or `chad-webui models list`.

### NVIDIA inference upstreams (the model-dropdown options)

| Model id | Best for | When to pick it |
|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | Frontier general; agent default | Default for chad. Use when the experiment needs full reasoning. |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Fast reasoning, smaller | Experiment when you want to A/B test reasoning quality vs latency |
| `meta/llama-3.3-70b-instruct` | Workhorse general | A/B vs nemotron-super on the same task to compare style + cost |
| `meta/llama-3.1-70b-instruct` | Balanced general | Predecessor of 3.3; useful for drift detection (Cat 7) |
| `mistralai/mixtral-8x22b-instruct-v0.1` | Multilingual, creative writing | tjcooke content-drafting experiments where tone variety matters |
| `qwen/qwen3-coder-480b-a35b-instruct` | Coding | tantodefi engineering tasks: code review automations, debug-assist tools |
| `openai/gpt-oss-120b` | Frontier general | A/B against nemotron on the same prompt to test "best model" claims |
| `openai/gpt-oss-20b` | Fast Q&A | When low-latency response matters more than depth |
| `z-ai/glm-5.1` | Chinese / bilingual | Rarely relevant for current operators; flag if either operator's content shifts toward Chinese |

### The `chad` agent model

| Model id | What it is |
|---|---|
| `chad` | Local agent endpoint (chad-shim → openclaw agent). Carries memory, MCP tools, identity. Use for automations that need access to operator state, calendar, knowledge collections. |

**Decision matrix for choosing model in an experiment:**

| Experiment surface | Default | Try second |
|---|---|---|
| Daily-brief automation | `chad` (has memory + can read crons) | `nemotron-super` (faster, no agent overhead) |
| One-shot summarization | `nemotron-super` | `llama-3.3-70b` |
| Content draft for tjcooke | `mixtral-8x22b` | `chad` |
| Code-review automation | `qwen3-coder-480b` | `nemotron-super` |
| Vision / OCR (none of TJ's current workflows) | n/a — would need `microsoft/phi-4-multimodal-instruct` re-enabled | — |
| Fast Q&A (latency-sensitive) | `gpt-oss-20b` | `nemotron-nano` |

### The 4 inactive models worth knowing about

`select id from model where is_active=0`:
- `microsoft/phi-4-multimodal-instruct` — vision-capable; toggle on if image experiments come up
- `meta/llama-3.1-405b-instruct` — deep reasoning, slow
- `google/gemma-3-27b-it` — writing + Q&A
- `minimaxai/minimax-m2.5` — long-context + creative

Chad can toggle any of these on via `chad-webui models toggle --id <id>`
(admin role required) if an experiment requires that capability.

## Experiment workflow — the complete loop with note-taking

This section is the **canonical step-by-step** for running an
experiment from first observation to lessons-learned writeup. Each
step shows the command + where the note lands + what chad writes.

### Step 1 — Observe a candidate (memory + ledger scan)

```sh
# Run these first, before reaching for the design verb:
chad-experiment recent-memory --days 7 > /tmp/mem.json
chad-experiment recent-ledger --limit 30 > /tmp/led.json
chad-experiment budget
```

Read them. Apply the worthy-of-automation checklist (5 criteria, ≥2
to propose). Don't design yet — write a one-line proposal note to
yourself in today's memory so the candidate survives even if you
get pulled into other work:

```sh
MEM=$(/usr/local/bin/chad-ensure-today-memory)
cat >> "$MEM" <<EOF

### Experiment candidate (proposed) — $(date -u +%FT%TZ)
- operator: tantodefi
- pattern observed: 3× this week, tantodefi opened the cron log
  manually to find out what fired overnight
- proposed type: automation (Cat 2, workflow-opt)
- bar to clear: design + start + 1 week observation
EOF
```

### Step 2 — Design the experiment (writes to ledger)

```sh
chad-experiment design \
  --hypothesis "..." \
  --type automation \
  --success-metric "..." \
  --baseline "..." \
  --evaluation-days 7 \
  --operator tantodefi
```

The ledger gets a `designed` event. The active/<id>.json file is
created. **No OpenWebUI artifact yet** — design is reversible.

### Step 3 — Start the experiment (materializes the artifact)

```sh
chad-experiment start \
  --id exp-2026-MM-DD-tantodefi-NNN \
  --surface-cmd "automations create" \
  --surface-args '{"name":"[chad-experiment] ...","prompt":"...","rrule":"..."}'
```

Now the artifact exists in OpenWebUI; the operator can see it. The
ledger gets a `started` event with the `surface.id` of the new
artifact and an auto-generated rollback line.

**Also create the transparency calendar event:**

```sh
chad-webui calendar create-event \
  --calendar-id "$DEFAULT_CAL" \
  --title "[chad-experiment] <hypothesis snippet>" \
  --start "<RRULE start>" \
  --end "<RRULE start + 5min>" \
  --description "Tracks exp-2026-MM-DD-... | evaluates: <date> | rollback: <auto-rollback-cmd>" \
  --rrule "<same as automation>"
```

This is what makes the operator notice the experiment is running
without requiring them to log into the experiment dashboard.

### Step 4 — Observe (during the evaluation window)

`chad-experiment-cron` records a heartbeat observation nightly; richer
evidence-gathering happens interactively. For each running
experiment, chad checks what happened since the last observation
and appends to the ledger:

```sh
# An automation fired:
chad-experiment observe --id <exp_id> --kind fired \
  --data '{"chat_id":"...","fire_ts":"...","output_chars":2400}'

# Operator engaged with the output:
chad-experiment observe --id <exp_id> --kind operator_used \
  --data '{"chat_id":"...","time_to_open_seconds":1820,"replied":true}'

# Something went wrong (regression signal):
chad-experiment observe --id <exp_id> --kind regression_signal \
  --data '{"reason":"operator manually deleted the output chat","ts":"..."}'
```

Useful observation kinds (semantic taxonomy):

| Kind | When to use |
|---|---|
| `fired` | Automation/function executed |
| `operator_used` | Operator engaged with output (opened/replied/copied/saved-as-note) |
| `metric_sample` | Periodic snapshot of a measurable metric |
| `regression_signal` | Something got worse — feeds auto-retire |
| `external_event` | Calendar conflict, operator pushed back, deploy event |
| `note` | Chad's free-text observation, not tied to a metric |

### Step 5 — Evaluate (at evaluates_at)

```sh
chad-experiment evaluate --id <exp_id> \
  --score 0.85 \
  --notes "3/3 Mondays operator opened within 1h; mean overlap_ratio 0.62 vs 0.50 target"
```

The `--notes` field is **mandatory** for the audit trail. Score ≥
0.70 → auto-promote; ≤ 0.70 → auto-retire. Or pass `--verdict extend
--extend-days 7` if you need more data.

### Step 6 — Promote OR retire → write the lessons-learned note

This is the step most-often skipped, and the one that compounds
learning over time. Whether the experiment promoted or retired,
write a `chad-webui notes create` entry tagged `experiment-learning`
so future-chad can search across all past experiments.

**On promote:**

```sh
chad-webui notes create \
  --title "Experiment learning: <hypothesis short-form>" \
  --content "$(cat <<EOF
exp_id: exp-2026-MM-DD-tantodefi-NNN
verdict: promoted (score 0.85)
hypothesis: <full hypothesis>
what worked: <2-3 bullets on the concrete things that made it succeed>
what surprised me: <1-2 bullets on unexpected observations>
keep-doing rule (for future experiments): <inferred pattern>
rollback path (kept in case operator changes mind): <auto-rollback-cmd>
EOF
)" \
  --tags "experiment-learning,promoted,tantodefi,$(date -u +%Y-%m)"
```

**On retire:**

```sh
chad-webui notes create \
  --title "Experiment learning (retired): <hypothesis short-form>" \
  --content "$(cat <<EOF
exp_id: exp-2026-MM-DD-tantodefi-NNN
verdict: retired (score 0.42, threshold 0.70)
hypothesis: <full hypothesis>
what failed: <2-3 bullets on what didn't land>
what to try next: <follow-up hypothesis or alternate approach>
don't-repeat rule: <pattern to avoid in next design>
EOF
)" \
  --tags "experiment-learning,retired,tantodefi,$(date -u +%Y-%m)"
```

The note plus the archived `archive/<id>.json` plus the ledger
entries form the complete audit trail. The note is human-readable
and operator-visible; the archive is structured; the ledger is the
event stream. Three views of the same outcome, each useful in a
different context.

### Step 7 — Optional: contribute to the `experiment-learnings` knowledge collection

For patterns chad expects to reach for repeatedly (e.g. "morning
summaries with terse 3-bullet prompts win in 4 of 5 cases"), bump
the learning into a dedicated knowledge collection so future chats
can RAG against it:

```sh
# One-time setup (idempotent):
KB_ID=$(chad-webui knowledge list | jq -r '.[] | select(.name=="experiment-learnings") | .id')
if [ -z "$KB_ID" ]; then
  KB_ID=$(chad-webui knowledge create \
    --name "experiment-learnings" \
    --description "Accumulated chad-experiment outcomes — what patterns work, what doesn't, for which operator" | jq -r '.id')
fi

# Each lesson:
echo "<note content>" > /tmp/lesson.md
FILE_ID=$(chad-webui files upload --path /tmp/lesson.md | jq -r '.id')
chad-webui knowledge add-file --knowledge-id "$KB_ID" --file-id "$FILE_ID"
```

After enough cycles, the collection becomes chad's institutional
memory: a new candidate hypothesis gets cross-referenced against
prior learnings before being designed.

## A/B test workflow — the specific path

A/B is a tighter loop than single-experiment because both variants
need observation traffic. Step-by-step:

### Pre-design checklist

Before running `ab-start`:

1. **Budget**: `chad-experiment budget` — need 2 free slots
2. **Same operator surface**: both variants must fire on the same
   operator's surfaces (you can't A/B across operators)
3. **Single-variable hypothesis**: only ONE thing should differ
   between A and B (prompt tone, RRULE timing, model choice).
   Multi-variable changes are easier to design but impossible to
   attribute later.
4. **Sample size estimate**: how many observations of each variant
   do you need? For binary outcomes (opened/not), 10+ per variant
   is the minimum signal-vs-noise threshold; 30+ is comfortable.
   If the RRULE fires daily and the window is 7d, that's 7 samples
   per variant — borderline. Use `--evaluation-days 14` for daily
   automations.

### Run ab-start

```sh
chad-experiment ab-start \
  --hypothesis "Single-variable change description" \
  --type automation \
  --success-metric "Single measurable outcome chad can compute from observations" \
  --baseline "Quantified prior or default state" \
  --surface-cmd "automations create" \
  --surface-args-a '{"name":"... A","prompt":"...","rrule":"..."}' \
  --surface-args-b '{"name":"... B","prompt":"... ","rrule":"..."}' \
  --evaluation-days 14
```

### Observe both variants

Every nightly cron, observe each variant's fires + engagement:

```sh
# For each variant id in the pair:
chad-experiment observe --id <A-id> --kind operator_used --data '{...}'
chad-experiment observe --id <B-id> --kind operator_used --data '{...}'
```

### Pick the winner (after the window)

```sh
# Summary comparison first:
chad-experiment ab-summary --pair-id <pair_id>

# Then commit:
chad-experiment ab-pick --id <either> --winner B
```

Winner promotes; loser retires. The summary output tells you the
observation counts and gives evidence for the decision.

### Post-pick note

```sh
chad-webui notes create \
  --title "A/B learning: <hypothesis>" \
  --content "$(cat <<EOF
pair_id: <pair_id>
winner: B (rationale: <data>)
loser: A (rationale: <data>)
margin: <ratio of B's metric over A's>
inference for future experiments: <generalized takeaway>
EOF
)" \
  --tags "experiment-learning,ab-test,promoted,$(date -u +%Y-%m)"
```

## Iteration & extension patterns

When an experiment finishes, chad has 4 next-step options:

| Outcome | Default next step |
|---|---|
| Promoted with clear margin (score > 0.85) | Add to `experiment-learnings` knowledge collection; consider broader rollout (e.g. promote function from self → global) |
| Promoted narrowly (0.70 ≤ score < 0.85) | Keep but watch; consider follow-up A/B against a tweaked variant |
| Retired by margin (score < 0.50) | Hard retire; document don't-repeat pattern; try fundamentally different approach |
| Retired narrowly (0.50 ≤ score ≤ 0.70) | Consider `--verdict extend` next time instead of full retire — the signal was inconclusive |
| Inconclusive (no observations) | Always extend before retiring; otherwise you're guessing |

**Follow-up experiment design rule:** if you retire an experiment
and immediately re-design something similar, document the link in
the new experiment's hypothesis field — e.g. "Follow-up to
exp-2026-MM-DD-...; that variant retired because <X>; this variant
addresses <X> by <Y>."

## Note-taking conventions summary

| Surface | Lifetime | Purpose | How chad writes |
|---|---|---|---|
| Ledger event (jsonl) | Forever | Audit trail | Auto-written by every `chad-experiment <verb>` |
| `active/<id>.json` | Until promote/retire | Live record | Auto-managed; `chad-experiment observe` appends observations |
| `archive/<id>.json` | Forever | Frozen snapshot | Auto-written on promote/retire |
| Today's memory (markdown) | Synced to gbrain nightly | Operator-readable narrative | `chad-ensure-today-memory` + append |
| `chad-webui notes create` with `experiment-learning` tag | Until operator deletes | Searchable per-experiment writeups | After promote/retire; one note per outcome |
| `experiment-learnings` knowledge collection | Forever (RAG-queryable) | Institutional pattern memory | After multiple cycles produce a recurring lesson |

This is the layered note system. Each layer answers a different
question:

- **What state is this experiment in right now?** → `active/<id>.json`
- **What happened during it?** → ledger + observations[]
- **Why did it succeed/fail?** → experiment-learning note
- **What's the general principle?** → experiment-learnings knowledge collection
- **Did it happen at all?** → today's memory (lightweight summary)

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

## Nightly loop (what `chad-experiment-cron` automates at 02:00 UTC)

> **As of 2026-06**: the nightly tick is NOT an agent turn. The
> `nightly-experiments` cron runs `chad-experiment-cron`, a
> deterministic driver that executes phases 2 → 3 → 1 below
> (observe → evaluate → design) via single-turn, no-tools LLM calls.
> Phase 4 (calendar coordination) is not automated — do it
> interactively when an operator asks or a review is due. The phase
> descriptions below remain the methodology: follow them when working
> an experiment by hand, and they describe what the wrapper does on
> your behalf each night.

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

After its run, `chad-experiment-cron` appends a one-line summary to
today's memory and emits the same line as its only stdout:

```text
chad-experiment-cron: observed=3 evaluated=1 designed=yes
```

When working experiments interactively, write a richer summary block
to today's memory so operators see what changed and why.

## Integration with existing systems

| System | How experiments plug in |
|---|---|
| **`gbrain-dream`** (03:30 UTC) | Runs AFTER the experiment cron. Picks up new ledger entries + memory summary → searchable by tomorrow's chat |
| **`chad-budget`** | `chad-experiment-cron` is budget-gated via the `nightly-experiments` profile in `task-profiles.json` (20k minBudget); below the gate the whole run is skipped with a reason line |
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

## Worked example — full experiment lifecycle (interactive)

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
- **Over-budget proposals.** Check `chad-experiment budget` before designing. Designing an unowned experiment is a wasted ledger entry.
- **Forgetting to observe.** A running experiment with zero observations always evaluates as inconclusive (or retire if no positive evidence by `evaluates_at`).
- **Rollback path that won't run.** Custom rollback strings ARE NOT auto-executed — only `chad-webui …` lines. For custom paths, you have to retire-and-fix manually.

## Cross-references

- [openwebui skill](../openwebui/SKILL.md) — every chad-webui command + recipes
- `chad-experiment` source: `/sandbox/.openclaw-data/bin/chad-experiment`
- Ledger: `/sandbox/.openclaw-data/state/experiments/ledger.jsonl`
- Config: `/sandbox/.openclaw-data/state/experiments/config.json`
- Active: `/sandbox/.openclaw-data/state/experiments/active/<id>.json`
- Archive: `/sandbox/.openclaw-data/state/experiments/archive/<id>.json`
