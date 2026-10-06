"""
title: Chad Lite Rate Limit
author: chad
version: 0.2.0
required_open_webui_version: 0.5.0
description: Per-user metering for the free tier. Credit-metered users (who bought credits via Square) consume 1 credit/message and skip the daily cap while in balance; everyone else gets the free daily message cap. Premium models (chad) and admins are exempt.
"""
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenWebUI FILTER function. inlet() runs before every model call; it counts a
# user's messages per UTC day and raises (blocks) once the free-tier cap is hit,
# with an upgrade CTA. Premium models and admins are exempt. Counts persist in a
# small JSON file so a container restart doesn't reset quotas mid-day.
#
# Install: Workspace -> Functions -> + -> paste; enable globally. Or via the
# admin API: POST /api/v1/functions/create (done by the deploy step).

import json
import os
import time
from typing import Optional

from pydantic import BaseModel, Field

_STATE_PATH = os.environ.get("CHAD_RATELIMIT_STATE", "/app/backend/data/chad_ratelimit.json")


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _load() -> dict:
    try:
        with open(_STATE_PATH) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save(state: dict) -> None:
    try:
        tmp = _STATE_PATH + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(state, fh)
        os.replace(tmp, _STATE_PATH)
    except OSError:
        pass  # best-effort; a read-only FS just means in-memory-only for this call


# Credit metering: the supachad Worker is the source of truth for credit balances
# (topped up by Square checkouts). The filter consumes 1 credit/message via its
# admin API. Gated on CHAD_CREDITS_ADMIN_SECRET being set, so the filter still works
# (free-cap only) before the Worker is wired.
_CREDITS_API = os.environ.get("CHAD_CREDITS_API", "https://supachad.com/api/credits")
_CREDITS_SECRET = os.environ.get("CHAD_CREDITS_ADMIN_SECRET", "")


def _consume_credit(email: str, amount: int = 1) -> str:
    """Consume `amount` credits for `email` via the Worker. Returns:
    "ok" (consumed — allow, skip daily cap), "insufficient" (0 balance),
    "unconfigured" (no secret/email), or "error" (network/other). Any non-"ok"
    result makes the caller fall through to the free daily cap — so a Worker
    outage never hard-blocks, it just reverts to free-tier limits."""
    if not _CREDITS_SECRET or not email or "@" not in email:
        return "unconfigured"
    import urllib.error
    import urllib.request

    body = json.dumps({"email": email, "amount": amount}).encode()
    req = urllib.request.Request(
        _CREDITS_API.rstrip("/") + "/consume",
        data=body,
        headers={"content-type": "application/json", "X-Admin-Secret": _CREDITS_SECRET},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            d = json.loads(resp.read() or b"{}")
            return "ok" if d.get("ok") else "insufficient"
    except urllib.error.HTTPError as e:
        return "insufficient" if e.code == 402 else "error"
    except Exception:
        return "error"


class Filter:
    class Valves(BaseModel):
        free_daily_limit: int = Field(
            default=50, description="Max messages/day for free-tier (non-exempt) models."
        )
        exempt_models: str = Field(
            default="chad",
            description="Comma-separated model ids exempt from the cap (premium).",
        )
        exempt_admins: bool = Field(
            default=True, description="Admins are never rate-limited."
        )
        upgrade_message: str = Field(
            default=(
                "You've reached today's free Chad Lite limit ({limit} messages). "
                "It resets at 00:00 UTC. Upgrade to premium **Chad** for the full "
                "agent, memory, automations, and no daily cap."
            ),
            description="Shown when the cap is hit. {limit} and {model} are substituted.",
        )

    def __init__(self):
        self.valves = self.Valves()

    def _exempt(self, model_id: str) -> bool:
        ids = {m.strip() for m in self.valves.exempt_models.split(",") if m.strip()}
        # Match the base id too (OWUI may prefix connection ids).
        return any(model_id == e or model_id.endswith("." + e) or e in model_id.split("/") for e in ids)

    def inlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        model_id = str(body.get("model", "") or "")
        if self._exempt(model_id):
            return body
        user = __user__ or {}
        if self.valves.exempt_admins and user.get("role") == "admin":
            return body
        email = user.get("email") or ""
        uid = user.get("id") or email or "anon"

        # Credit-metered users (bought credits via Square) pay per message and
        # skip the free daily cap while they have a balance. Any non-"ok" result
        # (no credits, or Worker unreachable) falls through to the free cap below.
        if _CREDITS_SECRET and email and _consume_credit(email) == "ok":
            return body

        state = _load()
        day = _today()
        if state.get("day") != day:
            state = {"day": day, "counts": {}}
        counts = state.setdefault("counts", {})
        used = int(counts.get(uid, 0))

        if used >= self.valves.free_daily_limit:
            raise Exception(
                self.valves.upgrade_message.format(
                    limit=self.valves.free_daily_limit, model=model_id
                )
            )

        counts[uid] = used + 1
        _save(state)
        return body

    def outlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        return body
