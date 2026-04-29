# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate ~/.openclaw/openclaw.json from build-time environment variables.

Invoked from the Dockerfile's final RUN step. All inputs come from env vars
(never from string interpolation) to avoid code-injection via Docker build
args — see Dockerfile comment at the ENV NEMOCLAW_* line.
"""

import base64
import json
import os
import secrets
from urllib.parse import urlparse


def _b64json(env_key: str, default_b64: str) -> object:
    raw = os.environ.get(env_key, default_b64) or default_b64
    return json.loads(base64.b64decode(raw).decode("utf-8"))


def _registry_defaults(model_id: str) -> dict:
    """Pull contextWindow / maxOutputTokens / reasoningSafe for a model from
    scripts/model-registry.json. Returns {} on any error so the caller falls
    back to env-var defaults — the registry is best-effort, not required."""
    candidates = [
        os.environ.get("NEMOCLAW_MODEL_REGISTRY"),
        "/usr/local/share/chad/model-registry.json",
        os.path.join(os.path.dirname(__file__), "model-registry.json"),
    ]
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path) as f:
                reg = json.load(f)
            entry = reg.get("models", {}).get(model_id, {})
            if entry:
                return entry
        except Exception:
            continue
    return {}


def main() -> None:
    model = os.environ["NEMOCLAW_MODEL"]
    chat_ui_url = os.environ["CHAT_UI_URL"]
    provider_key = os.environ["NEMOCLAW_PROVIDER_KEY"]
    primary_model_ref = os.environ["NEMOCLAW_PRIMARY_MODEL_REF"]
    inference_base_url = os.environ["NEMOCLAW_INFERENCE_BASE_URL"]
    inference_api = os.environ["NEMOCLAW_INFERENCE_API"]

    inference_compat = _b64json("NEMOCLAW_INFERENCE_COMPAT_B64", "e30=")
    web_config = _b64json("NEMOCLAW_WEB_CONFIG_B64", "e30=")
    msg_channels = _b64json("NEMOCLAW_MESSAGING_CHANNELS_B64", "W10=")
    allowed_ids = _b64json("NEMOCLAW_MESSAGING_ALLOWED_IDS_B64", "e30=")

    token_keys = {"discord": "token", "telegram": "botToken", "slack": "botToken"}
    env_keys = {
        "discord": "DISCORD_BOT_TOKEN",
        "telegram": "TELEGRAM_BOT_TOKEN",
        "slack": "SLACK_BOT_TOKEN",
    }

    ch_cfg: dict = {}
    for ch in msg_channels:
        if ch not in token_keys:
            continue
        account: dict = {
            token_keys[ch]: f"openshell:resolve:env:{env_keys[ch]}",
            "enabled": True,
        }
        if ch in allowed_ids and allowed_ids[ch]:
            account["dmPolicy"] = "allowlist"
            account["allowFrom"] = allowed_ids[ch]
        ch_cfg[ch] = {"accounts": {"main": account}}

    if "whatsapp" in msg_channels:
        wa_acct: dict = {"enabled": True}
        if "whatsapp" in allowed_ids and allowed_ids["whatsapp"]:
            wa_acct["dmPolicy"] = "allowlist"
            wa_acct["allowFrom"] = allowed_ids["whatsapp"]
        else:
            wa_acct["dmPolicy"] = "pairing"
        ch_cfg["whatsapp"] = {"accounts": {"main": wa_acct}}

    parsed = urlparse(chat_ui_url)
    if parsed.scheme and parsed.netloc:
        chat_origin = f"{parsed.scheme}://{parsed.netloc}"
    else:
        chat_origin = "http://127.0.0.1:18789"
    origins = list(dict.fromkeys(["http://127.0.0.1:18789", chat_origin]))

    disable_device_auth = os.environ.get("NEMOCLAW_DISABLE_DEVICE_AUTH", "") == "1"
    allow_insecure = parsed.scheme == "http"

    # Defaults come from scripts/model-registry.json (single source of truth
    # for per-model limits). Env vars NEMOCLAW_CONTEXT_WINDOW /
    # NEMOCLAW_MAX_TOKENS still override — the registry just removes the
    # need to pass them when running a known model.
    # NOTE: keep reasoning=False for Kimi-K2.5. Flipping it to True changes
    # the openclaw harness's tool-call parsing and K2.5 emits tool calls in
    # a form that doesn't round-trip — runs end up with "Tool  not found"
    # errors and the agent loops on empty toolUse stops. The registry's
    # reasoningSafe flag drives this default.
    reg = _registry_defaults(model)
    ctx_default = str(reg.get("contextWindow", 262144))
    max_default = str(reg.get("maxOutputTokens", 32768))
    reasoning_default = bool(reg.get("reasoningSafe", False))
    model_entry: dict = {
        "id": model,
        "name": primary_model_ref,
        "reasoning": reasoning_default,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": int(os.environ.get("NEMOCLAW_CONTEXT_WINDOW", ctx_default)),
        "maxTokens": int(os.environ.get("NEMOCLAW_MAX_TOKENS", max_default)),
    }
    if inference_compat:
        model_entry["compat"] = inference_compat

    providers = {
        provider_key: {
            "baseUrl": inference_base_url,
            "apiKey": "unused",
            "api": inference_api,
            "models": [model_entry],
        }
    }

    # Premium side-channel: surface Anthropic Sonnet/Opus/Haiku as a
    # *secondary* provider when ANTHROPIC_API_KEY is present in the deployed
    # credentials. Default routing stays on the primary inference gateway;
    # chad-premium / /premium explicitly select these models. Access is gated
    # downstream by chad-auth-context — the registry just declares them
    # available. The L7 proxy resolves the apiKey from
    # /sandbox/.nemoclaw/credentials.json (deployed by chad-setup.sh).
    if os.environ.get("ANTHROPIC_API_KEY"):
        anthropic_models = [
            ("claude-sonnet-4-6", 200000, 64000),
            ("claude-opus-4-7", 200000, 64000),
            ("claude-haiku-4-5-20251001", 200000, 64000),
        ]
        providers["anthropic"] = {
            "baseUrl": "https://api.anthropic.com",
            "apiKey": "openshell:resolve:env:ANTHROPIC_API_KEY",
            "api": "anthropic-messages",
            "models": [
                {
                    "id": mid,
                    "name": mid,
                    "reasoning": True,
                    "input": ["text", "image"],
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": ctx,
                    "maxTokens": maxout,
                    "requiresAuthContext": True,
                }
                for (mid, ctx, maxout) in anthropic_models
            ],
        }

    # Bundled OpenClaw skills (clawhub, coding-agent, gog, session-logs,
    # summarize) and the three custom sandbox skills (chad-bug-intake,
    # chad-orchestrator, proton-calendar) are explicitly enabled here.
    # Without this block, `openclaw skills check` reports them as
    # "disabled" because the default config ships with an empty allowlist.
    # Keep the list in sync with chad-readme.md §"Skill enablement".
    skills_cfg: dict = {
        "mode": "merge",
        "load": {
            "extraDirs": [
                "/sandbox/.openclaw-data/skills",
                "/opt/chad-orchestrator",
            ],
        },
        "enable": {
            # OpenClaw-bundled skills
            "clawhub": True,
            "coding-agent": True,
            "gog": True,
            "session-logs": True,
            "summarize": True,
            "openclaw-bundled": True,
            # Custom sandbox skills (synced by chad-setup.sh)
            "chad-bug-intake": True,
            "chad-orchestrator": True,
            "proton-calendar": True,
        },
    }

    config: dict = {
        "agents": {"defaults": {"model": {"primary": primary_model_ref}}},
        "models": {"mode": "merge", "providers": providers},
        "skills": skills_cfg,
        "channels": {"defaults": {"configWrites": False}, **ch_cfg},
        "gateway": {
            "mode": "local",
            "controlUi": {
                "allowInsecureAuth": allow_insecure,
                "dangerouslyDisableDeviceAuth": disable_device_auth,
                "allowedOrigins": origins,
            },
            "trustedProxies": ["127.0.0.1", "::1"],
            "auth": {"token": secrets.token_hex(32)},
        },
    }

    if web_config.get("provider") == "brave":
        search_cfg: dict = {"enabled": True, "provider": "brave"}
        if web_config.get("apiKey", ""):
            search_cfg["apiKey"] = web_config.get("apiKey", "")
        config["tools"] = {
            "web": {
                "search": search_cfg,
                "fetch": {"enabled": bool(web_config.get("fetchEnabled", True))},
            }
        }

    path = os.path.expanduser("~/.openclaw/openclaw.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(config, f, indent=2)
    os.chmod(path, 0o600)


if __name__ == "__main__":
    main()
