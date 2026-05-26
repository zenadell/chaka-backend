'use strict';

const { deepResearch } = require('../services/deepResearchService');

// POST /api/research
// SSE stream. Body: { query, maxIterations?, maxSourcesPerIter? }
async function handleResearch(req, res) {
  const { query, maxIterations, maxSourcesPerIter } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query is required (string)' });
  }
  if (query.length > 2000) {
    return res.status(400).json({ error: 'query too long (max 2000 chars)' });
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering on Render
  });

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  };

  // Client-disconnect detection: must use res.on('close'), NOT req.on('close').
  // req.on('close') fires when Express's body parser finishes draining the
  // request stream (i.e. right after the JSON body is read) — which would
  // abort the research before it even starts. res.on('close') fires when
  // the underlying socket actually closes (client navigated away / page reload).
  let closed = false;
  const abortController = new AbortController();
  res.on('close', () => { closed = true; abortController.abort(); });

  // Heartbeat — research can have long quiet stretches during scrape/LLM
  let lastEventTs = Date.now();
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastEventTs > 8000) {
      send('heartbeat', { elapsed_since_event_ms: Date.now() - lastEventTs });
    }
  }, 6000);

  send('start', { query });

  try {
    const result = await deepResearch(query, {
      maxIterations: Number(maxIterations) || 2,
      maxSourcesPerIter: Number(maxSourcesPerIter) || 8,
      signal: abortController.signal,
      onStatus: (event) => {
        if (closed) return;
        lastEventTs = Date.now();
        send(event.type, event);
      },
    });

    send('done', {
      query: result.query,
      report: result.report,
      sources: result.sources,
      elapsedMs: result.elapsedMs,
      provider: result.provider,
    });
  } catch (err) {
    console.error('[researchController] error:', err.message);
    send('error', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

// GET /api/research/status — reports which providers have keys + source
function status(req, res) {
  const apiKeyManager = require('../utils/apiKeyManager');
  const types = ['cerebras', 'sambanova', 'groq', 'openrouter', 'together'];
  const providers = types.map(t => {
    const adminCount = apiKeyManager.getKeysByType?.(t)?.length || 0;
    const envSet = !!(process.env[`${t.toUpperCase()}_API_KEY`] || '').trim();
    if (adminCount) return `${t}(admin×${adminCount})`;
    if (envSet)     return `${t}(env)`;
    return null;
  }).filter(Boolean);

  res.json({
    ok: true,
    phase: 6,
    service: 'deep-research',
    providers,
    search: !!apiKeyManager.keys?.find(k => k.type === 'search')?.key,
  });
}

module.exports = { handleResearch, status };
