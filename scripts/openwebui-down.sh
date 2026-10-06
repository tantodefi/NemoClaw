#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# openwebui-down — stop the chat front-end + tunnel.
#
# Usage:
#   bash scripts/openwebui-down.sh           # stop containers, leave Cloudflare config in place
#   bash scripts/openwebui-down.sh --purge   # also delete tunnel, DNS record, and Access app

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEBUI_DIR="$ROOT/scripts/openwebui"
ENV_FILE="$WEBUI_DIR/.env"

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if [ ! -f "$ENV_FILE" ]; then
  echo "no .env at $ENV_FILE — nothing to stop"
  exit 0
fi

# shellcheck source=/dev/null
set -a; . "$ENV_FILE"; set +a

echo "==> Stopping docker compose (all profiles)"
(cd "$WEBUI_DIR" && docker compose --env-file "$ENV_FILE" \
  --profile tunnel --profile quick down) || true

if [ "$PURGE" -eq 0 ]; then
  echo "==> Containers stopped (Cloudflare config preserved; --purge to also clean up CF)"
  exit 0
fi

if [ -z "${CF_API_TOKEN:-}" ] || [ -z "${CF_ACCOUNT_ID:-}" ] || [ -z "${CF_ZONE_ID:-}" ]; then
  echo "    cannot purge — CF_API_TOKEN / CF_ACCOUNT_ID / CF_ZONE_ID missing"
  exit 1
fi

cf_api() {
  curl -fsS \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "$@"
}

WEBUI_FQDN="${WEBUI_SUBDOMAIN}.${CF_DOMAIN}"

echo "==> Purging Cloudflare resources for ${WEBUI_FQDN}"

if [ -n "${CF_TUNNEL_ID:-}" ]; then
  echo "    deleting tunnel ${CF_TUNNEL_ID}"
  cf_api -X DELETE \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}?cascade=true" \
    >/dev/null 2>&1 \
    && echo "      ✓ tunnel deleted" \
    || echo "      ! tunnel delete failed (may already be gone)"
fi

DNS_ID="$(cf_api \
  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=${WEBUI_FQDN}" \
  2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    for r in d.get("result", []):
        print(r["id"]); break
except Exception:
    pass' || true)"
if [ -n "${DNS_ID:-}" ]; then
  cf_api -X DELETE \
    "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${DNS_ID}" \
    >/dev/null 2>&1 \
    && echo "      ✓ DNS record deleted" \
    || echo "      ! DNS delete failed"
fi

APP_ID="$(cf_api \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps" \
  2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for a in d.get('result', []):
        if a.get('domain') == '${WEBUI_FQDN}':
            print(a['id']); break
except Exception:
    pass" || true)"
if [ -n "${APP_ID:-}" ]; then
  cf_api -X DELETE \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}" \
    >/dev/null 2>&1 \
    && echo "      ✓ Access app deleted" \
    || echo "      ! Access app delete failed"
fi

echo "==> Cleaning tunnel state from .env"
python3 - "$ENV_FILE" <<'PY'
import sys, re
path = sys.argv[1]
with open(path) as f: lines = f.readlines()
out = []
for line in lines:
    if re.match(r'^(CF_TUNNEL_TOKEN|CF_TUNNEL_ID)=', line):
        key = line.split('=', 1)[0]
        out.append(f"{key}=\n")
    else:
        out.append(line)
with open(path, "w") as f: f.writelines(out)
PY

echo "==> Purge complete"
