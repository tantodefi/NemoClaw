-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
-- SPDX-License-Identifier: Apache-2.0
--
-- seed-models.sql — open-webui custom-model records for the chad sandbox.
--
-- Idempotent: run via `sqlite3 webui.db < seed-models.sql`. Each model
-- is INSERT OR REPLACE'd by id, preserving any user_id assignment in
-- the existing row (subquery falls back to the first user if missing).
--
-- Regenerate this file from a working DB whenever the curated set or
-- descriptions change:
--   bash scripts/openwebui/regen-seed-models.sh
--
-- Applied automatically by scripts/openwebui-setup.sh after docker compose up.
--
-- Latency figures (cold-start first-token) from nvidia-liveness.py daily probe.
-- ~60 s = MoE flagship that needs warm-up; subsequent requests are 3–10 s.
-- Dead models: is_active=0 so they stay hidden; liveness sweep re-activates
-- them if NVIDIA ever re-enables the base_model_id.

-- ──────────────────────────────────────────────────────────────
-- LOCAL AGENT
-- ──────────────────────────────────────────────────────────────

-- chad
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'chad',
  COALESCE((SELECT user_id FROM model WHERE id = 'chad'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'chad',
  'Chad — agent · memory · tools',
  '{"profile_image_url": "/static/favicon.png", "description": "Local OpenClaw agent on the chad sandbox. Use when you want access to private data/context, long-term memory (gbrain), custom skills, agent orchestration, or anything that needs tools (read/edit/exec, web, browser, cron). ~20 s/turn but full agent harness with workspace files and persistent memory.", "tags": [{"name": "agent"}, {"name": "tools"}, {"name": "memory"}, {"name": "private-context"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- NVIDIA NEMOTRON
-- ──────────────────────────────────────────────────────────────

-- nvidia/nemotron-3-ultra-550b-a55b  (flagship, ~5 s warm, ~4.7 s probe)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'nvidia/nemotron-3-ultra-550b-a55b',
  COALESCE((SELECT user_id FROM model WHERE id = 'nvidia/nemotron-3-ultra-550b-a55b'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'nvidia/nemotron-3-ultra-550b-a55b',
  'Nemotron 3 Ultra 550B — flagship agent model',
  '{"profile_image_url": "/static/favicon.png", "description": "NVIDIA''s best (June 2026). 550 B MoE / 55 B active. Chad''s primary inference model. Use for complex multi-step reasoning, agentic flows, and long-form analysis. ~5 s first token warm.", "tags": [{"name": "frontier"}, {"name": "reasoning"}, {"name": "agentic"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- nvidia/nemotron-3-nano-omni-30b-a3b-reasoning  (~0.5 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  COALESCE((SELECT user_id FROM model WHERE id = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'Nemotron 3 Nano Omni 30B — fast reasoning',
  '{"profile_image_url": "/static/favicon.png", "description": "Small + chain-of-thought. 30 B with explicit reasoning traces. Best for math, logic puzzles, step-by-step problem solving when you need speed over depth. Sub-second warm latency.", "tags": [{"name": "reasoning"}, {"name": "math"}, {"name": "fast"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- META LLAMA
-- ──────────────────────────────────────────────────────────────

-- meta/llama-4-maverick-17b-128e-instruct  (~60 s cold)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'meta/llama-4-maverick-17b-128e-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'meta/llama-4-maverick-17b-128e-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'meta/llama-4-maverick-17b-128e-instruct',
  'Llama 4 Maverick — frontier reasoning',
  '{"profile_image_url": "/static/favicon.png", "description": "Meta''s Llama 4 flagship. 17 B active / 128-expert MoE. Best for hard reasoning, long-context analysis, deep Q&A. ~60 s cold-start; fast once warmed.", "tags": [{"name": "frontier"}, {"name": "reasoning"}, {"name": "long-context"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- meta/llama-3.3-70b-instruct  (~1.4 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'meta/llama-3.3-70b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'meta/llama-3.3-70b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'meta/llama-3.3-70b-instruct',
  'Llama 3.3 70B — reliable workhorse',
  '{"profile_image_url": "/static/favicon.png", "description": "Meta''s reliable open-weight workhorse. Strong at writing, summarization, instruction-following, light code review. ~1.4 s warm. Good default when you don''t need a frontier flagship.", "tags": [{"name": "general"}, {"name": "writing"}, {"name": "fast"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- meta/llama-3.1-70b-instruct  (~0.4 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'meta/llama-3.1-70b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'meta/llama-3.1-70b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'meta/llama-3.1-70b-instruct',
  'Llama 3.1 70B — fast balanced',
  '{"profile_image_url": "/static/favicon.png", "description": "Solid Llama 3.1 generalist. Sub-0.5 s warm latency. Good for chat, drafting, summarization, simple code when you want speed over Llama 4''s depth.", "tags": [{"name": "general"}, {"name": "fast"}, {"name": "balanced"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- GOOGLE
-- ──────────────────────────────────────────────────────────────

-- google/gemma-4-31b-it  (~60 s cold — best quality writing, not for real-time)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'google/gemma-4-31b-it',
  COALESCE((SELECT user_id FROM model WHERE id = 'google/gemma-4-31b-it'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'google/gemma-4-31b-it',
  'Gemma 4 31B — quality writing + summarisation',
  '{"profile_image_url": "/static/favicon.png", "description": "Google''s Gemma 4. Highest prose quality among fast-to-cold models. Best for writing, summarisation, structured docs, and careful Q&A. ~60 s cold-start — not ideal for back-and-forth chat unless pre-warmed.", "tags": [{"name": "writing"}, {"name": "summarisation"}, {"name": "quality"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- OPENAI (open-weight via NVIDIA)
-- ──────────────────────────────────────────────────────────────

-- openai/gpt-oss-120b  (~0.3 s warm — fastest reliable general-purpose)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'openai/gpt-oss-120b',
  COALESCE((SELECT user_id FROM model WHERE id = 'openai/gpt-oss-120b'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'openai/gpt-oss-120b',
  'GPT-OSS 120B — fastest frontier general',
  '{"profile_image_url": "/static/favicon.png", "description": "OpenAI''s open-weight 120 B. Sub-0.3 s warm latency — fastest large model in the picker. Strong across all tasks. Best default for interactive chat, quick answers, and speed-sensitive workflows.", "tags": [{"name": "fast"}, {"name": "general"}, {"name": "frontier"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- openai/gpt-oss-20b  (~0.4 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'openai/gpt-oss-20b',
  COALESCE((SELECT user_id FROM model WHERE id = 'openai/gpt-oss-20b'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'openai/gpt-oss-20b',
  'GPT-OSS 20B — lightweight Q&A',
  '{"profile_image_url": "/static/favicon.png", "description": "OpenAI''s small open-weight model. Very fast, low cost. Best for quick Q&A, casual chat, classification, and simple transforms where quality is secondary to speed.", "tags": [{"name": "fast"}, {"name": "small"}, {"name": "lightweight"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- DEEPSEEK
-- ──────────────────────────────────────────────────────────────

-- deepseek-ai/deepseek-v4-pro  (~60 s cold — best for code + math)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'deepseek-ai/deepseek-v4-pro',
  COALESCE((SELECT user_id FROM model WHERE id = 'deepseek-ai/deepseek-v4-pro'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'deepseek-ai/deepseek-v4-pro',
  'DeepSeek v4 Pro — code + math + logic',
  '{"profile_image_url": "/static/favicon.png", "description": "DeepSeek''s flagship v4. Best-in-class for code generation, debugging, algorithmic problem solving, and math. ~60 s cold-start; subsequent requests fast. Not ideal for casual chat.", "tags": [{"name": "coding"}, {"name": "math"}, {"name": "frontier"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- QWEN
-- ──────────────────────────────────────────────────────────────

-- qwen/qwen3.5-397b-a17b  (~3.4 s warm — featured flagship)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'qwen/qwen3.5-397b-a17b',
  COALESCE((SELECT user_id FROM model WHERE id = 'qwen/qwen3.5-397b-a17b'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'qwen/qwen3.5-397b-a17b',
  'Qwen 3.5 397B — multilingual + long reasoning',
  '{"profile_image_url": "/static/favicon.png", "description": "Qwen''s largest flagship. 397 B MoE / 17 B active. Excellent for Chinese + multilingual tasks, extended chain-of-thought reasoning, and technical analysis. ~3.4 s warm.", "tags": [{"name": "multilingual"}, {"name": "reasoning"}, {"name": "chinese"}, {"name": "frontier"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- qwen/qwen3-coder-480b-a35b-instruct  (~1.6 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'qwen/qwen3-coder-480b-a35b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'qwen/qwen3-coder-480b-a35b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'qwen/qwen3-coder-480b-a35b-instruct',
  'Qwen3 Coder 480B — coding specialist',
  '{"profile_image_url": "/static/favicon.png", "description": "Coding-optimised 480 B MoE (35 B active). Best for writing new code, debugging, multi-file refactors, code review, and language migrations. ~1.6 s warm. Top choice for purely technical work without agent tools.", "tags": [{"name": "coding"}, {"name": "frontier"}, {"name": "moe"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- MISTRAL
-- ──────────────────────────────────────────────────────────────

-- mistralai/mistral-small-4-119b-2603  (~1 s warm — featured flagship)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'mistralai/mistral-small-4-119b-2603',
  COALESCE((SELECT user_id FROM model WHERE id = 'mistralai/mistral-small-4-119b-2603'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'mistralai/mistral-small-4-119b-2603',
  'Mistral Small 4 119B — multilingual writing',
  '{"profile_image_url": "/static/favicon.png", "description": "Mistral''s current flagship. 119 B; fast at ~1 s warm. Excellent multilingual instruction following, European-language content (FR/ES/DE/IT), structured writing. Balanced speed and quality.", "tags": [{"name": "multilingual"}, {"name": "writing"}, {"name": "fast"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- mistralai/mistral-large-3-675b-instruct-2512  (~60 s cold)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'mistralai/mistral-large-3-675b-instruct-2512',
  COALESCE((SELECT user_id FROM model WHERE id = 'mistralai/mistral-large-3-675b-instruct-2512'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'mistralai/mistral-large-3-675b-instruct-2512',
  'Mistral Large 3 675B — deep multilingual',
  '{"profile_image_url": "/static/favicon.png", "description": "Mistral''s 675 B flagship. Best multilingual depth for complex creative writing, FR/ES/DE/IT fluency, and long-form reasoning. ~60 s cold-start; use Mistral Small 4 for interactive sessions.", "tags": [{"name": "multilingual"}, {"name": "creative"}, {"name": "frontier"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- MOONSHOT / KIMI
-- ──────────────────────────────────────────────────────────────

-- moonshotai/kimi-k2.6  (~0.8 s warm — fast agentic)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'moonshotai/kimi-k2.6',
  COALESCE((SELECT user_id FROM model WHERE id = 'moonshotai/kimi-k2.6'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'moonshotai/kimi-k2.6',
  'Kimi K2.6 — fast agentic + long-context',
  '{"profile_image_url": "/static/favicon.png", "description": "Moonshot Kimi K2.6. Sub-second warm latency with strong tool-use and long-document handling. Good fast alternative to Ultra for agentic flows and multi-turn research tasks.", "tags": [{"name": "agentic"}, {"name": "long-context"}, {"name": "fast"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- ABACUSAI
-- ──────────────────────────────────────────────────────────────

-- abacusai/dracarys-llama-3.1-70b-instruct  (~0.5 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'abacusai/dracarys-llama-3.1-70b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'abacusai/dracarys-llama-3.1-70b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'abacusai/dracarys-llama-3.1-70b-instruct',
  'Dracarys 70B — code + tool-use',
  '{"profile_image_url": "/static/favicon.png", "description": "AbacusAI fine-tune of Llama 3.1 70B, optimised for code generation and function calling. Fast (~0.5 s warm). Best for structured code tasks and tool-heavy workflows when you don''t need a full agent harness.", "tags": [{"name": "coding"}, {"name": "tool-use"}, {"name": "fast"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- MINIMAXAI
-- ──────────────────────────────────────────────────────────────

-- minimaxai/minimax-m2.7  (~60 s cold — 1M context)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'minimaxai/minimax-m2.7',
  COALESCE((SELECT user_id FROM model WHERE id = 'minimaxai/minimax-m2.7'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'minimaxai/minimax-m2.7',
  'MiniMax M2.7 — 1M-context creative',
  '{"profile_image_url": "/static/favicon.png", "description": "MiniMax M2.7. 1 M-token context window. Best for book-length document processing, narrative generation across long source material, and creative writing with heavy context. ~60 s cold-start.", "tags": [{"name": "long-context"}, {"name": "creative"}, {"name": "1m-tokens"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- Z-AI / ZHIPU
-- ──────────────────────────────────────────────────────────────

-- z-ai/glm-5.1  (~7 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'z-ai/glm-5.1',
  COALESCE((SELECT user_id FROM model WHERE id = 'z-ai/glm-5.1'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'z-ai/glm-5.1',
  'GLM-5.1 — Chinese / bilingual',
  '{"profile_image_url": "/static/favicon.png", "description": "ZhipuAI GLM 5.1. Best for Chinese-primary content, EN↔ZH translation, and bilingual tasks. ~7 s warm. For mixed Chinese + reasoning tasks prefer Qwen 3.5.", "tags": [{"name": "chinese"}, {"name": "multilingual"}, {"name": "translation"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- LANGUAGE SPECIALISTS
-- ──────────────────────────────────────────────────────────────

-- sarvamai/sarvam-m  (~0.3 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'sarvamai/sarvam-m',
  COALESCE((SELECT user_id FROM model WHERE id = 'sarvamai/sarvam-m'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'sarvamai/sarvam-m',
  'Sarvam-M — Indic languages',
  '{"profile_image_url": "/static/favicon.png", "description": "Specialist for Hindi, Tamil, Telugu, Kannada, Bengali, and other Indic scripts. Sub-0.3 s warm. Use when working with Indian-language content.", "tags": [{"name": "indic"}, {"name": "multilingual"}, {"name": "specialist"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- stockmark/stockmark-2-100b-instruct  (~0.4 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'stockmark/stockmark-2-100b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'stockmark/stockmark-2-100b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'stockmark/stockmark-2-100b-instruct',
  'Stockmark 2 100B — Japanese',
  '{"profile_image_url": "/static/favicon.png", "description": "Specialist for Japanese business and general-purpose content. Sub-0.4 s warm. Use for Japanese text generation, translation, and summarisation.", "tags": [{"name": "japanese"}, {"name": "multilingual"}, {"name": "specialist"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- upstage/solar-10.7b-instruct  (~0.3 s warm)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'upstage/solar-10.7b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'upstage/solar-10.7b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'upstage/solar-10.7b-instruct',
  'Solar 10.7B — Korean',
  '{"profile_image_url": "/static/favicon.png", "description": "Upstage Solar. Specialist for Korean-language content. Sub-0.3 s warm. Use for Korean text generation, translation, and summarisation.", "tags": [{"name": "korean"}, {"name": "multilingual"}, {"name": "specialist"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- ──────────────────────────────────────────────────────────────
-- DEAD MODELS — keep rows so liveness sweep can re-enable if restored
-- ──────────────────────────────────────────────────────────────

-- microsoft/phi-4-multimodal-instruct  (HTTP 404 as of Jun 2026)
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'microsoft/phi-4-multimodal-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'microsoft/phi-4-multimodal-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'microsoft/phi-4-multimodal-instruct',
  'Phi-4 Multimodal — vision (unavailable)',
  '{"profile_image_url": "/static/favicon.png", "description": "Vision-capable model. Currently unavailable on NVIDIA endpoints (HTTP 404). Will auto-reactivate if NVIDIA re-enables it.", "tags": [{"name": "vision"}, {"name": "unavailable"}], "capabilities": {"vision": true, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  0
);
