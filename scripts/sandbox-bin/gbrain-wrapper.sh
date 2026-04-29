#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# gbrain wrapper — ensures OPENAI_API_KEY is set before invoking gbrain.
#
# gbrain stores `openai_api_key` in /sandbox/.gbrain/config.json (set to
# "unused" because we point at LM Studio on the host, which doesn't auth),
# but the underlying OpenAI Node SDK still throws if the OPENAI_API_KEY
# env var is empty. Cron sessions don't inherit interactive env, so
# embeddings fail with "OPENAI_API_KEY environment variable is missing".
#
# This wrapper reads the api key from config.json (or falls back to
# "unused"), exports it, and execs the real gbrain binary.
#
# Deployed by chad-setup.sh via base64 + kubectl exec. The renamed
# original lives at /usr/local/bin/gbrain-bin.

CFG=/sandbox/.gbrain/config.json

if [ -z "$OPENAI_API_KEY" ]; then
  if [ -f "$CFG" ]; then
    OPENAI_API_KEY=$(python3 -c "import json; print(json.load(open('$CFG')).get('openai_api_key', 'unused'))" 2>/dev/null)
  fi
  OPENAI_API_KEY="${OPENAI_API_KEY:-unused}"
  export OPENAI_API_KEY
fi

exec /usr/local/bin/gbrain-bin "$@"
