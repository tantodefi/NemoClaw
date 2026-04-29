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
up a chat front-end backed by the same K2.5 inference Chad uses, reachable
from any browser, gated by an email allowlist.

## Architecture at a glance

```
   browser
      │
      ▼  https://<sub>.<domain>           (TLS terminated at CF edge)
   ┌──────────────────────────┐
   │   Cloudflare Access      │  email-OTP allowlist (ADMIN_EMAILS)
   └──────────┬───────────────┘
              │  passes Cf-Access-Authenticated-User-Email header
              ▼
   ┌──────────────────────────┐
   │   Cloudflare Tunnel      │  outbound from host, no inbound ports
   └──────────┬───────────────┘
              │
   ───────────┼───────────────────  host (your laptop or server)
              ▼
   ┌──────────────────────────┐    ┌────────────────────────┐
   │  cloudflared (docker)    │───►│  open-webui  (docker)  │
   └──────────────────────────┘    │  127.0.0.1:3000 only   │
                                   └─────────┬──────────────┘
                                             │  OPENAI_API_BASE_URL
                                             ▼
                                   ┌────────────────────────┐
                                   │  NemoClaw inference    │
                                   │  (K2.5 OpenAI shim)    │
                                   └────────────────────────┘
```

Open-webui binds to `127.0.0.1` only — the cloudflared sidecar is the sole
inbound path. Cloudflare Access sits in front of that and verifies the user
against `ADMIN_EMAILS` before any traffic reaches the tunnel.

## Primary commands

| Command | What it does |
|---|---|
| `npm run webui:up` | Tunnel mode (default): creates tunnel + DNS + Access policy, brings up compose. Idempotent. |
| `npm run webui:up:quick` | Quick mode: ephemeral `*.trycloudflare.com` URL, no domain or API token required. Testing only. |
| `npm run webui:down` | Stop containers (both profiles); leave Cloudflare config in place. |
| `bash scripts/openwebui-down.sh --purge` | Stop containers **and** delete the tunnel, DNS record, and Access app from Cloudflare. |
| `npm run webui:logs` | Tail logs from open-webui + cloudflared. |

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

## Inference endpoint

`OPENAI_API_BASE_URL` controls where chat completions go. Two common setups:

- **Local NemoClaw inference** — `http://host.docker.internal:8000/v1` if
  `openclaw agent --local` is running on the host. The compose file ships
  with a `host.docker.internal:host-gateway` mapping so this resolves on
  Linux as well as macOS.
- **Sandbox-hosted inference** — point at the openshell sandbox via an
  SSH port-forward from the host (`ssh -L 8000:localhost:8000 openshell-chad`)
  and use `host.docker.internal:8000` as the URL.

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

For the broader threat model — what's safe to expose, what isn't — see
[Backup Policy](../resources/backup-policy.md) and the trust boundary
notes in `AGENTS.md` inside the workspace.

## Next steps

- [Chad Devflow](chad-devflow.md) — primary operator commands.
- [Backup and Restore](../workspace/backup-restore.md) — preserving chat
  history (the `~/.nemoclaw/openwebui/data/` volume) is **not** part of the
  Chad sectioned manifest; it's local to the host.
