---
name: proton-calendar
description: >
  Interact with Proton Mail and Calendar using the go-proton-api Go library.
  Use when the user asks to read emails, list calendar events, or manage
  their Proton account. Requires Go 1.26+ and network access to Proton API
  endpoints and Go module proxies.
---

# Proton Calendar & Mail Skill

## Overview

This skill provides a small Go CLI tool (`proton-tool`) that wraps the
[go-proton-api](https://github.com/ProtonMail/go-proton-api) library to
interact with Proton Mail and Calendar from the command line.

**Important:** `go-proton-api` is a *library*, not a standalone binary.
The `cmd/proton-tool/` directory in this skill contains a thin CLI that
imports the library and exposes useful commands.

## Prerequisites

| Requirement | Notes |
|---|---|
| Proton account | With Mail + Calendar access |
| `PROTON_USERNAME` | Set via env or `~/.nemoclaw/credentials.json` |
| `PROTON_PASSWORD` | Set via env or `~/.nemoclaw/credentials.json` |
| Network policy | `proton_api` only (runtime) |
| `proton-tool` binary | Pre-built by developer and deployed to `/usr/local/bin/proton-tool` |

> **Go is a build-time concern, not a runtime one.** The `go_modules`,
> `go_module_git_sources`, and `go_install` policies are only needed when
> building `proton-tool` from source. Chad's sandbox does not need them.
> Build on the host (or a dev sandbox with those policies), then deploy the
> compiled binary as described below.

## Build & Deploy (developer task, not agent task)

See [BUILD.md](BUILD.md) for full instructions on building `proton-tool` and
deploying the binary to Chad's sandbox. The agent does not build the tool —
only the compiled binary at `/usr/local/bin/proton-tool` is needed at runtime.

### Stable path

`proton-tool` is baked into the sandbox image at `/usr/local/bin/proton-tool`
by the Dockerfile's `proton-builder` stage. It is present after every sandbox
build — no deploy step is needed.

To update the binary, change the source in
`.github/skills/proton-calendar/cmd/proton-tool/` and rebuild the sandbox
image. The Dockerfile will recompile and install the new binary automatically.

## Usage

### Authentication

The tool reads credentials from environment variables:

```bash
export PROTON_USERNAME="user@proton.me"
export PROTON_PASSWORD="password"
```

Or load them from NemoClaw credentials:

```bash
eval "$(python3 -c "
import json
c = json.load(open('/sandbox/.nemoclaw/credentials.json', 'r') if __import__('os').path.exists('/sandbox/.nemoclaw/credentials.json') else open('/home/sandbox/.nemoclaw/credentials.json', 'r'))
for k,v in c.items():
    if k.startswith('PROTON_'):
        print(f'export {k}={v!r}')
")"
```

### List Calendars

```bash
/usr/local/bin/proton-tool calendars
```

Shows all calendars (owned and shared), including type (normal/subscribed),
color, display status, and members with their email and permissions.

### List Calendar Events

```bash
/usr/local/bin/proton-tool events --calendar-id=<ID> --days=7
```

Decrypts event details (title, description, location) using the calendar's
encryption keys. Falls back to metadata-only output if decryption fails
(e.g. shared calendar without key access). Displays:

- **Summary** — event title (decrypted from SharedEvents VEVENT data)
- **Location** — event location (if set)
- **Description** — event description (if set)
- Start/end times, timezone, full-day flag, author, attendee count

### List Mail (Inbox)

```bash
/usr/local/bin/proton-tool mail --limit=10
```

### List Sent Messages

```bash
/usr/local/bin/proton-tool sent --limit=15 --days=3
```

Lists recent messages from the Sent folder. Use `--days=N` to filter to the
last N days (useful for the email-check cron to recover conversation context
without pulling the entire sent history).

### Read a Message (decrypts body, auto-marks read)

```bash
/usr/local/bin/proton-tool read-mail --id=MSGID
```

### Mark Messages as Read

```bash
/usr/local/bin/proton-tool mark-read --id=MSGID1,MSGID2,MSGID3
```

### Reply to a Message

```bash
/usr/local/bin/proton-tool reply-mail --id=MSGID --body="Reply text"
```

Constructs a proper threaded reply using the Proton `ParentID` + `ReplyAction`
API. The subject is automatically prefixed with `Re:` if not already present.
Recipients are set to the original sender. Use `--all` to reply-all (original
To recipients are CC'd).

```bash
/usr/local/bin/proton-tool reply-mail --id=MSGID --all --body="Reply to all"
```

### Move Messages to Trash

```bash
/usr/local/bin/proton-tool trash-mail --id=MSGID1,MSGID2
```

### Send a New Email

```bash
/usr/local/bin/proton-tool send-mail --to=user@example.com --subject="Hello" --body="Message text"
```

### List Custom Labels and Folders

```bash
/usr/local/bin/proton-tool labels
```

Shows user-created labels and folders with their IDs. The standard system
labels (Inbox, Sent, Trash, Spam, Archive) are not listed here — they have
fixed IDs: Inbox=0, AllSent=2, Trash=3, Spam=4, Archive=6.

### Get User Info

```bash
/usr/local/bin/proton-tool whoami
```

### Clear Cached Session

```bash
/usr/local/bin/proton-tool logout
```

Clears the cached auth tokens at `/sandbox/.proton-session.json`. The next
command will perform a full SRP login. Use this after changing your password
or if you see persistent auth errors.

### Email-check cron job

An automated cron job runs every **30 minutes** to check and process email.
See [EMAIL-POLICY.md](EMAIL-POLICY.md) for the full policy governing
this automation including anti-spam rules, task-weight system, and
acknowledgment protocol.

> **Why 30 minutes?** Proton rate-limits SRP logins (`POST /auth/v4`) to
> ~10 per hour. Each proton-tool invocation is a separate login unless
> session caching is active. At 15-minute intervals with 2-5 commands
> per run, the tool was hitting 429 errors. 30 minutes keeps us well
> within limits even if session refresh fails and falls back to SRP.

Add the cron via the OpenClaw Gateway:

```bash
openclaw cron add \
  --name "email-check" \
  --cron "*/30 * * * *" \
  --session isolated \
  --message 'Check email now. Follow the EMAIL-POLICY.md rules strictly. STEPS: 1. Compute today'"'"'s UTC date (YYYY-MM-DD) and read memory/<today>.md for any Pending Follow-ups and Awaiting Responses from previous runs. Act on follow-ups first. 2. Run: /usr/local/bin/proton-tool mail --limit=20 3. For each unread message from admin users, run: /usr/local/bin/proton-tool read-mail --id=MSGID (this auto-marks as read). If it replies to an Awaiting Response thread, clear that entry. 4. For newsletters/spam/non-admin unread: /usr/local/bin/proton-tool mark-read --id=MSGID1,MSGID2 to clean them up 5. Run: /usr/local/bin/proton-tool sent --limit=15 --days=3 to scan recent sent messages. Cross-reference with inbox to find threads still awaiting a reply. Update Awaiting Responses in today'"'"'s log. 6. Respond per EMAIL-POLICY.md rules. Check cooldowns and daily cap before sending. NEVER send follow-up nudges automatically. 7. Log everything to memory/<today>.md including Awaiting Responses and Pending Follow-ups sections for next run.' \
  --announce \
  --channel last
```

> **Why single quotes?** The `--message` flag is wrapped in single quotes so
> the shell does **not** expand `$(date ...)` at registration time. The agent
> computes today's UTC date (`YYYY-MM-DD`) dynamically each time the cron fires,
> matching the `memory/YYYY-MM-DD.md` convention in EMAIL-POLICY.md.

## Proton REST API Reference

The go-proton-api library talks to these Proton API hosts:
- `mail-api.proton.me` (primary REST API)
- `api.protonmail.ch` (legacy, still functional)
- `account.proton.me` (auth/account operations)

Key API routes used by the library:
- `POST /auth/v4` — SRP authentication
- `GET /calendar/v1` — list calendars
- `GET /calendar/v1/{calID}/events` — list events (paged)
- `GET /calendar/v1/{calID}/events/{eventID}` — single event
- `GET /calendar/v1/{calID}/keys` — calendar encryption keys
- `GET /calendar/v1/{calID}/members` — calendar members
- `GET /calendar/v1/{calID}/passphrase` — calendar passphrase
- `GET /mail/v4/messages` — list messages
- `GET /core/v4/users` — user info

All data is end-to-end encrypted with PGP. The library handles
key exchange, SRP auth, and decryption internally.

## Session Caching & Rate Limits

Proton rate-limits SRP authentication (`POST /auth/v4`) to approximately
**10 logins per hour**. Exceeding this returns HTTP 429 "Too many recent
logins" and locks you out for a cooling period.

To avoid this, `proton-tool` caches auth tokens to a session file
(`/sandbox/.proton-session.json` by default). On subsequent invocations it
uses the refresh token (`POST /auth/v4/refresh`) instead of SRP, which has
a much higher rate limit.

| Item | Detail |
|---|---|
| Session file | `/sandbox/.proton-session.json` (override with `PROTON_SESSION_FILE`) |
| File permissions | `0600` (owner read/write only) |
| Token lifetime | Cached tokens are discarded after 24 hours |
| Refresh mechanism | `Manager.NewClientWithRefresh()` → `/auth/v4/refresh` |
| Fallback | If refresh fails, falls back to full SRP login |
| Clear session | `proton-tool logout` |

### Rate limit budget

With the 30-minute cron and session caching:

- **Normal case (session valid):** Most commands use token refresh (0 SRP).
  Commands needing key decryption (events, read-mail, send-mail) always
  use SRP since refresh tokens lack sufficient scope.
- **Typical cron run:** 1 SRP login (for read-mail) + refreshed calls for mail/sent/mark-read
- **Manual calendar checks:** Budget for ≤ 3 additional SRP logins/hour
- **Hard ceiling:** Never exceed 8 SRP logins in any rolling 60-minute window

If you see 429 errors, wait 30–60 minutes for the rate limit to reset, then
run `proton-tool logout` and try again.

## Network Policy Requirements

The sandbox needs these network policy groups for this skill:

- **`proton_api`** — `mail-api.proton.me`, `api.protonmail.ch`, `account.proton.me` on 443
- **`go_modules`** — `proxy.golang.org`, `sum.golang.org`, `storage.googleapis.com` on 443 (`access: full`)
- **`go_module_git_sources`** — `github.com`, `*.github.com`, `gitlab.com`, `*.gitlab.com` on 443 (`access: full`)
- **`go_install`** — `go.dev`, `dl.google.com`, `golang.org` on 443 (`access: full`)

All Go-related endpoints MUST use `access: full` because the Go toolchain
opens its own TLS connections (CONNECT tunnels through the proxy).

## Troubleshooting

| Problem | Fix |
|---|---|
| `go: Forbidden` on `go mod download` | Check that `go_modules` policy has `access: full` |
| `CONNECT tunnel failed, response 403` | The endpoint needs `access: full` not `protocol: rest` |
| `binary integrity violation` | Go binary was replaced after sandbox creation. Install to a NEW path (not `/sandbox/go`) |
| `Permission denied` removing module cache | Run `go clean -modcache` or use a fresh `GOPATH` |
| SRP auth failure | Verify PROTON_USERNAME/PROTON_PASSWORD are correct |
| HTTP 429 "Too many recent logins" | Wait 30-60 min, then `proton-tool logout` and retry. Reduce cron frequency or manual checks. See Session Caching section. |
| `Session refresh failed` in stderr | Cached session expired or was invalidated. The tool will auto-fallback to SRP. If SRP also fails with 429, wait for cooldown. |
| `Invalid page size parameter` (code 2021) | The go-proton-api library uses PageSize=150 but the Calendar API max is 100. The tool bypasses the library's `GetAllCalendarEvents` with a custom paginator using PageSize=100. If you see this error, the tool was built from old source — rebuild with `bash scripts/build.sh`. |
| Event titles blank / no Summary | Calendar key decryption failed. Check that the user is a member with key access (not view-only shared calendar). |

## File Structure

```
proton-calendar/
├── SKILL.md              # This file
├── EMAIL-POLICY.md       # Email cron job policy (anti-spam, task-weight, ack)
├── cmd/
│   └── proton-tool/
│       ├── main.go       # CLI entrypoint
│       ├── go.mod        # Module definition
│       └── go.sum        # (generated by go mod tidy)
├── scripts/
│   ├── install-go.sh     # Downloads Go 1.26.1
│   └── build.sh          # Builds proton-tool
├── references/           # API docs, notes
└── memory/               # Session notes
```
