'use strict';

/**
 * deepResearchService.js — Phase 6
 *
 * Grok-style multi-step research orchestrator. Takes a vague query, expands
 * into 4-8 diverse sub-queries (incl. site-scoped to LinkedIn / X / FB / GH),
 * parallel-searches via Serper, ranks + scrapes the top URLs, reflects on
 * gaps, iterates once more, then synthesizes a citation-rich report.
 *
 * Built on top of what we already have:
 *   • searchService.searchWeb (Serper)
 *   • scraperService.scrape    (tier-1 axios → tier-2 Playwright stealth)
 *   • Multi-provider LLM chain (Cerebras → Sambanova → Groq → OpenRouter)
 *
 * Total cost per research run: 4-6 LLM calls + 4-8 Serper calls + 6-12 scrapes
 * Wall-clock: typically 25-90s depending on site difficulty.
 */

const axios = require('axios');
const apiKeyManager = require('../utils/apiKeyManager');
const { searchWeb } = require('./searchService');
const scraperService = require('./scraperService');

// ── Multi-provider LLM helper (OpenAI-compatible) ───────────────────────────
// Mirrors the order of ChatFirstAvailable in stagehandService — but uses
// raw axios so we don't need browser-use's typed Message classes for these
// simple chat completions.

const PROVIDERS = [
  { name: 'cerebras',   url: 'https://api.cerebras.ai/v1/chat/completions',  model: () => process.env.CEREBRAS_MODEL  || 'gpt-oss-120b',                            keyEnv: 'CEREBRAS_API_KEY' },
  { name: 'sambanova',  url: 'https://api.sambanova.ai/v1/chat/completions', model: () => process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct',            keyEnv: 'SAMBANOVA_API_KEY' },
  { name: 'groq',       url: 'https://api.groq.com/openai/v1/chat/completions', model: () => 'llama-3.3-70b-versatile',                                            keyEnv: 'GROQ_API_KEY' },
  { name: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: () => process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free',             keyEnv: 'OPENROUTER_API_KEY', extraHeaders: { 'HTTP-Referer': 'https://github.com/chaka-ai', 'X-Title': 'Chaka AI' } },
];

const cooldowns = new Map(); // provider name → epoch ms when available again

// Resolve a provider's API key — prefer admin-managed (Turso config table
// via apiKeyManager) over env var, so keys rotate live without redeploy.
function _resolveKey(p) {
  try {
    const apiKeyManager = require('../utils/apiKeyManager');
    const adminKey = apiKeyManager.pickKey?.(p.name)?.key;
    if (adminKey) return adminKey;
  } catch {}
  return (process.env[p.keyEnv] || '').trim() || null;
}

async function callLlm(systemPrompt, userPrompt, opts = {}) {
  const now = Date.now();
  const withKeys = PROVIDERS.map(p => ({ ...p, _key: _resolveKey(p) })).filter(p => p._key);
  const available = withKeys.filter(p => (cooldowns.get(p.name) || 0) <= now);
  const tryOrder = available.length ? available : withKeys;
  if (!tryOrder.length) throw new Error('No LLM providers configured for research (set keys via Chaka Admin or env vars)');

  let lastErr;
  for (const p of tryOrder) {
    try {
      const resp = await axios.post(p.url, {
        model: p.model(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature: opts.temperature ?? 0.3,
        max_tokens:  opts.maxTokens   ?? 2048,
        ...(opts.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      }, {
        headers: {
          'Authorization': 'Bearer ' + p._key,
          'Content-Type':  'application/json',
          ...(p.extraHeaders || {}),
        },
        timeout: 50_000,
      });
      const content = resp.data.choices?.[0]?.message?.content || '';
      return { provider: p.name, content };
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 429) cooldowns.set(p.name, Date.now() + 60_000);
      else if (status === 503) cooldowns.set(p.name, Date.now() + 30_000);
      const errMsg = (e.response?.data?.error?.message || e.message || '').slice(0, 120);
      console.warn(`[research] ${p.name} failed (${status || 'no status'}): ${errMsg} → trying next`);
    }
  }
  throw new Error(`All LLM providers failed for research call: ${lastErr?.message}`);
}

// Robust JSON extraction (LLMs occasionally wrap in markdown / prose)
function safeJsonExtract(text, fallback = null) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return fallback;
}

// ── PHASE 1: Query expansion ────────────────────────────────────────────────

async function planSubQueries(query, onStatus) {
  onStatus?.({ type: 'planning', query });

  const system = `You are a research strategist. Given a user's research query, generate 4-8 diverse sub-queries that together will cover the topic comprehensively.

INCLUDE:
- The literal query
- Site-scoped variants if the topic is a person/company:
    "site:linkedin.com <name>" / "site:x.com <name>" / "site:facebook.com <name>" / "site:github.com <name>"
- Specific angles: background, recent activity, contact info, news, public records
- Alternative spellings / phrasings the target might appear under

Return ONLY a JSON object: {"queries": ["q1", "q2", ...]}. No prose, no markdown fence, no explanation.`;

  const user = `User's research query: "${query}"\n\nGenerate the JSON now.`;
  const { content, provider } = await callLlm(system, user, { responseFormat: 'json', temperature: 0.4, maxTokens: 1024 });

  const parsed = safeJsonExtract(content, { queries: [query] });
  const queries = (parsed.queries || [query]).slice(0, 8).map(q => String(q).trim()).filter(Boolean);
  onStatus?.({ type: 'queries_planned', queries, provider });
  return queries;
}

// ── PHASE 2: Parallel search ────────────────────────────────────────────────

async function searchAll(queries, onStatus) {
  const apiKey = apiKeyManager.keys?.find(k => k.type === 'search')?.key;
  if (!apiKey) {
    onStatus?.({ type: 'search_unavailable', message: 'No Serper search key configured' });
    return [];
  }

  const settled = await Promise.allSettled(queries.map(async (q) => {
    onStatus?.({ type: 'searching', query: q });
    try {
      const raw = await searchWeb(q, apiKey);
      // searchWeb returns the formatted text — extract URLs back out
      const urls = [...String(raw).matchAll(/Link:\s*(https?:\/\/[^\s\n]+)/gi)].map(m => m[1].replace(/[.,;:!?]+$/, ''));
      onStatus?.({ type: 'search_complete', query: q, hits: urls.length });
      return { query: q, urls };
    } catch (e) {
      onStatus?.({ type: 'search_failed', query: q, error: e.message.slice(0, 80) });
      return { query: q, urls: [] };
    }
  }));

  // Dedupe across sub-queries
  const seen = new Set();
  const unique = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const url of r.value.urls) {
      if (!seen.has(url)) {
        seen.add(url);
        unique.push({ url, foundBy: r.value.query });
      }
    }
  }
  return unique;
}

// ── PHASE 3: LLM-ranked relevance ───────────────────────────────────────────

async function rankUrls(originalQuery, urls, onStatus, maxKeep = 8) {
  if (urls.length <= maxKeep) return urls;
  onStatus?.({ type: 'ranking', candidate_count: urls.length });

  const system = `Rank URLs by relevance to a research query. Return ONLY a JSON object: {"ranked_indices": [0, 5, 2, ...]} — array of indices, most relevant first. No prose, no markdown.`;
  const urlList = urls.map((u, i) => `${i}: ${u.url} (found by: ${u.foundBy})`).join('\n');
  const user = `Research query: "${originalQuery}"\n\nCandidate URLs:\n${urlList}\n\nRank the indices, most relevant first. Top ${maxKeep}.`;

  try {
    const { content } = await callLlm(system, user, { responseFormat: 'json', maxTokens: 512, temperature: 0.1 });
    const parsed = safeJsonExtract(content);
    const indices = (parsed?.ranked_indices || []).slice(0, maxKeep);
    const ranked = indices.map(i => urls[i]).filter(Boolean);
    return ranked.length ? ranked : urls.slice(0, maxKeep);
  } catch (e) {
    console.warn('[research] rank failed:', e.message);
    return urls.slice(0, maxKeep);
  }
}

// ── PHASE 4: Parallel scrape with concurrency cap ───────────────────────────

async function scrapeAll(urls, onStatus, concurrency = 4) {
  const results = [];
  let running = 0;
  const queue = [...urls];

  return new Promise((resolve) => {
    function pump() {
      if (!queue.length && running === 0) return resolve(results);
      while (running < concurrency && queue.length) {
        const item = queue.shift();
        running++;
        onStatus?.({ type: 'scraping', url: item.url });
        scraperService.scrape(item.url, { useCache: true, ttl: 1800 })
          .then(r => {
            results.push({ ...item, content: r.content, title: r.title, wordCount: r.wordCount, error: null });
            onStatus?.({ type: 'source_added', url: item.url, title: r.title || item.url, words: r.wordCount });
          })
          .catch(err => {
            results.push({ ...item, content: null, title: null, wordCount: 0, error: err.message });
            onStatus?.({ type: 'scrape_failed', url: item.url, error: (err.message || '').slice(0, 100) });
          })
          .finally(() => { running--; pump(); });
      }
    }
    pump();
  });
}

// ── PHASE 5: Reflection — what's missing? ───────────────────────────────────

async function reflect(originalQuery, sources, onStatus) {
  onStatus?.({ type: 'reflecting' });
  const summary = sources.slice(0, 10).map(s => `- ${s.title || s.url} (${s.content ? s.wordCount + ' words' : 'FAILED'})`).join('\n');
  const system = `You are reviewing research progress. Given the original query and what we've scraped so far, identify INFORMATION GAPS and propose 0-3 follow-up sub-queries to close them.

If the existing sources comprehensively cover the query, return an empty queries array.

Return ONLY: {"gaps": "1-sentence summary of what's still missing or unclear", "queries": ["q1", "q2"]}`;
  const user = `Original query: "${originalQuery}"\n\nSources scraped so far:\n${summary}\n\nWhat gaps remain? Return JSON now.`;

  try {
    const { content } = await callLlm(system, user, { responseFormat: 'json', maxTokens: 512, temperature: 0.3 });
    const parsed = safeJsonExtract(content, { queries: [] });
    const newQueries = (parsed.queries || []).slice(0, 3).map(q => String(q).trim()).filter(Boolean);
    onStatus?.({ type: 'gaps_identified', gaps: parsed.gaps || '', follow_up_queries: newQueries });
    return newQueries;
  } catch (e) {
    console.warn('[research] reflect failed:', e.message);
    return [];
  }
}

// ── PHASE 6: Synthesis with inline citations ────────────────────────────────

async function synthesize(originalQuery, sources, onStatus) {
  onStatus?.({ type: 'synthesizing' });
  const valid = sources.filter(s => s.content && s.content.length > 100);

  if (!valid.length) {
    return {
      report: '> No usable sources were found for this query. The web searches returned results but every page either failed to load or returned no meaningful content. Consider rephrasing the query or trying again later.',
      sources: [],
      provider: null,
    };
  }

  // Build citation-numbered context, capping each source to avoid token blowup
  const numbered = valid.slice(0, 12);
  const contextBlocks = numbered.map((s, i) => {
    const num = i + 1;
    const excerpt = (s.content || '').slice(0, 2500);
    return `[${num}] ${s.title || s.url}\nURL: ${s.url}\nCONTENT:\n${excerpt}\n---`;
  }).join('\n\n');

  const system = `You are a senior research analyst. Given a research query and source materials, write a comprehensive, well-organized answer with INLINE CITATIONS in [1] [2] [3] format referring to the source numbers provided.

STRUCTURE:
- **TL;DR** — 2-3 sentence direct answer
- **Detailed findings** — markdown headings + bullets, every factual claim cited [N]
- **Key facts** — bulleted list of concrete data points with citations
- **Uncertainties** — explicitly flag what's unclear, contradicted between sources, or missing

RULES:
- Cite EVERY factual claim with [N] (one or multiple). Synthesis without citations is not allowed.
- If two sources contradict, mention both ("source [3] says X but [5] says Y").
- If the sources don't actually answer the query, say so honestly — don't fabricate.
- Use markdown (headings ##, bold **x**, bullets -, links).
- Be thorough but readable — typical length: 400-800 words.`;

  const user = `Research query: "${originalQuery}"\n\nNumbered sources:\n\n${contextBlocks}\n\nWrite the report now. Every factual claim must end with [N] citations.`;

  const { content, provider } = await callLlm(system, user, { temperature: 0.3, maxTokens: 3500 });

  return {
    report: content,
    sources: numbered.map((s, i) => ({ n: i + 1, url: s.url, title: s.title || s.url, foundBy: s.foundBy, words: s.wordCount })),
    provider,
  };
}

// ── MAIN entry point ────────────────────────────────────────────────────────

/**
 * Run deep research. Streams progress via onStatus callback.
 *
 * @param {string} query — the user's research request
 * @param {Object} opts
 * @param {(event) => void} opts.onStatus — SSE-style event stream
 * @param {number} opts.maxIterations    — reflection rounds (default 2)
 * @param {number} opts.maxSourcesPerIter — top URLs to scrape per round (default 8)
 * @param {AbortSignal} opts.signal      — abort handle
 */
async function deepResearch(query, opts = {}) {
  const {
    onStatus,
    maxIterations    = 2,
    maxSourcesPerIter = 8,
    signal,
  } = opts;
  const startedAt = Date.now();
  const aborted = () => signal?.aborted;

  onStatus?.({ type: 'start', query });

  // Phase 1: query expansion
  let pendingQueries = await planSubQueries(query, onStatus);
  if (aborted()) throw new Error('Research cancelled');

  // Iteration loop
  const allSources = [];
  for (let iter = 0; iter < maxIterations; iter++) {
    if (aborted()) throw new Error('Research cancelled');
    if (!pendingQueries.length) break;

    onStatus?.({ type: 'iteration_start', n: iter + 1, max: maxIterations, queries: pendingQueries });

    const searchResults = await searchAll(pendingQueries, onStatus);
    if (aborted()) throw new Error('Research cancelled');

    const ranked = await rankUrls(query, searchResults, onStatus, maxSourcesPerIter);
    if (aborted()) throw new Error('Research cancelled');

    const scraped = await scrapeAll(ranked, onStatus);
    allSources.push(...scraped);

    if (iter < maxIterations - 1) {
      pendingQueries = await reflect(query, allSources, onStatus);
      if (!pendingQueries.length) {
        onStatus?.({ type: 'no_more_gaps' });
        break;
      }
    }
  }

  // Phase 6: synthesis
  const result = await synthesize(query, allSources, onStatus);
  const elapsedMs = Date.now() - startedAt;

  onStatus?.({
    type: 'research_done',
    elapsedMs,
    source_count: result.sources.length,
    provider: result.provider,
  });

  return {
    query,
    report: result.report,
    sources: result.sources,
    elapsedMs,
    provider: result.provider,
  };
}

module.exports = { deepResearch, callLlm, safeJsonExtract };
