'use strict';

/**
 * deepDigController.js — Phase 8 (creator-only)
 *
 * Gated to the creator's Firebase UID(s) via the CREATOR_UIDS env var
 * (comma-separated). Frontend should hide the [[DIG:...]] marker from
 * non-creators; backend enforces it independently as a hard gate.
 *
 * SSE stream — same shape as research controller.
 */

const { deepDig } = require('../services/deepDigService');

// Hard gate: only these Firebase UIDs may invoke a deep dig.
// Configured via CREATOR_UIDS=uid1,uid2,uid3 in env.
function isCreator(uid) {
  if (!uid) return false;
  const allowed = (process.env.CREATOR_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return false;
  return allowed.includes(uid);
}

// POST /api/dig
// SSE. Body: { target, userContext?, knownDomain?, knownEmail? }
// Auth: req.user.uid must be in CREATOR_UIDS (Firebase middleware sets req.user).
async function handleDig(req, res) {
  const uid = req.user?.uid || req.headers['x-user-id'];
  if (!isCreator(uid)) {
    return res.status(403).json({ error: 'forbidden — creator-only endpoint' });
  }

  const { target, userContext, knownDomain, knownEmail } = req.body || {};
  if (!target || typeof target !== 'string') {
    return res.status(400).json({ error: 'target is required (string)' });
  }
  if (target.length > 500) {
    return res.status(400).json({ error: 'target too long (max 500 chars)' });
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  // res.on('close') — fires on actual socket close, NOT req-body drain.
  let closed = false;
  const abortController = new AbortController();
  res.on('close', () => { closed = true; abortController.abort(); });

  // Heartbeat — long quiet stretches during 700-probe username sleuth, etc.
  let lastEventTs = Date.now();
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastEventTs > 8000) {
      send('heartbeat', { elapsed_since_event_ms: Date.now() - lastEventTs });
    }
  }, 6000);

  const trimmedCtx = typeof userContext === 'string'
    ? userContext.replace(/\s+/g, ' ').trim().slice(0, 2000)
    : '';

  send('dig_start', { target, knownDomain, has_user_context: Boolean(trimmedCtx) });

  try {
    const result = await deepDig(target, {
      userContext: trimmedCtx,
      knownDomain,
      knownEmail,
      signal: abortController.signal,
      onStatus: (event) => {
        if (closed) return;
        lastEventTs = Date.now();
        send(event.type, event);
      },
    });

    send('done', {
      target: result.target,
      dossier: result.dossier,
      primitives: {
        username_hits:     result.primitives.username_sleuth?.hits?.length || 0,
        github_users:      result.primitives.github?.users?.length || 0,
        github_emails:     result.primitives.github?.commit_emails || [],
        whois_summary:     result.primitives.whois ? {
                              domain: result.primitives.whois.domain,
                              registrar: result.primitives.whois.whois?.registrar,
                              created:   result.primitives.whois.whois?.creationDate,
                              registrantOrg: result.primitives.whois.whois?.registrantOrganization,
                           } : null,
        wayback_snapshots: result.primitives.wayback?.[0]?.snapshots?.length || 0,
        search_hits:       result.primitives.deep_search?.results?.length || 0,
        hunter_email:      result.primitives.hunter?.email || null,
      },
      elapsedMs: result.elapsedMs,
      provider:  result.provider,
    });
  } catch (err) {
    console.error('[deepDigController] error:', err.message);
    send('error', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

// GET /api/dig/status — is the dig service available for this caller?
function status(req, res) {
  const uid = req.user?.uid || req.headers['x-user-id'];
  res.json({
    ok: true,
    phase: 8,
    service: 'deep-dig',
    available: isCreator(uid),
    primitives: ['username_sleuth', 'github', 'whois', 'wayback', 'hunter', 'deep_search'],
    creator_uids_configured: (process.env.CREATOR_UIDS || '').split(',').filter(Boolean).length,
  });
}

module.exports = { handleDig, status, isCreator };
