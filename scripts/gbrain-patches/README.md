<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# gbrain patches (vendored)

Files in this directory overlay the upstream gbrain source after `bun add 'github:tantodefi/gbrain'` runs in the Dockerfile (see the gbrain install step). They make gbrain's embedder configurable via env vars so the same binary can target the OpenAI default *or* an NVIDIA NIM endpoint without forking.

## What the upstream version hardcodes

`gbrain` v0.14.x ships with `text-embedding-3-large` at 1536 dimensions baked in:

- `src/core/embedding.ts:12` — `const MODEL = 'text-embedding-3-large'`, `const DIMENSIONS = 1536`. The `embed_model` field in `~/.gbrain/config.json` is **never read**.
- `src/core/pglite-schema.ts:51` — `embedding vector(1536)` in the DDL string.

`integrate.api.nvidia.com` does not serve `text-embedding-3-large`, and NVIDIA's embed-qa models return 1024 / 2048 dims (not 1536). The unpatched gbrain therefore can't talk to NVIDIA NIM at all.

## What the patches change

| File | Change |
|---|---|
| `embedding.ts` | `MODEL` / `DIMENSIONS` / `INPUT_TYPE` / `PASS_DIMENSIONS` read from env at module load. `OpenAI` SDK still picks up `OPENAI_BASE_URL` / `OPENAI_API_KEY` directly. |
| `pglite-schema.ts` | `vector(N)` and `embedding_dimensions` row read `GBRAIN_EMBED_DIMENSIONS` at module load; default unchanged at 1536. |

Behavior with no env vars set: identical to upstream (`text-embedding-3-large` @ 1536 against the OpenAI default endpoint).

## Env vars the patched gbrain reads

Read by `gbrain-wrapper.sh` from `/sandbox/.gbrain/config.json` and exported before exec:

| Env var | Config field | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | `openai_api_key` | (none — wrapper falls back to `unused`) | OpenAI SDK refuses to construct a client without this even when the endpoint doesn't auth. |
| `OPENAI_BASE_URL` | `openai_base_url` | `https://api.openai.com/v1` | Set to `https://integrate.api.nvidia.com/v1` for NVIDIA NIM. |
| `GBRAIN_EMBED_MODEL` | `embed_model` | `text-embedding-3-large` | NIM model id, e.g. `nvidia/llama-3.2-nv-embedqa-1b-v2`. |
| `GBRAIN_EMBED_DIMENSIONS` | `embed_dimensions` | `1536` | Must match what the chosen model returns. **Schema column is sized at `gbrain init` time** — changing this after init requires a fresh brain. |
| `GBRAIN_EMBED_INPUT_TYPE` | `embed_input_type` | (unset) | NIM-only. `passage` for indexing, `query` for retrieval. We use `passage` because gbrain's embed signature doesn't distinguish — query-time embeds are slightly miscoded but still rank well. |
| `GBRAIN_EMBED_PASS_DIMENSIONS` | (none) | `true` | Set to `false` for fixed-dim NIM models that reject the `dimensions` param. |

## How the overlay is applied

The Dockerfile copies these files over the upstream sources in `/usr/local/lib/gbrain/node_modules/gbrain/src/core/` *after* `bun add` runs:

```Dockerfile
COPY scripts/gbrain-patches/embedding.ts \
     /usr/local/lib/gbrain/node_modules/gbrain/src/core/embedding.ts
COPY scripts/gbrain-patches/pglite-schema.ts \
     /usr/local/lib/gbrain/node_modules/gbrain/src/core/pglite-schema.ts
```

Hot-deploy for an already-running sandbox without rebuilding the image:

```bash
docker exec openshell-cluster-nemoclaw kubectl exec -n openshell chad -- sh -c "
  cat > /usr/local/lib/gbrain/node_modules/gbrain/src/core/embedding.ts
  cat > /usr/local/lib/gbrain/node_modules/gbrain/src/core/pglite-schema.ts
" < scripts/gbrain-patches/embedding.ts < scripts/gbrain-patches/pglite-schema.ts
```

(in practice base64 + sequential exec — see `npm run chad:setup`).

## Keeping the overlay in sync with upstream

When bumping the gbrain version pinned in `Dockerfile`:

1. Read the new upstream `src/core/embedding.ts` and `src/core/pglite-schema.ts`.
2. If upstream renamed `MODEL` / `DIMENSIONS` / restructured `embedBatchWithRetry`, port the same env-var hooks into the new shape.
3. If upstream gains native `embed_model` config support, **delete this overlay** — the patches become unnecessary.
4. Run `npm run chad:setup` and verify `gbrain put` + `gbrain query` still work end-to-end.

The upstream behavior with no env vars is preserved by design, so the patch is safe to ship even if a downstream user prefers the OpenAI default.
