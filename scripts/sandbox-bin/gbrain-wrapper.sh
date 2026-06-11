#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# gbrain wrapper — pulls embedder config from /sandbox/.gbrain/config.json and
# exports the env vars that gbrain (and the OpenAI SDK underneath it) reads.
#
# Why a wrapper at all:
#   - gbrain v0.14.x reads OPENAI_API_KEY / OPENAI_BASE_URL from the
#     environment. Cron sessions don't inherit interactive env, so without
#     this shim embeddings fail with "OPENAI_API_KEY environment variable
#     is missing".
#   - Our patched gbrain (tantodefi/gbrain fork) also honors
#     GBRAIN_EMBED_MODEL / GBRAIN_EMBED_DIMENSIONS / GBRAIN_EMBED_INPUT_TYPE
#     so the same binary can target OpenAI or NVIDIA NIM embeddings.
#
# Config file shape (written by chad-setup.sh, see step 3b):
#   {
#     "engine": "pglite",
#     "database_path": "/sandbox/.gbrain/brain.pglite",
#     "openai_api_key": "<NVIDIA_API_KEY or sk-...>",
#     "openai_base_url": "https://integrate.api.nvidia.com/v1",
#     "embed_model": "nvidia/llama-nemotron-embed-1b-v2",
#     "embed_dimensions": "1536",
#     "embed_input_type": "passage"
#   }
#
# Deployed by chad-setup.sh via base64 + kubectl exec. The renamed
# original lives at /usr/local/bin/gbrain-bin.

CFG=/sandbox/.gbrain/config.json

if [ -f "$CFG" ]; then
  CFG_EXPORTS=$(
    python3 - <<'PY' 2>/dev/null
import json, os, shlex
try:
  c = json.load(open(os.environ.get('CFG','/sandbox/.gbrain/config.json')))
except Exception:
  raise SystemExit
mapping = {
  'openai_api_key':    'OPENAI_API_KEY',
  'openai_base_url':   'OPENAI_BASE_URL',
  'embed_model':       'GBRAIN_EMBED_MODEL',
  'embed_dimensions':  'GBRAIN_EMBED_DIMENSIONS',
  'embed_input_type':  'GBRAIN_EMBED_INPUT_TYPE',
}
for k, env in mapping.items():
  v = c.get(k)
  if v not in (None, ''):
    print(f'export {env}={shlex.quote(str(v))}')
PY
  )
  eval "$CFG_EXPORTS"
fi

# OpenAI SDK refuses to construct a client without OPENAI_API_KEY even when
# the endpoint doesn't require auth.
: "${OPENAI_API_KEY:=unused}"
export OPENAI_API_KEY

exec /usr/local/bin/gbrain-bin "$@"
