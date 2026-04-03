#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

GO_VERSION="1.26.1"
INSTALL_DIR="/sandbox/go1.26.1"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) GOARCH="amd64" ;;
  aarch64|arm64) GOARCH="arm64" ;;
  *)
    echo "Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

TARBALL="go${GO_VERSION}.linux-${GOARCH}.tar.gz"
URL="https://go.dev/dl/${TARBALL}"

if [ -x "$INSTALL_DIR/bin/go" ]; then
  installed="$($INSTALL_DIR/bin/go version 2>/dev/null || echo unknown)"
  echo "Go already installed at $INSTALL_DIR: $installed"
  exit 0
fi

echo "Downloading Go ${GO_VERSION} for linux/${GOARCH}..."
cd /tmp
curl -fsSL -o "$TARBALL" "$URL"

echo "Extracting to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
tar -xzf "$TARBALL" --strip-components=1 -C "$INSTALL_DIR"
rm -f "$TARBALL"

cat > /tmp/go-env.sh <<EOF
export GOROOT=$INSTALL_DIR
export GOPATH=/sandbox/gopath
export GOCACHE=/sandbox/gocache
export PATH=$INSTALL_DIR/bin:\$GOPATH/bin:\$PATH
EOF

echo "Go installed:"
"$INSTALL_DIR/bin/go" version
echo "Run: source /tmp/go-env.sh"
