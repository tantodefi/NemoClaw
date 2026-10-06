// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// lib/notify.js — one-way Moshi push via the device-token webhook. The single
// place the webhook call lives (chad-moshi-notify CLI + workflows both use it).
// Never throws — a notification failing must not sink a run. Works from any
// context (nemotron sessions, cron, Smithers workflows): no claude-hook, no Pro.

import { readFileSync } from "node:fs";

const ENDPOINT = process.env.MOSHI_WEBHOOK_URL || "https://api.getmoshi.app/api/webhook";
const CREDS = process.env.CHAD_HOST_CREDS || "/Users/r/.nemoclaw/credentials.json";

/** Resolve the device token from env, else host credentials.json. "" if absent. */
export function moshiToken() {
  if (process.env.MOSHI_DEVICE_TOKEN) return process.env.MOSHI_DEVICE_TOKEN;
  try { return JSON.parse(readFileSync(CREDS, "utf8")).MOSHI_DEVICE_TOKEN || ""; } catch { return ""; }
}

/**
 * moshiPing(title, message, opts?) — push a one-way notification. Resolves to
 * { sent, status?/reason? }; never rejects. opts.unified fans to all licensed
 * devices. Caps title/message to the API's practical limits.
 */
export async function moshiPing(title, message, opts = {}) {
  const token = opts.token || moshiToken();
  if (!token) return { sent: false, reason: "no MOSHI_DEVICE_TOKEN" };
  const body = { token, title: String(title || "").slice(0, 200), message: String(message || "").slice(0, 2000) };
  if (opts.unified) body.unified = true;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), opts.timeoutMs || 15000);
    const r = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
    clearTimeout(t);
    return { sent: r.ok, status: r.status };
  } catch (e) { return { sent: false, reason: String(e && e.message || e) }; }
}
