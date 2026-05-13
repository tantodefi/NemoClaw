#!/usr/bin/env bash
# Re-applies the in-container fix for the OpenWebUI 0.9.2 share-view admin bug.
#
# Upstream bug: GET /api/v1/chats/share/{share_id} under user.role=='admin' +
# ENABLE_ADMIN_CHAT_ACCESS=True calls Chats.get_chat_by_id(share_id) instead of
# Chats.get_chat_by_share_id(share_id), returning 401 → frontend bounces to /.
# Fix swaps the admin branch to try share lookup first, fall back to chat-id.
#
# Run after every `docker pull ghcr.io/open-webui/open-webui:main`.

set -euo pipefail

CONTAINER="${OWUI_CONTAINER:-nemoclaw-openwebui}"
TARGET="/app/backend/open_webui/routers/chats.py"
SENTINEL="get_chat_by_share_id(share_id, db=db)\n    if not chat and user.role == 'admin'"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERR: container '$CONTAINER' is not running" >&2
  exit 1
fi

if docker exec "$CONTAINER" python3 -c "
import sys
src = open('$TARGET').read()
sys.exit(0 if \"if not chat and user.role == 'admin' and ENABLE_ADMIN_CHAT_ACCESS:\" in src else 1)
"; then
  echo "already patched, nothing to do"
  exit 0
fi

docker exec "$CONTAINER" cp "$TARGET" "${TARGET}.bak-share-admin-fix"

docker exec -i "$CONTAINER" python3 - "$TARGET" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
src = p.read_text()
old = (
    "    if user.role == 'admin' and ENABLE_ADMIN_CHAT_ACCESS:\n"
    "        chat = await Chats.get_chat_by_id(share_id, db=db)\n"
    "    else:\n"
    "        chat = await Chats.get_chat_by_share_id(share_id, db=db)\n"
)
new = (
    "    chat = await Chats.get_chat_by_share_id(share_id, db=db)\n"
    "    if not chat and user.role == 'admin' and ENABLE_ADMIN_CHAT_ACCESS:\n"
    "        chat = await Chats.get_chat_by_id(share_id, db=db)\n"
)
matches = src.count(old)
if matches != 1:
    raise SystemExit(f"expected 1 match, got {matches} — upstream code shape changed, manual review needed")
p.write_text(src.replace(old, new))
print("patched ok")
PY

echo "restarting $CONTAINER..."
docker restart "$CONTAINER" >/dev/null

for i in $(seq 1 30); do
  h=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "?")
  if [ "$h" = "healthy" ]; then
    echo "healthy"
    exit 0
  fi
  sleep 2
done
echo "WARN: container did not reach healthy within 60s — check 'docker logs $CONTAINER'" >&2
exit 1
