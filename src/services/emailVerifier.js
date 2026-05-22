'use strict';

/**
 * emailVerifier.js — IMAP poller for sign-up verification flows (Phase 5.5)
 *
 * The #1 reason real-world sign-ups fail: site sends an email with a
 * verification code or link, agent has no way to read it. This service
 * connects to a user-provided IMAP inbox, polls for fresh emails matching
 * a domain, and extracts the 6-digit code OR the verification link.
 *
 * Activation:
 *   Set in .env:
 *     EMAIL_IMAP_HOST=imap.gmail.com
 *     EMAIL_IMAP_PORT=993
 *     EMAIL_IMAP_USER=you@gmail.com
 *     EMAIL_IMAP_PASS=<app password, NOT your real password>
 *
 *   For Gmail: enable 2FA + create an App Password at
 *   https://myaccount.google.com/apppasswords
 *
 * Public API:
 *   isConfigured()
 *   waitForVerificationEmail({ fromDomain, since, timeoutMs })
 *     → { from, subject, code, link, html } | null
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function isConfigured() {
  return Boolean(
    process.env.EMAIL_IMAP_HOST &&
    process.env.EMAIL_IMAP_USER &&
    process.env.EMAIL_IMAP_PASS
  );
}

function _makeClient() {
  return new ImapFlow({
    host: process.env.EMAIL_IMAP_HOST,
    port: Number(process.env.EMAIL_IMAP_PORT) || 993,
    secure: process.env.EMAIL_IMAP_SECURE !== 'false',
    auth: {
      user: process.env.EMAIL_IMAP_USER,
      pass: process.env.EMAIL_IMAP_PASS,
    },
    logger: false,
  });
}

/**
 * Extract a 6-digit verification code from email body.
 * Tries multiple patterns: "code: 123456", "123456 is your code", standalone 6 digits.
 */
function extractCode(text) {
  if (!text) return null;
  // Strong pattern: code/verification adjacent to 4-8 digits
  const patterns = [
    /(?:code|verification|verify|otp|pin|passcode)[:\s]+(\d{4,8})/i,
    /\b(\d{6})\b/,                            // bare 6-digit block
    /\b(\d{4})\b\s+is your (?:code|verification)/i,
    /<strong[^>]*>(\d{4,8})<\/strong>/i,      // bolded codes
    /<h\d[^>]*>(\d{4,8})<\/h\d>/i,            // heading codes
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Extract the most likely verification URL from email body.
 * Prefers URLs containing "verify", "confirm", "activate", "validate".
 */
function extractLink(text, html, fromDomain) {
  if (!text && !html) return null;
  const blob = `${html || ''}\n${text || ''}`;

  // Find all URLs
  const urls = [...blob.matchAll(/https?:\/\/[^\s"'<>)]+/gi)].map(m => m[0]);
  if (!urls.length) return null;

  // Rank: verify-keyword + from-domain match wins
  const scored = urls.map(u => {
    let score = 0;
    if (/verify|confirm|activate|validate|magic|link/i.test(u)) score += 10;
    if (fromDomain && u.includes(fromDomain.split('.').slice(-2)[0])) score += 5;
    if (u.length > 60) score += 2; // long URLs usually have tokens
    if (/unsubscribe|preferences|policy/i.test(u)) score -= 8;
    return { u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].u : null;
}

/**
 * Wait for a verification email from a specific domain.
 *
 * @param {Object} opts
 * @param {string} opts.fromDomain  Domain to filter sender (e.g. "github.com")
 * @param {Date}   [opts.since]      Only consider emails newer than this (default: now - 30s)
 * @param {number} [opts.timeoutMs]  Max wait (default 120_000 = 2 min)
 * @param {number} [opts.pollMs]     Poll interval (default 6000)
 * @returns {Promise<{from, subject, code, link, html, text} | null>}
 */
async function waitForVerificationEmail(opts = {}) {
  if (!isConfigured()) {
    console.warn('[emailVerifier] not configured — set EMAIL_IMAP_* env vars');
    return null;
  }

  const fromDomain = opts.fromDomain || '';
  const since      = opts.since || new Date(Date.now() - 30_000);
  const timeoutMs  = opts.timeoutMs || 120_000;
  const pollMs     = opts.pollMs    || 6_000;
  const deadline   = Date.now() + timeoutMs;

  const client = _makeClient();
  await client.connect();
  console.log(`[emailVerifier] connected to ${process.env.EMAIL_IMAP_HOST}`);

  try {
    await client.mailboxOpen('INBOX');

    while (Date.now() < deadline) {
      // Search for unseen emails since `since` matching the domain
      const searchCriteria = { since };
      if (fromDomain) searchCriteria.from = fromDomain;

      const uids = await client.search(searchCriteria);
      if (uids.length) {
        // Get the newest one (highest UID)
        const newestUid = uids[uids.length - 1];
        const msg = await client.fetchOne(newestUid, { source: true, envelope: true });
        if (msg && msg.source) {
          const parsed = await simpleParser(msg.source);
          const text = parsed.text || '';
          const html = parsed.html || '';
          const subject = parsed.subject || '';
          const from = parsed.from?.text || '';

          // If fromDomain wasn't searchable on the IMAP side, double-check
          if (fromDomain && !from.toLowerCase().includes(fromDomain.toLowerCase().split('.').slice(-2).join('.'))) {
            // Doesn't match domain — keep polling
            await new Promise(r => setTimeout(r, pollMs));
            continue;
          }

          const code = extractCode(`${subject}\n${text}\n${html}`);
          const link = extractLink(text, html, fromDomain);

          console.log(`[emailVerifier] ✓ match: subject="${subject.slice(0, 60)}" code=${code} link=${link?.slice(0, 80)}`);
          return { from, subject, code, link, html, text };
        }
      }

      await new Promise(r => setTimeout(r, pollMs));
    }

    console.warn(`[emailVerifier] timeout after ${timeoutMs}ms — no email from "${fromDomain}"`);
    return null;
  } finally {
    try { await client.logout(); } catch {}
  }
}

module.exports = { isConfigured, waitForVerificationEmail, extractCode, extractLink };
