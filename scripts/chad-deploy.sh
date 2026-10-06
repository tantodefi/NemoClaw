#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-deploy.sh — Incremental, checksum-based deploy of Chad's wrappers,
# data files, and sandbox tools from this repo to the pod.
#
# Why this exists:
#   chad-setup.sh is a one-shot bootstrap (gbrain init, creds, crons, L7).
#   When you change a wrapper or task-profiles.json, re-running setup is
#   heavy and silently swallows install failures. This script is the
#   incremental complement — read scripts/chad-deploy-manifest.txt, md5
#   each entry, push only what differs, and fail LOUD on errors.
#
# Modes:
#   chad-deploy.sh --verify             md5-compare every entry; exit 1 on drift.
#   chad-deploy.sh --push               push only entries where pod md5 != local md5.
#   chad-deploy.sh --push --all         push every entry regardless of drift.
#   chad-deploy.sh --file PATH          push exactly one src path (matched against col 1).
#   chad-deploy.sh --dry-run [--push]   print actions, don't execute.
#
# Environment:
#   CHAD_SANDBOX        sandbox name suffix for openshell-<name> (default: chad)
#   CHAD_DOCKER_HOST    docker container hosting kubectl (default: openshell-cluster-nemoclaw)
#   CHAD_K8S_NAMESPACE  k8s namespace (default: openshell)
#   CHAD_MANIFEST       override manifest path
#
# Exit codes: 0 ok / 1 drift detected (--verify) or push error / 2 usage.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MANIFEST="${CHAD_MANIFEST:-${SCRIPT_DIR}/chad-deploy-manifest.txt}"

SANDBOX="${CHAD_SANDBOX:-chad}"
REMOTE_HOST="openshell-${SANDBOX}"
DOCKER_HOST="${CHAD_DOCKER_HOST:-openshell-cluster-nemoclaw}"
K8S_NS="${CHAD_K8S_NAMESPACE:-openshell}"

MODE="verify"
DRY_RUN=0
FORCE_ALL=0
FILTER_SRC=""

# ── Output helpers ─────────────────────────────────────────────────────
RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
BLUE='\033[0;34m' CYAN='\033[0;36m' DIM='\033[2m' RESET='\033[0m'

step() { printf '%b==>%b %s\n' "$BLUE" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %b!%b %s\n' "$YELLOW" "$RESET" "$*"; }
err()  { printf '  %b✗%b %s\n' "$RED" "$RESET" "$*"; }
dim()  { printf '    %b%s%b\n' "$DIM" "$*" "$RESET"; }
fail() { err "$*"; exit 1; }

usage() {
  sed -n '4,28p' "$0" | sed 's|^# *||'
  exit "${1:-0}"
}

# ── Arg parsing ────────────────────────────────────────────────────────
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify)  MODE="verify";  shift ;;
    --push)    MODE="push";    shift ;;
    --all)     FORCE_ALL=1;    shift ;;
    --dry-run) DRY_RUN=1;      shift ;;
    --file)    FILTER_SRC="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "chad-deploy: unknown arg: $1" >&2; usage 2 ;;
  esac
done

[ -f "$MANIFEST" ] || fail "manifest not found: $MANIFEST"

# ── Pod resolution ─────────────────────────────────────────────────────
resolve_sandbox_pod() {
  # Pod name typically matches the sandbox name (e.g. "chad").
  # Fall back to first pod in the namespace if a name-match misses.
  local pod
  pod="$(docker exec "$DOCKER_HOST" kubectl get pod "$SANDBOX" -n "$K8S_NS" \
    -o jsonpath='{.metadata.name}' </dev/null 2>/dev/null)"
  if [ -z "$pod" ]; then
    pod="$(docker exec "$DOCKER_HOST" kubectl get pods -n "$K8S_NS" \
      -o jsonpath='{.items[0].metadata.name}' </dev/null 2>/dev/null)"
  fi
  printf '%s' "$pod"
}

SANDBOX_POD=""
if [ "$DRY_RUN" -eq 0 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not on PATH — kubectl-mode pushes will fail"
  else
    SANDBOX_POD="$(resolve_sandbox_pod)"
    [ -n "$SANDBOX_POD" ] || warn "could not resolve sandbox pod — kubectl-mode pushes will fail"
  fi
  ssh -o ConnectTimeout=5 "$REMOTE_HOST" 'true' >/dev/null 2>&1 \
    || warn "ssh ${REMOTE_HOST} unreachable — ssh-mode pushes will fail"
fi

# ── Checksum helpers ───────────────────────────────────────────────────
md5_local() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | awk '{print $1}'
  else
    md5 -q "$1"
  fi
}

md5_pod_kubectl() {
  [ -n "$SANDBOX_POD" ] || { echo "MISSING-POD"; return; }
  docker exec "$DOCKER_HOST" kubectl exec -n "$K8S_NS" "$SANDBOX_POD" -- \
    sh -c "md5sum '$1' 2>/dev/null || echo 'ABSENT  ABSENT'" </dev/null 2>/dev/null | awk '{print $1}'
}

md5_pod_ssh() {
  ssh -n "$REMOTE_HOST" "md5sum '$1' 2>/dev/null || echo 'ABSENT  ABSENT'" 2>/dev/null | awk '{print $1}'
}

# ── Push helpers ───────────────────────────────────────────────────────
push_kubectl() {
  local src="$1" dst="$2" mode="$3" name
  name="$(basename "$dst")"
  if [ "$DRY_RUN" -eq 1 ]; then
    dim "[dry-run] kubectl-push: $src → $dst (mode $mode)"
    return 0
  fi
  [ -n "$SANDBOX_POD" ] || { err "no sandbox pod"; return 1; }
  ssh "$REMOTE_HOST" "cat > '/tmp/${name}.deploy'" < "$src" \
    || { err "stage to /tmp failed: $src"; return 1; }
  docker exec "$DOCKER_HOST" kubectl exec -n "$K8S_NS" "$SANDBOX_POD" -- \
    sh -c "mkdir -p '$(dirname "$dst")' && cp '/tmp/${name}.deploy' '$dst' && chmod $mode '$dst' && rm -f '/tmp/${name}.deploy'" \
    || { err "kubectl install failed: $dst"; return 1; }
  return 0
}

push_ssh() {
  local src="$1" dst="$2" mode="$3" name
  name="$(basename "$dst")"
  if [ "$DRY_RUN" -eq 1 ]; then
    dim "[dry-run] ssh-push: $src → $dst (mode $mode)"
    return 0
  fi
  # Stage to a sibling temp, then atomically mv into place + chmod.
  ssh "$REMOTE_HOST" "mkdir -p '$(dirname "$dst")' && cat > '${dst}.deploy.$$' && chmod $mode '${dst}.deploy.$$' && mv '${dst}.deploy.$$' '$dst'" < "$src" \
    || { err "ssh install failed: $dst"; return 1; }
  return 0
}

# ── Manifest iteration ─────────────────────────────────────────────────
# Each successful read sets: SRC DST MODE VIA
read_manifest_entries() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/  { next }
    NF >= 4 { print $1 "\t" $2 "\t" $3 "\t" $4 }
  ' "$MANIFEST"
}

step "chad-deploy ${MODE} (sandbox=${SANDBOX}, manifest=$(basename "$MANIFEST"))"
[ "$DRY_RUN" -eq 1 ] && dim "(dry-run mode)"

DRIFT_COUNT=0
PUSH_COUNT=0
FAIL_COUNT=0
MATCH_COUNT=0
SKIP_COUNT=0
ABSENT_COUNT=0

while IFS=$'\t' read -r SRC DST MODE_FLAG VIA; do
  if [ -n "$FILTER_SRC" ] && [ "$SRC" != "$FILTER_SRC" ]; then
    continue
  fi

  src_abs="${REPO_ROOT}/${SRC}"
  if [ ! -f "$src_abs" ]; then
    warn "source missing: $SRC — skipping"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  local_md5="$(md5_local "$src_abs")"

  case "$VIA" in
    kubectl) pod_md5="$(md5_pod_kubectl "$DST")" ;;
    ssh)     pod_md5="$(md5_pod_ssh "$DST")"     ;;
    *)       err "unknown via='$VIA' for $SRC"; FAIL_COUNT=$((FAIL_COUNT + 1)); continue ;;
  esac

  matched=0
  if [ "$pod_md5" = "$local_md5" ] && [ -n "$pod_md5" ]; then
    matched=1
    MATCH_COUNT=$((MATCH_COUNT + 1))
  elif [ "$pod_md5" = "ABSENT" ] || [ -z "$pod_md5" ]; then
    ABSENT_COUNT=$((ABSENT_COUNT + 1))
  else
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  fi

  if [ "$MODE" = "verify" ]; then
    if [ "$matched" = "1" ]; then
      ok "$DST ($(printf '%.8s' "$local_md5"))"
    elif [ "$pod_md5" = "ABSENT" ]; then
      warn "$DST  [absent on pod — needs push]"
    else
      err "$DST  drift: local=$(printf '%.8s' "$local_md5")  pod=$(printf '%.8s' "$pod_md5")"
      dim "src: $SRC  via: $VIA"
    fi
    continue
  fi

  # push mode
  if [ "$matched" = "1" ] && [ "$FORCE_ALL" -eq 0 ]; then
    dim "skip (md5 match): $DST"
    continue
  fi

  step "push $DST  (via $VIA, mode $MODE_FLAG)"
  case "$VIA" in
    kubectl) push_kubectl "$src_abs" "$DST" "$MODE_FLAG" || { FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
    ssh)     push_ssh     "$src_abs" "$DST" "$MODE_FLAG" || { FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
  esac

  if [ "$DRY_RUN" -eq 0 ]; then
    case "$VIA" in
      kubectl) post_md5="$(md5_pod_kubectl "$DST")" ;;
      ssh)     post_md5="$(md5_pod_ssh "$DST")" ;;
    esac
    if [ "$post_md5" = "$local_md5" ]; then
      ok "verified $DST ($(printf '%.8s' "$post_md5"))"
      PUSH_COUNT=$((PUSH_COUNT + 1))
    else
      err "post-push md5 mismatch on $DST  local=$(printf '%.8s' "$local_md5")  pod=$(printf '%.8s' "$post_md5")"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  else
    PUSH_COUNT=$((PUSH_COUNT + 1))
  fi
done < <(read_manifest_entries)

# ── Summary ────────────────────────────────────────────────────────────
echo
step "Summary"
if [ "$MODE" = "verify" ]; then
  printf '  matched=%d  drift=%d  absent=%d  skipped(missing-src)=%d\n' \
    "$MATCH_COUNT" "$DRIFT_COUNT" "$ABSENT_COUNT" "$SKIP_COUNT"
  total_problems=$((DRIFT_COUNT + ABSENT_COUNT))
  if [ "$total_problems" -gt 0 ]; then
    err "$total_problems entries out of sync — run: chad-deploy.sh --push"
    exit 1
  else
    ok "pod in sync with manifest"
    exit 0
  fi
else
  printf '  pushed=%d  matched-skipped=%d  failed=%d  missing-src=%d\n' \
    "$PUSH_COUNT" "$MATCH_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    err "$FAIL_COUNT pushes failed — inspect above"
    exit 1
  fi
  ok "deploy complete"
  exit 0
fi
