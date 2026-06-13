// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// serve-runs.js — host-side Smithers Gateway API for the experiment run board.
// Phase 4b (UI in OpenWebUI). Run:  bun serve-runs.js   (or node)
//
// This starts the Gateway HTTP API (startServer) bound to the experiments DB.
// The visual run board is the separate `gateway-react` frontend, which talks to
// this API — see "Frontend + /runs routing" below; that piece still needs a
// static build + a boot test, so this script is the API half only.
//
// Auth: set SMITHERS_API_KEY (the gateway requires it for non-/health routes).
// Port: CHAD_RUNS_PORT (default 7331).
//
// ── Frontend + /runs routing (the recommendation, not yet applied) ───────────
// Recommended: path-based chad.supachad.com/runs — ONE Cloudflare Access policy
// (no new DNS/cert/Access app), via a second cloudflared ingress rule pointing
// /runs at this gateway (see cloudflared-runs.ingress.example.yaml). CAVEAT: the
// app served must emit assets under /runs (base path). `startServer` exposes no
// basePath option and gateway-react's base-path support is unverified, so if
// assets 404 under /runs, fall back to a subdomain (runs.supachad.com) where the
// app lives at root. Interim "UI in OpenWebUI" without any of this = the nightly
// leaderboard note (run-experiments.sh), which already works.

// NOTE: bun-only — the gateway expects a bun:sqlite Database instance.
import { startServer } from "smithers-orchestrator";
import { Database } from "bun:sqlite";

const port = Number(process.env.CHAD_RUNS_PORT || 7331);
const dbPath = process.env.CHAD_SMITHERS_DB || "./experiments.db";
const authToken = process.env.SMITHERS_API_KEY;

if (!authToken) {
  console.error("serve-runs: refusing to start without SMITHERS_API_KEY (gateway would be unauthenticated).");
  process.exit(2);
}

const db = new Database(dbPath);
console.error(`serve-runs: starting Smithers Gateway on :${port} for db ${dbPath}`);
startServer({ port, db, authToken });
