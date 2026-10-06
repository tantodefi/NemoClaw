#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# regen-seed-models.sh — Dump the live open-webui `model` table into
# scripts/openwebui/seed-models.sql so a fresh install (or a db wipe) can
# replay the curated 14-model picker without manual SQL.
#
# Runs against the host-side bind mount at ~/.nemoclaw/openwebui/data/webui.db.
# The SQL it emits is INSERT OR REPLACE keyed on id, so applying it never
# duplicates rows and never overwrites user_id when the row already exists.

set -euo pipefail

DB="${WEBUI_DB:-${HOME}/.nemoclaw/openwebui/data/webui.db}"
OUT="$(cd "$(dirname "$0")" && pwd)/seed-models.sql"

if [ ! -f "$DB" ]; then
  echo "regen-seed-models: $DB not found" >&2
  exit 1
fi

python3 - "$DB" "$OUT" <<'PY'
import sqlite3, sys

db_path, out_path = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db_path)
rows = con.execute(
    "SELECT id, base_model_id, name, meta, params, is_active "
    "FROM model ORDER BY id"
).fetchall()
con.close()

with open(out_path, "w") as f:
    f.write("-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n")
    f.write("-- SPDX-License-Identifier: Apache-2.0\n")
    f.write("--\n")
    f.write("-- seed-models.sql — open-webui custom-model records for the chad sandbox.\n")
    f.write("--\n")
    f.write("-- Idempotent: run via `sqlite3 webui.db < seed-models.sql`. Each model\n")
    f.write("-- is INSERT OR REPLACE'd by id, preserving any user_id assignment in\n")
    f.write("-- the existing row (subquery falls back to the first user if missing).\n")
    f.write("--\n")
    f.write("-- Regenerate this file from a working DB whenever the curated set or\n")
    f.write("-- descriptions change:\n")
    f.write("--   bash scripts/openwebui/regen-seed-models.sh\n")
    f.write("--\n")
    f.write("-- Applied automatically by scripts/openwebui-setup.sh after docker compose up.\n\n")

    for mid, base, name, meta, params, active in rows:
        e = lambda s: (s or "").replace("'", "''")
        f.write(f"-- {mid}\n")
        f.write("INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)\n")
        f.write("VALUES (\n")
        f.write(f"  '{e(mid)}',\n")
        f.write(f"  COALESCE((SELECT user_id FROM model WHERE id = '{e(mid)}'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),\n")
        f.write(f"  '{e(base)}',\n")
        f.write(f"  '{e(name)}',\n")
        f.write(f"  '{e(meta)}',\n")
        f.write(f"  '{e(params)}',\n")
        f.write("  CAST(strftime('%s','now') AS INTEGER),\n")
        f.write("  CAST(strftime('%s','now') AS INTEGER),\n")
        f.write(f"  {1 if active else 0}\n")
        f.write(");\n\n")

print(f"wrote {len(rows)} model records → {out_path}")
PY
