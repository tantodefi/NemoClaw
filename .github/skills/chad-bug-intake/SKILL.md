---
name: chad-bug-intake
description: "Create and manage GitHub bugs reported to Chad via chat or ProtonMail. Use when an approved sender wants Chad to file a bug, normalize an email subject into a GitHub issue title, search for duplicates, create or reuse an issue, break larger bugs into child tasks, and hand off into triage and build workflows. Trigger keywords - report bug, file bug from email, protonmail bug, create github issue from subject, break down bug, delegate issue, Chad."
argument-hint: "Bug summary, ProtonMail subject, or parent issue number"
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Chad Bug Intake

Create GitHub issues from trusted bug reports that reach Chad through chat or ProtonMail.
This skill is the orchestration layer that sits on top of the existing GitHub issue workflow.

## When To Use

- You want Chad to file a NemoClaw bug from chat.
- You want Chad to file a NemoClaw bug from ProtonMail.
- You want Chad to check for duplicate issues before opening a new one.
- You want Chad to break a larger bug into child tasks that can be delegated to other agents.

## Requirements

- `gh auth status` succeeds for the target repository.
- The GitHub workflow labels exist in the target repository.
- If the source is ProtonMail, the `proton-calendar` skill has been synced into the sandbox and `proton-tool` has been built.

## Target Repository

Supachad files issues on the **fork** `tantodefi/NemoClaw`, not upstream
`NVIDIA/NemoClaw`. The scripts default to `tantodefi/NemoClaw` when not
inside a git checkout. Override with `--repo` if needed.

## First-Time Setup

1. Bootstrap the workflow labels in the target repository:

   ```bash
   ./.github/skills/chad-bug-intake/scripts/bootstrap-github-labels.sh
   ```

2. Sync the repo-owned skills into Chad's sandbox and build the Proton helper:

   ```bash
   ./.github/skills/chad-bug-intake/scripts/sync-skills-to-sandbox.sh chad --build-proton
   ```

3. In the synced Proton skill directory, add TJ to `memory/admin-contacts.md` if Chad should treat TJ as an approved reporter in addition to the sandbox owner's Proton address.

## Intake Rules

- Only approved senders may trigger bug filing by email.
- Email subjects are treated as the initial bug title candidate and are normalized with [normalize-bug-title.sh](./scripts/normalize-bug-title.sh).
- Duplicate issues are checked before creating anything new.
- Clear, concrete reports should create a bug issue directly with [create-bug-issue.sh](./scripts/create-bug-issue.sh).
- Vague, architectural, or poorly scoped reports should go through the existing `create-spike` workflow instead of forcing a shallow bug issue.
- Larger bugs may be decomposed into child issues with [create-child-issues.sh](./scripts/create-child-issues.sh).
- This skill never applies `state:agent-ready`. That remains an explicit human gate.

## Chat Intake Flow

Use this when you or TJ tell Chad to file a bug directly in chat.

Before filing, **always collect session logs** from the current skill session.
The script auto-collects via `nemoclaw chad logs` when run inside the sandbox,
but you can also pass an explicit log file:

```bash
./.github/skills/chad-bug-intake/scripts/create-bug-issue.sh \
  --subject "Credential sync missing inside sandbox" \
  --body-file /tmp/report.txt \
  --session-log /tmp/session.log \
  --reporter "operator-chat" \
  --source chat \
  --sandbox chad
```

The script outputs either:

- `CREATED_ISSUE=<url>` for a new issue, or
- `DUPLICATE_ISSUE=<url>` if a matching title already exists.

## ProtonMail Intake Flow

Use this when Chad reads approved email and should turn it into a GitHub issue.

1. Use the `proton-calendar` skill to list mail and read the approved message.
2. Treat the subject line as the title candidate.
3. Save the message body to a temporary file.
4. Capture the current session log (recent sandbox output, skill activity,
   or `nemoclaw chad logs | tail -200 > /tmp/session.log`).
5. Run the create script:

   ```bash
   ./.github/skills/chad-bug-intake/scripts/create-bug-issue.sh \
     --subject "$(printf '%s' "$MAIL_SUBJECT")" \
     --body-file /tmp/proton-report.txt \
     --session-log /tmp/session.log \
     --reporter "sender@example.com" \
     --source proton \
     --sandbox chad
   ```

6. Reply by email with the created issue URL or duplicate issue URL.

## Break Down And Delegate

If the bug naturally splits into smaller tasks, prepare a task file with one task per line.
Use `Title | Description` format when you want a different body from the title.

Example task file:

```text
fix: inject Proton credentials during sandbox create | Ensure PROTON_USERNAME and PROTON_PASSWORD are present in the sandbox environment.
test: cover Proton credential detection | Add CLI tests for preset suggestion and credential propagation.
docs: explain Proton bug intake setup | Document label bootstrap, trusted senders, and Proton sync flow.
```

Create the child issues and add a summary comment back to the parent:

```bash
./.github/skills/chad-bug-intake/scripts/create-child-issues.sh \
  --parent 123 \
  --tasks-file /tmp/chad-bug-tasks.txt
```

After child issues exist, other agents can pick them up through the existing GitHub workflows:

- `triage-issue`
- `create-spike`
- `build-from-issue`
- `create-github-pr`
- `review-github-pr`

## Safety Rules

- Never copy secrets from ProtonMail or local credentials into GitHub issues.
- Never auto-apply `state:agent-ready`.
- Never create a second issue when the duplicate check returns an existing match.
- Never treat non-approved Proton senders as bug reporters.

## Related Skills

- Use the `proton-calendar` skill for mail access and replies.
- Reuse the existing OpenShell reference skills for triage, spike creation, implementation planning, and PR workflows.
