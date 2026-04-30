---
title:
  page: "Open WebUI Front-End for Chad"
  nav: "Open WebUI"
description:
  main: "How to stand up open-webui as a chat front-end backed by NemoClaw inference, exposed securely over the internet via Cloudflare Tunnel and Access."
  agent: "Operator guide for the open-webui chat front-end. Use when the user wants to chat with Chad/NemoClaw outside the sandbox SSH session, or asks how to onboard a second admin to the web UI."
keywords: ["open-webui", "cloudflare tunnel", "cloudflare access", "chad webui", "nemoclaw chat ui"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "openwebui", "chad", "operations"]
content:
  type: how_to
  difficulty: technical_intermediate
  audience: ["developer", "engineer", "operator"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Open WebUI Front-End for Chad

`open-webui` is a chat UI that speaks the OpenAI API. NemoClaw bundles a
docker compose plus a Cloudflare-Tunnel-based setup script so you can stand
up a chat front-end backed by the same Nemotron 3 Super 120B inference Chad uses, reachable
from any browser, gated by an email allowlist.

## Architecture at a glance

Two upstreams are wired in. The model picker in the chat UI lets the user
choose between them per conversation:

```
   browser
      │
      ▼  https://<sub>.<domain>                (TLS terminated at CF edge)
   ┌──────────────────────────┐
   │   Cloudflare Access      │  email-OTP allowlist (ADMIN_EMAILS)
   └──────────┬───────────────┘
              │  passes Cf-Access-Authenticated-User-Email header
              ▼
   ┌──────────────────────────┐
   │   Cloudflare Tunnel      │  outbound from host, no inbound ports
   └──────────┬───────────────┘
              │
   ───────────┼─────────────────────────────────  host (your laptop or server)
              ▼
   ┌──────────────────────────┐    ┌────────────────────────┐
   │  cloudflared (docker)    │───►│  open-webui  (docker)  │
   └──────────────────────────┘    │  127.0.0.1:3000 only   │
                                   └────┬─────────────┬─────┘
                       OpenAI provider 1│             │OpenAI provider 2
                                        ▼             ▼
                            ┌────────────────────┐  ┌──────────────────────┐
                            │ NVIDIA Build       │  │ host:8901            │
                            │ /v1 (nemotron 120B,│  │ (SSH port-forward)   │
                            │  raw inference)    │  └──────────┬───────────┘
                            └────────────────────┘             │
                                                ──host─────────┼────────────
                                                               ▼
                                              ┌────────────────────────────┐
                                              │  OpenShell sandbox         │
                                              │  127.0.0.1:8901 chad-shim  │
                                              │  → openclaw agent (main)   │
                                              │  → gbrain + policies       │
                                              │  → action-gate + premium   │
                                              │  → NVIDIA Build            │
                                              └────────────────────────────┘
```

Open-webui binds to `127.0.0.1` only — the cloudflared sidecar is the sole
inbound path. Cloudflare Access sits in front of that and verifies the user
against `ADMIN_EMAILS` before any traffic reaches the tunnel.

**Provider 1 (raw NVIDIA Build)** is the default — chat goes straight to
`integrate.api.nvidia.com` from the host with the `NVIDIA_API_KEY`. Same model
Chad uses (`nvidia/nemotron-3-super-120b-a12b`), but no agent stack between you and the LLM.

**Provider 2 (`chad` model)** routes each turn through `chad-shim` running
**inside** the sandbox, which translates `POST /v1/chat/completions` into
`openclaw agent --json --agent main --session-id <hash> --message <text>`.
Replies come back with full Chad context: gbrain memory, network policies,
action-gate, premium routing, the lot. Slower (10–30 s per turn) but it's
"actually Chad" instead of "an LLM that happens to use the same key."

## Primary commands

| Command | What it does |
|---|---|
| `npm run webui:up` | Tunnel mode (default): creates tunnel + DNS + Access policy, brings up compose. Idempotent. |
| `npm run webui:up:quick` | Quick mode: ephemeral `*.trycloudflare.com` URL, no domain or API token required. Testing only. |
| `npm run webui:down` | Stop containers (both profiles); leave Cloudflare config in place. |
| `bash scripts/openwebui-down.sh --purge` | Stop containers **and** delete the tunnel, DNS record, and Access app from Cloudflare. |
| `npm run webui:logs` | Tail logs from open-webui + cloudflared. |
| `npm run webui:chad:up` | Open SSH port-forward `host:8901 → sandbox:8901` so the `chad` model becomes reachable. Idempotent. |
| `npm run webui:chad:down` | Close the SSH port-forward. The shim inside the sandbox keeps running. |
| `npm run webui:chad:status` | Report tunnel pid + `chad-shim /healthz`. |

## Modes

| | Tunnel mode (default) | Quick mode |
|---|---|---|
| URL | `https://<sub>.<domain>` (stable) | `https://<random>.trycloudflare.com` (changes on every restart) |
| Auth gate | Cloudflare Access email-OTP allowlist | open-webui email/password only |
| Domain required | Yes — managed in Cloudflare DNS | No |
| CF API token required | Yes — four scopes | No |
| First admin | Auto-provisioned on first authenticated visit | Manual: visit URL, sign up first user (signup auto-enabled, lock back after) |
| When to use | Multi-user, internet-facing, production | Spin up for a 30-min test, throw away |

Switch modes by re-running setup with `--mode=quick` or `--mode=tunnel`. The quick path skips all Cloudflare API calls and `--purge` is a no-op for it (nothing to delete from Cloudflare).

## Prerequisites

- A domain managed in Cloudflare DNS (Cloudflare Registrar, or any domain
  with NS pointed at Cloudflare). Quick tunnels (`*.trycloudflare.com`)
  do **not** support Access and so are not used here.
- A Cloudflare API token with these scopes:
  - `Zone.Zone:Read`
  - `Zone.DNS:Edit`
  - `Account.Cloudflare Tunnel:Edit`
  - `Account.Access: Apps and Policies:Edit`
- Account ID and Zone ID (visible in the Cloudflare dashboard sidebar).
- Docker (`docker compose` v2).
- Cloudflare Zero Trust enabled on the account (free tier covers up to
  50 users).

## Quick-mode walkthrough (testing)

If you don't have a domain yet and just want to verify the chat surface works:

```console
$ cp scripts/openwebui/env.template scripts/openwebui/.env
$ # only OPENAI_API_BASE_URL needs a value in quick mode
$ npm run webui:up:quick
==> openwebui-setup starting [quick] — ephemeral *.trycloudflare.com URL, no Access gate
    ! first-time setup: ENABLE_SIGNUP=True so you can create the first admin
==> Starting docker compose (quick profile)
    ✓ open-webui + quick tunnel running
==> Waiting for cloudflared to print the random URL
    ✓ URL: https://random-words-here.trycloudflare.com
```

Visit the URL, sign up the first admin (your email), then **edit `.env` to set `ENABLE_SIGNUP=False`** and re-run `npm run webui:up:quick` to apply. After that, additional users must be created from inside open-webui's admin UI.

The URL changes on every `cloudflared` restart — quick mode is for short-lived testing, not durable access.

## Initial setup (tunnel mode)

1. Copy the env template and fill in the blanks:

   ```console
   $ cp scripts/openwebui/env.template scripts/openwebui/.env
   $ $EDITOR scripts/openwebui/.env
   ```

   Required fields: `CF_DOMAIN`, `WEBUI_SUBDOMAIN`, `ADMIN_EMAILS`,
   `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `OPENAI_API_BASE_URL`.

2. Run setup:

   ```console
   $ npm run webui:up
   ==> openwebui-setup starting (fqdn=chad.example.dev, admins=tantodefi@proton.me,tjcooke@example.com)
   ==> Creating Cloudflare Tunnel: nemoclaw-chad
       ✓ tunnel created (id=…)
   ==> Configuring tunnel ingress → http://open-webui:8080
       ✓ ingress: chad.example.dev → open-webui:8080
   ==> Creating DNS CNAME chad.example.dev → ….cfargotunnel.com
       ✓ DNS record created
   ==> Creating Cloudflare Access application
       ✓ Access app id=…
   ==> Creating Access policy (allowlist: tantodefi@proton.me,tjcooke@example.com)
       ✓ policy created
   ==> Starting docker compose
       ✓ open-webui + cloudflared running
   ==> Setup complete
       URL:          https://chad.example.dev
       Admin emails: tantodefi@proton.me,tjcooke@example.com
   ```

3. Visit `https://<sub>.<domain>` from any browser. Cloudflare Access will
   prompt for an allowlisted email, send a one-time code, and (after entry)
   pass you through to open-webui where you'll be auto-provisioned.

## Adding or removing an admin

Edit `ADMIN_EMAILS` in `scripts/openwebui/.env`, then re-run setup:

```console
$ $EDITOR scripts/openwebui/.env       # change ADMIN_EMAILS=
$ npm run webui:up                     # re-runs idempotently; re-applies policy
```

Setup is idempotent — re-running won't create duplicate tunnels or apps.
The Access policy is recreated with the new email list.

To remove a user's open-webui account (separate from Access), an admin
deletes them from the open-webui Settings → Users panel.

## Inference endpoints

### Provider 1 — raw NVIDIA Build

Set in `scripts/openwebui/.env`:

```bash
OPENAI_API_BASE_URL=https://integrate.api.nvidia.com/v1
OPENAI_API_KEY=<NVIDIA_API_KEY from /sandbox/.openclaw-data/credentials/credentials.json>
```

The model picker shows every model in your NVIDIA Build catalog
(`nvidia/nemotron-3-super-120b-a12b`, the various NIMs, etc.). No sandbox dependency —
chat works even if the OpenShell sandbox is down.

> Note: Cloudflare passes the user's email through to open-webui in tunnel
> mode, but **NVIDIA Build sees no per-user identity** beyond your shared
> key. Per-user quota or audit must happen at the open-webui layer (admin
> panel → Users → restrict models per user).

### Provider 2 — Chad as a model (sandbox-backed)

Routes `chat` model requests through `chad-shim` inside the sandbox, which
turns each turn into `openclaw agent --json` against the `main` agent.
Replies carry full Chad context: gbrain, action-gate, premium routing,
network policies, audit logs, the works.

**Setup (first time, after `npm run webui:up:quick` is already healthy):**

1. Deploy the shim into the sandbox. `chad-setup.sh` installs it to
   `/usr/local/bin/chad-shim.py` and starts it as part of its standard
   `install_to_usrlocal` loop, so this is usually a no-op:

   ```console
   $ bash scripts/chad-setup.sh chad
   ...
       ✓ chad-shim.py deployed to /usr/local/bin/chad-shim.py
       ✓ chad-shim ensured running
   $ ssh openshell-chad 'curl -sS http://127.0.0.1:8901/healthz'
   {"status": "ok", "agent": "main"}
   ```

   For a one-off deploy without re-running setup, use the same
   stage-then-`kubectl-cp` pattern setup uses, or just hot-patch via
   `npm run chad:sync` (which re-runs setup).

2. Open the SSH port-forward from the host:

   ```console
   $ npm run webui:chad:up
       ✓ tunnel up: localhost:8901 → openshell-chad:8901
   $ npm run webui:chad:status
       ✓ ssh tunnel pid=… (localhost:8901 → openshell-chad:8901)
       ✓ chad-shim /healthz responding
   ```

3. In the open-webui browser UI:
   - Click avatar → **Admin Panel** → **Settings** → **Connections**.
   - Under **OpenAI API**, click **+** to add a second provider.
   - URL: `http://host.docker.internal:8901/v1`
   - Key: `sk-no-key-required` (anything non-empty; the shim ignores it).
   - Click verify — it should hit `/v1/models` and show a `chad` entry. Save.

4. Back in chat, the model picker now lists `chad` alongside the NVIDIA
   models. Pick `chad` and send a message — first turn takes ~10–30 s while
   `openclaw` boots its session.

**Smoke test from the host (no browser):**

```console
$ curl -sS -X POST http://127.0.0.1:8901/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"chad","messages":[{"role":"user","content":"reply with PONG only"}]}' \
    | jq -r '.choices[0].message.content'
PONG
```

**Persistence (auto-restart across reboots and sandbox cycles):**

For one-shot use, `npm run webui:chad:up` opens an `ssh -fN` tunnel and
the shim is `nohup`'d in-sandbox. Both die on host reboot / sandbox reset.
For always-on use, install both lifecycle hooks:

```console
$ npm run webui:chad:install     # host: launchd agent, KeepAlive=true
$ npm run chad:sync              # sandbox: chad-setup.sh installs the shim
                                 # and ensures it's running
```

After install:

- **Host side:** launchd respawns the SSH port-forward whenever it exits
  (network blip, sleep, reboot, or `webui:chad:down`). The agent lives at
  `~/Library/LaunchAgents/dev.nemoclaw.chad-tunnel.plist`. Logs at
  `/tmp/chad-tunnel.{out,err}.log`. Remove with `npm run webui:chad:uninstall`.
- **Sandbox side:** `chad-setup.sh` installs `/usr/local/bin/chad-shim.py`
  and starts it. `chad-restore-from-github.sh` and `chad-backup-to-github.sh`
  each re-launch the shim if it's not running, so any cron pulse self-heals
  a crashed shim within 24 hours (or sooner — workspace backup runs hourly).

**Session continuity:** `chad-shim` derives a stable `--session-id` by
hashing the conversation's *first* message. New chat → new openclaw
session. Editing earlier turns in open-webui ("regenerate from here") will
hit the same openclaw session, so its memory may diverge from what the UI
shows. Live with it for now; revisit once we want strict consistency.

### Choosing per-user

Cloudflare Access (tunnel mode) passes the user's email in
`Cf-Access-Authenticated-User-Email`. Inside open-webui, you can scope which
users see which providers via *Admin Panel → Settings → Users → Permissions*.
A typical split for the NemoClaw two-admin setup:

| User | Sees `chad` model | Sees raw `nemotron-3-super-120b` |
|---|---|---|
| `tantodefi@proton.me` | ✓ | ✓ |
| `tjcooke@protonmail.com` | ✓ (free flows only — premium gated by `auto-actions.json`) | ✓ |

The premium boundary lives in the sandbox's `auto-actions.json`, not in
open-webui — so even when TJ chats `chad`, any tool call into `/premium`
flows is rejected by the action-gate. open-webui is the trust *display*;
the sandbox is the trust *enforcer*.

`OPENAI_API_KEY` is required by open-webui's client even if the upstream
shim ignores it — the default `sk-no-key-required` placeholder is fine.

## Tools / MCP

The first-pass setup exposes no MCP tools — open-webui is purely a chat
surface. To add tools later (e.g. read-only `gbrain` lookups):

1. Settings → Tools in the open-webui UI.
2. Add the MCP server URL (e.g. `http://host.docker.internal:5051/mcp`).
3. Enable per-conversation in the chat tool picker.

Be deliberate about what's exposed — anything in the tool list is callable
by anyone who can chat. **Do not add `proton-tool` or any wrapper from
`scripts/chad-cron-wrappers/` to this surface** without first auditing the
input handling. Read-only `gbrain` is the conservative default.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| 530 / "Argo tunnel error" | cloudflared can't reach the tunnel ingress target | `npm run webui:logs`; check open-webui is healthy |
| Browser loops on Access login | Email not in `ADMIN_EMAILS`, or policy didn't apply | Re-run setup; verify policy in CF Zero Trust dashboard |
| 502 from open-webui | `OPENAI_API_BASE_URL` is wrong or upstream is down | `curl $OPENAI_API_BASE_URL/models` from host to test |
| `chad` model picker shows but chat 502s | SSH tunnel down OR shim crashed | `npm run webui:chad:status` first; restart tunnel and/or `ssh openshell-chad 'pgrep -af chad-shim.py'` |
| `chad` model not in picker | Connection 2 not added in admin UI, or `/v1/models` 404 | Re-add provider in *Admin → Connections*; verify `curl http://127.0.0.1:8901/v1/models` returns the `chad` entry |
| `chad` reply is `[chad-shim] empty reply (stopReason=…)` | openclaw produced no text payloads (tool-only turn, or model declined) | Look at `/tmp/chad-shim.log` and the openclaw session log; some turns Chad delegates to a sub-agent and the immediate reply is empty |
| `chad` reply takes >100 s and times out | cloudflared quick-tunnel HTTP idle timeout | Use streaming (open-webui defaults to `stream:true`) — keeps the SSE connection live; or move to tunnel mode which has no quick-tunnel idle limit |
| First login lands as "pending" | `DEFAULT_USER_ROLE` was overridden | Set back to `user`; CF Access is the trust boundary |
| Tunnel never connects | `CF_TUNNEL_TOKEN` truncated / wrong | `bash scripts/openwebui-down.sh --purge` then re-run setup |
| LAN-reachable on host IP | Port binding regressed to `0.0.0.0` | Verify `ports:` in `docker-compose.yml` is `127.0.0.1:…` |

## Tear-down

```console
$ npm run webui:down                          # stop containers
$ bash scripts/openwebui-down.sh --purge      # also delete tunnel + DNS + Access app
```

`--purge` clears `CF_TUNNEL_ID` / `CF_TUNNEL_TOKEN` from `.env` so the next
setup creates a fresh tunnel.

## Security notes

- Open-webui is bound to `127.0.0.1` only; cloudflared is the sole inbound.
- `WEBUI_AUTH=True`, `ENABLE_SIGNUP=False` — internet-facing signup is off.
- Trusted-header SSO via `Cf-Access-Authenticated-User-Email` means the
  password layer is never exposed publicly. CF Access is the front door.
- 24-hour JWT expiry; forgotten browsers re-auth daily.
- `cloudflared` runs in a sidecar container with only the connector token,
  no host filesystem mount.
- `chad-shim` listens only on `127.0.0.1` *inside the sandbox*. The single
  reachable path is the SSH tunnel from your host — if the tunnel is down,
  the shim is unreachable from anywhere, including the open-webui container.
  No port is published to the LAN, the OpenShell network, or Cloudflare.
- The shim does not call out to the network itself (stdlib-only); it only
  spawns `openclaw` as a subprocess. The L7 trust boundary keeps applying
  because `openclaw` makes the upstream calls under its own binary
  identity, exactly as it does for cron-driven Chad.

For the broader threat model — what's safe to expose, what isn't — see
[Backup Policy](../resources/backup-policy.md) and the trust boundary
notes in `AGENTS.md` inside the workspace.

## Next steps

- [Chad Devflow](chad-devflow.md) — primary operator commands.
- [Backup and Restore](../workspace/backup-restore.md) — preserving chat
  history (the `~/.nemoclaw/openwebui/data/` volume) is **not** part of the
  Chad sectioned manifest; it's local to the host.
