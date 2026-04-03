#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CMD_DIR="$SKILL_DIR/cmd/proton-tool"

if [ -f /tmp/go-env.sh ]; then
  # shellcheck disable=SC1091
  source /tmp/go-env.sh
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Error: Go not found in PATH." >&2
  echo "Run: bash scripts/install-go.sh" >&2
  exit 1
fi

echo "Go version: $(go version)"
echo "Building proton-tool..."

cd "$CMD_DIR"
go mod download
go build -o "$SKILL_DIR/proton-tool" .

echo "Build complete: $SKILL_DIR/proton-tool"
