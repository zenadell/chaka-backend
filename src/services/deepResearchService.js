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

// ── PHASE 1: Query expansion with USER-CONTEXT injection ────────────────────

async function planSubQueries(query, opts = {}) {
  const { onStatus, userContext = '', depth = 0 } = opts;
  onStatus?.({ type: 'planning', query, depth });

  const ctxBlock = userContext
    ? `\n\n══════ WHO IS ASKING (CRITICAL — read carefully before generating queries) ══════\n${userContext}\n══════════════════════════════════════════════════════════════════════════════\n`
    : '';

  // HARD-RULE prompt — the bug we hit: LLM had user context but still generated
  // generic site-scoped queries instead of pivoting to the asker's known
  // affiliations. The rules below FORCE cross-referencing.
  const system = `You are a research strategist. Given a research query AND context about who is asking, generate 5-8 diverse sub-queries that together find the target with high precision.${ctxBlock}
🚨 CROSS-REFERENCE RULES — if WHO IS ASKING context is present:

Step 1: Extract from the context: asker_name(s), asker_companies, asker_projects, asker_websites, asker_aliases.

Step 2: Check if the target name in the query is SIMILAR to any asker_name or asker_alias (matches on first/middle/last name, nickname, cultural variant, initials). If YES → the asker is probably researching THEMSELVES or someone closely tied to them. You MUST include:
  • <target_name> <asker_company>          (e.g. "Ezinna Nweke jomiez")
  • <target_name> <asker_project>          (e.g. "Ezinna Nweke Chaka AI")
  • site:<asker_website> <target_name>     (e.g. "site:jomiez.com Ezinna")
  • <asker_known_name> <target_name>       (e.g. "Tim Temple Ezinna Nweke")
  • <asker_known_name> <asker_project>     (e.g. "Tim Temple Chaka AI")  ← finds the asker directly
  • <target_first> <target_last> founder OR creator OR CEO   (catches role-based mentions)

Step 3: ALSO include the standard generic queries:
  • The literal query
  • site:linkedin.com / site:x.com / site:facebook.com / site:github.com / site:instagram.com (with the target name)
  • <target_name> background OR education OR career

EXAMPLE — given context "Asker = Tim Temple, founder of Jomiez, built Chaka AI, jomiez.com" and query "find Ezinna Emmanuel Nweke":
{"queries": [
  "Tim Temple Jomiez founder",
  "Ezinna Emmanuel Nweke jomiez",
  "site:jomiez.com Ezinna Emmanuel",
  "Tim Temple Chaka AI creator",
  "Ezinna Nweke Chaka AI founder",
  "site:linkedin.com Ezinna Emmanuel Nweke",
  "site:github.com Ezinna Nweke",
  "Ezinna Emmanuel Nweke Nigeria software"
]}

If NO user context is present, just do the standard generic queries (literal query + site-scoped variants + background angle).

Return ONLY a JSON object: {"queries": ["q1", "q2", ...]}. No prose, no markdown fence, no explanation. 5-8 queries.`;

  const user = `User's research query: "${query}"\n\nGenerate the JSON now. Apply the CROSS-REFERENCE RULES above if context is present.`;
  const { content, provider } = await callLlm(system, user, { responseFormat: 'json', temperature: 0.4, maxTokens: 1024 });

  const parsed = safeJsonExtract(content, { queries: [query] });
  const queries = (parsed.queries || [query]).slice(0, 8).map(q => String(q).trim()).filter(Boolean);
  onStatus?.({ type: 'queries_planned', queries, provider });
  return queries;
}

// ── PHASE 2: Multi-engine search (Tavily + Exa + Linkup + Serper) ───────────

async function searchAll(queries, onStatus) {
  const { multiSearch, status: searchStatus } = require('./searchEngines');
  const stat = searchStatus();
  const active = Object.entries(stat).filter(([_, on]) => on).map(([n]) => n);
  if (!active.length) {
    onStatus?.({ type: 'search_unavailable', message: 'No search providers configured (add Tavily/Exa/Linkup/Serper key via Chaka Admin)' });
    return [];
  }

  const settled = await Promise.allSettled(queries.map(async (q) => {
    onStatus?.({ type: 'searching', query: q });
    const out = await multiSearch(q, { maxResults: 8 });
    onStatus?.({ type: 'search_complete', query: q, hits: out.results.length, providers: out.providers_used });
    return { query: q, results: out.results };
  }));

  // Aggregate + dedupe URL across all sub-queries; track which queries found each
  const map = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value.results) {
      if (!item.url) continue;
      const key = item.url.replace(/#.*$/, '').replace(/\/$/, '');
      const existing = map.get(key);
      if (existing) {
        if (!existing.foundBy.includes(r.value.query)) existing.foundBy.push(r.value.query);
        if ((item.snippet || '').length > (existing.snippet || '').length) existing.snippet = item.snippet;
        for (const s of item.sources || []) if (!existing.sources.includes(s)) existing.sources.push(s);
      } else {
        map.set(key, {
          url: item.url,
          title: item.title || key,
          snippet: item.snippet || '',
          sources: [...(item.sources || [])],
          foundBy: [r.value.query],
        });
      }
    }
  }
  return Array.from(map.values());
}

// ── PHASE 3: LLM-ranked relevance ───────────────────────────────────────────

async function rankUrls(originalQuery, urls, onStatus, maxKeep = 8) {
  if (urls.length <= maxKeep) return urls;
  onStatus?.({ type: 'ranking', candidate_count: urls.length });

  // Pre-sort by snippet richness + multi-engine confirmation (cheap heuristic)
  // — multi-engine hits are way more likely to be relevant than single-source.
  const preSorted = [...urls].sort((a, b) => {
    const aLen = a.snippet?.length || 0, bLen = b.snippet?.length || 0;
    const aS = (a.sources?.length || 1) * 3 + Math.min(aLen / 400, 3) + (a.foundBy?.length || 1);
    const bS = (b.sources?.length || 1) * 3 + Math.min(bLen / 400, 3) + (b.foundBy?.length || 1);
    return bS - aS;
  });

  // Then LLM-rerank the top 20 by actual query relevance — using snippets, not just URLs
  const candidates = preSorted.slice(0, Math.min(20, preSorted.length));
  const system = `Rank URLs by relevance to a research query. Return ONLY a JSON object: {"ranked_indices": [0, 5, 2, ...]} — array of indices, most relevant first. No prose, no markdown.`;
  const urlList = candidates.map((u, i) =>
    `${i}: ${u.url}\n   title: ${(u.title || '').slice(0, 100)}\n   snippet: ${(u.snippet || '').slice(0, 220)}\n   engines: ${(u.sources || []).join(',')}`
  ).join('\n');
  const user = `Research query: "${originalQuery}"\n\nCandidate URLs:\n${urlList}\n\nRank by relevance, most relevant first. Return the top ${maxKeep} indices.`;

  try {
    const { content } = await callLlm(system, user, { responseFormat: 'json', maxTokens: 512, temperature: 0.1 });
    const parsed = safeJsonExtract(content);
    const indices = (parsed?.ranked_indices || []).slice(0, maxKeep);
    const ranked = indices.map(i => candidates[i]).filter(Boolean);
    return ranked.length ? ranked : candidates.slice(0, maxKeep);
  } catch (e) {
    console.warn('[research] rank failed:', e.message);
    return candidates.slice(0, maxKeep);
  }
}

// ── NEW PHASE 4.5: Learning extraction per source ───────────────────────────
// For each scraped page, ask the LLM to extract ATOMIC FACTS + follow-up
// questions. This is the key dzhng/deep-research pattern — instead of dumping
// raw content into synthesis at the end, we build a structured knowledge
// graph as we go, and the recursion uses follow-up questions to deepen.

async function extractLearnings(source, originalQuery, onStatus) {
  if (!source.content || source.content.length < 200) return null;

  const system = `You are a research analyst extracting ATOMIC LEARNINGS from a single source.

Given the research query and the source content, return ONLY a JSON object:
{
  "learnings": ["fact 1 — concrete, specific, supported by this source", "fact 2", ...],
  "follow_up_questions": ["q1 — a question this source raises but doesn't fully answer", "q2"]
}

RULES:
- Each learning must be ONE atomic fact, directly supported by the source. No vague statements.
- 0-5 learnings per source. Quality over quantity. If the source doesn't address the query, return empty arrays.
- Follow-up questions should be specific things this source mentions but doesn't fully explain.
- 0-3 follow-ups.
- No citations in the learning text itself — the system tracks which source it came from.`;

  const user = `Research query: "${originalQuery}"\n\nSource: ${source.title || source.url}\nURL: ${source.url}\n\nContent (first 4000 chars):\n${(source.content || '').slice(0, 4000)}\n\nExtract the JSON now.`;

  try {
    const { content } = await callLlm(system, user, { responseFormat: 'json', maxTokens: 1024, temperature: 0.2 });
    const parsed = safeJsonExtract(content, { learnings: [], follow_up_questions: [] });
    const learnings = (parsed.learnings || []).slice(0, 5).map(String).map(s => s.trim()).filter(Boolean);
    const followUps = (parsed.follow_up_questions || []).slice(0, 3).map(String).map(s => s.trim()).filter(Boolean);
    onStatus?.({ type: 'learnings_extracted', url: source.url, learnings_count: learnings.length, followups_count: followUps.length });
    return { learnings, followUps };
  } catch (e) {
    console.warn('[research] learning extraction failed:', e.message);
    return null;
  }
}

// ── PHASE 4: Parallel scrape with concurrency cap ───────────────────────────
// For walled-garden domains (LinkedIn, X, FB, IG) where a live scrape just
// returns the login page, USE THE SEARCH-ENGINE SNIPPET AS THE CONTENT.
// Google/Tavily/Exa pre-cache the public-side preview of these profiles —
// the snippet is way more useful than the "Sign Up | LinkedIn" wall.

// Domains where live HTTP scrape will hit a login wall. Use search snippet instead.
const WALLED_DOMAINS = new Set([
  'linkedin.com', 'www.linkedin.com',
  'x.com', 'twitter.com', 'mobile.twitter.com',
  'facebook.com', 'www.facebook.com', 'm.facebook.com',
  'instagram.com', 'www.instagram.com',
  'tiktok.com', 'www.tiktok.com',
  'threads.net', 'www.threads.net',
  'medium.com', // paywall on most articles
  'indeed.com', 'www.indeed.com',
  'glassdoor.com', 'www.glassdoor.com',
]);

function isWalled(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Also catch subdomains like "co.linkedin.com" or "ng.linkedin.com"
    return WALLED_DOMAINS.has(host) ||
      [...WALLED_DOMAINS].some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

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

        // SHORT-CIRCUIT walled-garden URLs: use the snippet as content.
        // This is the LinkedIn/X/FB unlock — the snippet contains the actual
        // public-side data Google + Tavily already harvested.
        if (isWalled(item.url) && item.snippet && item.snippet.length > 60) {
          const snippetContent = `[NOTE: This is the public search-engine preview of ${item.url} — the live page requires login. The following is the cached public summary.]\n\n${item.snippet}`;
          results.push({
            ...item,
            content: snippetContent,
            title: item.title || item.url,
            wordCount: item.snippet.split(/\s+/).length,
            error: null,
            via: 'search_snippet',
          });
          onStatus?.({
            type: 'source_added',
            url: item.url,
            title: item.title || item.url,
            words: item.snippet.split(/\s+/).length,
            via: 'search_snippet',
          });
          running--;
          pump();
          continue;
        }

        // Normal path: live scrape via tier-1 axios → tier-2 Playwright
        onStatus?.({ type: 'scraping', url: item.url });
        scraperService.scrape(item.url, { useCache: true, ttl: 1800 })
          .then(r => {
            // If the live scrape returned a login wall but we have a snippet, fall back to snippet
            const isLoginWall = /sign\s*up\s*\|\s*linkedin|sign\s+in\s+to\s+(linkedin|facebook|twitter|x)|enable\s+javascript|please\s+log\s*in/i.test(r.title || '') && (r.wordCount || 0) < 150;
            if (isLoginWall && item.snippet && item.snippet.length > 60) {
              const snippetContent = `[NOTE: ${item.url} returned a login wall on live fetch — using cached search-engine preview instead.]\n\n${item.snippet}`;
              results.push({
                ...item,
                content: snippetContent,
                title: item.title || r.title,
                wordCount: item.snippet.split(/\s+/).length,
                error: null,
                via: 'snippet_fallback',
              });
              onStatus?.({ type: 'source_added', url: item.url, title: item.title || r.title, words: item.snippet.split(/\s+/).length, via: 'snippet_fallback' });
            } else {
              results.push({ ...item, content: r.content, title: r.title, wordCount: r.wordCount, error: null, via: r.tier || 'live' });
              onStatus?.({ type: 'source_added', url: item.url, title: r.title || item.url, words: r.wordCount, via: r.tier || 'live' });
            }
          })
          .catch(err => {
            // Scrape failed — fall back to snippet if we have one
            if (item.snippet && item.snippet.length > 60) {
              const snippetContent = `[NOTE: ${item.url} live fetch failed (${err.message.slice(0, 60)}) — using cached search-engine preview.]\n\n${item.snippet}`;
              results.push({
                ...item,
                content: snippetContent,
                title: item.title || item.url,
                wordCount: item.snippet.split(/\s+/).length,
                error: null,
                via: 'snippet_fallback',
              });
              onStatus?.({ type: 'source_added', url: item.url, title: item.title || item.url, words: item.snippet.split(/\s+/).length, via: 'snippet_fallback' });
            } else {
              results.push({ ...item, content: null, title: null, wordCount: 0, error: err.message });
              onStatus?.({ type: 'scrape_failed', url: item.url, error: (err.message || '').slice(0, 100) });
            }
          })
          .finally(() => { running--; pump(); });
      }
    }
    pump();
  });
}

// ── PHASE 6: Synthesis with inline citations + extracted learnings ─────────

async function synthesize(originalQuery, sources, learnings, onStatus, opts = {}) {
  onStatus?.({ type: 'synthesizing' });
  const valid = sources.filter(s => s.content && s.content.length > 100);

  if (!valid.length && !learnings.length) {
    return {
      report: '> No usable sources were found for this query. The web searches returned results but every page either failed to load or returned no meaningful content. Consider rephrasing the query, adding context about who or what specifically you mean, or trying again later.',
      sources: [],
      provider: null,
    };
  }

  // Build citation-numbered source set (cap at 14)
  const numbered = valid.slice(0, 14);
  const urlToNum = new Map(numbered.map((s, i) => [s.url, i + 1]));

  // Build numbered learnings — each tagged with its source citation
  const numberedLearnings = learnings
    .filter(l => urlToNum.has(l.sourceUrl))
    .map(l => `- ${l.text} [${urlToNum.get(l.sourceUrl)}]`)
    .join('\n');

  // Build context blocks, capped per source to avoid token blowup
  const contextBlocks = numbered.map((s, i) => {
    const num = i + 1;
    const excerpt = (s.content || '').slice(0, 2200);
    const foundByStr = Array.isArray(s.foundBy) ? s.foundBy.join(' | ') : (s.foundBy || '');
    const enginesStr = (s.sources || []).join(',');
    return `[${num}] ${s.title || s.url}\nURL: ${s.url}\nFOUND_BY_QUERIES: ${foundByStr}\nSEARCH_ENGINES: ${enginesStr}\nCONTENT:\n${excerpt}\n---`;
  }).join('\n\n');

  const ctxBlock = opts.userContext
    ? `\n\nCONTEXT — WHO IS ASKING (use to disambiguate identity matches):\n${opts.userContext}\n`
    : '';

  const system = `You are a senior research analyst. Given a research query, extracted learnings, and source materials, write a comprehensive citation-rich report.${ctxBlock}
STRUCTURE:
- **TL;DR** — 2-3 sentence direct answer that resolves the query
- **Detailed findings** — markdown headings + bullets, every factual claim cited [N]
- **Key facts** — bulleted list of concrete data points with citations
- **Identity / match confidence** — if this is a person/company discovery query, EXPLICITLY say whether sources match the target with high/medium/low confidence + what would increase confidence
- **Uncertainties** — flag what's unclear, contradicted between sources, or missing

RULES:
- Cite EVERY factual claim with [N]. Synthesis without citations is not allowed.
- If sources contradict, mention both ("source [3] says X but [5] says Y").
- If sources don't answer the query, say so honestly — don't fabricate.
- The pre-extracted LEARNINGS are higher-confidence than raw content — lean on them first.
- Use markdown (## headings, **bold**, - bullets, [links](url)).
- Thorough but readable. Typical length 400-1000 words.`;

  const user = `Research query: "${originalQuery}"\n\nPRE-EXTRACTED LEARNINGS (atomic facts from individual sources):\n${numberedLearnings || '(none — rely on raw source content)'}\n\nNUMBERED SOURCES:\n\n${contextBlocks}\n\nWrite the report now. Every factual claim must end with [N] citations.`;

  const { content, provider } = await callLlm(system, user, { temperature: 0.3, maxTokens: 4000 });

  return {
    report: content,
    sources: numbered.map((s, i) => ({
      n: i + 1,
      url: s.url,
      title: s.title || s.url,
      foundBy: Array.isArray(s.foundBy) ? s.foundBy.join(', ') : s.foundBy,
      words: s.wordCount,
      engines: s.sources,
    })),
    provider,
  };
}

// ── MAIN entry point — recursive breadth + depth tree search ────────────────
// Inspired by dzhng/deep-research (MIT, 19k★). Re-implemented from scratch
// against our multi-provider LLM router + multi-engine search + our scraper.
//
// Algorithm per branch:
//   1. Plan N sub-queries (breadth)
//   2. Search all sub-queries in parallel across all configured engines
//   3. Dedupe + rank by snippet richness × multi-engine confirmation
//   4. Scrape top K with concurrency=4
//   5. For each scraped page, extract atomic learnings + follow-up questions
//   6. If depth > 0, recurse on follow-ups (parallel, breadth halved)
// Final: synthesize all accumulated learnings + sources into citation-rich report.

/**
 * @param {string} query
 * @param {Object} opts
 * @param {Function} opts.onStatus       — SSE-style event stream
 * @param {string}   opts.userContext    — who's asking, for disambiguation
 * @param {number}   opts.breadth        — sub-queries per branch (default 5, top-level)
 * @param {number}   opts.depth          — recursion depth (default 2 levels)
 * @param {number}   opts.maxSourcesPerBranch — top URLs to scrape per branch (default 5)
 * @param {AbortSignal} opts.signal      — abort handle
 * Legacy options preserved for backward compat:
 * @param {number}   opts.maxIterations   — mapped to depth
 * @param {number}   opts.maxSourcesPerIter — mapped to maxSourcesPerBranch
 */
async function deepResearch(query, opts = {}) {
  const {
    onStatus,
    userContext = '',
    signal,
    breadth = 5,
    depth = 2,
    maxSourcesPerBranch = 5,
    maxIterations,
    maxSourcesPerIter,
  } = opts;

  const effDepth  = (maxIterations    != null) ? maxIterations    : depth;
  const effBranch = (maxSourcesPerIter != null) ? maxSourcesPerIter : maxSourcesPerBranch;

  const startedAt = Date.now();
  const aborted = () => signal?.aborted;

  onStatus?.({
    type: 'start',
    query,
    breadth,
    depth: effDepth,
    has_user_context: Boolean(userContext),
  });

  // Tree-wide accumulators (dedupe across the whole tree)
  const allSources    = new Map();   // url → source object
  const allLearnings  = [];          // [{ text, sourceUrl }]
  const visitedQueries = new Set();  // skip identical branches

  async function exploreBranch(branchQuery, depthRemaining) {
    if (aborted()) return;
    const normalized = branchQuery.trim().toLowerCase();
    if (visitedQueries.has(normalized)) return;
    visitedQueries.add(normalized);

    onStatus?.({ type: 'branch_start', query: branchQuery, depth_remaining: depthRemaining });

    // 1. Plan
    const queries = await planSubQueries(branchQuery, { onStatus, userContext, depth: depthRemaining });
    if (aborted()) return;

    // 2. Search
    const searched = await searchAll(queries, onStatus);
    if (aborted()) return;
    if (!searched.length) return;

    // 3. Rank
    const ranked = await rankUrls(branchQuery, searched, onStatus, effBranch);
    if (aborted()) return;

    // 4. Skip URLs we already scraped
    const newUrls = ranked.filter(r => !allSources.has(r.url));

    // 5. Scrape new URLs in parallel (concurrency=4 via scrapeAll)
    const scraped = await scrapeAll(newUrls, onStatus, 4);
    if (aborted()) return;

    const successfulSources = [];
    for (const s of scraped) {
      if (s.content && s.content.length > 100) {
        allSources.set(s.url, s);
        successfulSources.push(s);
      }
    }

    // 6. Extract atomic learnings + follow-up questions per source (parallel)
    const learningResults = await Promise.allSettled(
      successfulSources.map(s => extractLearnings(s, branchQuery, onStatus))
    );

    const followUps = [];
    for (let i = 0; i < successfulSources.length; i++) {
      const r = learningResults[i];
      if (r.status !== 'fulfilled' || !r.value) continue;
      for (const text of r.value.learnings || []) {
        allLearnings.push({ text, sourceUrl: successfulSources[i].url });
      }
      for (const fq of r.value.followUps || []) followUps.push(fq);
    }

    // 7. Recurse on follow-ups (if depth budget remains)
    if (depthRemaining > 0 && followUps.length) {
      // Dedupe, cap, lowercase-compare against visited
      const unique = [...new Set(followUps.map(f => f.trim()))]
        .filter(f => f && !visitedQueries.has(f.toLowerCase()))
        .slice(0, Math.max(2, Math.ceil(breadth / 2)));
      if (unique.length) {
        onStatus?.({ type: 'recursing', from_query: branchQuery, follow_ups: unique, depth_remaining: depthRemaining - 1 });
        await Promise.allSettled(unique.map(fq => exploreBranch(fq, depthRemaining - 1)));
      }
    }
  }

  // Run the root branch
  await exploreBranch(query, effDepth);

  if (aborted()) throw new Error('Research cancelled');

  // Final synthesis from accumulated sources + learnings
  const sourcesArr = Array.from(allSources.values());
  const result = await synthesize(query, sourcesArr, allLearnings, onStatus, { userContext });
  const elapsedMs = Date.now() - startedAt;

  onStatus?.({
    type: 'research_done',
    elapsedMs,
    source_count: result.sources.length,
    learning_count: allLearnings.length,
    queries_explored: visitedQueries.size,
    provider: result.provider,
  });

  return {
    query,
    report: result.report,
    sources: result.sources,
    learnings: allLearnings,
    queries_explored: visitedQueries.size,
    elapsedMs,
    provider: result.provider,
  };
}

module.exports = { deepResearch, callLlm, safeJsonExtract, extractLearnings, planSubQueries };
