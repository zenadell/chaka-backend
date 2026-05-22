/**
 * browserService.js — Chaka's Browser Hands (Phase 4)
 *
 * Wraps Playwright with safety guards. Shares one headless Chromium across
 * requests for speed, gives each request its own fresh page (tab).
 *
 * Safety:
 *   - URL allowlist check (no file://, no private/internal IPs unless allowed)
 *   - Hard timeout per action (default 25s)
 *   - Caps on response size, screenshot size, text extraction length
 *   - Stealth-ish user agent (basic — full stealth comes in Phase 5)
 */

const { chromium } = require('playwright');

const DEFAULTS = {
  navTimeoutMs: 25000,
  actionTimeoutMs: 8000,
  maxTextChars: 50000,
  screenshotMaxWidth: 1280,
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const BLOCKED_URL_PATTERNS = [
  /^file:/i,
  /^chrome:/i,
  /^about:/i,
  /^javascript:/i,
  /\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i,
];

let browserInstance = null;
let browserStartPromise = null;

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function getBrowser() {
  if (browserInstance) return browserInstance;
  if (browserStartPromise) return browserStartPromise;

  browserStartPromise = (async () => {
    console.log('[browserService] Launching headless Chromium...');
    const b = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    b.on('disconnected', () => {
      console.warn('[browserService] Chromium disconnected — will relaunch on next use');
      browserInstance = null;
    });
    browserInstance = b;
    browserStartPromise = null;
    console.log('[browserService] Chromium ready');
    return b;
  })();

  return browserStartPromise;
}

async function shutdown() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch {}
    browserInstance = null;
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('url is required (string)');
  }

  // Block dangerous schemes BEFORE normalization (otherwise we'd https-prefix file:// etc.)
  const trimmed = rawUrl.trim();
  for (const pat of BLOCKED_URL_PATTERNS) {
    if (pat.test(trimmed)) {
      throw new Error(`Blocked URL pattern: ${pat}`);
    }
  }

  // Normalize: prepend https:// if no scheme
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try { new URL(url); } catch {
    throw new Error('Invalid URL');
  }

  // Re-check after normalization (catches private IPs that needed scheme to be detected)
  for (const pat of BLOCKED_URL_PATTERNS) {
    if (pat.test(url)) {
      throw new Error(`Blocked URL pattern: ${pat}`);
    }
  }

  return url;
}

// ── Page helpers ─────────────────────────────────────────────────────────────

async function withPage(options, fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: options.viewport || DEFAULTS.viewport,
    userAgent: options.userAgent || DEFAULTS.userAgent,
    bypassCSP: true,
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    try { await context.close(); } catch {}
  }
}

async function gotoSafe(page, url, timeout = DEFAULTS.navTimeoutMs) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    // Give SPAs a beat to populate
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } catch (e) {
    throw new Error(`Failed to load ${url}: ${e.message}`);
  }
}

// ── PUBLIC ACTIONS ───────────────────────────────────────────────────────────

/**
 * Extract internal links from the current page.
 * Returns deduplicated array of { url, text } for links pointing to the same origin.
 * This is what gives Chaka her site map — she knows what pages exist.
 */
async function extractInternalLinks(page, originUrl) {
  try {
    const origin = new URL(originUrl).origin;
    const links = await page.evaluate(() => {
      const out = [];
      const anchors = document.querySelectorAll('a[href]');
      for (const a of anchors) {
        const href = a.getAttribute('href');
        const text = (a.textContent || '').trim();
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
        out.push({ href, text: text.slice(0, 80) });
      }
      return out;
    });

    // Resolve to absolute URLs, filter to same-origin, dedupe by URL
    const seen = new Set();
    const internal = [];
    for (const l of links) {
      let absolute;
      try { absolute = new URL(l.href, origin).href; } catch { continue; }
      if (!absolute.startsWith(origin)) continue;
      // Strip hash + trailing slash for dedupe
      const norm = absolute.split('#')[0].replace(/\/$/, '');
      if (seen.has(norm)) continue;
      seen.add(norm);
      internal.push({ url: absolute, text: l.text || '(no text)' });
      if (internal.length >= 40) break; // cap to keep prompt manageable
    }
    return internal;
  } catch (e) {
    console.warn('[browserService] extractInternalLinks failed:', e.message);
    return [];
  }
}

/**
 * Navigate to URL, return text + title + final URL + screenshot + internal link inventory.
 * The link inventory is what enables Chaka to navigate sub-pages intelligently —
 * she sees the actual site map instead of guessing URLs blindly.
 */
async function navigate({ url, screenshot = true, fullPage = false, includeLinks = true }) {
  const safeUrl = validateUrl(url);
  return await withPage({}, async (page) => {
    await gotoSafe(page, safeUrl);

    const title = await page.title();
    const finalUrl = page.url();
    let text = await page.evaluate(() => document.body?.innerText || '');
    if (text.length > DEFAULTS.maxTextChars) {
      text = text.slice(0, DEFAULTS.maxTextChars) + `\n\n[...truncated at ${DEFAULTS.maxTextChars} chars]`;
    }

    let screenshotB64 = null;
    if (screenshot) {
      const buf = await page.screenshot({ fullPage, type: 'jpeg', quality: 75 });
      screenshotB64 = buf.toString('base64');
    }

    const links = includeLinks ? await extractInternalLinks(page, finalUrl) : [];

    return {
      title,
      finalUrl,
      text,
      screenshot: screenshotB64,
      screenshotMime: 'image/jpeg',
      links, // ← the site map: [{ url, text }, ...]
    };
  });
}

/**
 * Smart navigation with fallback:
 * 1. Try the exact URL
 * 2. If it 404s OR page text is suspiciously empty, navigate to the root domain
 *    and look for a link matching keywords from the requested path
 * 3. If found, navigate there
 *
 * Example: smartBrowse("jomiez.com/resume") → tries /resume directly,
 * if missing, hits the root and finds "Resume" in the nav → goes there.
 */
async function smartBrowse({ url, screenshot = true }) {
  const safeUrl = validateUrl(url);
  const parsed = new URL(safeUrl);
  const requestedPath = parsed.pathname.replace(/^\/|\/$/g, '');

  // First attempt: direct navigation
  let result;
  try {
    result = await navigate({ url: safeUrl, screenshot });
    // Heuristics for "looks like a successful page"
    const seemsValid = result.text && result.text.trim().length > 80 &&
      !/404|not found|page (doesn't|does not) exist/i.test(result.title || '');
    if (seemsValid || !requestedPath) {
      result.fallbackUsed = false;
      return result;
    }
    console.log(`[smartBrowse] direct navigation to "${safeUrl}" looks empty/404, trying fallback...`);
  } catch (e) {
    console.log(`[smartBrowse] direct navigation failed: ${e.message}, trying fallback...`);
  }

  // Fallback: hit the root, look for a matching link, navigate to it
  try {
    const root = `${parsed.protocol}//${parsed.host}`;
    const rootResult = await navigate({ url: root, screenshot: false });

    // Build keyword set from the requested path (lowercase, words only)
    const keywords = requestedPath
      .toLowerCase()
      .split(/[\/\-_]+/)
      .filter(k => k.length > 2);

    // Score each link by how many keywords it matches in href or text
    const ranked = rootResult.links.map(l => {
      const haystack = `${l.url} ${l.text}`.toLowerCase();
      const score = keywords.reduce((s, k) => s + (haystack.includes(k) ? 1 : 0), 0);
      return { ...l, score };
    }).filter(l => l.score > 0).sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      // No match — return whatever we got from the original attempt (or the root)
      if (result) { result.fallbackUsed = 'no_match'; return result; }
      rootResult.fallbackUsed = 'returned_root';
      return rootResult;
    }

    const best = ranked[0];
    console.log(`[smartBrowse] fallback found "${best.text}" → ${best.url}`);
    const finalResult = await navigate({ url: best.url, screenshot });
    finalResult.fallbackUsed = `redirected_to_${best.url}`;
    finalResult.originalRequest = safeUrl;
    return finalResult;
  } catch (e) {
    console.warn('[smartBrowse] fallback failed:', e.message);
    if (result) return result;
    throw e;
  }
}

/**
 * Just take a screenshot of a URL.
 */
async function screenshot({ url, fullPage = false }) {
  const safeUrl = validateUrl(url);
  return await withPage({}, async (page) => {
    await gotoSafe(page, safeUrl);
    const buf = await page.screenshot({ fullPage, type: 'jpeg', quality: 80 });
    return {
      url: page.url(),
      title: await page.title(),
      screenshot: buf.toString('base64'),
      screenshotMime: 'image/jpeg',
    };
  });
}

/**
 * Click an element matching a CSS selector or visible text, then return new state.
 */
async function click({ url, selector }) {
  if (!selector) throw new Error('selector is required');
  const safeUrl = validateUrl(url);
  return await withPage({}, async (page) => {
    await gotoSafe(page, safeUrl);
    try {
      await page.click(selector, { timeout: DEFAULTS.actionTimeoutMs });
    } catch (e) {
      throw new Error(`Click failed: ${e.message}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return {
      finalUrl: page.url(),
      title: await page.title(),
      text: (await page.evaluate(() => document.body?.innerText || '')).slice(0, DEFAULTS.maxTextChars),
    };
  });
}

/**
 * Fill a form field, optionally then submit.
 */
async function fill({ url, fields = {}, submitSelector = null }) {
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    throw new Error('fields is required (object of {selector: value})');
  }
  const safeUrl = validateUrl(url);
  return await withPage({}, async (page) => {
    await gotoSafe(page, safeUrl);
    for (const [selector, value] of Object.entries(fields)) {
      await page.fill(selector, String(value), { timeout: DEFAULTS.actionTimeoutMs });
    }
    if (submitSelector) {
      await page.click(submitSelector, { timeout: DEFAULTS.actionTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
    return {
      finalUrl: page.url(),
      title: await page.title(),
      text: (await page.evaluate(() => document.body?.innerText || '')).slice(0, DEFAULTS.maxTextChars),
    };
  });
}

/**
 * Extract structured data from a URL based on a CSS selector list.
 * For LLM-driven extraction, use navigate() and pass the text/screenshot to Chaka.
 */
async function extract({ url, selectors = {} }) {
  const safeUrl = validateUrl(url);
  return await withPage({}, async (page) => {
    await gotoSafe(page, safeUrl);
    const result = {};
    for (const [key, sel] of Object.entries(selectors)) {
      try {
        const handles = await page.$$(sel);
        if (handles.length === 0) {
          result[key] = null;
        } else if (handles.length === 1) {
          result[key] = (await handles[0].textContent() || '').trim();
        } else {
          result[key] = await Promise.all(handles.map(async h => (await h.textContent() || '').trim()));
        }
      } catch (e) {
        result[key] = { error: e.message };
      }
    }
    return { finalUrl: page.url(), extracted: result };
  });
}

module.exports = {
  navigate,
  smartBrowse,
  screenshot,
  click,
  fill,
  extract,
  extractInternalLinks,
  shutdown,
  // exposed for tests
  validateUrl,
  _DEFAULTS: DEFAULTS,
};
