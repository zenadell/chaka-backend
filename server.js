require('dotenv').config();

// ── DNS resilience ──────────────────────────────────────────────────────────
// macOS's system DNS resolver keeps breaking on this dev machine, blocking
// Turso / Groq / Gemini. Patch dns.lookup to use c-ares with public DNS
// (1.1.1.1 + 8.8.8.8) instead of the OS resolver. This affects all HTTP
// requests (fetch, axios, libsql, googleapis) because they all call lookup().
const dns = require('dns');
try {
  dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4']);
  if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');
  // Override dns.lookup to use dns.resolve4 (c-ares) instead of getaddrinfo (OS resolver).
  // This only kicks in if the hostname looks public (skip localhost / IPs).
  const origLookup = dns.lookup;
  const simpleCache = new Map(); // hostname → { ips: string[], expires }
  dns.lookup = function patchedLookup(hostname, opts, cb) {
    // Normalize arg shapes: dns.lookup supports (host, cb) | (host, opts, cb) | (host, family, cb)
    let options = {};
    let callback;
    if (typeof opts === 'function') { callback = opts; }
    else if (typeof opts === 'number') { options = { family: opts }; callback = cb; }
    else { options = opts || {}; callback = cb; }

    if (!hostname || hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
      return origLookup.call(dns, hostname, opts, cb);
    }

    const respondWith = (ips) => {
      if (options.all) {
        // Caller wants an array of { address, family }
        const list = ips.map(ip => ({ address: ip, family: 4 }));
        return process.nextTick(() => callback(null, list));
      }
      return process.nextTick(() => callback(null, ips[0], 4));
    };

    const now = Date.now();
    const cached = simpleCache.get(hostname);
    if (cached && cached.expires > now) return respondWith(cached.ips);

    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || !addresses.length) {
        // Fall back to OS resolver
        return origLookup.call(dns, hostname, opts, cb);
      }
      simpleCache.set(hostname, { ips: addresses, expires: now + 60_000 });
      respondWith(addresses);
    });
  };
  console.log('🌐 DNS patched: lookup() routes through c-ares (1.1.1.1 / 8.8.8.8), bypassing OS resolver');
} catch (e) {
  console.warn('⚠️ Could not patch DNS:', e.message);
}

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http'); // Required for Socket.io attachment
const { generateSystemArchitecture } = require('./src/utils/generateSystemArch');


// Initialize Firebase Admin
// Priority order:
// 1. Environment variable FIREBASE_SERVICE_ACCOUNT (JSON string)
// 2. Local file ./firebase-service-account.json (local dev)
// 3. Render secret file /etc/secrets/firebase-service-account.json (Render production)
// 4. Application default credentials (if available)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Loaded Firebase service account from FIREBASE_SERVICE_ACCOUNT env var.');
  } catch (e) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', e.message);
  }
} else {
  const saPath = (() => {
    const candidates = [
      'firebase-service-account.json',
      'chakachaka-e672a-firebase-adminsdk-fbsvc-7f0400d5aa.json'
    ];
    for (const name of candidates) {
      const p = path.join(__dirname, name);
      if (fs.existsSync(p)) return p;
    }
    return path.join(__dirname, 'firebase-service-account.json');
  })();
  const renderSecretPath = '/etc/secrets/firebase-service-account.json';

  // Try local file first (dev environment)
  if (fs.existsSync(saPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
      console.log('✅ Loaded Firebase service account from local file:', path.basename(saPath));
    } catch (e) {
      console.error('❌ Failed to load local firebase service account:', e.message);
    }
  }
  // If local file not found, try Render's secret file path (production environment)
  else if (fs.existsSync(renderSecretPath)) {
    try {
      const fileContent = fs.readFileSync(renderSecretPath, 'utf8');
      serviceAccount = JSON.parse(fileContent);
      console.log('✅ Loaded Firebase service account from Render secret file:', renderSecretPath);
    } catch (e) {
      console.error('❌ Failed to load service account from Render secret path:', e.message);
    }
  } else {
    console.warn('⚠️  No firebase service account found (checked env var, local file, and Render secrets). Relying on application default credentials.');
  }
}

// If we have a parsed serviceAccount and GOOGLE_APPLICATION_CREDENTIALS is not set,
// write the JSON to a temp file and point GOOGLE_APPLICATION_CREDENTIALS at it so
// other Google client libraries (like Vertex AI) can pick it up via Application
// Default Credentials. Alternatively, if the file is already on disk (e.g., Render
// secret), point directly to it.
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  if (serviceAccount) {
    // We have parsed JSON; write it to a temp file
    try {
      const tmpFile = path.join(os.tmpdir(), `gcloud-service-account-${process.pid}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(serviceAccount));
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpFile;
      console.log('✅ ADC configured via temp file:', tmpFile);
    } catch (e) {
      console.warn('⚠️  Could not write temp service account file for ADC:', e.message);
    }
  } else if (fs.existsSync('/etc/secrets/firebase-service-account.json')) {
    // Render's secret file exists; point ADC directly at it
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/etc/secrets/firebase-service-account.json';
    console.log('✅ ADC configured via Render secret file: /etc/secrets/firebase-service-account.json');
  } else {
    console.log('ℹ️  GOOGLE_APPLICATION_CREDENTIALS not set. Relying on default credential detection (may work in GCP).');
  }
}

const adminInitOptions = {
  projectId: "chakachaka-e672a"
};
if (serviceAccount) {
  adminInitOptions.credential = admin.credential.cert(serviceAccount);
}
adminInitOptions.storageBucket = "chakachaka-e672a.firebasestorage.app";
admin.initializeApp(adminInitOptions);

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '25mb' })); // 25mb covers full HD base64 screenshots


// --- Routes will go here ---

// Initialize Logic Managers
const apiKeyManager = require('./src/utils/apiKeyManager');
const vertexImageService = require('./src/services/vertexImageService');
const { initializeTursoSchema } = require('./src/services/tursoSchema');
const { initializeSockets } = require('./src/services/realtimeSockets');
const { handleLiveStreamUpgrade } = require('./src/services/liveProxy');

// Start the managers
apiKeyManager.initialize();
initializeTursoSchema();
initializeSockets(server);

// Intercept specific WebSocket connections for our Gemini Live Proxy
server.on('upgrade', (request, socket, head) => {
    if (request.url.startsWith('/api/live/stream')) {
        handleLiveStreamUpgrade(request, socket, head);
    }
});

// --- IMPORT ROUTES ---
const chatRoutes = require('./src/routes/chatRoutes');
const ragRoutes = require('./src/routes/ragRoutes');
const toolRoutes = require('./src/routes/toolRoutes');
const dbRoutes = require('./src/routes/dbRoutes');
const visionRoutes = require('./src/routes/visionRoutes');
const handsRoutes = require('./src/routes/handsRoutes');
const scraperRoutes = require('./src/routes/scraperRoutes');

// --- Routes will go here ---

// --- MOUNT API ROUTES ---
app.use('/api/chat', chatRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/tools', toolRoutes);
app.use('/api/db', dbRoutes);
app.use('/api/vision', visionRoutes);
app.use('/api/hands', handsRoutes);
app.use('/api/scrape', scraperRoutes);

// Manual warmup endpoint
app.post('/health/warmup', async (req, res) => {
  try {
    if (vertexImageService && typeof vertexImageService.ensureWarmupReady === 'function') {
      await vertexImageService.ensureWarmupReady();
      return res.json({ ok: true, warmed: true });
    }
    return res.status(500).json({ ok: false, error: 'Warmup function not available.' });
  } catch (e) {
    console.error('Warmup endpoint failed:', e.message || e);
    return res.status(500).json({ ok: false, error: e.message || 'warmup failed' });
  }
});

// Basic Health Check
app.get('/', (req, res) => {
    res.send('Chaka AI Backend is running 🚀');
});

// --- ⚡️ OPTIMIZED KEEP-ALIVE ---

// 1. Keep Turso Connection Hot (Aggressive)
// Pinging every 45s prevents the database socket from timing out (often happens at 60s).
setInterval(async () => {
    try {
        const { executeSql } = require('./src/services/tursoService');
        await executeSql('SELECT 1');
    } catch (e) {}
}, 45 * 1000); // 45 seconds

// 2. HTTP Keep-Alive (Browser Connection)
// Tell the browser to hold the line for 5 minutes if possible.
app.use((req, res, next) => {
    res.set('Connection', 'keep-alive');
    res.set('Keep-Alive', 'timeout=300'); // 5 minutes
    next();
});

// 3. Server Self-Ping (Sleep Prevention)
// 10 minutes is usually safe for Render/Railway free tiers. 
// 30 seconds is dangerous.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
// Use axios with async wrapper so a missing global `fetch` won't crash the process.
// Also log failures so Render shows why the service might be unhealthy.
setInterval(async () => {
  try {
    await axios.get(SELF_URL, { timeout: 5000 });
    console.log(`Self-ping successful: ${SELF_URL}`);
  } catch (err) {
    console.warn(`Self-ping failed (${SELF_URL}):`, err.message || err);
  }
}, 10 * 60 * 1000); // 10 minutes

// ────────────────────────────────────────────────────────────────────────────
// CRITICAL: browser-use@0.6.1 registers its own uncaughtException AND
// unhandledRejection handlers in playwright-manager.js that call
// process.exit(1) UNCONDITIONALLY. Their handlers run alongside ours and
// kill the process even with --unhandled-rejections=warn.
//
// We strip ALL such listeners (browser-use's + Node's defaults) and re-install
// ours that swallow the error and keep the process alive. This must happen
// AFTER handsRoutes is required (because that's what loads browser-use).
// ────────────────────────────────────────────────────────────────────────────
const _browserUseUnhandledRejectionListeners = process.listenerCount('unhandledRejection');
const _browserUseUncaughtExceptionListeners  = process.listenerCount('uncaughtException');
process.removeAllListeners('unhandledRejection');
process.removeAllListeners('uncaughtException');
console.log(`🛡  Stripped ${_browserUseUnhandledRejectionListeners} unhandledRejection + ${_browserUseUncaughtExceptionListeners} uncaughtException listeners (browser-use's process.exit handlers)`);

// Global handlers — log and SWALLOW so a single browser-use rejection (e.g.
// page.waitForEvent('download') timeout that leaks past their try/catch)
// doesn't kill the whole backend mid-agent-run.
// IMPORTANT: package.json start script passes --unhandled-rejections=warn
// so Node's default fatal-on-rejection policy is overridden.
process.on('uncaughtException', (err) => {
  const tag = err?.name === 'TimeoutError' ? '⏱  ' : '🔥 ';
  console.error(`${tag}Uncaught Exception (swallowed, backend stays up):`, err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason) => {
  const isPlaywrightTimeout = String(reason?.message || reason || '').includes('waitForEvent');
  const tag = isPlaywrightTimeout ? '⏱  [browser-use waitForEvent leak] ' : '🌊 Unhandled Rejection: ';
  console.error(tag, reason?.stack || reason);
});

// --- BLOCKING STARTUP WARMUP (Before app.listen) ---
(async () => {
  console.log('\n🔥 Starting blocking warmup phase...\n');
  
  // Warmup Sharp + Sanitizer
  try {
    console.log('⏳ Warming up Sharp and sanitizer...');
    if (vertexImageService && typeof vertexImageService.warmup === 'function') {
      await vertexImageService.warmup();
      console.log('✅ Sharp + sanitizer warmup complete.\n');
    }
  } catch (err) {
    console.error('⚠️ Sharp warmup failed:', err.message || err);
  }

  // Warmup DNS for Cloudinary
  try {
    console.log('⏳ Warming up Cloudinary DNS...');
    const dns = require('dns').promises;
    await dns.resolve4('api.cloudinary.com');
    console.log('✅ Cloudinary DNS warmup complete.\n');
  } catch (err) {
    console.warn('⚠️ Cloudinary DNS warmup failed:', err.message);
  }

  // Warmup DNS for image CDN domains
  const imageDomains = ['files.rework.ink', 'cloudinary.com'];
  for (const domain of imageDomains) {
    try {
      console.log(`⏳ Warming up DNS for ${domain}...`);
      const dns = require('dns').promises;
      await dns.resolve4(domain);
      console.log(`✅ DNS warmup for ${domain} complete.\n`);
    } catch (err) {
      console.warn(`⚠️ DNS warmup for ${domain} failed:`, err.message);
    }
  }

  console.log('🎯 Blocking warmup phase COMPLETE. Starting server...\n');

  // 🧠 SECRET ADMIN ROUTE: Refreshes Chaka's knowledge of itself
app.get('/admin/refresh-brain', (req, res) => {
    try {
        const result = generateSystemArchitecture();
        res.send(`<pre>${result}</pre>`);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

  // Start Server and run auth diagnostics
  server.listen(port, async () => {
    console.log(`\n⚡️ Server is running. local: http://localhost:${port}  external: ${process.env.RENDER_EXTERNAL_URL || 'N/A'}`);
    console.log(`🔥 Firebase Admin initialized for project: ${serviceAccount?.project_id || process.env.GCP_PROJECT || 'unknown'}`);
    console.log(`📝 GOOGLE_APPLICATION_CREDENTIALS: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || 'not set'}\n`);

    // Diagnostic: Test Turso access
    try {
      const { executeSql } = require('./src/services/tursoService');
      await executeSql('SELECT 1');
      console.log('✅ Turso DB connection check: SUCCESS');
    } catch (err) {
      console.error('❌ Turso DB connection check FAILED:', err.message);
      console.error('   Check your TURSO_DATABASE_URL and TURSO_AUTH_TOKEN');
    }

    // Diagnostic: Test Vertex AI auth
    try {
      const { VertexAI } = require('@google-cloud/vertexai');
      const vTest = new VertexAI({ project: serviceAccount?.project_id || 'unknown', location: 'us-central1' });
      console.log('✅ Vertex AI client initialized successfully');
    } catch (err) {
      console.error('⚠️  Vertex AI client init warning:', err.message);
    }
  });
})();

// testing git update
// forcing git update
