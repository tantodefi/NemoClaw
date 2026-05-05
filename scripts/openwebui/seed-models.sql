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

-- chad
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'chad',
  COALESCE((SELECT user_id FROM model WHERE id = 'chad'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'chad',
  'Chad — agent · memory · tools',
  '{"profile_image_url": "/static/favicon.png", "description": "Local OpenClaw agent on the chad sandbox. Use when you want access to private data/context, long-term memory (gbrain), custom skills, agent orchestration, or anything that needs tools (read/edit/exec, web, browser, cron). Slower (~20s/turn) but full agent harness with workspace files baked in.", "tags": [{"name": "agent"}, {"name": "tools"}, {"name": "memory"}, {"name": "private-context"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- google/gemma-3-27b-it
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'google/gemma-3-27b-it',
  COALESCE((SELECT user_id FROM model WHERE id = 'google/gemma-3-27b-it'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'google/gemma-3-27b-it',
  'Gemma 3 27B — writing + Q&A',
  '{"profile_image_url": "/static/favicon.png", "description": "Google''s mid-size open model. Strong at writing, summarization, structured output. Tight, efficient \u2014 good for Q&A and explanation tasks.", "tags": [{"name": "writing"}, {"name": "explanation"}, {"name": "balanced"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- meta/llama-3.1-405b-instruct
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'meta/llama-3.1-405b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'meta/llama-3.1-405b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'meta/llama-3.1-405b-instruct',
  'Llama 3.1 405B — deep reasoning (slow)',
  '{"profile_image_url": "/static/favicon.png", "description": "Largest open Llama. Pick when you need maximum reasoning depth on hard, ambiguous problems. Slow cold start; not for quick chat.", "tags": [{"name": "frontier"}, {"name": "reasoning"}, {"name": "long-form"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- meta/llama-3.1-70b-instruct
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'meta/llama-3.1-70b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'meta/llama-3.1-70b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'meta/llama-3.1-70b-instruct',
  'Llama 3.1 70B — balanced general',
  '{"profile_image_url": "/static/favicon.png", "description": "Mid-size Llama. Solid generalist when you don''t need frontier \u2014 chat, drafting, summarization, simple code. Good speed/quality trade-off.", "tags": [{"name": "general"}, {"name": "balanced"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- meta/llama-3.3-70b-instruct
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'meta/llama-3.3-70b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'meta/llama-3.3-70b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'meta/llama-3.3-70b-instruct',
  'Llama 3.3 70B — workhorse general',
  '{"profile_image_url": "/static/favicon.png", "description": "Meta''s frontier open model. Best general-purpose for writing, summarization, instruction-following, light code review. Reliable workhorse.", "tags": [{"name": "general"}, {"name": "writing"}, {"name": "open"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- microsoft/phi-4-multimodal-instruct
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'microsoft/phi-4-multimodal-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'microsoft/phi-4-multimodal-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'microsoft/phi-4-multimodal-instruct',
  'Phi-4 Multimodal — vision',
  '{"profile_image_url": "/static/favicon.png", "description": "Vision-capable. Pick this when you need to analyze images, diagrams, screenshots, or PDFs alongside text. Smaller than the giants but solid for multimodal tasks.", "tags": [{"name": "vision"}, {"name": "multimodal"}], "capabilities": {"vision": true, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- minimaxai/minimax-m2.5
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'minimaxai/minimax-m2.5',
  COALESCE((SELECT user_id FROM model WHERE id = 'minimaxai/minimax-m2.5'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'minimaxai/minimax-m2.5',
  'MiniMax M2.5 — long-context + creative',
  '{"profile_image_url": "/static/favicon.png", "description": "MiniMax frontier. Strong at long-context document processing, creative writing, narrative generation. Pick when you have a lot of context to thread through.", "tags": [{"name": "long-context"}, {"name": "creative"}, {"name": "frontier"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- mistralai/mixtral-8x22b-instruct-v0.1
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'mistralai/mixtral-8x22b-instruct-v0.1',
  COALESCE((SELECT user_id FROM model WHERE id = 'mistralai/mixtral-8x22b-instruct-v0.1'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'mistralai/mixtral-8x22b-instruct-v0.1',
  'Mixtral 8x22B — multilingual + creative',
  '{"profile_image_url": "/static/favicon.png", "description": "Mixture-of-experts. Strong at multilingual chat, creative writing, French/Spanish/German fluency. Fast for its size.", "tags": [{"name": "multilingual"}, {"name": "creative"}, {"name": "moe"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  COALESCE((SELECT user_id FROM model WHERE id = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'Nemotron 3 Nano Omni 30B — reasoning',
  '{"profile_image_url": "/static/favicon.png", "description": "Small + reasoning. 30B with chain-of-thought traces. Best for math, logic puzzles, step-by-step problem solving on a budget. Fast.", "tags": [{"name": "reasoning"}, {"name": "math"}, {"name": "small"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- nvidia/nemotron-3-super-120b-a12b
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'nvidia/nemotron-3-super-120b-a12b',
  COALESCE((SELECT user_id FROM model WHERE id = 'nvidia/nemotron-3-super-120b-a12b'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'nvidia/nemotron-3-super-120b-a12b',
  'Nemotron 3 Super 120B — frontier general',
  '{"profile_image_url": "/static/favicon.png", "description": "Frontier general-purpose. 120B MoE / 12B active, NVIDIA''s flagship for chat, reasoning, code, summarization. Same model Chad uses internally \u2014 pick this when you want raw inference without the agent wrapper.", "tags": [{"name": "frontier"}, {"name": "general"}, {"name": "reasoning"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- openai/gpt-oss-120b
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'openai/gpt-oss-120b',
  COALESCE((SELECT user_id FROM model WHERE id = 'openai/gpt-oss-120b'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'openai/gpt-oss-120b',
  'GPT-OSS 120B — frontier general',
  '{"profile_image_url": "/static/favicon.png", "description": "OpenAI''s frontier open model. Strong general reasoning + writing. Pick over GPT-OSS 20B when quality matters more than speed.", "tags": [{"name": "frontier"}, {"name": "general"}, {"name": "reasoning"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- openai/gpt-oss-20b
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'openai/gpt-oss-20b',
  COALESCE((SELECT user_id FROM model WHERE id = 'openai/gpt-oss-20b'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'openai/gpt-oss-20b',
  'GPT-OSS 20B — fast Q&A',
  '{"profile_image_url": "/static/favicon.png", "description": "OpenAI''s small open model. Fast, low-latency. Best for quick Q&A, casual chat, classification, simple transforms.", "tags": [{"name": "fast"}, {"name": "small"}, {"name": "general"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- qwen/qwen3-coder-480b-a35b-instruct
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'qwen/qwen3-coder-480b-a35b-instruct',
  COALESCE((SELECT user_id FROM model WHERE id = 'qwen/qwen3-coder-480b-a35b-instruct'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'qwen/qwen3-coder-480b-a35b-instruct',
  'Qwen3 Coder 480B — coding',
  '{"profile_image_url": "/static/favicon.png", "description": "Coding-optimized 480B MoE. Best for: writing new code, debugging, multi-file refactors, code review, language migrations. Top choice for technical work that doesn''t need agent tools.", "tags": [{"name": "coding"}, {"name": "frontier"}, {"name": "moe"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);

-- z-ai/glm-5.1
INSERT OR REPLACE INTO model (id, user_id, base_model_id, name, meta, params, created_at, updated_at, is_active)
VALUES (
  'z-ai/glm-5.1',
  COALESCE((SELECT user_id FROM model WHERE id = 'z-ai/glm-5.1'), (SELECT id FROM user ORDER BY created_at LIMIT 1)),
  'z-ai/glm-5.1',
  'GLM-5.1 — Chinese / bilingual',
  '{"profile_image_url": "/static/favicon.png", "description": "ChatGLM frontier. Best for Chinese-language tasks, English-Chinese bilingual chat, translation. Strong reasoning in both languages.", "tags": [{"name": "multilingual"}, {"name": "chinese"}, {"name": "frontier"}], "capabilities": {"vision": false, "usage": true, "citations": true}}',
  '{}',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER),
  1
);
