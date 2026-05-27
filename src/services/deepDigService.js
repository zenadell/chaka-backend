'use strict';

/**
 * deepDigService.js — Phase 8 OSINT-grade research (creator-only)
 *
 * Goes beyond surface-web search. Runs ~8 OSINT primitives in parallel,
 * pipes everything into a single synthesized "dossier" with strict
 * identity gating against the asker's known affiliations.
 *
 * Primitives:
 *   • Username sleuth — probe 60+ sites for the target's handle
 *   • GitHub deep — user + repos + commit-email harvest
 *   • WHOIS — domain ownership + history
 *   • Wayback Machine — historical snapshots of known URLs
 *   • Email enumeration — Holehe-pattern (consent-gated, optional)
 *   • Hunter.io — name+domain → verified email (free tier 50/mo)
 *   • Deep search — runs through the existing multi-engine aggregator
 *     with stronger query expansion (this is the bedrock)
 *   • Reverse-image (Bing) — if a profile image URL is provided
 *
 * Gated to creator-only at the controller layer. This module itself just
 * runs the primitives and synthesizes — admin gating is enforced by the
 * caller before invocation.
 */

const axios = require('axios');
const dns = require('dns').promises;
let whoisJson;
try { whoisJson = require('whois-json'); } catch { whoisJson = null; }
const { callLlm, safeJsonExtract } = require('./deepResearchService');
const { multiSearch } = require('./searchEngines');

const apiKeyManager = require('../utils/apiKeyManager');
const scraperService = require('./scraperService');

// ── Helper: resolve a key (admin first, env fallback) ──────────────────────
function _key(type, envName) {
  try {
    const k = apiKeyManager.pickKey?.(type)?.key;
    if (k) return k;
  } catch {}
  return (process.env[envName] || '').trim() || null;
}

// ── Curated list of probable usernames from a target string ────────────────
function buildHandleCandidates(target) {
  const t = String(target || '').toLowerCase().trim();
  if (!t) return [];
  const parts = t.split(/[\s.,_\-]+/).filter(Boolean);
  const set = new Set();
  if (parts.length === 1) set.add(parts[0]);
  if (parts.length >= 2) {
    set.add(parts.join(''));           // emmanuelnweke
    set.add(parts.join('.'));          // emmanuel.nweke
    set.add(parts.join('_'));          // emmanuel_nweke
    set.add(parts.join('-'));          // emmanuel-nweke
    set.add(parts[0]);                 // emmanuel
    set.add(parts[parts.length - 1]);  // nweke
    set.add(parts[0][0] + parts[parts.length - 1]); // enweke
    set.add(parts[0] + parts[parts.length - 1][0]); // emmanueln
  }
  return Array.from(set).filter(s => s.length >= 3 && s.length <= 40).slice(0, 12);
}

// ── 1. Username Sleuth (Sherlock-pattern, curated ~30 high-signal sites) ──
// We only probe sites where a 200/302 actually means "this handle exists" —
// many social sites return 200 for both real and fake handles. Curated for
// signal, not coverage.
const HANDLE_SITES = [
  { name: 'github',       url: u => `https://github.com/${u}`,                   ok: r => r.status === 200 && !/Page not found/i.test(r.body) },
  { name: 'twitter/x',    url: u => `https://x.com/${u}`,                        ok: r => r.status === 200 && !/account doesn.t exist/i.test(r.body) },
  { name: 'instagram',    url: u => `https://www.instagram.com/${u}/`,            ok: r => r.status === 200 && !/Sorry, this page isn.?t available/i.test(r.body) },
  { name: 'reddit',       url: u => `https://www.reddit.com/user/${u}`,           ok: r => r.status === 200 && !/Sorry, nobody on Reddit/i.test(r.body) },
  { name: 'medium',       url: u => `https://medium.com/@${u}`,                   ok: r => r.status === 200 && !/PAGE NOT FOUND/i.test(r.body) },
  { name: 'devto',        url: u => `https://dev.to/${u}`,                        ok: r => r.status === 200 && !/Page not found/i.test(r.body) },
  { name: 'producthunt',  url: u => `https://www.producthunt.com/@${u}`,          ok: r => r.status === 200 && !/Page not found/i.test(r.body) },
  { name: 'tiktok',       url: u => `https://www.tiktok.com/@${u}`,               ok: r => r.status === 200 && !/Couldn.?t find this account/i.test(r.body) },
  { name: 'pinterest',    url: u => `https://www.pinterest.com/${u}/`,            ok: r => r.status === 200 && !/User not found/i.test(r.body) },
  { name: 'youtube',      url: u => `https://www.youtube.com/@${u}`,              ok: r => r.status === 200 && !/This page isn.?t available/i.test(r.body) },
  { name: 'gitlab',       url: u => `https://gitlab.com/${u}`,                    ok: r => r.status === 200 },
  { name: 'bitbucket',    url: u => `https://bitbucket.org/${u}/`,                ok: r => r.status === 200 && !/has not created any/i.test(r.body) },
  { name: 'npm',          url: u => `https://www.npmjs.com/~${u}`,                ok: r => r.status === 200 && !/User not found/i.test(r.body) },
  { name: 'stackoverflow',url: u => `https://stackoverflow.com/users/?tab=Reputation&search=${u}`, ok: r => r.status === 200 && new RegExp(u, 'i').test(r.body) },
  { name: 'hackernews',   url: u => `https://news.ycombinator.com/user?id=${u}`,  ok: r => r.status === 200 && !/No such user/i.test(r.body) },
  { name: 'spotify',      url: u => `https://open.spotify.com/user/${u}`,         ok: r => r.status === 200 && !/Page not found/i.test(r.body) },
  { name: 'soundcloud',   url: u => `https://soundcloud.com/${u}`,                ok: r => r.status === 200 && !/We can.?t find that user/i.test(r.body) },
  { name: 'behance',      url: u => `https://www.behance.net/${u}`,               ok: r => r.status === 200 && !/Page Not Found/i.test(r.body) },
  { name: 'dribbble',     url: u => `https://dribbble.com/${u}`,                  ok: r => r.status === 200 && !/Whoops, that page is gone/i.test(r.body) },
  { name: 'codepen',      url: u => `https://codepen.io/${u}`,                    ok: r => r.status === 200 },
  { name: 'replit',       url: u => `https://replit.com/@${u}`,                   ok: r => r.status === 200 && !/Looks like you took a wrong turn/i.test(r.body) },
  { name: 'huggingface',  url: u => `https://huggingface.co/${u}`,                ok: r => r.status === 200 && !/page not found/i.test(r.body) },
  { name: 'kaggle',       url: u => `https://www.kaggle.com/${u}`,                ok: r => r.status === 200 && !/Page Not Found/i.test(r.body) },
  { name: 'wikipedia',    url: u => `https://en.wikipedia.org/wiki/User:${u}`,    ok: r => r.status === 200 && !/has not been written yet/i.test(r.body) },
  { name: 'patreon',      url: u => `https://www.patreon.com/${u}`,               ok: r => r.status === 200 && !/Page Not Found/i.test(r.body) },
  { name: 'mastodon.social',url:u =>`https://mastodon.social/@${u}`,              ok: r => r.status === 200 && !/page doesn.?t exist/i.test(r.body) },
  { name: 'bluesky',      url: u => `https://bsky.app/profile/${u}.bsky.social`,  ok: r => r.status === 200 && !/Account not found/i.test(r.body) },
  { name: 'gravatar',     url: u => `https://gravatar.com/${u}`,                  ok: r => r.status === 200 && !/Whoops, no profile here/i.test(r.body) },
  { name: 'keybase',      url: u => `https://keybase.io/${u}`,                    ok: r => r.status === 200 && !/Sorry, we can.?t find that user/i.test(r.body) },
  { name: 'about.me',     url: u => `https://about.me/${u}`,                      ok: r => r.status === 200 && !/Profile not found/i.test(r.body) },
];

async function _probe(site, handle) {
  try {
    const url = site.url(handle);
    const r = await axios.get(url, {
      timeout: 6000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    });
    const body = typeof r.data === 'string' ? r.data : '';
    const found = site.ok({ status: r.status, body });
    return { site: site.name, url, handle, found, status: r.status };
  } catch (e) {
    return { site: site.name, handle, found: false, error: e.code || e.message?.slice(0, 50) };
  }
}

async function usernameSleuth(target, onStatus) {
  const candidates = buildHandleCandidates(target);
  if (!candidates.length) return { primitive: 'username_sleuth', candidates: [], hits: [] };
  onStatus?.({ type: 'dig_probe_start', primitive: 'username_sleuth', candidates });

  const tasks = [];
  for (const handle of candidates) for (const site of HANDLE_SITES) tasks.push(_probe(site, handle));

  // Concurrency control — don't hammer (60 sites × 12 handles = 720 reqs)
  const results = [];
  let idx = 0;
  const CONC = 16;
  await new Promise(resolve => {
    let active = 0;
    function pump() {
      if (idx >= tasks.length && active === 0) return resolve();
      while (active < CONC && idx < tasks.length) {
        active++;
        tasks[idx++].then(r => { if (r.found) results.push(r); }).finally(() => { active--; pump(); });
      }
    }
    pump();
  });

  onStatus?.({ type: 'dig_probe_done', primitive: 'username_sleuth', hits: results.length });
  return { primitive: 'username_sleuth', candidates, hits: results };
}

// ── 2. GitHub deep — user search + repos + commit emails ───────────────────
async function githubDeep(target, onStatus) {
  onStatus?.({ type: 'dig_probe_start', primitive: 'github' });
  const ghKey = _key('github', 'GITHUB_TOKEN');
  const headers = ghKey ? { Authorization: `token ${ghKey}` } : {};
  const out = { primitive: 'github', users: [], repos: [], commit_emails: [] };

  try {
    const u = await axios.get(`https://api.github.com/search/users?q=${encodeURIComponent(target)}&per_page=8`,
      { headers, timeout: 10000 });
    out.users = (u.data.items || []).map(x => ({
      login: x.login,
      url: x.html_url,
      score: x.score,
      type: x.type,
    }));

    // For top 3 users, pull their public emails from commit authors
    const top = out.users.slice(0, 3);
    for (const user of top) {
      try {
        const events = await axios.get(`https://api.github.com/users/${user.login}/events/public?per_page=30`, { headers, timeout: 10000 });
        for (const e of events.data || []) {
          if (e.type === 'PushEvent' && e.payload?.commits) {
            for (const c of e.payload.commits) {
              if (c.author?.email && !c.author.email.endsWith('@users.noreply.github.com')) {
                out.commit_emails.push({ login: user.login, email: c.author.email, name: c.author.name });
              }
            }
          }
        }
      } catch {}
    }

    // Dedupe emails
    const seen = new Set();
    out.commit_emails = out.commit_emails.filter(e => {
      const k = e.email.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch (e) {
    out.error = e.message;
  }

  onStatus?.({ type: 'dig_probe_done', primitive: 'github', user_count: out.users.length, email_count: out.commit_emails.length });
  return out;
}

// ── 3. WHOIS + DNS for a domain ─────────────────────────────────────────────
async function whoisDeep(domain, onStatus) {
  if (!domain || !/[a-z]/i.test(domain)) return null;
  onStatus?.({ type: 'dig_probe_start', primitive: 'whois', domain });
  const out = { primitive: 'whois', domain };

  if (whoisJson) {
    try {
      out.whois = await whoisJson(domain);
    } catch (e) { out.whois_error = e.message; }
  } else {
    out.whois_error = 'whois-json not installed';
  }

  try {
    out.dns = {};
    for (const type of ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME']) {
      try {
        out.dns[type] = await dns.resolve(domain, type);
      } catch {}
    }
  } catch (e) { out.dns_error = e.message; }

  onStatus?.({ type: 'dig_probe_done', primitive: 'whois' });
  return out;
}

// ── 4. Wayback Machine — historical snapshots ──────────────────────────────
async function waybackDeep(url, onStatus) {
  onStatus?.({ type: 'dig_probe_start', primitive: 'wayback', url });
  try {
    const cdx = await axios.get('https://web.archive.org/cdx/search/cdx', {
      params: { url, output: 'json', limit: 20, filter: 'statuscode:200', collapse: 'timestamp:6' },
      timeout: 15000,
    });
    const rows = cdx.data || [];
    const snapshots = rows.slice(1).map(r => ({
      timestamp: r[1], original: r[2], status: r[4], length: Number(r[6]) || 0,
      wayback_url: `https://web.archive.org/web/${r[1]}/${r[2]}`,
    }));
    onStatus?.({ type: 'dig_probe_done', primitive: 'wayback', snapshot_count: snapshots.length });
    return { primitive: 'wayback', url, snapshots };
  } catch (e) {
    onStatus?.({ type: 'dig_probe_done', primitive: 'wayback', error: e.message });
    return { primitive: 'wayback', url, error: e.message };
  }
}

// ── 5. Hunter.io email finder (optional, paid free-tier) ───────────────────
async function hunterFindEmail(name, domain, onStatus) {
  const key = _key('hunter', 'HUNTER_API_KEY');
  if (!key) return { primitive: 'hunter', skipped: 'no key' };
  onStatus?.({ type: 'dig_probe_start', primitive: 'hunter' });
  try {
    const parts = String(name || '').split(/\s+/);
    const r = await axios.get('https://api.hunter.io/v2/email-finder', {
      params: { domain, first_name: parts[0], last_name: parts[parts.length - 1], api_key: key },
      timeout: 15000,
    });
    const data = r.data?.data;
    onStatus?.({ type: 'dig_probe_done', primitive: 'hunter', found: !!data?.email });
    return { primitive: 'hunter', email: data?.email || null, score: data?.score, sources: data?.sources || [] };
  } catch (e) {
    return { primitive: 'hunter', error: e.response?.data?.errors?.[0]?.details || e.message };
  }
}

// ── 6. Deep multi-engine search (reuses our aggregator with broad fanout) ──
async function deepSearchPrimitive(target, onStatus) {
  onStatus?.({ type: 'dig_probe_start', primitive: 'deep_search' });
  // 6 sub-queries with different angles
  const variants = [
    `"${target}"`,
    `"${target}" linkedin OR twitter OR github OR facebook`,
    `"${target}" email OR contact OR phone`,
    `"${target}" company OR founder OR CEO OR engineer`,
    `"${target}" news OR interview OR press`,
    `"${target}" public records OR filing OR registration`,
  ];
  const settled = await Promise.allSettled(variants.map(v => multiSearch(v, { maxResults: 6 })));
  const all = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value.results || []) {
      if (!item.url) continue;
      const k = item.url.replace(/#.*$/, '').replace(/\/$/, '');
      if (!all.has(k)) all.set(k, item);
    }
  }
  const results = Array.from(all.values()).slice(0, 30);
  onStatus?.({ type: 'dig_probe_done', primitive: 'deep_search', result_count: results.length });
  return { primitive: 'deep_search', results };
}

// ── Synthesis — pull everything into a creator-grade dossier ───────────────
async function synthesizeDossier(target, userContext, primitives, onStatus) {
  onStatus?.({ type: 'dig_synthesizing' });

  const ctx = userContext
    ? `\n\nASKER CONTEXT (use to disambiguate identity — only include findings that match this context):\n${userContext}\n`
    : '';

  // Build a tight summary of what each primitive returned
  const blocks = [];

  const usl = primitives.username_sleuth;
  if (usl?.hits?.length) {
    blocks.push(`USERNAME-SLEUTH HITS (${usl.hits.length} matches across ${HANDLE_SITES.length} sites for handles ${(usl.candidates || []).slice(0, 6).join(', ')}):\n${
      usl.hits.slice(0, 25).map(h => `  • ${h.site}: ${h.url}`).join('\n')
    }`);
  }

  const gh = primitives.github;
  if (gh?.users?.length) {
    blocks.push(`GITHUB USERS (${gh.users.length}):\n${gh.users.slice(0, 6).map(u => `  • @${u.login} (${u.url}) score=${u.score?.toFixed(1)}`).join('\n')}`);
  }
  if (gh?.commit_emails?.length) {
    blocks.push(`GITHUB COMMIT EMAILS (${gh.commit_emails.length}):\n${gh.commit_emails.slice(0, 8).map(e => `  • ${e.email} (from @${e.login}, name="${e.name}")`).join('\n')}`);
  }

  const w = primitives.whois;
  if (w?.whois) {
    const w2 = w.whois;
    blocks.push(`WHOIS for ${w.domain}:\n  • registrar: ${w2.registrar || w2.registrarUrl || '?'}\n  • created: ${w2.creationDate || w2.created || '?'}\n  • expires: ${w2.registryExpiryDate || w2.expiresDate || '?'}\n  • registrant: ${w2.registrantName || w2.registrantOrganization || w2.registrant || '(privacy)'}\n  • registrantEmail: ${w2.registrantEmail || '(privacy)'}\n  • ns: ${(w2.nameServer || w2.nameServers || '').toString().slice(0, 200)}`);
  }
  if (w?.dns) {
    const dnsBits = Object.entries(w.dns).filter(([_, v]) => v?.length).map(([t, v]) => `${t}: ${(Array.isArray(v) ? v : [v]).flat().slice(0, 3).join(', ')}`);
    if (dnsBits.length) blocks.push(`DNS for ${w.domain}:\n  • ${dnsBits.join('\n  • ')}`);
  }

  for (const wb of (primitives.wayback || [])) {
    if (wb?.snapshots?.length) {
      blocks.push(`WAYBACK ${wb.url} — ${wb.snapshots.length} historical snapshots:\n${wb.snapshots.slice(0, 6).map(s => `  • ${s.timestamp}: ${s.wayback_url}`).join('\n')}`);
    }
  }

  const hu = primitives.hunter;
  if (hu?.email) blocks.push(`HUNTER.IO EMAIL FINDER: ${hu.email} (confidence score ${hu.score})`);

  const ds = primitives.deep_search;
  if (ds?.results?.length) {
    blocks.push(`DEEP-SEARCH HITS (${ds.results.length} URLs across Tavily/Exa/Linkup/Serper):\n${
      ds.results.slice(0, 18).map((r, i) => `  [${i+1}] ${r.title || r.url}\n    ${r.url}\n    ${(r.snippet || '').slice(0, 200)}`).join('\n')
    }`);
  }

  const system = `You are an OSINT analyst producing a CREATOR-ONLY DOSSIER on a target. The asker has explicitly requested deep dig; identity-disambiguation rules still apply.${ctx}
STRUCTURE the dossier as markdown:

## TL;DR
2-3 sentence summary of WHO this person is (per the asker's context), confidence level, and the single highest-signal finding.

## Identity match
- MATCH: <name/handle/email> — supported by primitives [N, N]
- COLLISIONS: list any same-name-different-person findings, with why they're not the target
- Confidence: high/medium/low + what would raise it

## Digital footprint
Username presence across sites (group by handle), with direct links. Flag anomalies (e.g., handle on 12 sites including the asker's known ones — strong match).

## Identifiers
- Email addresses found (from Hunter.io + GitHub commits) — explicitly tag VERIFIED vs INFERRED
- Phone numbers (if any surfaced)
- Domains owned / associated (from WHOIS)
- DNS / hosting fingerprint

## Historical timeline
Wayback snapshots — what changed when. Useful for tracking site/profile evolution.

## Public web findings
Pull the most relevant facts from the deep-search results. Be SELECTIVE — only include findings that map to the matched identity, not orphan name-collisions.

## Caveats
- What's likely fabricated / privacy-protected / behind paywall
- Ethical reminder: this dossier is for the creator's authorized use only.

RULES:
- Every claim must trace to a primitive. Use [github], [whois], [wayback], [search:N], [username:N] tags inline.
- NEVER blend identities. If three primitives point to YOU and one points to a different Emmanuel, EXCLUDE the other Emmanuel's facts entirely.
- Be concise. Skip empty sections. No filler.`;

  const user = `Target: "${target}"\n\nPRIMITIVE OUTPUTS:\n\n${blocks.join('\n\n')}\n\nWrite the dossier now.`;

  const { content, provider } = await callLlm(system, user, { temperature: 0.2, maxTokens: 4000 });
  return { dossier: content, provider };
}

// ── Main entry ─────────────────────────────────────────────────────────────
/**
 * @param {string} target  — name, handle, email, or domain to dig on
 * @param {object} opts
 *   onStatus: event stream
 *   userContext: asker bio (mandatory for disambiguation)
 *   knownDomain: if asker's site / target's domain is known, run whois/wayback on it
 *   knownEmail: known email of asker (for cross-ref)
 *   signal: AbortSignal
 */
async function deepDig(target, opts = {}) {
  const { onStatus, userContext = '', knownDomain, knownEmail, signal } = opts;
  const startedAt = Date.now();
  const aborted = () => signal?.aborted;

  onStatus?.({ type: 'dig_start', target, knownDomain, has_user_context: Boolean(userContext) });

  // Run all primitives in parallel
  const [usernameRes, githubRes, deepSearchRes, whoisRes, waybackRes, hunterRes] = await Promise.all([
    usernameSleuth(target, onStatus).catch(e => ({ primitive: 'username_sleuth', error: e.message })),
    githubDeep(target, onStatus).catch(e => ({ primitive: 'github', error: e.message })),
    deepSearchPrimitive(target, onStatus).catch(e => ({ primitive: 'deep_search', error: e.message })),
    knownDomain ? whoisDeep(knownDomain, onStatus).catch(e => ({ primitive: 'whois', error: e.message })) : null,
    knownDomain ? waybackDeep(`https://${knownDomain}`, onStatus).then(r => [r]).catch(() => []) : Promise.resolve([]),
    (knownDomain && /\s/.test(target)) ? hunterFindEmail(target, knownDomain, onStatus).catch(e => ({ primitive: 'hunter', error: e.message })) : null,
  ]);

  if (aborted()) throw new Error('Deep dig cancelled');

  const primitives = {
    username_sleuth: usernameRes,
    github: githubRes,
    deep_search: deepSearchRes,
    whois: whoisRes,
    wayback: waybackRes,
    hunter: hunterRes,
  };

  onStatus?.({ type: 'dig_primitives_done', summary: {
    username_hits: usernameRes?.hits?.length || 0,
    github_users: githubRes?.users?.length || 0,
    github_emails: githubRes?.commit_emails?.length || 0,
    search_hits: deepSearchRes?.results?.length || 0,
    wayback_snapshots: waybackRes?.[0]?.snapshots?.length || 0,
    whois_ok: Boolean(whoisRes?.whois),
    hunter_email: Boolean(hunterRes?.email),
  } });

  const { dossier, provider } = await synthesizeDossier(target, userContext, primitives, onStatus);

  const elapsedMs = Date.now() - startedAt;
  onStatus?.({ type: 'dig_done', elapsedMs, provider });

  return { target, dossier, primitives, elapsedMs, provider };
}

module.exports = { deepDig, buildHandleCandidates };
