<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Building proton-tool (development reference)

`proton-tool` is a Go CLI that wraps
[go-proton-api](https://github.com/ProtonMail/go-proton-api).

**In normal operation, you do not need to build or deploy this manually.**
The Dockerfile compiles proton-tool via a `proton-builder` stage and installs
it at `/usr/local/bin/proton-tool` in every sandbox image. Rebuilding the
sandbox image is sufficient to pick up source changes.

This document is a reference for **local development** — running proton-tool
outside a sandbox, or testing changes before committing.

## Prerequisites (local dev only)

- Go 1.26.1+
- Network access to `proxy.golang.org`, `github.com` (for `go mod download`)

## Install Go (if needed)

```bash
cd .github/skills/proton-calendar
bash scripts/install-go.sh
```

This downloads Go 1.26.1 to `/sandbox/go1.26.1`.

**Do NOT extract to `/sandbox/go`.** OpenShell fingerprints binaries at sandbox
creation — replacing `/sandbox/go/bin/go` causes all Go network requests to be
denied with "binary integrity violation".

The script sets `GOROOT`, `GOPATH`, `GOCACHE`, and updates `PATH` for the
current shell session.

## Build

```bash
cd .github/skills/proton-calendar
bash scripts/build.sh
```

Runs `go mod download` then `go build ./cmd/proton-tool/`. Output binary is at
`./proton-tool` (relative to the skill root).

## Deploy to Chad's Sandbox

**Not needed for normal operation.** `proton-tool` is installed at
`/usr/local/bin/proton-tool` by the Dockerfile. To update it, commit your
changes and rebuild the sandbox image.

To test a local build against Chad without a full image rebuild:

```bash
# Build for linux/amd64 (match sandbox arch)
cd .github/skills/proton-calendar
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 bash scripts/build.sh

# Copy to sandbox (temporary, will be overwritten on next image build)
scp ./proton-tool openshell-chad:/tmp/proton-tool-dev
ssh openshell-chad 'chmod +x /tmp/proton-tool-dev'

# Test it — note: /tmp/proton-tool-dev is NOT in the proton_api policy,
# so network calls will be blocked. For a full network test, rebuild the image.
```

## Verify

```bash
ssh openshell-chad '/usr/local/bin/proton-tool --help'
```

## Network Policies Required (build-time only)

| Policy | Purpose |
|--------|---------|
| `go_install` | Download Go tarball from `go.dev` / `dl.google.com` |
| `go_modules` | `go mod download` via `proxy.golang.org` |
| `go_module_git_sources` | Fetch ProtonMail modules directly from GitHub |

These are **not** needed in Chad's sandbox at runtime. Only `proton_api` is
required once the binary is deployed.
