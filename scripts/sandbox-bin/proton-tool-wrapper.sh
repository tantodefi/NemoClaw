#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# proton-tool wrapper — loads PROTON_USERNAME/PROTON_PASSWORD from
# /sandbox/.nemoclaw/credentials.json when not already in the env, then
# execs the real binary at /usr/local/bin/proton-tool-bin.
#
# This is needed because openclaw cron isolated sessions do NOT inherit
# the interactive shell's env; without this wrapper, proton-tool would
# fail to authenticate when invoked from a cron.
#
# Deployed by chad-setup.sh via base64 + kubectl exec. The renamed
# original lives at /usr/local/bin/proton-tool-bin.

CREDS=/sandbox/.nemoclaw/credentials.json

if [ -z "$PROTON_USERNAME" ] && [ -f "$CREDS" ]; then
  PROTON_USERNAME=$(python3 -c "import json; print(json.load(open('$CREDS'))['PROTON_USERNAME'])" 2>/dev/null)
  export PROTON_USERNAME
fi

if [ -z "$PROTON_PASSWORD" ] && [ -f "$CREDS" ]; then
  PROTON_PASSWORD=$(python3 -c "import json; print(json.load(open('$CREDS'))['PROTON_PASSWORD'])" 2>/dev/null)
  export PROTON_PASSWORD
fi

exec /usr/local/bin/proton-tool-bin "$@"
