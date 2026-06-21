/**
 * handsController.js — HTTP layer for Chaka's Browser Hands (Phase 4)
 *
 * All endpoints are auth-gated via verifyToken at the route level.
 * Returns clean 400 on validation failures, 500 on browser/network errors.
 */

const browser = require('../services/browserService');
const stagehand = require('../services/stagehandService');
const vault = require('../services/credentialVault');

// POST /api/hands/agent  (Server-Sent Events)
// Streams per-step progress + screenshots while the autonomous agent works.
// Body: { task, maxSteps?, startUrl?, mode?, variables?, useCredentials? (service name to auto-load from vault) }
exports.handleAgent = async (req, res) => {
  const { task, maxSteps, startUrl, mode, variables: extraVars, useCredentials } = req.body || {};
  if (!task || typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'task (string) is required' });
  }
  const userId = req.user?.uid || 'anonymous';

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch { /* client gone */ }
  };

  let closed = false;
  req.on('close', () => { closed = true; });

  // Auto-load credentials from vault if requested
  // useCredentials can be a string ("instagram") or array (["instagram", "github"])
  let variables = { ...(extraVars || {}) };
  if (useCredentials) {
    const services = Array.isArray(useCredentials) ? useCredentials : [useCredentials];
    for (const service of services) {
      try {
        const v = await vault.getServiceVariables({ userId, service });
        variables = { ...variables, ...v };
        console.log(`[handsController.agent] loaded ${Object.keys(v).length} credentials for service=${service}`);
      } catch (e) {
        console.warn(`[handsController.agent] vault load failed for ${service}:`, e.message);
      }
    }
  }

  // Get the actual model name for the frontend badge
  const modelName = stagehand.getActiveModelName?.() || 'gemini-2.5-flash';

  send('start', { task, mode: mode || 'hybrid', startUrl: startUrl || null, hasCredentials: Object.keys(variables).length > 0, modelName });

  // Track whether we've already emitted a 2FA/captcha alert this run so
  // we don't spam the user with the same event on every step.
  let notifiedState = null;

  // Phase 5.8 — Heartbeat: fire every 8s with elapsed-since-last-step so the
  // frontend knows the backend is alive when LLM provider chain is slow
  // (e.g. Groq 429 → fallthrough to Cerebras → Sambanova all serial).
  let lastStepTs = Date.now();
  let currentStepNum = 0;
  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    const elapsedSinceStep = Date.now() - lastStepTs;
    // Only emit heartbeat if we've gone > 10s without a step (otherwise step events
    // are arriving normally — no need to nag).
    if (elapsedSinceStep > 10_000) {
      send('heartbeat', {
        elapsed_since_last_step_ms: elapsedSinceStep,
        current_step: currentStepNum,
        message: `LLM provider chain is slow today — still working on step ${currentStepNum || '?'} (${Math.round(elapsedSinceStep / 1000)}s)`,
      });
    }
  }, 8000);

  try {
    const result = await stagehand.runAgent(task, {
      userId,
      mode: mode || 'hybrid',
      maxSteps: maxSteps || 35,
      startUrl,
      variables,
      liveFps: 6, // 6fps live preview to the frontend
      onFrame: async (payload) => {
        if (closed) return;
        send('frame', payload);
      },
      onStep: async (payload) => {
        if (closed) return;
        lastStepTs = Date.now();         // reset heartbeat timer
        currentStepNum = payload.step || (currentStepNum + 1);
        send('step', payload);

        // Detect 2FA or CAPTCHA and notify user — they'll need to intervene
        if (payload.pageState && payload.pageState !== 'normal' && payload.pageState !== notifiedState) {
          notifiedState = payload.pageState;
          send('attention_required', {
            kind: payload.pageState, // '2fa' | 'captcha'
            url: payload.url,
            screenshot: payload.screenshot,
            screenshotMime: 'image/jpeg',
            message: payload.pageState === '2fa'
              ? 'The site is asking for a verification code. Reply with the code (e.g. "the code is 123456") so I can continue.'
              : 'A CAPTCHA appeared. I will try to solve it — if I get stuck, you may need to help.',
          });
        }
      },
      // Phase 5.5: reliability pack — wait_for_email + solve_captcha status updates
      onStatus: (event) => {
        if (closed) return;
        // Forward as a dedicated SSE event type per status kind
        send(event.type, event);
      },
    });

    send('done', {
      success: result.success,
      message: result.message,
      finalUrl: result.finalUrl,
      finalScreenshot: result.finalScreenshot,
      screenshotMime: 'image/jpeg',
      actionCount: result.actions?.length || 0,
      steps: result.stepHistory,
    });
  } catch (err) {
    console.error('[handsController.agent] error:', err.message);
    send('error', { error: err.message });
  } finally {
    clearInterval(heartbeatTimer);
    res.end();
  }
};

// ── Credential vault endpoints (Phase 4E) ────────────────────────────────────

// GET /api/hands/credentials                — list current user's creds (names only)
// GET /api/hands/credentials?service=...   — list for one service
exports.handleListCredentials = async (req, res) => {
  const userId = req.user?.uid;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const creds = await vault.listCredentials({ userId, service: req.query.service });
    res.json({ credentials: creds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/hands/credentials  body: { service, keyName, value, description? }
exports.handleSetCredential = async (req, res) => {
  const userId = req.user?.uid;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { service, keyName, value, description } = req.body || {};
  if (!service || !keyName || value == null) {
    return res.status(400).json({ error: 'service, keyName, and value are required' });
  }
  try {
    const result = await vault.setCredential({ userId, service, keyName, value: String(value), description });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/hands/credentials  body: { service, keyName }
exports.handleDeleteCredential = async (req, res) => {
  const userId = req.user?.uid;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { service, keyName } = req.body || {};
  if (!service || !keyName) {
    return res.status(400).json({ error: 'service and keyName are required' });
  }
  try {
    const result = await vault.deleteCredential({ userId, service, keyName });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/hands/act — single-shot Stagehand action ("click login button")
exports.handleAct = async (req, res) => {
  const { instruction, startUrl } = req.body || {};
  if (!instruction) return res.status(400).json({ error: 'instruction is required' });
  try {
    const result = await stagehand.act(instruction, { userId: req.user?.uid, startUrl });
    res.json(result);
  } catch (err) {
    console.error('[handsController.act]', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/hands/observe — list interactable elements with descriptions
exports.handleObserve = async (req, res) => {
  const { instruction, startUrl } = req.body || {};
  try {
    const result = await stagehand.observe(instruction || 'find all clickable elements', { userId: req.user?.uid, startUrl });
    res.json(result);
  } catch (err) {
    console.error('[handsController.observe]', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/hands/extract-ai — Stagehand AI extraction
exports.handleExtractAI = async (req, res) => {
  const { instruction, startUrl } = req.body || {};
  if (!instruction) return res.status(400).json({ error: 'instruction is required' });
  try {
    const result = await stagehand.extractData(instruction, { userId: req.user?.uid, startUrl });
    res.json(result);
  } catch (err) {
    console.error('[handsController.extractAI]', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/hands/session/close — close this user's persistent browser
// (so user-data dir is released; profile is preserved for next time)
exports.handleSessionClose = async (req, res) => {
  const userId = req.user?.uid;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await stagehand.closeSession(userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/hands/browser/navigate
// Uses smartBrowse by default — if the URL 404s or returns empty, falls back to
// finding a matching link from the root domain's nav. Pass smart=false to disable.
exports.handleNavigate = async (req, res) => {
  const { url, screenshot, fullPage, smart } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const useSmart = smart !== false;
    const result = useSmart
      ? await browser.smartBrowse({ url, screenshot: screenshot !== false })
      : await browser.navigate({ url, screenshot: screenshot !== false, fullPage: !!fullPage });
    const fallbackTag = result.fallbackUsed ? ` ↪ ${result.fallbackUsed}` : '';
    console.log(`🖐 navigate → ${url} (text=${result.text.length}c, links=${result.links?.length || 0}, ss=${result.screenshot ? 'yes' : 'no'})${fallbackTag}`);
    res.json(result);
  } catch (err) {
    console.error('[handsController.navigate]', err.message);
    res.status(err.message.startsWith('Blocked URL') ? 400 : 500).json({ error: err.message });
  }
};

// POST /api/hands/browser/screenshot
exports.handleScreenshot = async (req, res) => {
  const { url, fullPage } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const result = await browser.screenshot({ url, fullPage: !!fullPage });
    console.log(`📸 screenshot → ${url}`);
    res.json(result);
  } catch (err) {
    console.error('[handsController.screenshot]', err.message);
    res.status(err.message.startsWith('Blocked URL') ? 400 : 500).json({ error: err.message });
  }
};

// POST /api/hands/browser/click
exports.handleClick = async (req, res) => {
  const { url, selector } = req.body || {};
  if (!url || !selector) return res.status(400).json({ error: 'url and selector are required' });

  try {
    const result = await browser.click({ url, selector });
    console.log(`🖱  click → ${url} :: ${selector}`);
    res.json(result);
  } catch (err) {
    console.error('[handsController.click]', err.message);
    res.status(err.message.startsWith('Blocked URL') ? 400 : 500).json({ error: err.message });
  }
};

// POST /api/hands/browser/fill
exports.handleFill = async (req, res) => {
  const { url, fields, submitSelector } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'fields object is required (e.g. {"#email": "x@y.com"})' });
  }

  try {
    const result = await browser.fill({ url, fields, submitSelector });
    console.log(`⌨️  fill → ${url} :: ${Object.keys(fields).join(', ')}${submitSelector ? ' (+submit)' : ''}`);
    res.json(result);
  } catch (err) {
    console.error('[handsController.fill]', err.message);
    res.status(err.message.startsWith('Blocked URL') ? 400 : 500).json({ error: err.message });
  }
};

// POST /api/hands/browser/extract
exports.handleExtract = async (req, res) => {
  const { url, selectors } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!selectors || typeof selectors !== 'object') {
    return res.status(400).json({ error: 'selectors object is required (e.g. {"title": "h1", "price": ".price"})' });
  }

  try {
    const result = await browser.extract({ url, selectors });
    console.log(`🔍 extract → ${url} :: keys=${Object.keys(selectors).join(',')}`);
    res.json(result);
  } catch (err) {
    console.error('[handsController.extract]', err.message);
    res.status(err.message.startsWith('Blocked URL') ? 400 : 500).json({ error: err.message });
  }
};
