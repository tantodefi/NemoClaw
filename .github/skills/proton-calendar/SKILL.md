---
name: proton-calendar
description: >
  Interact with Proton Mail and Calendar using the bundled Go CLI.
  Use when Chad needs to read or send Proton email, inspect recent mail,
  or support approved email-driven bug intake. Requires Go 1.26+ and
  network access to Proton API endpoints and Go module proxies.
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Proton Calendar & Mail Skill

## Overview

This skill provides a small Go CLI tool, `proton-tool`, that wraps the
`go-proton-api` library to interact with Proton Mail and Calendar from the command line.

Use this skill for Proton transport and mailbox access.
Use `chad-bug-intake` to decide whether an approved message should become a GitHub issue.

## Prerequisites

| Requirement | Notes |
|---|---|
| Go >= 1.26.1 | Use [install-go.sh](./scripts/install-go.sh) if missing. |
| Proton account | Mail and Calendar access required. |
| `PROTON_USERNAME` | Injected by NemoClaw or exported manually. |
| `PROTON_PASSWORD` | Injected by NemoClaw or exported manually. |
| Network policy | `proton_api`, `go_modules`, `go_module_git_sources`, `go_install` |

## Installation

If this skill has been synced into a sandbox, run the build steps from the synced skill directory:

```bash
cd /sandbox/.openclaw-data/skills/proton-calendar
bash ./scripts/install-go.sh
bash ./scripts/build.sh
```

After building, the binary is at `./proton-tool`.

### Install Go

The install script downloads Go 1.26.1 to `/sandbox/go1.26.1`.
Do not extract Go to `/sandbox/go`, because OpenShell fingerprints binaries at sandbox creation time and replacing that path causes binary integrity violations.

### Build The Tool

```bash
bash ./scripts/build.sh
```

This runs `go mod download` and then builds the bundled CLI in `cmd/proton-tool/`.

## Usage

### Authentication

The tool reads credentials from the environment:

```bash
export PROTON_USERNAME="user@proton.me"
export PROTON_PASSWORD="password"
```

### Common Commands

```bash
./proton-tool whoami
./proton-tool calendars
./proton-tool events --days=7
./proton-tool mail --limit=10
./proton-tool sent --limit=15 --days=3
./proton-tool read-mail --id=MSGID
./proton-tool mark-read --id=MSGID1,MSGID2
./proton-tool send-mail --to=user@example.com --subject="Hello" --body="Message text"
```

## Chad Bug Intake Integration

When an approved sender asks Chad to report a bug:

1. Use this skill to list and read the message.
2. Use `chad-bug-intake` to normalize the subject, check for duplicates, and create or reuse a GitHub issue.
3. Use this skill again to send the acknowledgment email with the resulting issue URL.

The mail-handling rules for that flow live in [EMAIL-POLICY.md](./EMAIL-POLICY.md).

## Proton REST API Reference

The bundled CLI talks to these Proton hosts:

- `mail-api.proton.me`
- `api.protonmail.ch`
- `account.proton.me`

## Network Policy Requirements

The sandbox needs these policy groups:

- `proton_api`
- `go_modules`
- `go_module_git_sources`
- `go_install`

All Go-related endpoints must use `access: full`, because the Go toolchain opens its own TLS connections.

## Troubleshooting

| Problem | Fix |
|---|---|
| `go: Forbidden` on `go mod download` | Check that `go_modules` uses `access: full`. |
| `CONNECT tunnel failed, response 403` | The endpoint needs `access: full`, not `protocol: rest`. |
| `binary integrity violation` | Install Go to a new path such as `/sandbox/go1.26.1`, never `/sandbox/go`. |
| SRP auth failure | Verify `PROTON_USERNAME` and `PROTON_PASSWORD`. |

## File Structure

```text
proton-calendar/
├── SKILL.md
├── EMAIL-POLICY.md
├── cmd/
│   └── proton-tool/
│       ├── main.go
│       ├── go.mod
│       └── go.sum
├── scripts/
│   ├── install-go.sh
│   └── build.sh
└── references/
```
