// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Defaults: OpenAI text-embedding-3-large at 1536 dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 *
 * Override via env (set at gbrain wrapper start):
 *   GBRAIN_EMBED_MODEL        — model name (default text-embedding-3-large)
 *   GBRAIN_EMBED_DIMENSIONS   — vector size (default 1536; must match schema)
 *   GBRAIN_EMBED_INPUT_TYPE   — NIM-only: "passage" | "query" (sent if set)
 *   GBRAIN_EMBED_PASS_DIMENSIONS — "false" to skip the dimensions param for
 *                                   providers that don't accept it (default: send)
 *   OPENAI_BASE_URL / OPENAI_API_KEY — picked up by the OpenAI SDK directly
 */

import OpenAI from 'openai';

const MODEL = process.env.GBRAIN_EMBED_MODEL || 'text-embedding-3-large';
const DIMENSIONS = parseInt(process.env.GBRAIN_EMBED_DIMENSIONS || '1536', 10);
const INPUT_TYPE = process.env.GBRAIN_EMBED_INPUT_TYPE || '';
const PASS_DIMENSIONS = (process.env.GBRAIN_EMBED_PASS_DIMENSIONS || 'true') !== 'false';
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const params: Record<string, unknown> = {
        model: MODEL,
        input: texts,
      };
      if (PASS_DIMENSIONS) params.dimensions = DIMENSIONS;
      if (INPUT_TYPE) params.input_type = INPUT_TYPE;
      const response = await getClient().embeddings.create(
        params as Parameters<OpenAI['embeddings']['create']>[0]
      );

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      // Check for rate limit with Retry-After header
      let delay = exponentialDelay(attempt);

      if (e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            delay = parsed * 1000;
          }
        }
      }

      await sleep(delay);
    }
  }

  // Should not reach here
  throw new Error('Embedding failed after all retries');
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };
