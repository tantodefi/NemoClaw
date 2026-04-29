# Chad GitHub Worker

Uses `tantodefi/chad-state` as a job queue and GitHub Actions as compute.
Chad submits jobs via `chad-dispatch`, the workflow processes them with Claude,
results land back in the repo, and Chad collects them on the next wake.

## Architecture

```
Chad sandbox (isolated session)
  └── chad-dispatch --kind research --prompt "..."
        └── gh api PUT jobs/pending/job-xxx.json → tantodefi/chad-state
                                  ↓ push trigger (< 60s)
                     GitHub Actions (ubuntu-latest, free tier)
                       └── ANTHROPIC_API_KEY secret
                       └── curl → api.anthropic.com → result
                       └── git commit jobs/completed/job-xxx.json
                                  ↓
Chad cron (next wake or collect step)
  └── chad-dispatch --collect
        └── reads jobs/completed/ → appends to memory/YYYY-MM-DD.md
        └── archives job to jobs/archived/
```

## One-time Setup

### 1. Add supachad to tantodefi/chad-state

GitHub → tantodefi/chad-state → Settings → Collaborators → Add `supachad`
with **Write** access.

### 2. Copy the workflow into chad-state

```bash
# From your host machine
git clone git@github.com:tantodefi/chad-state.git /tmp/chad-state
mkdir -p /tmp/chad-state/.github/workflows
cp workflow.yml /tmp/chad-state/.github/workflows/chad-jobs.yml
mkdir -p /tmp/chad-state/jobs/{pending,completed,failed,archived}
touch /tmp/chad-state/jobs/.gitkeep
cd /tmp/chad-state && git add . && git commit -m "feat: add GitHub Actions job processor"
git push
```

### 3. Add ANTHROPIC_API_KEY secret

GitHub → tantodefi/chad-state → Settings → Secrets → Actions → New secret:
- Name: `ANTHROPIC_API_KEY`
- Value: your Anthropic API key

### 4. Deploy chad-dispatch to Chad's sandbox

```bash
# From host, run chad-setup.sh (it deploys automatically after this PR)
# Or manually:
SANDBOX_POD=$(docker exec openshell-cluster-nemoclaw kubectl get pods -n openshell \
  -o jsonpath='{.items[0].metadata.name}')
cat chad-dispatch | docker exec -i openshell-cluster-nemoclaw \
  kubectl exec -n openshell "$SANDBOX_POD" -i -- \
  sh -c 'cat > /usr/local/bin/chad-dispatch && chmod +x /usr/local/bin/chad-dispatch'
```

## Usage (from Chad's sandbox)

```bash
# Submit a research job
chad-dispatch --kind research --prompt "Find the latest NVIDIA NIM updates and summarize"

# Submit a draft with context
chad-dispatch --kind draft \
  --prompt "Write a reply acknowledging the project request and asking for a timeline" \
  --context "$(cat /tmp/email-context.txt)"

# Check what's running
chad-dispatch --list

# Collect completed results into today's memory
chad-dispatch --collect
```

## Job Kinds

| Kind | Model | Use |
|------|-------|-----|
| `research` | haiku | Web-independent research, synthesis |
| `draft` | sonnet | Writing drafts, emails, documents |
| `triage` | haiku | Issue scoring, priority sorting |
| `analysis` | sonnet | Deep analysis of long documents |
| `custom` | haiku | Anything else |

## Token Budget

Each job uses the Anthropic API directly (not Chad's openclaw budget).
- haiku: ~$0.0025 / 1k output tokens
- sonnet: ~$0.015 / 1k output tokens
- 100 haiku jobs × 1k tokens ≈ $0.25

## Adding to Cron

Add a collect step to gbrain-dream or email-check:
```
chad-dispatch --collect
```
