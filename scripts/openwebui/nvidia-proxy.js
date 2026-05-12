#!/usr/bin/env bun
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// nvidia-proxy — filtering passthrough between open-webui and NVIDIA's API.
//
//   GET  /v1/models         → fetch upstream, drop entries flagged "dead" in
//                             liveness.json (lenient: unknown stays visible)
//   GET  /_health           → last-sweep timestamp + live/dead counts
//   *                       → transparent passthrough to integrate.api.nvidia.com
//
// Companion: nvidia-liveness.py rewrites liveness.json daily. Repoint
// OPENAI_API_BASE_URL at this proxy and open-webui's auto-discovered model
// list reflects only live upstream models.

import { existsSync, readFileSync, statSync } from "fs";

const UPSTREAM = process.env.NVIDIA_UPSTREAM ?? "https://integrate.api.nvidia.com";
const UPSTREAM_HOST = new URL(UPSTREAM).host;
const PORT = parseInt(process.env.NVIDIA_PROXY_PORT ?? "3002");
const LIVENESS_PATH =
  process.env.NVIDIA_LIVENESS_FILE ??
  `${process.env.HOME}/.nemoclaw/openwebui/liveness.json`;

let livenessCache = null;
let livenessMtime = 0;

function loadLiveness() {
  if (!existsSync(LIVENESS_PATH)) return null;
  const mtime = statSync(LIVENESS_PATH).mtimeMs;
  if (mtime === livenessMtime && livenessCache) return livenessCache;
  try {
    livenessCache = JSON.parse(readFileSync(LIVENESS_PATH, "utf-8"));
    livenessMtime = mtime;
    return livenessCache;
  } catch (e) {
    console.error(`[nvidia-proxy] liveness reload failed: ${e.message}`);
    return livenessCache;
  }
}

function shouldExpose(modelId, liveness) {
  // Featured list is the curation output (per-provider top picks). If
  // present, only those are exposed. If absent (pre-first-sweep), fall back
  // to "drop only confirmed-dead" so the dropdown still works.
  if (!liveness) return true;
  if (Array.isArray(liveness.featured) && liveness.featured.length > 0) {
    return liveness.featured.includes(modelId);
  }
  return liveness?.models?.[modelId]?.status !== "dead";
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/_health") {
      const liveness = loadLiveness();
      const counts = { live: 0, dead: 0, unknown: 0 };
      for (const m of Object.values(liveness?.models ?? {})) {
        const s = m.status || "unknown";
        counts[s] = (counts[s] ?? 0) + 1;
      }
      return Response.json({
        status: "ok",
        upstream: UPSTREAM,
        liveness_file: LIVENESS_PATH,
        liveness_loaded: !!liveness,
        last_sweep: liveness?.last_sweep ?? null,
        counts,
      });
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("connection");
    headers.set("host", UPSTREAM_HOST);

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        duplex: "half",
      });
    } catch (e) {
      console.error(`[nvidia-proxy] upstream fetch failed: ${e.message}`);
      return Response.json(
        { error: { message: `upstream fetch failed: ${e.message}`, type: "proxy_error" } },
        { status: 502 }
      );
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!upstreamResp.ok) {
        return new Response(upstreamResp.body, {
          status: upstreamResp.status,
          headers: upstreamResp.headers,
        });
      }
      const body = await upstreamResp.json();
      const liveness = loadLiveness();
      const before = (body.data || []).length;
      // NVIDIA's upstream lists ~6 ids twice (staging vs prod entries with same id).
      // Dedupe so open-webui doesn't show the same model twice in the dropdown.
      const seen = new Set();
      body.data = (body.data || []).filter((m) => {
        if (!shouldExpose(m.id, liveness)) return false;
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      console.error(`[nvidia-proxy] /v1/models ${before} → ${body.data.length}`);
      return Response.json(body);
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: upstreamResp.headers,
    });
  },
});

console.error(`[nvidia-proxy] listening on http://${server.hostname}:${server.port} → ${UPSTREAM}`);
console.error(`[nvidia-proxy] liveness file: ${LIVENESS_PATH}`);
