#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-provision-tier0.sh — provision the Tier-0 ("Chad Lite") OpenWebUI model.
#
# Tier 0 is the lightweight, stateless tier for casual new users (see
# docs/design/multi-user-chad.md). It is NOT a full OpenClaw agent: it's a plain
# Nemotron Ultra workspace-model with a generic system prompt, served by
# OpenWebUI, which supplies per-user MEMORY and WEB SEARCH natively — fully
# isolated by OpenWebUI account, with zero pod state and zero gbrain. New users
# never touch Chad's agent, memory, or tjcooke's data.
#
# This script does the ONE scriptable part: create the Tier-0 model preset via
# chad-webui (which lives on the pod). Everything else is an operator/dashboard
# action (no API for it), printed at the end as a checklist.
#
# Usage:
#   ./chad-provision-tier0.sh                 # create with defaults
#   CHAD_TIER0_BASE=nvidia/... ./chad-provision-tier0.sh
#   DRY_RUN=1 ./chad-provision-tier0.sh       # print the chad-webui call only
#
# Env:
#   CHAD_POD_SSH       ssh alias to the pod (default openshell-chad)
#   CHAD_WEBUI_POD_BIN chad-webui path on the pod (default the .openclaw-data bin)
#   CHAD_TIER0_ID      model id  (default chad-lite)
#   CHAD_TIER0_NAME    display name (default "Chad Lite")
#   CHAD_TIER0_BASE    base model id (default Nemotron 3 Ultra 550B)

set -uo pipefail

POD_SSH="${CHAD_POD_SSH:-openshell-chad}"
POD_WEBUI="${CHAD_WEBUI_POD_BIN:-/sandbox/.openclaw-data/bin/chad-webui}"
ID="${CHAD_TIER0_ID:-chad-lite}"
NAME="${CHAD_TIER0_NAME:-Chad Lite}"
BASE="${CHAD_TIER0_BASE:-nvidia/nemotron-3-ultra-550b-a55b}"

# Generic, honest system prompt — a helpful assistant, NOT the full Chad persona.
read -r -d '' SYSTEM_PROMPT <<'EOF'
You are Chad Lite, a helpful, concise assistant. You can search the web when the
user's question needs current or factual information — cite what you use. You do
not have access to private files, calendars, email, or anyone else's data; you
only know this conversation and what the user tells you. If asked to do something
that needs those, say you can't and suggest the user ask their operator about a
full account. Be direct and useful.
EOF

# OpenWebUI model row. params.system sets the system prompt; meta.description +
# citations capability surface the web-search citations cleanly.
PARAMS_JSON=$(python3 -c 'import json,sys; print(json.dumps({"system": sys.argv[1]}))' "$SYSTEM_PROMPT")
META_JSON='{"description":"Lightweight assistant: Nemotron Ultra + web search + per-user memory. No agent, no private data.","capabilities":{"citations":true}}'

echo "==> Tier-0 model: id=$ID name=\"$NAME\" base=$BASE"
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN: would run on $POD_SSH:"
  echo "  $POD_WEBUI models create --id '$ID' --base-model-id '$BASE' --name '$NAME' --params <system-prompt> --meta <meta>"
else
  ssh -o ConnectTimeout=15 "$POD_SSH" \
    "'$POD_WEBUI' models create --id '$ID' --base-model-id '$BASE' --name '$NAME' \
       --params $(printf '%q' "$PARAMS_JSON") --meta $(printf '%q' "$META_JSON")" \
    && echo "==> created (or already exists)." \
    || echo "!! create failed — check pod ssh + chad-webui admin key."
fi

cat <<'CHECKLIST'

────────────────────────────────────────────────────────────────────────
OPERATOR CHECKLIST (no API — do these in the dashboards, once):

1. WEB SEARCH — the in-stack SearXNG ships in docker-compose.yml now:
   - Add SEARXNG_SECRET to scripts/openwebui/.env (openssl rand -hex 32), then
     `docker compose up -d` to start the searxng container.
   - The ENABLE_WEB_SEARCH / WEB_SEARCH_ENGINE / SEARXNG_QUERY_URL envs only
     seed a FRESH webui.db. On the EXISTING db, set it in admin →
     Settings → Web Search:
       Engine    = searxng
       Query URL = http://searxng:8080/search?q=<query>&format=json
       Enable    = on
   - That makes the per-chat web-search toggle available to Tier-0 users.

2. MEMORY (per-user, OpenWebUI → Settings → Personalization → Memory):
   - Already per-user and isolated by account; nothing to provision.
   - Optional: install an "adaptive memory" Function (chad-webui functions
     create) if you want memory to populate itself instead of users clicking
     "remember".

3. ACCESS CONTROL — the important isolation step:
   - Restrict the powerful `chad` model to operators only so new users can't
     select it. In OpenWebUI admin → Models → chad → set access to the
     operators group (or tantodefi + tjcooke). Or scriptable once you have the
     ids/group:
       chad-webui models update --id chad \
         --access-control '{"read":{"group_ids":["<operators>"],"user_ids":[]}}'
   - Leave the Tier-0 model public (default) so new users see it.

4. ACCOUNTS:
   - Add the new emails to the Cloudflare Access policy (≤50 seats, free tier).
   - On first SSO login OpenWebUI auto-creates the account. Set role = user
     (NOT admin — admin bypasses ownership and would see everything).

Result: new users get Nemotron Ultra + web search + their own memory, with no
access to Chad's agent, gbrain, or anyone else's data. Upgrade path to a full
isolated agent (Tier 1) is in docs/design/multi-user-chad.md.
────────────────────────────────────────────────────────────────────────
CHECKLIST
