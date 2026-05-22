'use strict';

const { scrape, batchScrape, clearCache } = require('../services/scraperService');

// POST /api/scrape
// Body: { url, useCache?, ttl?, screenshot?, proxy?, forcePlaywright? }
async function scrapeOne(req, res) {
  const { url, useCache, ttl, screenshot, proxy, forcePlaywright } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  // Basic SSRF guard — block private ranges and localhost
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      host.startsWith('172.') ||
      host.endsWith('.local') ||
      u.protocol === 'file:'
    ) {
      return res.status(400).json({ error: 'Private / internal URLs are not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const result = await scrape(url, {
      useCache: useCache !== false,
      ttl: Number(ttl) || 3600,
      screenshot: screenshot === true,
      proxy: proxy || null,
      forcePlaywright: forcePlaywright === true,
    });
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('[scraperController] scrape failed:', err.message);
    return res.status(502).json({ error: err.message });
  }
}

// POST /api/scrape/batch
// Body: { urls: string[], useCache?, ttl?, concurrency? }
async function scrapeMany(req, res) {
  const { urls, useCache, ttl, concurrency } = req.body || {};

  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }
  if (urls.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 URLs per batch request' });
  }

  try {
    const results = await batchScrape(urls, {
      useCache: useCache !== false,
      ttl: Number(ttl) || 3600,
      concurrency: Math.min(Number(concurrency) || 3, 5),
    });
    return res.json({ ok: true, results });
  } catch (err) {
    console.error('[scraperController] batch failed:', err.message);
    return res.status(502).json({ error: err.message });
  }
}

// DELETE /api/scrape/cache
// Body: { url }
async function bustCache(req, res) {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  await clearCache(url);
  return res.json({ ok: true });
}

// GET /api/scrape/status
function status(req, res) {
  return res.json({ ok: true, phase: 5, service: 'smart-scraper', tiers: ['tier1-fetch', 'tier2-playwright'] });
}

module.exports = { scrapeOne, scrapeMany, bustCache, status };
