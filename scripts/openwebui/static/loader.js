// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// chad-shim — open-webui loader.js injection.
//
// open-webui 0.9.x doesn't render model.meta.description as a hover tooltip
// in the model dropdown. This script watches the DOM for model-picker items
// and sets a `title=` attribute (browser-native tooltip) from a baked-in
// id → description map.
//
// Also adds a small visual hint (cursor:help) on hover so users know to
// pause for the tooltip.

(function () {
  "use strict";

  // ── Bug workaround: open-webui 0.9.x's auth route does
  // `new URL(redirectPath)` which throws "Invalid URL" when redirectPath is
  // "//" (protocol-relative without host) or empty. The result is a blank
  // page after Cloudflare-Access SSO. Strip/normalize the bad redirect param
  // BEFORE the SPA mounts so the auth route gets either "/" or a real path.
  try {
    if (location.pathname === "/auth") {
      const params = new URLSearchParams(location.search);
      const redirect = params.get("redirect");
      if (redirect && (redirect === "//" || /^\/{2,}/.test(redirect) || redirect.startsWith("//"))) {
        params.set("redirect", "/");
        const fixed = location.pathname + "?" + params.toString() + location.hash;
        history.replaceState(null, "", fixed);
        console.log("[chad-tooltips] normalized broken auth redirect param: '" + redirect + "' → '/'");
      }
    }
    // Also clear any stale redirectPath in localStorage that's malformed
    try {
      const stale = localStorage.getItem("redirectPath");
      if (stale && (stale === "//" || /^\/{2,}/.test(stale))) {
        localStorage.setItem("redirectPath", "/");
        console.log("[chad-tooltips] normalized stale localStorage redirectPath: '" + stale + "' → '/'");
      }
    } catch (_) {}
  } catch (_) {}

  const DESCRIPTIONS = {
    "chad":
      "Local OpenClaw agent on the chad sandbox. Use when you want access to private data/context, long-term memory (gbrain), custom skills, agent orchestration, or anything that needs tools (read/edit/exec, web, browser, cron). Slower (~20s/turn) but full agent harness with workspace files baked in.",
    "nvidia/nemotron-3-super-120b-a12b":
      "Frontier general-purpose. 120B MoE / 12B active, NVIDIA's flagship for chat, reasoning, code, summarization. Same model Chad uses internally — pick this when you want raw inference without the agent wrapper.",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning":
      "Small + reasoning. 30B with chain-of-thought traces. Best for math, logic puzzles, step-by-step problem solving on a budget. Fast.",
    "meta/llama-3.3-70b-instruct":
      "Meta's frontier open model. Best general-purpose for writing, summarization, instruction-following, light code review. Reliable workhorse.",
    "meta/llama-3.1-405b-instruct":
      "Largest open Llama. Pick when you need maximum reasoning depth on hard, ambiguous problems. Slow cold start; not for quick chat.",
    "meta/llama-3.1-70b-instruct":
      "Mid-size Llama. Solid generalist when you don't need frontier — chat, drafting, summarization, simple code. Good speed/quality trade-off.",
    "mistralai/mixtral-8x22b-instruct-v0.1":
      "Mixture-of-experts. Strong at multilingual chat, creative writing, French/Spanish/German fluency. Fast for its size.",
    "google/gemma-3-27b-it":
      "Google's mid-size open model. Strong at writing, summarization, structured output. Tight, efficient — good for Q&A and explanation tasks.",
    "openai/gpt-oss-20b":
      "OpenAI's small open model. Fast, low-latency. Best for quick Q&A, casual chat, classification, simple transforms.",
    "openai/gpt-oss-120b":
      "OpenAI's frontier open model. Strong general reasoning + writing. Pick over GPT-OSS 20B when quality matters more than speed.",
    "microsoft/phi-4-multimodal-instruct":
      "Vision-capable. Pick this when you need to analyze images, diagrams, screenshots, or PDFs alongside text. Smaller than the giants but solid for multimodal tasks.",
    "qwen/qwen3-coder-480b-a35b-instruct":
      "Coding-optimized 480B MoE. Best for: writing new code, debugging, multi-file refactors, code review, language migrations. Top choice for technical work that doesn't need agent tools.",
    "z-ai/glm-5.1":
      "ChatGLM frontier. Best for Chinese-language tasks, English-Chinese bilingual chat, translation. Strong reasoning in both languages.",
    "minimaxai/minimax-m2.5":
      "MiniMax frontier. Strong at long-context document processing, creative writing, narrative generation. Pick when you have a lot of context to thread through.",
  };

  // Build a name-prefix → description map too, since open-webui shows the
  // display name in the dropdown (e.g. "Chad — agent · memory · tools") and
  // we want to match either by id or by the start of the name.
  const NAME_PREFIXES = {
    "Chad": DESCRIPTIONS["chad"],
    "Nemotron 3 Super": DESCRIPTIONS["nvidia/nemotron-3-super-120b-a12b"],
    "Nemotron 3 Nano": DESCRIPTIONS["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
    "Llama 3.3 70B": DESCRIPTIONS["meta/llama-3.3-70b-instruct"],
    "Llama 3.1 405B": DESCRIPTIONS["meta/llama-3.1-405b-instruct"],
    "Llama 3.1 70B": DESCRIPTIONS["meta/llama-3.1-70b-instruct"],
    "Mixtral": DESCRIPTIONS["mistralai/mixtral-8x22b-instruct-v0.1"],
    "Gemma": DESCRIPTIONS["google/gemma-3-27b-it"],
    "GPT-OSS 20B": DESCRIPTIONS["openai/gpt-oss-20b"],
    "GPT-OSS 120B": DESCRIPTIONS["openai/gpt-oss-120b"],
    "Phi-4": DESCRIPTIONS["microsoft/phi-4-multimodal-instruct"],
    "Qwen3 Coder": DESCRIPTIONS["qwen/qwen3-coder-480b-a35b-instruct"],
    "GLM-5.1": DESCRIPTIONS["z-ai/glm-5.1"],
    "MiniMax": DESCRIPTIONS["minimaxai/minimax-m2.5"],
  };

  function descriptionFor(text) {
    if (!text) return null;
    const trimmed = text.trim();
    // Direct id match
    if (DESCRIPTIONS[trimmed]) return DESCRIPTIONS[trimmed];
    // Display-name prefix match
    for (const prefix of Object.keys(NAME_PREFIXES)) {
      if (trimmed.startsWith(prefix)) return NAME_PREFIXES[prefix];
    }
    return null;
  }

  // Updates a tippy.js instance's content. open-webui's Tooltip.svelte attaches
  // tippy via `tippy(el, { content })`; tippy stores the instance on
  // `el._tippy`, exposing `.setContent()` for live updates.
  //
  // Virtualization caveat: open-webui's model dropdown uses windowed rendering
  // — when you scroll, the SAME DOM nodes get reused with different model
  // data. The patch marker is keyed on model id (data-value) so a recycled
  // row gets re-patched the moment its id changes.
  function patchTippyContent(el, newContent, modelId) {
    const inst = el && el._tippy;
    if (!inst) return false;
    const key = modelId + "|" + newContent.length;
    if (el.dataset.chadTippy === key) return false;
    inst.setContent(newContent);
    el.dataset.chadTippy = key;
    return true;
  }

  function annotate(item) {
    const modelId = item.getAttribute && item.getAttribute("data-value");
    if (!modelId) return;
    const desc = DESCRIPTIONS[modelId] || descriptionFor(modelId);
    if (!desc) return;

    // Re-patch all tippy descendants every time, keyed on modelId. open-webui
    // recycles row DOM nodes during virtualized scroll, so a row that was
    // showing model A may now show model B with the same _tippy instance —
    // we have to reset content based on the *current* data-value.
    let patched = 0;
    item.querySelectorAll("*").forEach((el) => {
      if (!el._tippy) return;
      const cur = el._tippy.props && el._tippy.props.content;
      // Replace any tippy that's the small label-side tooltip (short string).
      // Skip very long contents — those are description tippies we already
      // installed in a prior pass.
      if (typeof cur === "string" && cur.length < 400) {
        if (patchTippyContent(el, desc, modelId)) patched++;
      }
    });
    // Always sync the native title to the current model id so virtualized
    // recycling doesn't leave a stale tooltip.
    if (item.dataset.chadTitledFor !== modelId) {
      item.title = desc;
      item.style.cursor = "help";
      item.dataset.chadTitledFor = modelId;
    }
    return patched;
  }

  function scan(root) {
    if (!(root instanceof Element)) return;
    const sel = '[role="option"][data-value]';
    root.querySelectorAll(sel).forEach(annotate);
    if (root.matches && root.matches(sel)) annotate(root);
  }

  // Belt-and-suspenders: re-scan every 600ms while a dropdown is open. Cheap
  // (~14 buttons × 5 children × hashtable lookup) and survives any DOM-recycle
  // pattern the SPA throws at us.
  let pollHandle = null;
  function startPolling() {
    if (pollHandle) return;
    pollHandle = setInterval(() => {
      if (document.querySelector('[role="listbox"]')) scan(document.body);
    }, 600);
  }

  function start() {
    // Initial pass for any items already on the page
    scan(document.body);

    // Watch for new items as the user opens dropdowns
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => scan(n));
        if (m.type === "attributes" && m.target instanceof Element) annotate(m.target);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-value", "aria-label", "title", "data-model-id"],
    });

    // Polling fallback for virtualized scroll DOM-recycle
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // Diagnostic: log to console so you can verify the script is actually
  // running in the browser (DevTools → Console). Also exposes a small
  // helper window.chadTooltips.refresh() to re-scan if needed.
  window.chadTooltips = {
    descriptions: DESCRIPTIONS,
    refresh: () => scan(document.body),
    annotateAll: () => {
      let count = 0;
      const all = document.querySelectorAll("*");
      all.forEach((el) => {
        const before = el.dataset.chadTitled;
        annotate(el);
        if (el.dataset.chadTitled === "1" && before !== "1") count++;
      });
      console.log(`[chad-tooltips] annotated ${count} elements`);
      return count;
    },
  };
  console.log(
    "[chad-tooltips] loaded — " + Object.keys(DESCRIPTIONS).length +
    " models. Open the model picker and hover. Manual re-scan: chadTooltips.annotateAll()"
  );
})();
