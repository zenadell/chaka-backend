'use strict';

/**
 * searchEngines.js — Phase 6.5: Multi-API search aggregator
 *
 * The single biggest gap between our research engine and Grok-tier tools
 * is the search layer: Serper returns keyword links, but Tavily/Exa
 * return SYNTHESIZED PASSAGES from across the web — including cached
 * LinkedIn/X snippets that bypass login walls.
 *
 * This module fans a query out to all configured providers in parallel,
 * dedupes by URL, and returns a unified shape so the orchestrator can
 * stay engine-agnostic.
 *
 * Providers (all optional, graceful no-op without keys):
 *   • Tavily — purpose-built for AI research, returns clean passages
 *   • Exa.ai — semantic / neural search (concepts, not keywords)
 *   • Linkup — newer, claims direct LinkedIn passage access
 *   • Serper — Google search snippets (fallback)
 *
 * Keys are loaded from apiKeyManager (admin → Turso) first, env vars second.
 */

const axios = require('axios');
const apiKeyManager = require('../utils/apiKeyManager');

// Resolve a key by type — admin pool first, env fallback.
function _resolveKey(type, envName) {
  try {
    const k = apiKeyManager.pickKey?.(type)?.key;
    if (k) return k;
  } catch {}
  return (process.env[envName] || '').trim() || null;
}

// ── Tavily ──────────────────────────────────────────────────────────────────
async function searchTavily(query, opts = {}) {
  const key = _resolveKey('tavily', 'TAVILY_API_KEY');
  if (!key) return { provider: 'tavily', skipped: true, results: [] };
  try {
    const resp = await axios.post('https://api.tavily.com/search', {
      query,
      search_depth: opts.depth || 'advanced',
      max_results: opts.maxResults || 10,
      include_raw_content: true,
      include_answer: false,
    }, {
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    const results = (resp.data?.results || []).map(r => ({
      url: r.url,
      title: r.title,
      snippet: r.content || r.raw_content?.slice(0, 800) || '',
      score: r.score,
      source: 'tavily',
    }));
    return { provider: 'tavily', results };
  } catch (e) {
    return { provider: 'tavily', error: e.response?.data?.error || e.message, results: [] };
  }
}

// ── Exa.ai (semantic / neural search) ──────────────────────────────────────
async function searchExa(query, opts = {}) {
  const key = _resolveKey('exa', 'EXA_API_KEY');
  if (!key) return { provider: 'exa', skipped: true, results: [] };
  try {
    const resp = await axios.post('https://api.exa.ai/search', {
      query,
      numResults: opts.maxResults || 10,
      type: 'auto', // auto picks neural or keyword based on the query
      contents: {
        text: { maxCharacters: 1500 },
        // Highlights = token-efficient, query-focused excerpts. For "find a
        // person" queries these surface the exact relevant lines (incl. cached
        // LinkedIn/X passages), which sharpens ranking AND the walled-garden
        // snippet fallback in deepResearchService.
        highlights: { numSentences: 5, highlightsPerUrl: 3, query },
      },
    }, {
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    const results = (resp.data?.results || []).map(r => {
      // Lead the snippet with the query-focused highlights, then the page text.
      const hl = Array.isArray(r.highlights) ? r.highlights.join(' … ') : '';
      const snippet = [hl, r.text || r.snippet || ''].filter(Boolean).join('\n\n');
      return {
        url: r.url,
        title: r.title,
        snippet,
        score: r.score,
        publishedDate: r.publishedDate,
        source: 'exa',
      };
    });
    return { provider: 'exa', results };
  } catch (e) {
    return { provider: 'exa', error: e.response?.data?.message || e.message, results: [] };
  }
}

// ── Linkup ─────────────────────────────────────────────────────────────────
async function searchLinkup(query, opts = {}) {
  const key = _resolveKey('linkup', 'LINKUP_API_KEY');
  if (!key) return { provider: 'linkup', skipped: true, results: [] };
  try {
    const resp = await axios.post('https://api.linkup.so/v1/search', {
      q: query,
      depth: 'deep',
      outputType: 'sourcedAnswer',
    }, {
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 40_000,
    });
    const results = (resp.data?.sources || []).map(r => ({
      url: r.url,
      title: r.name || r.title || r.url,
      snippet: r.snippet || r.content || '',
      source: 'linkup',
    }));
    return { provider: 'linkup', results, answer: resp.data?.answer || null };
  } catch (e) {
    return { provider: 'linkup', error: e.response?.data?.error || e.message, results: [] };
  }
}

// ── Serper (existing, kept as a fallback / coverage diversifier) ───────────
async function searchSerper(query, opts = {}) {
  const key = _resolveKey('search', 'SERPER_API_KEY');
  if (!key) return { provider: 'serper', skipped: true, results: [] };
  try {
    const resp = await axios.post('https://google.serper.dev/search',
      { q: query, num: opts.maxResults || 10 },
      { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, timeout: 15_000 }
    );
    const results = (resp.data?.organic || []).map(r => ({
      url: r.link,
      title: r.title,
      snippet: r.snippet || '',
      source: 'serper',
    }));
    return { provider: 'serper', results };
  } catch (e) {
    return { provider: 'serper', error: e.response?.data?.error || e.message, results: [] };
  }
}

// ── Aggregator ─────────────────────────────────────────────────────────────
/**
 * Run a query across ALL configured providers in parallel, dedupe by URL,
 * merge snippets, and return a single ranked list.
 *
 * Ranking: prefer hits that appear in multiple providers (cross-validated),
 * then prefer Tavily/Exa over Serper (richer snippets).
 *
 * @returns {Promise<{ results, providers_used, providers_skipped, errors }>}
 */
async function multiSearch(query, opts = {}) {
  const tasks = [
    searchTavily(query, opts),
    searchExa(query, opts),
    searchLinkup(query, opts),
    searchSerper(query, opts),
  ];
  const settled = await Promise.allSettled(tasks);

  const providersUsed = [];
  const providersSkipped = [];
  const errors = [];
  const urlMap = new Map(); // url → { url, title, snippet, sources: [...] }

  for (const r of settled) {
    if (r.status !== 'fulfilled') {
      errors.push({ message: r.reason?.message || String(r.reason) });
      continue;
    }
    const { provider, results = [], skipped, error } = r.value;
    if (skipped) { providersSkipped.push(provider); continue; }
    if (error)   { errors.push({ provider, error }); }
    if (results.length) providersUsed.push(`${provider}(${results.length})`);

    for (const item of results) {
      if (!item.url) continue;
      const norm = item.url.replace(/#.*$/, '').replace(/\/$/, '');
      const existing = urlMap.get(norm);
      if (existing) {
        // Merge: keep richer snippet, track all sources
        if ((item.snippet || '').length > (existing.snippet || '').length) {
          existing.snippet = item.snippet;
        }
        if (!existing.sources.includes(item.source)) existing.sources.push(item.source);
        if (!existing.title && item.title) existing.title = item.title;
      } else {
        urlMap.set(norm, {
          url: item.url,
          title: item.title || norm,
          snippet: item.snippet || '',
          sources: [item.source],
          score: item.score,
        });
      }
    }
  }

  // Ranking heuristic: more sources = more confidence, then by snippet length
  const PROVIDER_WEIGHTS = { tavily: 3, exa: 3, linkup: 2.5, serper: 1 };
  const ranked = Array.from(urlMap.values()).map(r => ({
    ...r,
    _rank: r.sources.reduce((acc, s) => acc + (PROVIDER_WEIGHTS[s] || 1), 0)
             + Math.min((r.snippet?.length || 0) / 500, 2),
  })).sort((a, b) => b._rank - a._rank);

  return {
    results: ranked,
    providers_used: providersUsed,
    providers_skipped: providersSkipped,
    errors,
  };
}

// ── Status — what's configured ─────────────────────────────────────────────
function status() {
  return {
    tavily:  Boolean(_resolveKey('tavily',  'TAVILY_API_KEY')),
    exa:     Boolean(_resolveKey('exa',     'EXA_API_KEY')),
    linkup:  Boolean(_resolveKey('linkup',  'LINKUP_API_KEY')),
    serper:  Boolean(_resolveKey('search',  'SERPER_API_KEY')),
  };
}

module.exports = {
  multiSearch,
  searchTavily,
  searchExa,
  searchLinkup,
  searchSerper,
  status,
};
