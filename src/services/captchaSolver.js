'use strict';

/**
 * captchaSolver.js — 2captcha REST client (Phase 5.5)
 *
 * Solves reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, and image CAPTCHAs
 * via the 2captcha.com API. Costs ~$0.003 per solve.
 *
 * Activation:
 *   Set TWOCAPTCHA_API_KEY in .env to enable.
 *   Without the key, every call returns null and we fall back to the
 *   existing "attention_required" SSE event so the user can solve manually.
 *
 * Public API:
 *   isConfigured() → boolean
 *   solveRecaptchaV2(siteKey, pageUrl)   → token | null
 *   solveHcaptcha(siteKey, pageUrl)       → token | null
 *   solveTurnstile(siteKey, pageUrl)      → token | null
 *   detectAndSolve(page)                  → { type, token } | null
 *
 *   Once you have a token, inject it into the page via:
 *     await page.evaluate(`document.getElementById('g-recaptcha-response').value = '${token}'`)
 */

const axios = require('axios');

const API_BASE = 'https://2captcha.com';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24; // 24 * 5s = 2 min max

function isConfigured() {
  return Boolean(process.env.TWOCAPTCHA_API_KEY);
}

async function _submit(payload) {
  const resp = await axios.post(`${API_BASE}/in.php`, null, {
    params: { ...payload, key: process.env.TWOCAPTCHA_API_KEY, json: 1 },
    timeout: 15_000,
  });
  if (resp.data?.status !== 1) {
    throw new Error(`2captcha submit failed: ${resp.data?.request || 'unknown'}`);
  }
  return resp.data.request; // captcha ID
}

async function _poll(captchaId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const resp = await axios.get(`${API_BASE}/res.php`, {
      params: { key: process.env.TWOCAPTCHA_API_KEY, action: 'get', id: captchaId, json: 1 },
      timeout: 15_000,
    });
    if (resp.data?.status === 1) return resp.data.request;
    if (resp.data?.request === 'CAPCHA_NOT_READY') continue;
    throw new Error(`2captcha poll error: ${resp.data?.request}`);
  }
  throw new Error('2captcha timeout after 2 min');
}

async function solveRecaptchaV2(siteKey, pageUrl) {
  if (!isConfigured()) return null;
  try {
    console.log(`[captcha] solving reCAPTCHA v2 sitekey=${siteKey.slice(0, 12)}… on ${pageUrl}`);
    const id = await _submit({ method: 'userrecaptcha', googlekey: siteKey, pageurl: pageUrl });
    const token = await _poll(id);
    console.log(`[captcha] ✓ reCAPTCHA v2 solved (${token.length} chars)`);
    return token;
  } catch (e) {
    console.error(`[captcha] reCAPTCHA v2 failed: ${e.message}`);
    return null;
  }
}

async function solveHcaptcha(siteKey, pageUrl) {
  if (!isConfigured()) return null;
  try {
    console.log(`[captcha] solving hCaptcha sitekey=${siteKey.slice(0, 12)}… on ${pageUrl}`);
    const id = await _submit({ method: 'hcaptcha', sitekey: siteKey, pageurl: pageUrl });
    const token = await _poll(id);
    console.log(`[captcha] ✓ hCaptcha solved`);
    return token;
  } catch (e) {
    console.error(`[captcha] hCaptcha failed: ${e.message}`);
    return null;
  }
}

async function solveTurnstile(siteKey, pageUrl) {
  if (!isConfigured()) return null;
  try {
    console.log(`[captcha] solving Turnstile sitekey=${siteKey.slice(0, 12)}…`);
    const id = await _submit({ method: 'turnstile', sitekey: siteKey, pageurl: pageUrl });
    const token = await _poll(id);
    return token;
  } catch (e) {
    console.error(`[captcha] Turnstile failed: ${e.message}`);
    return null;
  }
}

/**
 * Detect the captcha type on the current Playwright page and solve it.
 * Returns { type, token, selector } so caller can inject the token.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{type, token, injectSelector} | null>}
 */
async function detectAndSolve(page) {
  if (!isConfigured()) return null;
  const url = page.url();

  // Try reCAPTCHA v2
  const recaptchaSiteKey = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    if (iframe) {
      const m = iframe.src.match(/[?&]k=([^&]+)/);
      if (m) return m[1];
    }
    const el = document.querySelector('[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  }).catch(() => null);

  if (recaptchaSiteKey) {
    const token = await solveRecaptchaV2(recaptchaSiteKey, url);
    if (token) return { type: 'recaptcha-v2', token, injectSelector: '#g-recaptcha-response' };
  }

  // Try hCaptcha
  const hcaptchaSiteKey = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="hcaptcha"]');
    if (iframe) {
      const m = iframe.src.match(/sitekey=([^&]+)/);
      if (m) return m[1];
    }
    const el = document.querySelector('[data-hcaptcha-sitekey], .h-captcha[data-sitekey]');
    return el ? (el.getAttribute('data-hcaptcha-sitekey') || el.getAttribute('data-sitekey')) : null;
  }).catch(() => null);

  if (hcaptchaSiteKey) {
    const token = await solveHcaptcha(hcaptchaSiteKey, url);
    if (token) return { type: 'hcaptcha', token, injectSelector: 'textarea[name="h-captcha-response"]' };
  }

  // Try Cloudflare Turnstile
  const turnstileSiteKey = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  }).catch(() => null);

  if (turnstileSiteKey) {
    const token = await solveTurnstile(turnstileSiteKey, url);
    if (token) return { type: 'turnstile', token, injectSelector: 'input[name="cf-turnstile-response"]' };
  }

  return null;
}

/**
 * Inject a solved token into the page and submit any callbacks.
 */
async function injectToken(page, { token, injectSelector, type }) {
  try {
    await page.evaluate(({ token, selector, type }) => {
      const el = document.querySelector(selector);
      if (el) {
        el.value = token;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Trigger reCAPTCHA callback if registered
      if (type === 'recaptcha-v2' && typeof window.___grecaptcha_cfg !== 'undefined') {
        try {
          const ids = Object.keys(window.___grecaptcha_cfg.clients);
          for (const id of ids) {
            const cb = window.___grecaptcha_cfg.clients[id]?.U?.U?.callback ||
                       window.___grecaptcha_cfg.clients[id]?.aa?.l?.callback;
            if (typeof cb === 'function') cb(token);
          }
        } catch {}
      }
      // hCaptcha callback
      if (type === 'hcaptcha' && typeof window.hcaptcha !== 'undefined') {
        try { window.hcaptcha.execute(); } catch {}
      }
    }, { token, selector: injectSelector, type });
    console.log(`[captcha] token injected → ${injectSelector}`);
    return true;
  } catch (e) {
    console.error(`[captcha] inject failed: ${e.message}`);
    return false;
  }
}

module.exports = {
  isConfigured,
  solveRecaptchaV2,
  solveHcaptcha,
  solveTurnstile,
  detectAndSolve,
  injectToken,
};
