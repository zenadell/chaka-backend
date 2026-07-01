'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { tryProcessVideo } = require('./videoAgent');

// ── User-agent pool (realistic Chrome / Firefox / Safari) ─────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function browserHeaders(ua) {
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  };
}

// ── Cloudflare / block detection ──────────────────────────────────────────────

function isBlocked(status, body = '') {
  if ([403, 429, 503].includes(status)) return true;
  const l = body.slice(0, 4000).toLowerCase();
  return l.includes('just a moment') ||
    l.includes('attention required') ||
    l.includes('checking your browser') ||
    l.includes('access denied') ||
    l.includes('you have been blocked') ||
    l.includes('enable javascript and cookies') ||
    l.includes('ddos-guard');
}

// ── Turndown markdown converter (shared instance) ─────────────────────────────

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
td.remove(['script', 'style', 'noscript', 'head', 'meta', 'link']);

// ── Content extraction (cheerio → markdown) ───────────────────────────────────

function extract(html, url) {
  const $ = cheerio.load(html);

  // Strip noise
  $('script,style,noscript,iframe,svg,canvas,nav,footer,header,aside').remove();
  $('[class*="cookie"],[class*="popup"],[class*="modal"],[class*="banner"],[class*="advert"],[class*=" ad "],[id*="cookie"],[id*="popup"],[role="banner"],[role="navigation"],[role="complementary"]').remove();

  // Metadata
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="title"]').attr('content') ||
    $('title').text().trim() ||
    $('h1').first().text().trim() ||
    '';

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';

  const author =
    $('meta[name="author"]').attr('content') ||
    $('[rel="author"]').first().text().trim() ||
    $('[class*="author"],[itemprop="author"]').first().text().trim() ||
    '';

  const publishedTime =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    '';

  const favicon =
    $('link[rel="icon"]').attr('href') ||
    $('link[rel="shortcut icon"]').attr('href') ||
    '/favicon.ico';

  // Find the main content block (biggest text-dense container)
  const MAIN_SELECTORS = [
    'article', '[role="main"]', 'main', '.article-body', '.article-content',
    '.post-content', '.entry-content', '.content-body', '.story-body',
    '.prose', '#content', '.content', '.page-content',
  ];

  let mainEl = null;
  for (const sel of MAIN_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 300) { mainEl = el; break; }
  }

  // Fallback: densest div/section
  if (!mainEl) {
    let bestLen = 0;
    $('div,section').each((_, el) => {
      const t = $(el).text().trim().length;
      if (t > bestLen && t < 200_000) { bestLen = t; mainEl = $(el); }
    });
  }

  const contentHtml = mainEl ? mainEl.html() : $('body').html() || '';
  let markdown = td.turndown(contentHtml).replace(/\n{3,}/g, '\n\n').trim().slice(0, 60_000);

  // Links
  const baseUrl = (() => { try { return new URL(url); } catch { return null; } })();
  const seen = new Set();
  const links = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const text = $(el).text().trim().slice(0, 120);
    if (!href || !text || href.startsWith('#') || href.startsWith('javascript:')) return;
    try {
      const abs = baseUrl ? new URL(href, baseUrl).href : href;
      if (!seen.has(abs)) { seen.add(abs); links.push({ text, url: abs }); }
    } catch {}
  });

  // Images
  const images = [];
  $('img[src]').each((_, el) => {
    const src = ($(el).attr('src') || '').trim();
    const alt = ($(el).attr('alt') || '').trim();
    if (!src || src.startsWith('data:')) return;
    try {
      const abs = baseUrl ? new URL(src, baseUrl).href : src;
      images.push({ src: abs, alt });
    } catch {}
  });

  const wordCount = markdown.split(/\s+/).filter(Boolean).length;

  return {
    title: title.slice(0, 300),
    description: description.slice(0, 500),
    author: author.slice(0, 200),
    publishedTime,
    favicon,
    content: markdown,
    links: links.slice(0, 60),
    images: images.slice(0, 20),
    wordCount,
    readTimeMin: Math.ceil(wordCount / 200),
  };
}

// ── Tier 1: Direct axios fetch ────────────────────────────────────────────────

async function fetchDirect(url, opts = {}) {
  const ua = pickUA();
  const resp = await axios.get(url, {
    headers: { ...browserHeaders(ua), ...(opts.headers || {}) },
    timeout: opts.timeout || 14_000,
    maxRedirects: 6,
    validateStatus: null,
    decompress: true,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });
  const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  if (isBlocked(resp.status, body)) {
    throw Object.assign(new Error(`Blocked: HTTP ${resp.status}`), { code: 'BLOCKED' });
  }
  if (resp.status >= 400) {
    throw Object.assign(new Error(`HTTP ${resp.status}`), { code: 'HTTP_ERROR' });
  }
  return body;
}

// ── Tier 2: Playwright stealth ────────────────────────────────────────────────

let _browser = null;
let _browserLastUsed = 0;

// Close idle browser after 5 min to free memory
setInterval(() => {
  if (_browser && Date.now() - _browserLastUsed > 5 * 60_000) {
    _browser.close().catch(() => {});
    _browser = null;
    console.log('[scraper] idle Playwright browser closed');
  }
}, 60_000);

async function getBrowser() {
  if (_browser && _browser.isConnected()) {
    _browserLastUsed = Date.now();
    return _browser;
  }
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1366,768',
      '--disable-dev-shm-usage',
    ],
  });
  _browserLastUsed = Date.now();
  return _browser;
}

async function fetchPlaywright(url, opts = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: pickUA(),
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9', 'DNT': '1' },
    ...(opts.proxy ? { proxy: { server: opts.proxy } } : {}),
  });

  // Stealth overrides
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    // Remove __playwright / __pw markers
    delete window.__playwright;
    delete window.__pwInitScripts;
  });

  const page = await context.newPage();
  try {
    // NOTE: waitUntil was previously 'networkidle', which hangs for the full
    // timeout on sites with continuous background polling/analytics (TikTok,
    // Twitter/X, Instagram never go network-idle). domcontentloaded + a bounded,
    // swallowed attempt at networkidle gives JS-heavy pages a chance to hydrate
    // without blocking on sites that never settle.
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeout || 30_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

    // Give JS-heavy pages a moment to settle
    await page.waitForTimeout(1500);

    // Cloudflare challenge — wait up to 8s more
    const pageTitle = await page.title();
    if (/just a moment|attention required|ddos/i.test(pageTitle)) {
      await page.waitForTimeout(8000);
      const retitle = await page.title();
      if (/just a moment|attention required|ddos/i.test(retitle)) {
        throw Object.assign(new Error('Cloudflare challenge not bypassed'), { code: 'CF_BLOCKED' });
      }
    }

    const html = await page.content();
    const screenshot = opts.screenshot
      ? (await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64')
      : null;

    _browserLastUsed = Date.now();
    return { html, screenshot };
  } finally {
    await context.close().catch(() => {});
  }
}

// ── Turso cache ───────────────────────────────────────────────────────────────

let _db = null;

async function getDb() {
  if (_db) return _db;
  // NOTE: was TURSO_DB_URL, which doesn't match the TURSO_DATABASE_URL name
  // used everywhere else (see tursoService.js) — the cache was silently
  // never activating in any environment that only sets TURSO_DATABASE_URL.
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) return null;
  const { createClient } = require('@libsql/client');
  _db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  await _db.execute(`
    CREATE TABLE IF NOT EXISTS scrape_cache (
      hash      TEXT    PRIMARY KEY,
      url       TEXT    NOT NULL,
      result    TEXT    NOT NULL,
      tier      TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      ttl_s     INTEGER NOT NULL DEFAULT 3600
    )
  `);
  return _db;
}

function urlHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

async function getCached(url) {
  try {
    const db = await getDb();
    if (!db) return null;
    const hash = urlHash(url);
    const res = await db.execute({ sql: 'SELECT result, tier, created_at, ttl_s FROM scrape_cache WHERE hash = ?', args: [hash] });
    if (!res.rows.length) return null;
    const r = res.rows[0];
    const age = Math.floor(Date.now() / 1000) - Number(r.created_at);
    if (age > Number(r.ttl_s)) {
      db.execute({ sql: 'DELETE FROM scrape_cache WHERE hash = ?', args: [hash] }).catch(() => {});
      return null;
    }
    return { ...JSON.parse(r.result), tier: r.tier + ' (cached)', cached: true, cacheAgeSeconds: age };
  } catch { return null; }
}

async function setCache(url, result, tier, ttlSeconds = 3600) {
  try {
    const db = await getDb();
    if (!db) return;
    const hash = urlHash(url);
    await db.execute({
      sql: 'INSERT OR REPLACE INTO scrape_cache (hash, url, result, tier, created_at, ttl_s) VALUES (?,?,?,?,?,?)',
      args: [hash, url, JSON.stringify(result), tier, Math.floor(Date.now() / 1000), ttlSeconds],
    });
  } catch {}
}

// ── Simple concurrency limiter (avoids ESM p-limit) ──────────────────────────

function makeLimiter(max) {
  let running = 0;
  const queue = [];
  function next() {
    if (running >= max || !queue.length) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve).catch(reject).finally(() => { running--; next(); });
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Scrape a single URL. Returns structured result.
 * Options:
 *   useCache      {boolean}  default true
 *   ttl           {number}   cache TTL seconds, default 3600
 *   screenshot    {boolean}  capture screenshot in tier-2, default false
 *   proxy         {string}   proxy URL e.g. "http://user:pass@host:port"
 *   forcePlaywright {boolean} skip tier-1, default false
 *   timeout       {number}   fetch timeout ms
 */
async function scrape(url, options = {}) {
  const { useCache = true, ttl = 3600, screenshot = false, proxy = null,
    forcePlaywright = false, timeout } = options;

  // Validate URL
  try { new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }

  if (useCache) {
    const hit = await getCached(url);
    if (hit) return hit;
  }

  // Video-first: try yt-dlp's own extractor detection before treating this as
  // a normal webpage. This covers YouTube, TikTok, Twitter/X, Instagram, Vimeo,
  // Reddit, and hundreds of other sites uniformly — we never guess from the
  // URL string ourselves, we just ask yt-dlp and fall through cleanly if it
  // says no. This also happens to be the ONLY reliable way to get TikTok
  // content at all: TikTok's web page hard-blocks headless browsers (returns
  // a bare login wall) even via full Playwright, while yt-dlp talks to
  // TikTok's own API and works fine.
  if (!forcePlaywright) {
    const videoAnalysis = await tryProcessVideo(url).catch(() => null);
    if (videoAnalysis) {
      const wordCount = videoAnalysis.split(/\s+/).filter(Boolean).length;
      const result = {
        url,
        tier: 'video',
        title: '',
        description: '',
        author: '',
        publishedTime: '',
        favicon: '',
        content: videoAnalysis,
        links: [],
        images: [],
        wordCount,
        readTimeMin: Math.ceil(wordCount / 200),
        screenshot: null,
        scrapedAt: new Date().toISOString(),
        cached: false,
        cacheAgeSeconds: 0,
      };
      if (useCache) setCache(url, result, 'video', ttl).catch(() => {});
      return result;
    }
  }

  let html = null;
  let tier = 'tier1';
  let pwResult = null;
  let data = null;

  // Tier 1: direct fetch
  if (!forcePlaywright) {
    try {
      html = await fetchDirect(url, { proxy, timeout });
      data = extract(html, url);
      // Tier-1 can return HTTP 200 with an almost-empty JS-rendered shell
      // (e.g. YouTube's SSR shell has real title/meta tags but no body text).
      // A clean 200 response used to be treated as full success with no
      // check on whether it actually got any content — escalate instead.
      if (!data.content || data.wordCount < 30) {
        console.log(`[scraper] tier-1 content too thin (${data.wordCount} words) → escalating to Playwright`);
        html = null;
        data = null;
      }
    } catch (e) {
      console.log(`[scraper] tier-1 failed (${e.message}) → escalating to Playwright`);
    }
  }

  // Tier 2: Playwright stealth
  if (!data) {
    pwResult = await fetchPlaywright(url, { screenshot, proxy, timeout });
    html = pwResult.html;
    tier = 'tier2';
    data = extract(html, url);
  }

  const result = {
    url,
    tier,
    ...data,
    screenshot: pwResult?.screenshot || null,
    scrapedAt: new Date().toISOString(),
    cached: false,
    cacheAgeSeconds: 0,
  };

  if (useCache && data.content) {
    setCache(url, result, tier, ttl).catch(() => {});
  }

  return result;
}

/**
 * Scrape multiple URLs with concurrency control (max 3 parallel).
 */
async function batchScrape(urls, options = {}) {
  const limit = makeLimiter(options.concurrency || 3);
  return Promise.all(
    urls.map(url =>
      limit(() => scrape(url, options).catch(err => ({ url, error: err.message, tier: 'failed' })))
    )
  );
}

/**
 * Clear cached result for a URL.
 */
async function clearCache(url) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute({ sql: 'DELETE FROM scrape_cache WHERE hash = ?', args: [urlHash(url)] });
  } catch {}
}

module.exports = { scrape, batchScrape, clearCache, urlHash };
