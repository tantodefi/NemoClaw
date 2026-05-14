---
name: openwebui
description: |
  Chad's complete control surface for the OpenWebUI deployment at
  chad.supachad.com. Covers every v0.9.5 endpoint (60 commands across
  10 groups) via two paths: native MCP tools (webui__*) for in-agent
  use, and the chad-webui CLI for scripts and cron wrappers. Includes
  worked examples per command, composed recipes for common workflows,
  and a nightly-experiment playbook so Chad can run his own iteration
  loops (function development, memory consolidation, knowledge curation,
  model A/B testing, calendar/chat hygiene) without supervision.
  Fail-closed per-operator scoping is enforced at the wrapper layer.
  Use when Chad needs to act on operator calendar, notes, automations,
  memories, chats, knowledge, models, functions, tools, or folders —
  or when scripting a multi-step OpenWebUI workflow.
triggers:
  - calendar
  - schedule meeting
  - book a session
  - reschedule
  - rsvp
  - note
  - save this
  - reminder
  - automation
  - recurring
  - cron
  - memory
  - openwebui
  - supachad
  - knowledge base
  - rag
  - function
  - tool
  - chat history
  - chad-webui
  - night experiment
  - nightly run
  - run an experiment
allowed-tools:
  - exec
  - read
  - mcp_webui_*
---

# OpenWebUI — Chad's Operator Manual

This skill is the **complete reference** for how Chad interacts with
the OpenWebUI deployment at `chad.supachad.com`. It documents every
sub-command of the `chad-webui` CLI (and every corresponding `webui__*`
MCP tool), gives worked examples, and provides composed recipes Chad
can chain together for nightly experiments without supervision.

## Two paths to the same API

| Path | When to use |
|---|---|
| **MCP tools** (`webui__<group>_<command>`) | Default for any in-chat or agent-turn action. Structured args, JSON-schema validated, single line of trace per call. Auto-discovered in the agent's tool list. |
| **CLI** (`/sandbox/.openclaw-data/bin/chad-webui <group> <command>`) | Shell scripts, cron wrappers, multi-step pipelines using `jq`, error-recovery flows that need exit codes, or when you need to `xargs` over many ids. |

Both paths share auth, fail-closed operator scoping, JSON output, and
the same network plumbing. Choose the path that matches the call site,
not the surface — the result is identical.

## Auth model (read this before any write)

Two layers, both required, both already configured in
`/sandbox/.nemoclaw/credentials.json`:

```jsonc
{
  "OPENWEBUI_API_KEY":               "sk-…",            // default admin key
  "OPENWEBUI_API_KEY_TANTODEFI":     "sk-…",            // per-operator
  "OPENWEBUI_API_KEY_TJCOOKE":       "sk-…",            // per-operator
  "CF_ACCESS_CLIENT_ID":             "<token>.access",  // CF Access service token
  "CF_ACCESS_CLIENT_SECRET":         "<secret>",
  "OPENWEBUI_BASE_URL":              "https://chad.supachad.com/api/v1"  // optional override
}
```

The two layers:

1. **Cloudflare Access** at the edge. The service-token headers
   `CF-Access-Client-Id` + `CF-Access-Client-Secret` get past Zero
   Trust. Without these, every request returns `HTTP 403` from CF
   before it ever reaches OpenWebUI.
2. **OpenWebUI bearer auth** at the app. The `Authorization: Bearer
   <key>` header authenticates against an `auth.api_key` row. The
   owning user's role (`user`/`admin`) determines what the request
   can write.

The bearer key is **operator-scoped**. When `chad-shim` launches an
agent turn from open-webui, it exports:

```sh
CHAD_OPERATOR_SLUG=tantodefi      # email local-part, sanitized
CHAD_OPERATOR_EMAIL=tantodefi@proton.me
CHAD_OPERATOR_ROLE=admin
CHAD_OPERATOR_CHAT_ID=7f02...     # used as openclaw --session-id
```

The wrapper reads `CHAD_OPERATOR_SLUG` and selects
`OPENWEBUI_API_KEY_<SLUG_UPPER>`. **If that key is missing, the
wrapper exits 3** — it refuses to fall back to the default key. This
contains a confused or jailbroken model: cross-operator writes hit
HTTP 403 at the OpenWebUI permission layer regardless of what the
prompt says.

Anonymous callers (no `CHAD_OPERATOR_SLUG`) get `OPENWEBUI_API_KEY`.

## Network plumbing (and the one-thing-that-bit-us)

Outbound from the sandbox routes through OpenShell's L7 proxy at
`10.200.0.1:3128`. The proxy MITMs TLS for hosts where the OPA
policy declares `l7_protocol="rest"` (chad.supachad.com is one of
those), so it can inspect the request method, path, and query
params. The client then sees the proxy's cert, signed by the
OpenShell CA — not Cloudflare's cert.

Node trusts the OpenShell CA via `NODE_EXTRA_CA_CERTS`. **Python
urllib does not read that var**, so any python tool talking to
chad.supachad.com must point urllib at the CA bundle:

```sh
SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem
REQUESTS_CA_BUNDLE=/etc/openshell-tls/ca-bundle.pem
```

The `chad-webui-mcp` server sets these for every subprocess
automatically. If you ever run `chad-webui` outside its MCP host
(e.g. from a cron wrapper with a stripped env), set these too — or
you'll see `[Errno 101] Network is unreachable` followed by a
`TLS UnknownCA` line in `/var/log/openshell.YYYY-MM-DD.log`.

## Discovery patterns (always run before mutation)

| Want to … | Run first | Why |
|---|---|---|
| Create an event | `webui__calendar_list_calendars` | You need a `calendar_id` |
| Update a note | `webui__notes_list` then `webui__notes_get --note-id ID` | Confirm what you're overwriting; titles aren't unique |
| Add a file to a knowledge base | `webui__knowledge_list` then `webui__knowledge_get --knowledge-id ID` | See what's already in the collection |
| Toggle a model | `webui__models_list` | The dropdown shows base id, not the model id you'd toggle |
| Install a function | `webui__functions_list` | Avoid id collisions; function ids are globally unique |

If in doubt, **start with `webui__whoami`** to confirm you have the
identity + role you expect.

---

# Command reference (every command, every flag, worked example)

The CLI form is shown for each; the MCP tool name is always
`webui__<group>_<command>` with `_` instead of `-` (e.g.
`webui__calendar_create_event`).

For MCP, args are passed as a JSON object with snake_case keys (e.g.
`{"calendar_id": "…", "title": "…"}`). For CLI, kebab-case flags
(`--calendar-id …`). The wrapper translates one to the other.

## Diagnostics

### `whoami` — show OpenWebUI identity

```sh
chad-webui whoami
```

Hits `GET /api/v1/auths/`. Returns the full user record:

```json
{
  "id": "79495dc3-…",
  "name": "tantodefi",
  "role": "admin",
  "email": "tantodefi@proton.me",
  "token": "sk-…"
}
```

Use this as the **cheap health check** before any privileged
operation. If `role != "admin"`, downgrade your plan accordingly.

### `health` — probe reachability + auth

```sh
chad-webui health
```

Returns a diagnostic blob: base URL, the selected api-key name
(per-operator vs default), CF Access status, `/api/version` probe
result. Use when a downstream call fails and you don't know if it's
auth, network, or app.

## Calendar

The default calendar is the operator's primary. Events are stored
with nanosecond precision; `--all-day` flips the time component off.

### `calendar list-calendars`

```sh
chad-webui calendar list-calendars | jq '.[].name'
# "Personal"
# "Coached by TJ"
```

### `calendar create-calendar`

```sh
chad-webui calendar create-calendar \
  --name "Content drops" \
  --color "#FF5733" \
  --default
```

`--default` makes the new calendar the default for new events.

### `calendar set-default-calendar` / `delete-calendar`

```sh
CALS=$(chad-webui calendar list-calendars)
ID=$(echo "$CALS" | jq -r '.[] | select(.name=="Content drops") | .id')
chad-webui calendar set-default-calendar --calendar-id "$ID"
chad-webui calendar delete-calendar     --calendar-id "$ID"
```

### `calendar list-events`

```sh
# Default: today + 14 days
chad-webui calendar list-events

# Specific window
chad-webui calendar list-events \
  --start 2026-05-14 \
  --end   2026-05-21

# Single calendar
chad-webui calendar list-events \
  --calendar-ids "$ID" \
  --start 2026-05-14T00:00:00Z \
  --end   2026-05-15T00:00:00Z
```

`--start`/`--end` accept either bare `YYYY-MM-DD` (midnight UTC) or
full ISO 8601 with timezone.

### `calendar search-events`

```sh
chad-webui calendar search-events --query "review with tj" --limit 10
```

Full-text against title + description.

### `calendar get-event`

```sh
chad-webui calendar get-event --event-id 7f02…
```

### `calendar create-event`

```sh
# One-shot
chad-webui calendar create-event \
  --calendar-id "$CAL_ID" \
  --title "Weekly review with tjcooke" \
  --start 2026-05-19T10:00:00Z \
  --end   2026-05-19T10:30:00Z \
  --description "Look at last week's coaching content; queue this week's" \
  --location "Zoom: https://…" \
  --color "#1E90FF" \
  --rrule "FREQ=WEEKLY;BYDAY=MO"

# All-day reminder
chad-webui calendar create-event \
  --calendar-id "$CAL_ID" \
  --title "Quarterly retrospective" \
  --start 2026-06-30 \
  --all-day
```

RRULE follows [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10).
Common patterns:

| Recurrence | RRULE |
|---|---|
| Every weekday at 9am | `FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0` |
| Every other Monday | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` |
| 1st of every month | `FREQ=MONTHLY;BYMONTHDAY=1` |
| Daily for 30 occurrences | `FREQ=DAILY;COUNT=30` |
| Daily until a date | `FREQ=DAILY;UNTIL=20260701T000000Z` |

### `calendar update-event`

All flags from `create-event` are optional on update; only `--event-id`
is required.

```sh
chad-webui calendar update-event \
  --event-id "$EVENT_ID" \
  --start 2026-05-19T11:00:00Z \
  --end   2026-05-19T11:30:00Z
```

### `calendar delete-event` / `rsvp`

```sh
chad-webui calendar delete-event --event-id "$EVENT_ID"

chad-webui calendar rsvp \
  --event-id "$EVENT_ID" \
  --status accepted     # accepted | declined | tentative | pending
```

## Notes

Notes are tagged markdown documents. Tags are comma-separated strings.

### `notes list` / `get`

```sh
chad-webui notes list | jq '.[] | {id,title,updated_at}'
chad-webui notes get --note-id "$NOTE_ID"
```

### `notes create`

```sh
# Inline content
chad-webui notes create \
  --title "Mobility protocol for tj" \
  --content "## Warm-up\n- 5 min row\n- 90/90 hip rotations\n- …" \
  --tags "coaching,mobility,tj"

# Long content from a file (avoids shell quoting hell)
chad-webui notes create \
  --title "Week of 2026-05-19 — content plan" \
  --content-file /tmp/content-plan.md \
  --tags "content,planning"
```

### `notes update`

```sh
chad-webui notes update \
  --note-id "$ID" \
  --content-file /tmp/refined-plan.md
```

Pass only the fields you want changed.

### `notes delete`

```sh
chad-webui notes delete --note-id "$ID"
```

## Automations (scheduled prompts)

Automations are recurring prompts that run on a schedule and write
their output to the operator's chats. The schedule is an RRULE.

### `automations list` / `get`

```sh
chad-webui automations list
chad-webui automations get --automation-id "$AUTO_ID"
```

### `automations create`

```sh
chad-webui automations create \
  --name "Morning brief — tantodefi" \
  --prompt "Read overnight inbox + cron memory. Summarize what changed and what needs attention. Keep it to 5 bullets." \
  --rrule "FREQ=DAILY;BYHOUR=7;BYMINUTE=0" \
  --model "chad"
```

`--inactive` creates it disabled. Omit `--model` to use the operator's
current default.

### `automations update`

```sh
chad-webui automations update \
  --automation-id "$AUTO_ID" \
  --rrule "FREQ=DAILY;BYHOUR=8;BYMINUTE=30"
```

### `automations delete`

```sh
chad-webui automations delete --automation-id "$AUTO_ID"
```

## Memories (per-operator long-term)

Memories surface to the model on every chat turn as context. Keep
them short (one fact per memory). They're operator-scoped — tantodefi
can't see tjcooke's memories, and vice versa.

### `memories list` / `create` / `update` / `delete`

```sh
chad-webui memories list
chad-webui memories create --content "Prefers metric units; lifts on Mon/Wed/Fri."
chad-webui memories update --memory-id "$MEM_ID" --content "Prefers imperial units for body weight, metric for plates."
chad-webui memories delete --memory-id "$MEM_ID"
```

## Chats

The chat history is the source of truth for past conversations. New
chats can't be created here — they're created by the model serving
turn. But every other lifecycle action is exposed.

### `chats list` / `get` / `search`

```sh
chad-webui chats list --page 1                # 20 per page
chad-webui chats get --chat-id "$CHAT_ID"     # full conversation
chad-webui chats search --query "openwebui upgrade"
```

### `chats archive` / `pin`

Both are toggles — call once to set, again to unset. The response
shows the new state.

```sh
chad-webui chats archive --chat-id "$ID"
chad-webui chats pin     --chat-id "$ID"
```

### `chats share` / `unshare`

```sh
RESP=$(chad-webui chats share --chat-id "$ID")
SHARE_ID=$(echo "$RESP" | jq -r '.share_id')
echo "Share URL: https://chad.supachad.com/s/$SHARE_ID"

chad-webui chats unshare --chat-id "$ID"     # revokes the share token
```

### `chats delete`

```sh
chad-webui chats delete --chat-id "$ID"      # permanent; no undo
```

## Knowledge (RAG collections)

Knowledge collections are vector-indexed file groups the model can
RAG-retrieve into a chat turn. A collection is metadata; files come
from `POST /api/v1/files/` (not in chad-webui yet — see
"Knowledge ingestion" recipe below for the workaround).

### `knowledge list` / `get`

```sh
chad-webui knowledge list
chad-webui knowledge get --knowledge-id "$KB_ID"   # includes the file list
```

### `knowledge create`

```sh
chad-webui knowledge create \
  --name "Strength training programming" \
  --description "Sources for coaching content drafts — Schoenfeld, Helms, Israetel, MASS."
```

### `knowledge update`

```sh
chad-webui knowledge update \
  --knowledge-id "$KB_ID" \
  --name "Strength + hypertrophy programming"
```

### `knowledge add-file`

Attach an already-uploaded file (you must POST to `/api/v1/files/`
first, then use the returned id here):

```sh
# Step 1: upload via curl (no chad-webui wrapper yet)
FILE_RESP=$(curl -sS -X POST "https://chad.supachad.com/api/v1/files/" \
  -H "Authorization: Bearer $OPENWEBUI_API_KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -F "file=@/tmp/schoenfeld-2021-review.pdf")
FILE_ID=$(echo "$FILE_RESP" | jq -r '.id')

# Step 2: attach to the collection
chad-webui knowledge add-file --knowledge-id "$KB_ID" --file-id "$FILE_ID"
```

### `knowledge delete`

```sh
chad-webui knowledge delete --knowledge-id "$KB_ID"
```

## Models (admin role required for writes)

The model registry powers the dropdown. `list` shows every row; the
write commands are admin-only and uncommon — typically for adding a
new fine-tuned variant or toggling visibility.

### `models list`

```sh
chad-webui models list | jq '.[] | {id,name,is_active}'
```

### `models create`

```sh
chad-webui models create \
  --id "chad-experiment-1" \
  --base-model-id "chad" \
  --name "Chad experiment 1 — terser style" \
  --params '{"system":"Be very terse. Single sentences. No emojis."}' \
  --meta '{"description":"A/B test variant"}'
```

`--params` and `--meta` accept JSON strings. Available `params` keys
include `system`, `temperature`, `max_tokens`, `seed`, plus open-webui
specific ones — see the upstream docs link below.

### `models update`

```sh
chad-webui models update \
  --id "chad-experiment-1" \
  --params '{"system":"Be terse but warm. Two sentences max."}'
```

### `models toggle`

```sh
chad-webui models toggle --id "chad-experiment-1"
```

Toggle enables/disables a model row. Disabled rows don't appear in
the dropdown but the entry stays in the db.

## Functions (admin role required for writes)

Functions are Python modules that extend OpenWebUI. Three types:

| Type | What it does | Example use |
|---|---|---|
| `filter` | Mutates request/response in the chat pipeline | Strip PII before sending to upstream |
| `pipe` | Replaces the upstream call entirely with custom Python | Local model proxy, mock model for testing |
| `action` | Adds a clickable button under each assistant message | "Save to notes", "Regenerate with longer answer" |

### `functions list` / `get`

```sh
chad-webui functions list
chad-webui functions get --function-id strip_emails
```

### `functions create`

```sh
chad-webui functions create \
  --id strip_emails \
  --name "Strip emails from prompts" \
  --type filter \
  --content-file /tmp/strip-emails.py \
  --description "Removes email addresses from user messages before they reach the upstream."
```

Function source format: see [OpenWebUI Functions docs][owui-functions].

### `functions update` / `delete`

```sh
chad-webui functions update \
  --function-id strip_emails \
  --content-file /tmp/strip-emails-v2.py

chad-webui functions delete --function-id strip_emails
```

### `functions toggle`

Toggle enables/disables a function. `--scope global` toggles whether
it applies to **every** chat (admin only); default `--scope self`
only toggles for the current user.

```sh
chad-webui functions toggle --function-id strip_emails --scope global
```

## Tools (admin role required for writes)

Tools are Python modules exposed to the model as OpenAI-style tool
specs. Different from functions: tools are *called by the model* on
demand, functions transparently mutate the pipeline.

### `tools list` / `get` / `create` / `update` / `delete`

Same flag shape as functions, minus the `--type` and `--scope`:

```sh
chad-webui tools list
chad-webui tools create \
  --id weather_check \
  --name "Weather check" \
  --content-file /tmp/weather-tool.py \
  --description "Returns current weather for a city."
chad-webui tools update --tool-id weather_check --content-file /tmp/weather-v2.py
chad-webui tools delete --tool-id weather_check
```

Tool source format: see [OpenWebUI Tools docs][owui-tools].

## Folders

Chat folders are a UI-side organization mechanism. The chats inside
aren't physically moved — they get a `folder_id` reference.

```sh
chad-webui folders list
chad-webui folders create --name "Coaching content drafts"
chad-webui folders rename --folder-id "$F_ID" --name "Coaching drafts (active)"
chad-webui folders delete --folder-id "$F_ID"
```

---

# Composed workflows (recipes)

These are multi-step patterns that come up repeatedly. Each is
written as a shell script for clarity; chains of MCP tool calls work
equivalently.

## Recipe 1 — "Save this conversation as a note"

```sh
CHAT_ID="$CHAD_OPERATOR_CHAT_ID"          # provided by chad-shim
CHAT=$(chad-webui chats get --chat-id "$CHAT_ID")
TITLE=$(echo "$CHAT" | jq -r '.title')
BODY=$(echo "$CHAT" | jq -r '.chat.messages[] | "**\(.role)**: \(.content)\n"' | sed 's/^null$//')
echo "$BODY" > /tmp/chat-snapshot.md
chad-webui notes create \
  --title "Chat: $TITLE" \
  --content-file /tmp/chat-snapshot.md \
  --tags "chat-export,$(date -u +%Y-%m)"
```

## Recipe 2 — "Reschedule everything from tomorrow to next Monday"

```sh
TOMORROW=$(date -u -d 'tomorrow' +%Y-%m-%d)
NEXT_MON=$(date -u -d 'next Monday' +%Y-%m-%d)
EVENTS=$(chad-webui calendar list-events --start "$TOMORROW" --end "$TOMORROW")
echo "$EVENTS" | jq -r '.[].id' | while read EVENT_ID; do
  # Preserve time-of-day; only shift the date
  OLD=$(chad-webui calendar get-event --event-id "$EVENT_ID")
  OLD_START=$(echo "$OLD" | jq -r '.start')
  TIME=$(echo "$OLD_START" | cut -dT -f2)
  chad-webui calendar update-event \
    --event-id "$EVENT_ID" \
    --start "${NEXT_MON}T${TIME}"
done
```

## Recipe 3 — "Hygiene: archive chats older than 30 days that aren't pinned"

```sh
CUTOFF_MS=$(( $(date -u +%s) * 1000 - 30 * 86400 * 1000 ))
chad-webui chats list | jq -r --argjson cutoff "$CUTOFF_MS" '
  .[] | select(.pinned != true and .updated_at < $cutoff) | .id
' | while read ID; do
  chad-webui chats archive --chat-id "$ID"
done
```

## Recipe 4 — "Ingest a URL into a knowledge collection"

```sh
URL="$1"
KB_NAME="$2"
KB=$(chad-webui knowledge list | jq -r --arg n "$KB_NAME" '.[] | select(.name == $n) | .id')
if [ -z "$KB" ]; then
  KB=$(chad-webui knowledge create --name "$KB_NAME" | jq -r '.id')
fi
# Download + upload + attach
curl -sS "$URL" -o /tmp/ingest-$$
FILE_ID=$(curl -sS -X POST "$OPENWEBUI_BASE_URL/files/" \
  -H "Authorization: Bearer $OPENWEBUI_API_KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -F "file=@/tmp/ingest-$$" | jq -r '.id')
chad-webui knowledge add-file --knowledge-id "$KB" --file-id "$FILE_ID"
rm -f /tmp/ingest-$$
```

## Recipe 5 — "Memory consolidation pass"

Detect near-duplicate memories, propose a merged version, keep one,
delete the others.

```sh
MEMS=$(chad-webui memories list)
# Group by similar prefixes (cheap heuristic — chad can replace with embedding sim)
echo "$MEMS" | jq -r '.[] | "\(.id) \(.content[:60])"' | sort -k2 > /tmp/mems.txt
# Send to chad to find dupes → human-approval flow → delete via memories delete.
```

## Recipe 6 — "A/B test two model variants"

```sh
# Create two variants
chad-webui models create --id chad-A --base-model-id chad --name "Chad A — terse" \
  --params '{"system":"Be terse."}'
chad-webui models create --id chad-B --base-model-id chad --name "Chad B — warm" \
  --params '{"system":"Be warm and slightly verbose."}'
# Sample prompts (in a test chat each)
PROMPTS=("morning brief" "summarize my inbox" "write a note about today")
for P in "${PROMPTS[@]}"; do
  for M in chad-A chad-B; do
    # Use openclaw agent (or curl /api/chat/completions) with --model $M
    echo "[$M] $P"
  done
done
# Optionally: chad-webui models toggle to retire the loser.
```

---

# Nightly experiment playbook

Chad has 02:00-06:00 UTC to himself most days. Patterns he can run
without supervision (idempotent, low-blast, easy to roll back):

## Pattern A — "Function development cycle"

Goal: iteratively develop a custom function, test, refine.

1. `webui__functions_list` → check if a sibling exists; pick a fresh id
2. Write Python to `/tmp/test-fn-$DATE.py`
3. `webui__functions_create` with `--inactive` (set in `meta`)
4. Activate for self with `webui__functions_toggle --scope self`
5. Send a sample chat through (model picks the function up)
6. `webui__chats_list` + `webui__chats_get` to inspect the response
7. Refine → `webui__functions_update`
8. When happy: `webui__functions_toggle --scope global`
9. Log the iteration to memory: `webui__memories_create`
10. **Rollback if needed**: `webui__functions_delete` (file id preserved in your notes from step 3)

## Pattern B — "Knowledge curation pass"

Goal: keep RAG collections fresh; drop stale, add recent.

1. `webui__knowledge_list` → enumerate collections
2. For each collection, `webui__knowledge_get` to see file ages
3. Identify files older than the policy cutoff (e.g. 90 days for news,
   never for foundational papers)
4. (no chad-webui wrapper for delete-file yet — fall back to
   `DELETE /api/v1/files/{file_id}` via curl)
5. Replace with fresher sources via the Recipe 4 ingest pattern
6. `webui__memories_create` to log "Refreshed KB X on 2026-MM-DD; replaced N files"

## Pattern C — "Memory hygiene"

Goal: keep operator memory store tight; dedupe and condense.

1. `webui__memories_list`
2. Group by topic (chad does this in prompt; cheap)
3. Identify duplicates / outdated / superseded
4. For each: `webui__memories_update` with a consolidated version,
   then `webui__memories_delete` the redundant ones
5. **Never delete without first updating a survivor** — atomicity matters

## Pattern D — "Calendar / chat hygiene"

Goal: keep the operator's surfaces clean.

- Archive every past event older than 7 days (the UI hides them but
  the search still indexes)
- Archive every chat older than 30 days that isn't pinned (Recipe 3)
- Verify all recurring events still match the operator's stated
  rhythm (cross-ref against `identity.md`)

## Pattern E — "Automation review"

Goal: ensure scheduled automations are still firing as expected.

1. `webui__automations_list`
2. For each, inspect last fire time vs RRULE expectation
3. If drift: `webui__automations_update` with corrected RRULE OR
   `webui__automations_delete` if obsolete

## Safe-experiment ground rules

| Rule | Why |
|---|---|
| Always `whoami` first | Confirms identity + role before any write |
| List before update | You're not in a UI; you can't see what you're about to change |
| Tag every experiment in memory | So you can find it tomorrow morning |
| Use `--inactive` / `is_active=False` on new artifacts until tested | Surface them only after you've confirmed they work |
| Delete = the last resort | Update / archive / disable first |
| Log the rollback path | "If this breaks, run X to undo" — written as a memory at start of experiment |

## Suggested cron-wrapper additions (not yet built)

These don't exist as named cron jobs yet but are good candidates for
Chad's autonomous loops. Mention this to the operator when proposing
new automations:

| Wrapper | Schedule | Purpose |
|---|---|---|
| `chad-webui-curate` | `0 3 * * *` | Run Pattern B every night for stale KB files |
| `chad-memory-condense` | `0 4 * * 0` | Pattern C weekly |
| `chad-chat-hygiene` | `0 5 * * *` | Pattern D archive sweep |
| `chad-automation-audit` | `0 6 * * 0` | Pattern E weekly review |

---

# Error handling + idempotency

## Exit codes (CLI form)

| Code | Meaning | Recovery |
|---|---|---|
| 0 | Success (JSON on stdout) | Use the response |
| 1 | HTTP error (4xx/5xx) — stderr has the detail | Re-read the request; common: missing required field, wrong id format |
| 2 | Credentials file missing or malformed | Run `chad-restore-from-github`; check `/sandbox/.nemoclaw/credentials.json` |
| 3 | Operator slug set but matching API key missing — fail-closed | Add `OPENWEBUI_API_KEY_<SLUG>` to credentials; never relax this |

## Idempotency matrix

| Operation | Idempotent? | Notes |
|---|---|---|
| List / get / search | Yes | Read-only |
| Create event/note/memory/automation | No — duplicates the record | Search first, decide |
| Update | Yes | Setting the same fields again is a no-op |
| Delete | Yes (first call deletes, subsequent calls 404) | Tolerate 404 in scripts |
| Toggle | No — flips each time | Read state first if you want a specific direction |
| Archive | No — toggles | Same as toggle |
| Share | No — creates a new share each call | Check `share_id` field on the chat first |

## HTTP 403 / 401 — auth failure routing

| Symptom | Root cause | Fix |
|---|---|---|
| 403 with `cloudflare` in body | CF Access service token rejected | Check `CF_ACCESS_CLIENT_*` in credentials; verify token in CF Zero Trust dashboard |
| 401 with `unauthenticated` | Bearer key invalid | Rotate via `/api/v1/auths/api_key` (admin) |
| 403 with `not allowed` | Operator role insufficient (e.g. trying admin op as user) | Surface to tantodefi; don't escalate |

## `[Errno 101] Network is unreachable` from urllib

Two possible causes:

1. **`HTTPS_PROXY` env not set in subprocess.** The L7 proxy at
   `10.200.0.1:3128` is the only outbound path; without the env,
   urllib tries direct egress and fails. `chad-webui-mcp` sets
   this automatically — for any other call site, set:
   ```sh
   export HTTPS_PROXY=http://10.200.0.1:3128
   export HTTP_PROXY=http://10.200.0.1:3128
   export NO_PROXY=localhost,127.0.0.1,::1,10.200.0.1
   ```

2. **TLS UnknownCA**, often misreported as Errno 101 depending on
   client. Set the CA bundle:
   ```sh
   export SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem
   export REQUESTS_CA_BUNDLE=/etc/openshell-tls/ca-bundle.pem
   ```

Check `/var/log/openshell.YYYY-MM-DD.log` for the matching
`CONNECT_L7` line; the `action="allow"` / `action="deny"` reveals
whether the L7 policy was the block.

---

# Linked docs

## Official OpenWebUI

- [OpenWebUI docs](https://docs.openwebui.com/)
- [Environment variables](https://docs.openwebui.com/getting-started/env-configuration)
- [API reference](https://docs.openwebui.com/getting-started/api-endpoints)
- [Functions][owui-functions] — Python pipeline filter / pipe / action
- [Tools][owui-tools] — OpenAI-style tool specs
- [Pipelines](https://docs.openwebui.com/pipelines/) — long-form pipeline framework
- [GitHub releases](https://github.com/open-webui/open-webui/releases)

[owui-functions]: https://docs.openwebui.com/features/plugin/functions/
[owui-tools]: https://docs.openwebui.com/features/plugin/tools/

## Local docs (in this repo)

- `docs/operations/openwebui.md` — host-side deployment guide
- `docs/operations/chad-devflow.md` — full chad-* wrapper catalog
- `docs/operations/wrapper-bugs.md` — tracked bugs + shim workarounds

## Source

- Wrapper: `/sandbox/.openclaw-data/bin/chad-webui` (Python, stdlib only)
- MCP server: `/sandbox/.openclaw-data/bin/chad-webui-mcp` (Python, stdlib only)
- Source-of-truth: `scripts/openwebui/chad-webui` and `scripts/openwebui/chad-webui-mcp`
- Credentials: `/sandbox/.nemoclaw/credentials.json`
- MCP registration: `mcp.servers.webui` in `/sandbox/.openclaw/openclaw.json`

## In-container source (for endpoint discovery)

When something isn't documented and you need to find an endpoint:

```sh
docker exec nemoclaw-openwebui grep -hE '@router\.(get|post|delete|put|patch)' \
  /app/backend/open_webui/routers/<router>.py
```

Where `<router>` is one of: `auths, chats, models, functions, tools,
knowledge, memories, folders, files, calendar, notes, automations,
configs, prompts, channels, users, groups, evaluations, audio, images`.
