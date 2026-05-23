#!/usr/bin/env node
/**
 * smoke-test.js — Chaka Backend Smoke Test
 *
 * Single-command pre-deploy gate. Verifies:
 *   1. Backend boots and health check responds
 *   2. All major routes are registered (404 = missing, 401 = auth working)
 *   3. Database connectivity (Turso reachable)
 *   4. Personality data is loadable
 *   5. Live config returns the expected tools (search_web, set_vision, etc.)
 *   6. Model router logic (Claude vs Gemini routing)
 *   7. Capabilities injection logic
 *
 * Usage:
 *   node smoke-test.js              # against http://localhost:3000
 *   BASE=https://my-deploy.com node smoke-test.js
 *
 * Exit code 0 = all pass, 1 = any failure.
 */

require('dotenv').config();

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');

// ──────────────────────────────────────────────────────────────────────────
// Pretty output
// ──────────────────────────────────────────────────────────────────────────
const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', GRAY = '\x1b[90m', BOLD = '\x1b[1m';

const results = [];
let groupName = '';

function group(name) {
  groupName = name;
  console.log(`\n${BOLD}${name}${RESET}`);
}

function pass(name, detail = '') {
  results.push({ name, ok: true, group: groupName });
  console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${GRAY}— ${detail}${RESET}` : ''}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, group: groupName, detail });
  console.log(`  ${RED}✗${RESET} ${name}${detail ? ` ${RED}— ${detail}${RESET}` : ''}`);
}

function warn(name, detail) {
  console.log(`  ${YELLOW}!${RESET} ${name}${detail ? ` ${YELLOW}— ${detail}${RESET}` : ''}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
async function timed(fn) {
  const t = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t };
}

async function check(name, method, path, expectedStatus, body = null) {
  try {
    const opts = { method };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const { result: res, ms } = await timed(() => fetch(`${BASE}${path}`, opts));
    const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (expected.includes(res.status)) {
      pass(name, `HTTP ${res.status} in ${ms}ms`);
      return res;
    }
    fail(name, `expected HTTP ${expected.join('|')}, got ${res.status}`);
    return res;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`${BOLD}Chaka Backend Smoke Test${RESET}`);
  console.log(`${GRAY}Target: ${BASE}${RESET}`);
  const startedAt = Date.now();

  // 1. Server alive
  group('1. Server health');
  await check('Health check responds', 'GET', '/', 200);

  // 2. All major routes registered
  group('2. Route registration (401 = guarded, 404 = missing)');
  await check('POST /api/chat',              'POST', '/api/chat',                 [400, 401, 503], { contents: [] });
  await check('POST /api/rag/embed',         'POST', '/api/rag/embed',            [400, 401]);
  await check('POST /api/tools/search',      'POST', '/api/tools/search',         401);
  await check('POST /api/tools/tts',         'POST', '/api/tools/tts',            401);
  await check('POST /api/tools/image',       'POST', '/api/tools/image',          401);
  await check('POST /api/tools/youtube',     'POST', '/api/tools/youtube',        401);
  await check('POST /api/tools/email',       'POST', '/api/tools/email',          401);
  await check('POST /api/tools/scrape-url',  'POST', '/api/tools/scrape-url',     401);
  await check('POST /api/tools/whisper',     'POST', '/api/tools/whisper',        401);
  await check('POST /api/tools/memory',      'POST', '/api/tools/memory',         401);
  await check('POST /api/tools/reflection',  'POST', '/api/tools/reflection',     401);
  await check('GET  /api/tools/live/config', 'GET',  '/api/tools/live/config',    401);
  await check('POST /api/vision/screen',     'POST', '/api/vision/screen',        401);
  await check('POST /api/vision/webcam',     'POST', '/api/vision/webcam',        401);
  await check('POST /api/vision/ocr',        'POST', '/api/vision/ocr',           401);
  await check('POST /api/vision/objects',    'POST', '/api/vision/objects',       401);
  await check('GET  /api/vision/memory',     'GET',  '/api/vision/memory',        401);
  await check('POST /api/vision/surveillance','POST','/api/vision/surveillance', 401);
  await check('POST /api/hands/browser/navigate',  'POST', '/api/hands/browser/navigate',   401);
  await check('POST /api/hands/browser/screenshot','POST', '/api/hands/browser/screenshot', 401);
  await check('POST /api/hands/browser/click',     'POST', '/api/hands/browser/click',      401);
  await check('POST /api/hands/browser/fill',      'POST', '/api/hands/browser/fill',       401);
  await check('POST /api/hands/browser/extract',   'POST', '/api/hands/browser/extract',    401);
  await check('POST /api/hands/agent',             'POST', '/api/hands/agent',              401);
  await check('POST /api/hands/act',               'POST', '/api/hands/act',                401);
  await check('POST /api/hands/observe',           'POST', '/api/hands/observe',            401);
  await check('POST /api/hands/extract-ai',        'POST', '/api/hands/extract-ai',         401);
  await check('POST /api/hands/session/close',     'POST', '/api/hands/session/close',      401);
  await check('GET  /api/hands/credentials',       'GET',  '/api/hands/credentials',        401);
  await check('POST /api/hands/credentials',       'POST', '/api/hands/credentials',        401);
  await check('DELETE /api/hands/credentials',     'DELETE','/api/hands/credentials',       401);
  await check('GET  /api/db/personalities',  'GET',  '/api/db/personalities',     [200, 401]);

  // 3. Database connectivity
  group('3. Database connectivity (Turso)');
  try {
    const res = await fetch(`${BASE}/api/db/personalities`);
    if (res.ok) {
      const data = await res.json();
      const items = Array.isArray(data) ? data : (data.personalities || []);
      if (items.length > 0) {
        pass('Turso reachable and personalities table populated', `${items.length} personalities`);
        const withPrompt = items.filter(p => (p.systemPrompt || p.persona || '').length > 100);
        if (withPrompt.length === 0) {
          warn('No personality has a substantial systemPrompt — Chaka will run naked');
        } else {
          pass('At least one personality has a real systemPrompt', `${withPrompt.length}/${items.length}`);
        }
        const hasDefault = items.some(p => p.isDefault);
        if (!hasDefault) {
          warn('No personality marked as default — relying on frontend fallback');
        } else {
          pass('A default personality is configured');
        }
      } else {
        fail('Turso reachable but personalities table is empty');
      }
    } else {
      fail('Could not load personalities', `HTTP ${res.status}`);
    }
  } catch (e) {
    fail('Could not load personalities', e.message);
  }

  // 4. Live config (the heart of the vision integration)
  group('4. Live mode configuration');
  try {
    // Live config is gated — try with a bearer token if available
    const res = await fetch(`${BASE}/api/tools/live/config?persona=&userId=test&voiceId=Puck`);
    if (res.status === 401) {
      warn('Live config is auth-gated (expected) — skipping deep check', '401');
    } else if (res.ok) {
      const data = await res.json();
      if (data.tools && data.tools[0]?.function_declarations) {
        const fnNames = data.tools[0].function_declarations.map(f => f.name);
        const required = ['search_web', 'scrape_url', 'set_vision', 'end_conversation'];
        const missing = required.filter(n => !fnNames.includes(n));
        if (missing.length === 0) {
          pass('Live tools include all expected functions', fnNames.join(', '));
        } else {
          fail('Live tools missing functions', `missing: ${missing.join(', ')}`);
        }
      } else {
        fail('Live config returned but has no function_declarations');
      }
    } else {
      fail('Live config unreachable', `HTTP ${res.status}`);
    }
  } catch (e) {
    fail('Live config check threw', e.message);
  }

  // 5. Model router logic (in-process — no HTTP)
  group('5. Model router logic');
  try {
    const { routeRequest, detectImage } = require('./src/services/modelRouter');
    const { isClaudeAvailable } = require('./src/services/claudeService');

    const claudeReady = isClaudeAvailable();
    if (claudeReady) {
      pass('Claude is configured (ANTHROPIC_API_KEY present)');
    } else {
      warn('Claude not configured — Gemini-only routing (expected if no funds yet)');
    }

    const cases = [
      { label: 'voice → Gemini',  args: { voiceInput: true, contents: [] }, expectBrain: 'gemini' },
      { label: 'image → Gemini',  args: { hasImage: true, contents: [] },   expectBrain: 'gemini' },
      { label: 'gemini explicit', args: { model: 'gemini-2.5-flash', contents: [] }, expectBrain: 'gemini' },
      { label: 'general chat',    args: { contents: [{ role:'user', parts:[{ text:'hey' }] }] }, expectBrain: 'gemini' },
    ];
    if (claudeReady) {
      cases.push({ label: 'claude explicit', args: { model: 'claude-sonnet-4-6', contents: [] }, expectBrain: 'claude' });
      cases.push({ label: 'code → Claude',   args: { contents: [{ role:'user', parts:[{ text:'write code to sort an array' }] }] }, expectBrain: 'claude' });
    }
    for (const c of cases) {
      const r = routeRequest(c.args);
      if (r.brain === c.expectBrain) pass(`Router: ${c.label}`, `→ ${r.brain}`);
      else fail(`Router: ${c.label}`, `expected ${c.expectBrain}, got ${r.brain}`);
    }

    // detectImage
    if (detectImage([{ role:'user', parts:[{ inlineData: { data: 'x', mimeType: 'image/jpeg' } }] }])) pass('detectImage: positive case');
    else fail('detectImage: positive case');
    if (!detectImage([{ role:'user', parts:[{ text: 'hi' }] }])) pass('detectImage: negative case');
    else fail('detectImage: negative case');
  } catch (e) {
    fail('Model router import failed', e.message);
  }

  // 6. Capabilities injector
  group('6. Capabilities injector');
  try {
    const { injectCapabilities, MARKER } = require('./src/utils/capabilities');

    // Empty contents → returns unchanged
    const empty = [];
    injectCapabilities(empty);
    if (empty.length === 0) pass('Idempotent on empty input');
    else fail('Should not modify empty input', `length=${empty.length}`);

    // Long first user message → appends to existing
    const single = [{ role: 'user', parts: [{ text: 'a'.repeat(200) }] }];
    injectCapabilities(single);
    if (single[0].parts[0].text.includes(MARKER)) pass('Appends to existing system prompt');
    else fail('Failed to append capabilities to first message');

    // Idempotency: calling again should NOT double-inject
    const before = single[0].parts[0].text.length;
    injectCapabilities(single);
    const after = single[0].parts[0].text.length;
    if (before === after) pass('Idempotent on second call', 'no double-inject');
    else fail('Double-injected capabilities!', `${before} → ${after} chars`);

    // No system prompt → prepends synthetic system turn
    const noSystem = [{ role: 'user', parts: [{ text: 'hi' }] }];
    injectCapabilities(noSystem);
    if (noSystem.length === 3 && noSystem[0].parts[0].text.includes(MARKER)) pass('Prepends synthetic system turn when no system prompt');
    else fail('Did not handle missing system prompt', `length=${noSystem.length}`);
  } catch (e) {
    fail('Capabilities injector import failed', e.message);
  }

  // 7. Marker regex (agentic vision + hands)
  group('7. Agentic marker regex');
  try {
    const EYES_RE  = /(?:\[\[|<<)EYES:(webcam|screen|ocr)(?:\]\]|>>)/i;
    const HANDS_RE = /(?:\[\[|<<)HANDS:(browse|screenshot):([^\]>]+?)(?:\]\]|>>)/i;

    const eyesCases = [
      { input: 'Let me have a look at you…\n\n[[EYES:webcam]]', expect: 'webcam' },
      { input: 'Sure, taking a look at your screen…\n[[EYES:screen]]', expect: 'screen' },
      { input: 'Reading text…\n[[EYES:ocr]]', expect: 'ocr' },
      { input: 'legacy syntax <<EYES:webcam>>', expect: 'webcam' },
      { input: 'just a normal response with no marker', expect: null },
    ];
    for (const c of eyesCases) {
      const m = c.input.match(EYES_RE);
      const got = m ? m[1].toLowerCase() : null;
      if (got === c.expect) pass(`EYES: "${c.input.slice(0,40)}…"`, `→ ${got || 'no match'}`);
      else fail(`EYES: "${c.input.slice(0,40)}…"`, `expected ${c.expect}, got ${got}`);
    }

    const handsCases = [
      { input: 'Let me check…\n\n[[HANDS:browse:example.com]]', action: 'browse', target: 'example.com' },
      { input: 'One sec…\n[[HANDS:browse:https://github.com/foo/bar]]', action: 'browse', target: 'https://github.com/foo/bar' },
      { input: 'Taking a look…\n[[HANDS:screenshot:news.ycombinator.com]]', action: 'screenshot', target: 'news.ycombinator.com' },
      { input: 'normal response no marker', action: null, target: null },
    ];
    for (const c of handsCases) {
      const m = c.input.match(HANDS_RE);
      const action = m ? m[1].toLowerCase() : null;
      const target = m ? m[2].trim() : null;
      if (action === c.action && target === c.target) pass(`HANDS: "${c.input.slice(0,40)}…"`, `→ ${action || 'no match'}${target ? `:${target}` : ''}`);
      else fail(`HANDS: "${c.input.slice(0,40)}…"`, `expected ${c.action}/${c.target}, got ${action}/${target}`);
    }

    // JSON unwrap test — Chaka hallucinates JSON wrapping even with plainText
    const KNOWN = ['final_answer','summary','description','text','response','answer','message','content','result'];
    function unwrap(raw) {
      if (!raw) return raw;
      const t = raw.trim();
      if (!t.startsWith('{')) return raw;
      try {
        const json = JSON.parse(t);
        for (const k of KNOWN) {
          if (typeof json[k] === 'string' && json[k].length > 0) return json[k];
        }
        const strings = Object.values(json).filter(v => typeof v === 'string');
        if (strings.length === 1) return strings[0];
        if (strings.length > 1) return strings.reduce((a, b) => a.length >= b.length ? a : b);
      } catch {}
      return raw;
    }
    const unwrapCases = [
      { raw: '{"final_answer": "hello"}', expect: 'hello' },
      { raw: '{"summary": "Jomiez is a software company"}', expect: 'Jomiez is a software company' },
      { raw: '{"description": "test"}', expect: 'test' },
      { raw: 'plain prose with no JSON wrap', expect: 'plain prose with no JSON wrap' },
    ];
    for (const c of unwrapCases) {
      const got = unwrap(c.raw);
      if (got === c.expect) pass(`unwrap: "${c.raw.slice(0,40)}…"`, '→ clean');
      else fail(`unwrap: "${c.raw.slice(0,40)}…"`, `expected "${c.expect}", got "${got}"`);
    }

    // Legacy schema bridge test — script25.js action_required pattern (multi-kind)
    function bridge(raw) {
      try {
        const t = raw.trim();
        if (!t.startsWith('{')) return null;
        const json = JSON.parse(t);
        const action = (json.action_required || '').toLowerCase();
        const payload = json.action_payload;
        const VISION = { look_webcam: 'webcam', look_screen: 'screen', ocr_screen: 'ocr' };
        const BROWSE = new Set(['browse','browse_url','navigate','open_url','scrape']);
        const AGENT = new Set(['agent_task','agent','autonomous_task']);
        if (!action || action === 'none') return null;
        if (VISION[action]) return { kind: 'eyes', source: VISION[action] };
        if (AGENT.has(action) && typeof payload === 'string') return { kind: 'agent', task: payload };
        if (BROWSE.has(action) && typeof payload === 'string') return { kind: 'hands', action: 'browse', target: payload };
        if (action === 'screenshot' && typeof payload === 'string') return { kind: 'hands', action: 'screenshot', target: payload };
        return null;
      } catch { return null; }
    }
    const bridgeCases = [
      { raw: '{"final_answer":"Okay","action_required":"browse_url","action_payload":"jomiez.com/resume"}', expect: { kind: 'hands', action: 'browse', target: 'jomiez.com/resume' } },
      { raw: '{"final_answer":"Okay","action_required":"browse","action_payload":"jomiez.com"}', expect: { kind: 'hands', action: 'browse', target: 'jomiez.com' } },
      { raw: '{"final_answer":"Let me look","action_required":"look_webcam","action_payload":""}', expect: { kind: 'eyes', source: 'webcam' } },
      { raw: '{"final_answer":"Reading","action_required":"ocr_screen","action_payload":""}', expect: { kind: 'eyes', source: 'ocr' } },
      { raw: '{"final_answer":"On it","action_required":"agent_task","action_payload":"sign up on example.com"}', expect: { kind: 'agent', task: 'sign up on example.com' } },
      { raw: '{"final_answer":"hi","action_required":"none","action_payload":""}', expect: null },
      { raw: 'plain text', expect: null },
    ];
    // Credential vault encryption roundtrip (Phase 4E)
    try {
      const vault = require('./src/services/credentialVault');
      const plaintext = 'super-secret-instagram-password-!@#$';
      const ct = vault._encrypt(plaintext);
      if (ct === plaintext) fail('Vault encrypt: produced plaintext', 'no encryption occurred');
      else pass('Vault encrypt: produces non-plaintext ciphertext');
      const pt = vault._decrypt(ct);
      if (pt === plaintext) pass('Vault decrypt: roundtrip recovers original');
      else fail('Vault decrypt: roundtrip mismatch', `got "${pt}"`);
      // Tampered ciphertext should fail
      try {
        vault._decrypt(ct.replace(/.$/, 'X'));
        fail('Vault decrypt: tampered ciphertext should have thrown');
      } catch { pass('Vault decrypt: rejects tampered ciphertext (AEAD working)'); }
    } catch (e) {
      fail('Vault module load/test failed', e.message);
    }

    // AGENT marker regex
    const AGENT_RE = /(?:\[\[|<<)HANDS:agent:([\s\S]+?)(?:\]\]|>>)/i;
    const agentCases = [
      { input: 'On it…\n\n[[HANDS:agent:go to example.com, sign up with email tim@test.com]]', expect: 'go to example.com, sign up with email tim@test.com' },
      { input: 'plain reply no marker', expect: null },
    ];
    for (const c of agentCases) {
      const m = c.input.match(AGENT_RE);
      const task = m ? m[1].trim() : null;
      if (task === c.expect) pass(`AGENT marker: "${c.input.slice(0,40)}…"`, task ? `→ ${task.slice(0,40)}` : '→ no match');
      else fail(`AGENT marker: "${c.input.slice(0,40)}…"`, `expected ${c.expect}, got ${task}`);
    }
    for (const c of bridgeCases) {
      const got = bridge(c.raw);
      const ok = (got === null && c.expect === null) ||
                 (got && c.expect && JSON.stringify(got) === JSON.stringify(c.expect));
      if (ok) pass(`bridge: "${c.raw.slice(0,50)}…"`, got ? `→ ${JSON.stringify(got)}` : '→ null');
      else fail(`bridge: "${c.raw.slice(0,50)}…"`, `expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`);
    }
  } catch (e) {
    fail('Marker regex test failed', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Phase 5 — Advanced Scraping
  // ──────────────────────────────────────────────────────────────────────
  group = 'Phase5-Scraper';
  try {
    const scraperSvc = require('./src/services/scraperService');
    pass('scraperService: module loads');
    if (typeof scraperSvc.scrape === 'function') pass('scraperService: scrape() exported');
    else fail('scraperService: scrape() missing');
    if (typeof scraperSvc.batchScrape === 'function') pass('scraperService: batchScrape() exported');
    else fail('scraperService: batchScrape() missing');
    if (typeof scraperSvc.urlHash === 'function') pass('scraperService: urlHash() exported');
    else fail('scraperService: urlHash() missing');

    const h1 = scraperSvc.urlHash('https://example.com/test');
    const h2 = scraperSvc.urlHash('https://example.com/test');
    if (h1 === h2) pass('urlHash: deterministic (same URL → same hash)');
    else fail('urlHash: not deterministic', `${h1} vs ${h2}`);
    if (/^[0-9a-f]{32}$/.test(h1)) pass('urlHash: 32-char lowercase hex');
    else fail('urlHash: bad format', h1);
    const h3 = scraperSvc.urlHash('https://other.com/different-page');
    if (h1 !== h3) pass('urlHash: different URLs → different hashes');
    else fail('urlHash: collision on different URLs');

    require('./src/controllers/scraperController');
    pass('scraperController: module loads');
    require('./src/routes/scraperRoutes');
    pass('scraperRoutes: module loads');
  } catch (e) {
    fail('Phase5 module load', e.message);
  }

  try {
    const SCRAPE_RE = /(?:\[\[|<<)SCRAPE:(https?:\/\/[^\]>]+?)(?:\]\]|>>)/i;
    const STRIP_RE  = /(?:\[\[|<<)(?:EYES:(?:webcam|screen|ocr)|HANDS:(?:browse|screenshot):[^\]>]+?|HANDS:agent:[\s\S]+?|SCRAPE:https?:\/\/[^\]>]+?)(?:\]\]|>>)/gi;

    const scrapeCases = [
      { input: 'Let me read that…\n\n[[SCRAPE:https://techcrunch.com/article]]', expectUrl: 'https://techcrunch.com/article' },
      { input: '<<SCRAPE:https://bbc.com/news/123>>', expectUrl: 'https://bbc.com/news/123' },
      { input: '[[HANDS:browse:example.com]]', expectUrl: null },
      { input: '[[EYES:screen]]', expectUrl: null },
      { input: 'no marker here', expectUrl: null },
    ];
    for (const c of scrapeCases) {
      const m = c.input.match(SCRAPE_RE);
      const got = m ? m[1] : null;
      if (got === c.expectUrl) pass(`SCRAPE_RE: "${c.input.slice(0, 50)}"`, got ? `→ ${got}` : '→ no match');
      else fail(`SCRAPE_RE: "${c.input.slice(0, 50)}"`, `expected ${c.expectUrl}, got ${got}`);
    }

    const stripped = '[[SCRAPE:https://example.com/article]] rest of text'.replace(STRIP_RE, '').trim();
    if (stripped === 'rest of text') pass('STRIP_RE: strips [[SCRAPE:url]] markers');
    else fail('STRIP_RE: did not strip SCRAPE marker', `got "${stripped}"`);

    const caps = require('./src/utils/capabilities');
    if (caps.MARKER === '<<CHAKA_TOOLS_v16>>') pass('capabilities: MARKER bumped to v16');
    else fail('capabilities: MARKER not v16', caps.MARKER);
    if (caps.TOOLS_BRIEF.includes('HARD BOT-BLOCK')) pass('capabilities: hard bot-block section present');
    else fail('capabilities: missing hard bot-block section');
    if (caps.TOOLS_BRIEF.includes('WHICH WEB TOOL TO USE')) pass('capabilities: tool-selection decision guide present');
    else fail('capabilities: missing tool-selection decision guide');
    if (caps.TOOLS_BRIEF.includes('[[RESEARCH:')) pass('capabilities: [[RESEARCH:]] marker documented');
    else fail('capabilities: missing [[RESEARCH:]] marker doc');
    if (caps.TOOLS_BRIEF.includes('ANTI-LAZINESS RULE')) pass('capabilities: anti-laziness rule present');
    else fail('capabilities: missing anti-laziness rule');
    if (caps.TOOLS_BRIEF.includes('solve_visual_puzzle')) pass('capabilities: documents solve_visual_puzzle');
    else fail('capabilities: missing solve_visual_puzzle documentation');
    if (caps.TOOLS_BRIEF.includes('NEVER-GIVE-UP RULE')) pass('capabilities: never-give-up rule for captchas present');
    else fail('capabilities: missing never-give-up rule');
    if (caps.TOOLS_BRIEF.includes('[[SCRAPE:')) pass('capabilities: TOOLS_BRIEF includes [[SCRAPE]] example');
    else fail('capabilities: TOOLS_BRIEF missing [[SCRAPE]] example');
    if (caps.TOOLS_BRIEF.includes('wait_for_verification_email')) pass('capabilities: TOOLS_BRIEF documents wait_for_verification_email');
    else fail('capabilities: TOOLS_BRIEF missing wait_for_verification_email');
    if (caps.TOOLS_BRIEF.includes('solve_captcha_on_page')) pass('capabilities: TOOLS_BRIEF documents solve_captcha_on_page');
    else fail('capabilities: TOOLS_BRIEF missing solve_captcha_on_page');
  } catch (e) {
    fail('Phase5 marker/caps tests', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Phase 5.5 — Reliability Pack (captcha + email + humanize)
  // ──────────────────────────────────────────────────────────────────────
  group = 'Phase5.5-Reliability';
  try {
    const captcha = require('./src/services/captchaSolver');
    pass('captchaSolver: module loads');
    if (typeof captcha.isConfigured === 'function') pass('captchaSolver: isConfigured() exported');
    else fail('captchaSolver: isConfigured() missing');
    if (typeof captcha.solveRecaptchaV2 === 'function') pass('captchaSolver: solveRecaptchaV2() exported');
    else fail('captchaSolver: solveRecaptchaV2() missing');
    if (typeof captcha.detectAndSolve === 'function') pass('captchaSolver: detectAndSolve() exported');
    else fail('captchaSolver: detectAndSolve() missing');

    // Without API key, all solvers must return null gracefully (no crash)
    const savedKey = process.env.TWOCAPTCHA_API_KEY;
    delete process.env.TWOCAPTCHA_API_KEY;
    if (!captcha.isConfigured()) pass('captchaSolver: graceful when key not set');
    else fail('captchaSolver: should report unconfigured without key');
    const r = await captcha.solveRecaptchaV2('dummy', 'https://example.com');
    if (r === null) pass('captchaSolver: solveRecaptchaV2 returns null without key');
    else fail('captchaSolver: should return null without key', String(r));
    if (savedKey) process.env.TWOCAPTCHA_API_KEY = savedKey;

    const email = require('./src/services/emailVerifier');
    pass('emailVerifier: module loads');
    if (typeof email.isConfigured === 'function') pass('emailVerifier: isConfigured() exported');
    else fail('emailVerifier: isConfigured() missing');
    if (typeof email.waitForVerificationEmail === 'function') pass('emailVerifier: waitForVerificationEmail() exported');
    else fail('emailVerifier: waitForVerificationEmail() missing');

    // Code extraction tests
    if (email.extractCode('Your verification code is 482917 — enter it on the page') === '482917')
      pass('emailVerifier: extractCode finds keyword+digits');
    else fail('emailVerifier: extractCode failed on keyword pattern');
    if (email.extractCode('OTP: 123456') === '123456') pass('emailVerifier: extractCode finds OTP pattern');
    else fail('emailVerifier: extractCode OTP failed');
    if (email.extractCode('plain text no digits') === null) pass('emailVerifier: extractCode returns null when no code');
    else fail('emailVerifier: extractCode should return null');

    // Link extraction
    const link = email.extractLink('Click here to verify your account', '<a href="https://example.com/verify?token=abc123">Verify</a>', 'example.com');
    if (link && link.includes('verify')) pass('emailVerifier: extractLink finds verify URL');
    else fail('emailVerifier: extractLink failed', String(link));

    // humanize utility
    const humanize = require('./src/utils/humanize');
    pass('humanize: module loads');
    const d = humanize.humanDelay('click');
    if (d >= 180 && d <= 520) pass('humanize: humanDelay(click) within bounds');
    else fail('humanize: click delay out of bounds', String(d));
    const j = humanize.jitterCoord(100, 200);
    if (Math.abs(j.x - 100) <= 6 && Math.abs(j.y - 200) <= 5) pass('humanize: jitterCoord within ±6/5px');
    else fail('humanize: jitter out of bounds', JSON.stringify(j));
  } catch (e) {
    fail('Phase5.5 reliability tests', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Phase 5.6 — Visual puzzle solver (Gemini Vision)
  // ──────────────────────────────────────────────────────────────────────
  group = 'Phase5.6-VisualPuzzle';
  try {
    const vp = require('./src/services/visualPuzzleSolver');
    pass('visualPuzzleSolver: module loads');
    if (typeof vp.analyzePuzzle === 'function') pass('visualPuzzleSolver: analyzePuzzle() exported');
    else fail('visualPuzzleSolver: analyzePuzzle() missing');
    if (typeof vp.executeSolution === 'function') pass('visualPuzzleSolver: executeSolution() exported');
    else fail('visualPuzzleSolver: executeSolution() missing');
    if (typeof vp.parseResponse === 'function') pass('visualPuzzleSolver: parseResponse() exported');
    else fail('visualPuzzleSolver: parseResponse() missing');

    // Parser: checkbox solution
    const r1 = vp.parseResponse('[TYPE]: checkbox\n[ACTION]: Click the I\'m not a robot checkbox\n[COORDS]: 420, 360\n[CONFIDENCE]: high');
    if (r1.puzzle_type === 'checkbox' && r1.coords?.[0] === 420 && r1.coords?.[1] === 360 && r1.confidence === 'high')
      pass('parseResponse: checkbox + coords + confidence');
    else fail('parseResponse: checkbox parse mismatch', JSON.stringify(r1));

    // Parser: slider with drag path
    const r2 = vp.parseResponse('[TYPE]: slider\n[ACTION]: drag right\n[DRAG_FROM]: 100, 200\n[DRAG_TO]: 300, 200\n[CONFIDENCE]: medium');
    if (r2.puzzle_type === 'slider' && r2.drag_from?.[0] === 100 && r2.drag_to?.[0] === 300)
      pass('parseResponse: slider drag_from + drag_to');
    else fail('parseResponse: slider parse mismatch', JSON.stringify(r2));

    // Parser: press-hold
    const r3 = vp.parseResponse('[TYPE]: press_hold\n[ACTION]: hold the button\n[COORDS]: 500, 500\n[HOLD_MS]: 2000\n[CONFIDENCE]: high');
    if (r3.puzzle_type === 'press_hold' && r3.hold_ms === 2000) pass('parseResponse: press_hold + hold_ms');
    else fail('parseResponse: press_hold parse mismatch', JSON.stringify(r3));

    // Parser: image_select (legacy grid format)
    const r4 = vp.parseResponse('[TYPE]: image_select\n[ACTION]: pick traffic lights\n[IMAGES]: 1,3,5,7\n[CONFIDENCE]: medium');
    if (r4.puzzle_type === 'image_select' && JSON.stringify(r4.images_to_select) === '[1,3,5,7]')
      pass('parseResponse: image_select grid positions (legacy)');
    else fail('parseResponse: image_select legacy mismatch', JSON.stringify(r4));

    // Parser: image_select (Phase 5.6.1 — pixel CLICK lines + SUBMIT_COORDS)
    const r4b = vp.parseResponse('[TYPE]: image_select\n[ACTION]: Click ducks then submit\n[CLICK]: 320, 400\n[CLICK]: 480, 400\n[CLICK]: 320, 560\n[SUBMIT_COORDS]: 555, 740\n[CONFIDENCE]: high');
    if (r4b.puzzle_type === 'image_select' &&
        r4b.clicks?.length === 3 &&
        r4b.clicks[0][0] === 320 && r4b.clicks[2][1] === 560 &&
        r4b.submit_coords?.[0] === 555 && r4b.submit_coords?.[1] === 740)
      pass('parseResponse: image_select pixel clicks + submit_coords');
    else fail('parseResponse: image_select pixel format mismatch', JSON.stringify(r4b));

    // Parser: none (no puzzle)
    const r5 = vp.parseResponse('[TYPE]: none\n[CONFIDENCE]: high');
    if (r5.puzzle_type === 'none') pass('parseResponse: none case');
    else fail('parseResponse: none case mismatch', JSON.stringify(r5));
  } catch (e) {
    fail('Phase5.6 visual puzzle tests', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Phase 6 — Deep research (Grok-style multi-source orchestrator)
  // ──────────────────────────────────────────────────────────────────────
  group = 'Phase6-Research';
  try {
    const research = require('./src/services/deepResearchService');
    pass('deepResearchService: module loads');
    if (typeof research.deepResearch === 'function') pass('deepResearchService: deepResearch() exported');
    else fail('deepResearchService: deepResearch() missing');
    if (typeof research.callLlm === 'function') pass('deepResearchService: callLlm() exported');
    else fail('deepResearchService: callLlm() missing');
    if (typeof research.safeJsonExtract === 'function') pass('deepResearchService: safeJsonExtract() exported');
    else fail('deepResearchService: safeJsonExtract() missing');

    // safeJsonExtract robustness
    const j1 = research.safeJsonExtract('{"queries":["a","b"]}');
    if (j1?.queries?.length === 2) pass('safeJsonExtract: pure JSON');
    else fail('safeJsonExtract: pure JSON parse failed');
    const j2 = research.safeJsonExtract('Here is the JSON: {"queries":["x"]} done!');
    if (j2?.queries?.[0] === 'x') pass('safeJsonExtract: JSON embedded in prose');
    else fail('safeJsonExtract: embedded JSON parse failed');
    const j3 = research.safeJsonExtract('no json here', { queries: ['fallback'] });
    if (j3?.queries?.[0] === 'fallback') pass('safeJsonExtract: returns fallback when no JSON');
    else fail('safeJsonExtract: fallback failed');

    require('./src/controllers/researchController');
    pass('researchController: module loads');
    require('./src/routes/researchRoutes');
    pass('researchRoutes: module loads');
  } catch (e) {
    fail('Phase6 module load', e.message);
  }

  // Phase 6 frontend marker regex (mirrors agentic-vision.js)
  try {
    const RESEARCH_RE = /(?:\[\[|<<)RESEARCH:([\s\S]+?)(?:\]\]|>>)/i;
    const cases = [
      { in: 'On it.\n\n[[RESEARCH:find me everything about Ezinna Nweke]]', expect: 'find me everything about Ezinna Nweke' },
      { in: '<<RESEARCH:dig up info on jomiez>>', expect: 'dig up info on jomiez' },
      { in: '[[SCRAPE:https://example.com]]', expect: null },
      { in: '[[HANDS:browse:example.com]]', expect: null },
      { in: 'no marker here', expect: null },
    ];
    for (const c of cases) {
      const m = c.in.match(RESEARCH_RE);
      const got = m ? m[1].trim() : null;
      if (got === c.expect) pass(`RESEARCH_RE: "${c.in.slice(0, 50)}"`);
      else fail(`RESEARCH_RE: "${c.in.slice(0, 50)}"`, `expected ${c.expect}, got ${got}`);
    }

    // STRIP_RE should also strip RESEARCH markers
    const STRIP_RE = /(?:\[\[|<<)(?:EYES:(?:webcam|screen|ocr)|HANDS:(?:browse|screenshot):[^\]>]+?|HANDS:agent:[\s\S]+?|SCRAPE:https?:\/\/[^\]>]+?|RESEARCH:[\s\S]+?)(?:\]\]|>>)/gi;
    const stripped = '[[RESEARCH:find me X]] post text'.replace(STRIP_RE, '').trim();
    if (stripped === 'post text') pass('STRIP_RE: strips [[RESEARCH:...]] markers');
    else fail('STRIP_RE: did not strip RESEARCH marker', `got "${stripped}"`);
  } catch (e) {
    fail('Phase6 marker regex tests', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const totalMs = Date.now() - startedAt;

  console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  if (failed.length === 0) {
    console.log(`${GREEN}${BOLD}✓ ${passed} checks passed${RESET} ${GRAY}in ${totalMs}ms${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}✗ ${failed.length} of ${results.length} checks failed${RESET} ${GRAY}in ${totalMs}ms${RESET}`);
    for (const f of failed) {
      console.log(`  ${RED}•${RESET} [${f.group}] ${f.name} — ${f.detail || ''}`);
    }
    console.log();
    process.exit(1);
  }
})();
