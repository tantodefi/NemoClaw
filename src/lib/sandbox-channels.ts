// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deleteCredential, saveCredential } from "./credentials";

export interface ChannelDef {
  // null for channels that authenticate via mounted creds.json (e.g. whatsapp)
  envKey: string | null;
  // "creds-mount" for channels paired outside the container; otherwise undefined
  credType?: "creds-mount";
  description: string;
  help: string;
  label: string | null;
  appTokenEnvKey?: string;
  appTokenHelp?: string;
  appTokenLabel?: string;
  userIdEnvKey?: string;
  userIdHelp?: string;
  userIdLabel?: string;
  allowIdsMode?: "dm" | "guild";
  serverIdEnvKey?: string;
  serverIdHelp?: string;
  serverIdLabel?: string;
  requireMentionEnvKey?: string;
  requireMentionHelp?: string;
  tokenFormat?: RegExp;
  tokenFormatHint?: string;
  appTokenFormat?: RegExp;
  appTokenFormatHint?: string;
}

export const KNOWN_CHANNELS: Record<string, ChannelDef> = {
  telegram: {
    envKey: "TELEGRAM_BOT_TOKEN",
    description: "Telegram bot messaging",
    help: "Create a bot via @BotFather on Telegram, then copy the token.",
    label: "Telegram Bot Token",
    userIdEnvKey: "TELEGRAM_ALLOWED_IDS",
    userIdHelp: "Send /start to @userinfobot on Telegram to get your numeric user ID.",
    userIdLabel: "Telegram User ID (for DM access)",
    allowIdsMode: "dm",
  },
  discord: {
    envKey: "DISCORD_BOT_TOKEN",
    description: "Discord bot messaging",
    help: "Discord Developer Portal → Applications → Bot → Reset/Copy Token.",
    label: "Discord Bot Token",
    serverIdEnvKey: "DISCORD_SERVER_ID",
    serverIdHelp:
      "Enable Developer Mode in Discord, then right-click your server and copy the Server ID.",
    serverIdLabel: "Discord Server ID (for guild workspace access)",
    requireMentionEnvKey: "DISCORD_REQUIRE_MENTION",
    requireMentionHelp:
      "Choose whether the bot should reply only when @mentioned or to all messages in this server.",
    userIdEnvKey: "DISCORD_USER_ID",
    userIdHelp:
      "Optional: enable Developer Mode in Discord, then right-click your user/avatar and copy the User ID. Leave blank to allow any member of the configured server to message the bot.",
    userIdLabel: "Discord User ID (optional guild allowlist)",
    allowIdsMode: "guild",
  },
  slack: {
    envKey: "SLACK_BOT_TOKEN",
    description: "Slack bot messaging",
    help: "Slack API → Your Apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...).",
    label: "Slack Bot Token",
    tokenFormat: /^xoxb-[A-Za-z0-9_-]+$/,
    tokenFormatHint: "Slack bot tokens start with 'xoxb-' (e.g. xoxb-1234-5678-abcdef).",
    appTokenEnvKey: "SLACK_APP_TOKEN",
    appTokenHelp: "Slack API → Your Apps → Basic Information → App-Level Tokens (xapp-...).",
    appTokenLabel: "Slack App Token (Socket Mode)",
    appTokenFormat: /^xapp-[A-Za-z0-9_-]+$/,
    appTokenFormatHint: "Slack app tokens start with 'xapp-' (e.g. xapp-1-A0000-12345-abcdef).",
  },
  whatsapp: {
    // WhatsApp uses session credentials (creds.json) rather than a static bot token.
    // The account must be paired outside the container with:
    //   docker run --rm -it ghcr.io/nvidia/nemoclaw/sandbox-base:latest \
    //     openclaw channels login --channel whatsapp
    // Then mount the creds.json read-only at container start:
    //   -v /path/to/creds.json:/sandbox/.openclaw-data/credentials/whatsapp/main/creds.json:ro
    envKey: null,
    credType: "creds-mount",
    description: "WhatsApp messaging (requires pre-paired creds.json mount)",
    help: "WhatsApp uses session credentials, not a bot token. Pair the account first:\n  docker run --rm -it ghcr.io/nvidia/nemoclaw/sandbox-base:latest openclaw channels login --channel whatsapp\nThen mount the creds.json at sandbox start (see docs).",
    label: null,
    userIdEnvKey: "WHATSAPP_ALLOWED_IDS",
    userIdHelp: "Enter E.164 phone number(s) to allowlist (e.g. +14155552671). Comma-separate multiple.",
    userIdLabel: "WhatsApp phone number(s) to allowlist",
  },
};

export function getChannelDef(name: string): ChannelDef | undefined {
  return KNOWN_CHANNELS[name.trim().toLowerCase()];
}

export function knownChannelNames(): string[] {
  return Object.keys(KNOWN_CHANNELS);
}

export function listChannels(): Array<{ name: string } & ChannelDef> {
  return Object.entries(KNOWN_CHANNELS).map(([name, def]) => ({ name, ...def }));
}

export function getChannelTokenKeys(channel: ChannelDef): string[] {
  // creds-mount channels (whatsapp) have no env-var-backed tokens
  if (!channel.envKey) return [];
  return channel.appTokenEnvKey ? [channel.envKey, channel.appTokenEnvKey] : [channel.envKey];
}

export function persistChannelTokens(tokens: Record<string, string>): void {
  for (const [key, value] of Object.entries(tokens)) {
    saveCredential(key, value);
  }
}

export function clearChannelTokens(channel: ChannelDef): void {
  for (const key of getChannelTokenKeys(channel)) {
    deleteCredential(key);
  }
}
