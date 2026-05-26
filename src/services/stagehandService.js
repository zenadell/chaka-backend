/**
 * stagehandService.js — Autonomous Browser Agent (Phase 4D + 4E)
 *
 * BACKED BY browser-use (TypeScript port of the famous Python library).
 * https://github.com/webllm/browser-use  •  npm: browser-use@0.6.1
 *
 * What browser-use gives us that our home-grown loop couldn't:
 *   • Indexed DOM element references (@e1, @e2, ...) — the LLM points to
 *     interactive elements by stable index, not "click the Submit button"
 *     which was failing silently. Solves the stuck-typing-'Tim' loop.
 *   • Built-in loop detection — refuses to repeat the same action
 *   • Built-in stealth mode (no manual init-script needed)
 *   • Built-in CAPTCHA solver hook
 *   • Per-step callbacks with screenshot + URL + action info
 *   • Sensitive-data substitution with domain scoping (perfect for our vault)
 *   • Vision support via Gemini directly
 *
 * Per-user persistent profiles still live at ./user-data/<userId>/ for
 * social-media-grade autonomy (stay logged in across sessions).
 */

const { Agent, BrowserProfile, BrowserSession, Controller } = require('browser-use');
const { ChatGoogle } = require('browser-use/llm/google');
const { ChatGroq } = require('browser-use/llm/groq');
const { ChatCerebras } = require('browser-use/llm/cerebras');
const { ChatOpenAI } = require('browser-use/llm/openai');
const { z } = require('zod');

// Phase 5.5 reliability pack
const captchaSolver = require('./captchaSolver');
const emailVerifier = require('./emailVerifier');
// Phase 5.6 vision-based puzzle solver
const visualPuzzle = require('./visualPuzzleSolver');
const fs = require('fs');
const path = require('path');
const apiKeyManager = require('../utils/apiKeyManager');

const USER_DATA_ROOT = path.join(__dirname, '..', '..', 'user-data');
if (!fs.existsSync(USER_DATA_ROOT)) fs.mkdirSync(USER_DATA_ROOT, { recursive: true });

const RECORDINGS_ROOT = path.join(__dirname, '..', '..', 'agent-recordings');
if (!fs.existsSync(RECORDINGS_ROOT)) fs.mkdirSync(RECORDINGS_ROOT, { recursive: true });

// One BrowserSession per user. Sessions stay warm across requests so login
// state persists between asks — what makes IG / WhatsApp / etc usable.
const sessions = new Map(); // userId → { session, profile, lastUsed, initPromise }

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getUserDataDir(userId) {
  const safe = String(userId || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const dir = path.join(USER_DATA_ROOT, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pickGeminiKey() {
  return (
    apiKeyManager.keys.find(k => k.type === 'text')?.key ||
    apiKeyManager.getCurrentKey()?.key
  );
}

/**
 * RotatingChatGoogle — wraps multiple ChatGoogle instances (one per key) and
 * rotates on 429 / quota errors. Solves: free-tier Gemini allows only 5 req/min
 * per key, but we have 11 keys → 55 req/min effective capacity.
 *
 * Extends ChatGoogle so it passes `instanceof BaseChatModel` checks inside browser-use.
 */
class RotatingChatGoogle extends ChatGoogle {
  constructor(apiKeys, opts = {}) {
    if (!apiKeys?.length) throw new Error('RotatingChatGoogle needs at least one apiKey');
    // Use gemini-2.5-flash by default — better structured-output reliability
    // and separate capacity from gemini-2.5-flash. Thinking mode disabled (=0) so
    // the model returns clean JSON instead of hidden chain-of-thought tokens.
    const baseOpts = {
      model: opts.model || 'gemini-2.5-flash',
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      thinkingBudget: 0,            // disable thinking — cleaner JSON output
      supportsStructuredOutput: true,
      maxRetries: 0,                // we handle retries ourselves via rotation
    };
    super({ ...baseOpts, apiKey: apiKeys[0] });
    this._allKeys = [...apiKeys];
    this._currentIdx = 0;
    this._opts = opts;
    // Eagerly build a ChatGoogle for each key so we can hot-swap their internals
    this._instances = apiKeys.map(k => new ChatGoogle({ ...baseOpts, apiKey: k }));
    this.client = this._instances[0].client;
  }

  _useNextKey() {
    this._currentIdx = (this._currentIdx + 1) % this._allKeys.length;
    this.client = this._instances[this._currentIdx].client;
  }

  // Override ainvoke to retry across keys on 429 / parse errors
  async ainvoke(messages, output_format) {
    let lastErr;
    const tried = new Set();
    for (let attempt = 0; attempt < this._allKeys.length; attempt++) {
      if (tried.has(this._currentIdx)) {
        this._useNextKey();
        continue;
      }
      tried.add(this._currentIdx);
      try {
        const result = await super.ainvoke(messages, output_format);
        return result;
      } catch (err) {
        lastErr = err;
        const msg = err?.message || String(err);
        const is429 = /429|RESOURCE_EXHAUSTED|quota|rate ?limit|Too Many Requests/i.test(msg);
        const isParse = /Unexpected non-whitespace character|JSON parse|Unexpected token/i.test(msg);
        if (is429 || isParse) {
          console.warn(`[RotatingChatGoogle] key #${this._currentIdx} failed (${is429 ? '429' : 'parse'}), rotating to next`);
          this._useNextKey();
          continue;
        }
        throw err; // unknown error — surface immediately
      }
    }
    throw lastErr || new Error('All Gemini keys exhausted');
  }
}

/**
 * Build the primary LLM for the browser agent.
 *
 * Priority:
 *   1. Groq + Llama-3.3-70B if GROQ_API_KEY is set — best free model for tool/function
 *      calling, 100 req/min, 6000/day, very reliable structured output. Used by
 *      browser-use with dedicated parser recovery code.
 *   2. Otherwise Gemini key pool with rotation (5 req/min per key × N keys).
 */
/**
 * ChatFirstAvailable — Phase 5.5 cross-provider router.
 *
 * Tries each underlying LLM in order. On 429 rate-limit it cools down
 * that provider for 60s before retrying. On 503 high-demand, 30s.
 * Other errors fall through to the next provider without cooling down.
 *
 * Implements the same BaseChatModel surface (ainvoke + model_name + provider)
 * so browser-use's Agent treats it identically to a single LLM.
 */
class ChatFirstAvailable {
  constructor(providers) {
    // providers: [{ name, llm }, …]
    if (!providers?.length) throw new Error('ChatFirstAvailable: no providers');
    this.providers = providers;
    this.cooldown = new Map();      // name → epoch ms when available again
    this.consec429 = new Map();     // name → consecutive 429 count (resets on success)
    this.lastProvider = null;       // name of the provider that served the last successful call
    this.model = providers[0].llm.model || providers[0].llm.model_name || 'multi';
    this.provider = providers.map(p => p.name).join('+');
  }
  get model_name() { return this.model; }
  get name() { return `multi(${this.provider})`; }

  // Exponential cooldown: 60s × 2^N for N consecutive 429s (capped 10min).
  // After 3 consecutive 429s, Groq cools for 8 min instead of looping every 60s.
  _cooldownFor429(name) {
    const n = (this.consec429.get(name) || 0) + 1;
    this.consec429.set(name, n);
    const ms = Math.min(60_000 * Math.pow(2, n - 1), 600_000); // 60s, 120s, 240s, 480s, 600s (cap)
    return ms;
  }

  async ainvoke(messages, output_format, options) {
    const now = Date.now();
    const ordered = this.providers.filter(p => (this.cooldown.get(p.name) || 0) <= now);
    const fallthrough = ordered.length ? ordered : this.providers; // if all in cooldown, try anyway

    let lastErr;
    for (const { name, llm } of fallthrough) {
      try {
        const result = await llm.ainvoke(messages, output_format, options);
        this.consec429.delete(name);  // success resets the counter
        this.lastProvider = name;
        return result;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        if (/429|rate.?limit|too many requests/i.test(msg)) {
          const ms = this._cooldownFor429(name);
          this.cooldown.set(name, Date.now() + ms);
          console.warn(`[ChatFirstAvailable] ${name} rate-limited (429 #${this.consec429.get(name)}) → cooling ${Math.round(ms / 1000)}s, trying next`);
        } else if (/503|unavailable|high demand|overload/i.test(msg)) {
          this.cooldown.set(name, Date.now() + 30_000);
          console.warn(`[ChatFirstAvailable] ${name} unavailable (503) → cooling 30s, trying next`);
        } else if (/leaked|forbidden|permission_denied|401|403/i.test(msg)) {
          this.cooldown.set(name, Date.now() + 24 * 60 * 60_000); // 24h for revoked keys
          console.warn(`[ChatFirstAvailable] ${name} auth failed → cooling 24h, trying next`);
        } else {
          console.warn(`[ChatFirstAvailable] ${name} error: ${msg.slice(0, 140)} → trying next`);
        }
      }
    }
    throw lastErr || new Error('All LLM providers failed');
  }
}

// Phase 5.7+: prefer admin-managed keys (Turso config table via apiKeyManager)
// over env vars. This means keys can be rotated live via the Chaka Admin UI
// with NO redeploy. Env vars are kept ONLY as a local-dev fallback.
function _providerKey(type, envFallback) {
  const adminKey = apiKeyManager.pickKey?.(type)?.key;
  if (adminKey) return { key: adminKey, source: 'admin' };
  const envKey = (process.env[envFallback] || '').trim();
  if (envKey) return { key: envKey, source: 'env' };
  return null;
}

function makeLlm() {
  // Build a stack: Groq first (fastest), Cerebras second (free Llama 3.3 70b alt),
  // Sambanova third, OpenRouter fourth, Gemini pool last.
  // For each provider, prefer admin-managed keys (rotatable, multi-key pool),
  // fall back to env var for local dev.
  const providers = [];

  const groqInfo = _providerKey('groq', 'GROQ_API_KEY');
  const groqKey = groqInfo?.key || '';
  if (groqKey) {
    providers.push({
      name: 'groq-llama-3.3-70b',
      llm: new ChatGroq({
        model: 'llama-3.3-70b-versatile',
        apiKey: groqKey,
        temperature: 0.2,
        maxOutputTokens: 8192,
        maxRetries: 1,
      }),
    });
  }

  // Phase 5.5: Cerebras — separate rate-limit pool from Groq.
  // Model preference: CEREBRAS_MODEL env override, then gpt-oss-120b (OpenAI's
  // open-source agentic model, strong tool calling, ~1.5s/call on Cerebras).
  // The available model set varies per account — current free tier offers
  // gpt-oss-120b, qwen-3-235b, zai-glm-4.7, llama3.1-8b.
  const cerebrasInfo = _providerKey('cerebras', 'CEREBRAS_API_KEY');
  const cerebrasKey = cerebrasInfo?.key || '';
  if (cerebrasKey) {
    const cerebrasModel = (process.env.CEREBRAS_MODEL || 'gpt-oss-120b').trim();
    providers.push({
      name: `cerebras-${cerebrasModel}`,
      llm: new ChatCerebras({
        model: cerebrasModel,
        apiKey: cerebrasKey,
        temperature: 0.2,
        maxTokens: 8192,
        maxRetries: 1,
      }),
    });
  }

  // Phase 5.7: Sambanova — Llama 3.3 70B at >2000 tok/sec on RDU silicon,
  // free tier 10 req/min. OpenAI-compatible API at api.sambanova.ai/v1.
  const sambanovaInfo = _providerKey('sambanova', 'SAMBANOVA_API_KEY');
  const sambanovaKey = sambanovaInfo?.key || '';
  if (sambanovaKey) {
    const sambanovaModel = (process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct').trim();
    providers.push({
      name: `sambanova-${sambanovaModel}`,
      llm: new ChatOpenAI({
        model: sambanovaModel,
        apiKey: sambanovaKey,
        baseURL: 'https://api.sambanova.ai/v1',
        temperature: 0.2,
        maxCompletionTokens: 8192,
        maxRetries: 1,
      }),
    });
  }

  // Phase 5.7: OpenRouter — aggregator with multiple free agentic models.
  // Default: openai/gpt-oss-120b:free (same model Cerebras runs, designed
  // for tool calling, ~10s/call on the free tier — slow but reliable).
  // Avoid meta-llama/llama-3.3-70b-instruct:free — it's the most-requested
  // free model and instantly 429s. OPENROUTER_MODEL env override.
  const openrouterInfo = _providerKey('openrouter', 'OPENROUTER_API_KEY');
  const openrouterKey = openrouterInfo?.key || '';
  if (openrouterKey) {
    const openrouterModel = (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free').trim();
    providers.push({
      name: `openrouter-${openrouterModel.split('/').pop()}`,
      llm: new ChatOpenAI({
        model: openrouterModel,
        apiKey: openrouterKey,
        baseURL: 'https://openrouter.ai/api/v1',
        temperature: 0.2,
        maxCompletionTokens: 8192,
        maxRetries: 1,
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/chaka-ai',
          'X-Title': 'Chaka AI',
        },
      }),
    });
  }

  // Phase 5.7: Together AI — Llama 3.3 70B Turbo, $5 free credit (~~5M tokens).
  // OpenAI-compatible. Fast (~200 tok/sec) and reliable for tool calling.
  const togetherInfo = _providerKey('together', 'TOGETHER_API_KEY');
  const togetherKey = togetherInfo?.key || '';
  if (togetherKey) {
    const togetherModel = (process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo').trim();
    providers.push({
      name: `together-${togetherModel.split('/').pop()}`,
      llm: new ChatOpenAI({
        model: togetherModel,
        apiKey: togetherKey,
        baseURL: 'https://api.together.xyz/v1',
        temperature: 0.2,
        maxCompletionTokens: 8192,
        maxRetries: 1,
      }),
    });
  }

  // Last resort: Gemini pool (rotates between N keys internally)
  const geminiKeys = apiKeyManager.keys?.filter(k => k.type === 'text' && k.key)?.map(k => k.key) || [];
  if (!geminiKeys.length) {
    const fb = apiKeyManager.getCurrentKey()?.key;
    if (fb) geminiKeys.push(fb);
  }
  if (geminiKeys.length) {
    providers.push({
      name: `gemini-2.5-flash-pool(${geminiKeys.length})`,
      llm: new RotatingChatGoogle(geminiKeys, {
        model: 'gemini-2.5-flash',
        temperature: 0.2,
        maxOutputTokens: 8192,
      }),
    });
  }

  if (!providers.length) {
    throw new Error('No LLM available (no GROQ_API_KEY, no CEREBRAS_API_KEY, no Gemini text keys)');
  }

  if (providers.length === 1) {
    console.log(`[stagehandService] makeLlm() → ${providers[0].name} (single provider)`);
    return providers[0].llm;
  }

  console.log(`[stagehandService] makeLlm() → multi-provider router: ${providers.map(p => p.name).join(' → ')}`);
  return new ChatFirstAvailable(providers);
}

/**
 * Build a fallback LLM for browser-use's `fallback_llm` option.
 * If the primary is Groq, we use Gemini as fallback (and vice versa) so
 * a single provider outage doesn't kill the agent.
 */
function makeFallbackLlm() {
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const geminiKeys = apiKeyManager.keys?.filter(k => k.type === 'text' && k.key)?.map(k => k.key) || [];

  // If primary is Groq → fallback to Gemini
  if (groqKey && geminiKeys.length) {
    return new RotatingChatGoogle(geminiKeys, {
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      maxOutputTokens: 8192,
    });
  }
  return null;
}

// ── Per-user session lifecycle ──────────────────────────────────────────────

async function getSessionForUser(userId) {
  const key = userId || 'anonymous';
  const existing = sessions.get(key);
  if (existing?.session) {
    existing.lastUsed = Date.now();
    return existing.session;
  }
  if (existing?.initPromise) return existing.initPromise;

  const userDataDir = getUserDataDir(userId);
  console.log(`[stagehandService] Launching browser-use session for user=${key} profile=${userDataDir}`);

  const initPromise = (async () => {
    // Phase 5.5: optional residential proxy from env
    // Format: AGENT_PROXY=http://user:pass@host:port  (or socks5://)
    const proxyServer = process.env.AGENT_PROXY || null;
    if (proxyServer) {
      console.log(`[stagehandService] using proxy ${proxyServer.replace(/:[^:@]+@/, ':***@')}`);
    }

    const profile = new BrowserProfile({
      user_data_dir: userDataDir,
      stealth: true,            // built-in stealth — defeats most bot detectors
      captcha_solver: true,     // built-in CAPTCHA hook
      keep_alive: true,         // don't auto-close between agent runs
      headless: true,
      window_size: { width: 1366, height: 800 },
      minimum_wait_page_load_time: 0.5,
      wait_for_network_idle_page_load_time: 1.5,
      ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    });

    const session = new BrowserSession({ browser_profile: profile });
    sessions.set(key, { session, profile, lastUsed: Date.now(), initPromise: null });
    console.log(`[stagehandService] ✅ browser-use session ready for user=${key}`);
    return session;
  })();

  sessions.set(key, { session: null, profile: null, lastUsed: Date.now(), initPromise });
  return initPromise;
}

async function closeSession(userId) {
  const key = userId || 'anonymous';
  const s = sessions.get(key);
  if (!s) return;
  try { await s.session?.kill?.(); } catch {}
  sessions.delete(key);
  console.log(`[stagehandService] session closed for user=${key}`);
}

async function shutdown() {
  for (const [key] of sessions) {
    try { await closeSession(key); } catch {}
  }
}

// Idle cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (s.session && now - s.lastUsed > IDLE_TIMEOUT_MS) {
      console.log(`[stagehandService] closing idle session for user=${key}`);
      closeSession(key).catch(() => {});
    }
  }
}, 5 * 60 * 1000);

// ── 2FA / CAPTCHA detection ─────────────────────────────────────────────────

const TWO_FA_PATTERNS = [
  /verification code/i, /two[- ]factor/i, /enter.{0,15}code/i, /\b2fa\b/i, /\bOTP\b/,
  /one[- ]time (?:password|code|pin)/i, /authenticator app/i, /we sent you a code/i,
  /confirm your identity/i,
];
const CAPTCHA_PATTERNS = [
  /i'?m not a robot/i, /verify you are human/i, /please complete the captcha/i,
  /h?captcha/i, /recaptcha/i,
];

function classifyPageState(text) {
  if (!text) return 'normal';
  for (const p of TWO_FA_PATTERNS) if (p.test(text)) return '2fa';
  for (const p of CAPTCHA_PATTERNS) if (p.test(text)) return 'captcha';
  return 'normal';
}

// Convert credentialVault-style variables into browser-use sensitive_data format,
// scoped to the target domain if we can guess it from the task or startUrl.
function buildSensitiveData(variables, startUrl) {
  if (!variables || !Object.keys(variables).length) return null;

  // Try to extract a domain pattern from startUrl. Falls back to '*' (any domain).
  let domainKey = '*';
  if (startUrl) {
    try {
      const host = new URL(startUrl.startsWith('http') ? startUrl : `https://${startUrl}`).hostname;
      // Use base domain pattern, e.g. instagram.com → *.instagram.com
      const parts = host.split('.').filter(Boolean);
      if (parts.length >= 2) domainKey = `*.${parts.slice(-2).join('.')}`;
    } catch {}
  }

  const creds = {};
  for (const [k, v] of Object.entries(variables)) {
    if (v?.value) creds[k] = v.value;
  }
  if (!Object.keys(creds).length) return null;
  return { [domainKey]: creds };
}

// ── Phase 5.5: Custom Controller with reliability actions ───────────────────
// We extend browser-use's default action set with two new tools the agent
// can autonomously invoke when it gets stuck:
//   1. wait_for_verification_email — polls IMAP for sign-up codes/links
//   2. solve_captcha_on_page       — auto-solves via 2captcha
//
// onStatus is a hook the actions call to surface progress events
// (awaiting_email, email_received, solving_captcha) up through SSE.
function buildAgentController({ onStatus, abortSignal } = {}) {
  const controller = new Controller();

  // ── wait_for_verification_email ──────────────────────────────────────
  controller.registry.action(
    'Wait for and read a verification email from the user\'s inbox. Use this AFTER you submit a sign-up form and see a "check your email" message, or whenever you need a verification code that was just emailed. Returns the verification code (digits) or verification link from the most recent matching email.',
    {
      param_model: z.object({
        from_domain: z.string().describe('Domain that will send the email, e.g. "github.com" or "notifications.airbnb.com"'),
        timeout_seconds: z.number().int().optional().default(120).describe('Max time to wait, default 120 seconds'),
      }),
    }
  )(async (params, _ctx) => {
    if (abortSignal?.aborted) return { success: false, error: 'Task cancelled' };

    onStatus?.({ type: 'awaiting_email', from_domain: params.from_domain, timeout_seconds: params.timeout_seconds || 120 });

    if (!emailVerifier.isConfigured()) {
      return {
        success: false,
        error: 'Email verification is not configured on this server. The user must set EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS environment variables (Gmail app password works). For now, ask the user to check their inbox manually and tell you the code.',
      };
    }

    try {
      const result = await emailVerifier.waitForVerificationEmail({
        fromDomain: params.from_domain,
        since: new Date(Date.now() - 60_000),
        timeoutMs: (params.timeout_seconds || 120) * 1000,
      });

      if (!result) {
        onStatus?.({ type: 'email_timeout', from_domain: params.from_domain });
        return { success: false, error: `No verification email from "${params.from_domain}" within ${params.timeout_seconds || 120}s. The email may not have arrived yet or it's from a different sender domain.` };
      }

      onStatus?.({
        type: 'email_received',
        from: result.from,
        subject: result.subject,
        code: result.code,
        link: result.link,
      });

      return {
        success: true,
        from: result.from,
        subject: result.subject,
        verification_code: result.code,
        verification_link: result.link,
        next_step: result.code
          ? `A verification code was received: ${result.code}. Now find the code input field on the page and type "${result.code}" into it, then submit.`
          : result.link
            ? `A verification link was received: ${result.link}. Now navigate to that URL.`
            : 'Email arrived but no clear code or link was found. Tell the user what the subject was and ask for guidance.',
      };
    } catch (e) {
      console.error('[stagehandService] wait_for_email error:', e.message);
      return { success: false, error: e.message };
    }
  });

  // ── solve_captcha_on_page ────────────────────────────────────────────
  controller.registry.action(
    'Automatically solve any CAPTCHA challenge visible on the current page (reCAPTCHA v2, hCaptcha, Cloudflare Turnstile). Use this only when you see a CAPTCHA blocking progress — for "I\'m not a robot" checkboxes, try clicking first; only call this action if the checkbox triggers an image challenge or fails. After solving, the page form is ready to submit.',
    { param_model: z.object({}) }
  )(async (_params, ctx) => {
    if (abortSignal?.aborted) return { success: false, error: 'Task cancelled' };
    onStatus?.({ type: 'solving_captcha' });

    if (!captchaSolver.isConfigured()) {
      return {
        success: false,
        error: 'CAPTCHA solver is not configured. The user needs to set TWOCAPTCHA_API_KEY (2captcha.com, ~$3 per 1000 solves). For now, ask the user to solve the CAPTCHA in the screen-share viewport — you\'ll see them do it.',
      };
    }

    const page = ctx?.page || ctx?.browser_session?.current_page;
    if (!page) {
      return { success: false, error: 'No active page available to scan for CAPTCHA.' };
    }

    try {
      const result = await captchaSolver.detectAndSolve(page);
      if (!result) {
        return { success: false, error: 'No supported CAPTCHA found on page (looked for reCAPTCHA v2, hCaptcha, Turnstile).' };
      }
      const injected = await captchaSolver.injectToken(page, result);
      onStatus?.({ type: 'captcha_solved', captcha_type: result.type, success: injected });
      return {
        success: injected,
        captcha_type: result.type,
        next_step: injected
          ? 'CAPTCHA token has been injected. Now click the submit button to proceed.'
          : 'Token was obtained but injection into the page failed. Try submitting the form anyway — sometimes the page already received the callback.',
      };
    } catch (e) {
      console.error('[stagehandService] solve_captcha error:', e.message);
      return { success: false, error: e.message };
    }
  });

  // ── solve_visual_puzzle (Phase 5.6) ──────────────────────────────────
  // Vision-based fallback for ANY visual blocker the agent can't reason
  // about through the DOM index: slider captchas, "click the X" tests,
  // press-and-hold buttons, popup overlays, "try again" buttons after a
  // failed CAPTCHA attempt, etc. Uses Gemini 2.5 Flash Vision (free).
  controller.registry.action(
    'Solve a visual puzzle, slider CAPTCHA, "click the X" challenge, modal popup, or any visual blocker on the page. Use this when you see something blocking progress that you cannot interact with via the normal indexed DOM elements — for example: a slider you need to drag, a "press and hold" button, a custom captcha, a popup with no obvious close button by index, or a "try again" overlay after a failed CAPTCHA. A vision model analyzes the screenshot, finds the target coordinates, and the system clicks/drags for you.',
    {
      param_model: z.object({
        context: z.string().optional().describe('Optional hint to the vision model about what you see — "there is a red X close button" or "drag the slider piece to match the gap" — improves accuracy when the puzzle is ambiguous.'),
      }),
    }
  )(async (params, ctx) => {
    if (abortSignal?.aborted) return { success: false, error: 'Task cancelled' };

    const page = ctx?.page || ctx?.browser_session?.current_page;
    if (!page) return { success: false, error: 'No active page available' };

    onStatus?.({ type: 'analyzing_puzzle', context: params.context || null });

    try {
      const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
      const screenshot = screenshotBuf.toString('base64');
      const viewport = page.viewportSize() || { width: 1366, height: 800 };

      const solution = await visualPuzzle.analyzePuzzle(screenshot, {
        viewport_w: viewport.width,
        viewport_h: viewport.height,
        context: params.context,
      });

      onStatus?.({
        type: 'puzzle_analyzed',
        puzzle_type: solution.puzzle_type,
        action: solution.action,
        confidence: solution.confidence,
      });

      if (solution.puzzle_type === 'none') {
        return {
          success: false,
          error: 'No visual puzzle detected on the page. The page looks normal — continue with normal actions.',
        };
      }

      if (solution.confidence === 'low') {
        return {
          success: false,
          error: `Vision model has LOW confidence: "${solution.action}". Try a different approach or ask the user for guidance.`,
          vision_raw: solution.raw_response.slice(0, 400),
        };
      }

      const exec = await visualPuzzle.executeSolution(page, solution);

      onStatus?.({
        type: 'puzzle_executed',
        puzzle_type: solution.puzzle_type,
        executed: exec.executed,
      });

      return {
        success: exec.executed !== 'none' && exec.executed !== 'partial',
        puzzle_type: solution.puzzle_type,
        action_taken: solution.action,
        execution: exec,
        next_step: exec.executed === 'partial'
          ? `Partial execution: ${exec.note}. Try again with a more specific context, or ask the user.`
          : exec.executed === 'none'
            ? 'No action taken — continue normally.'
            : 'Action executed. Wait 1-2 seconds, then verify the puzzle is gone before continuing.',
      };
    } catch (e) {
      console.error('[stagehandService] solve_visual_puzzle error:', e.message);
      return { success: false, error: e.message };
    }
  });

  return controller;
}

// ── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Capture a live frame from the active page as base64 JPEG.
 * Used by the live-stream ticker — keep small + fast (lower quality OK).
 */
async function captureLiveFrame(session) {
  try {
    // Find active Playwright page through the browser-use session's CDP context
    const pages = await session.browser_context?.pages?.() || [];
    let page = null;
    for (const p of pages) {
      try { if (!p.isClosed() && p.url() !== 'about:blank') { page = p; break; } } catch {}
    }
    if (!page) page = pages[0];
    if (!page) return null;
    const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
    return buf.toString('base64');
  } catch { return null; }
}

/**
 * Run an autonomous multi-step task using browser-use.
 *
 * onStep(payload) is called after each step with:
 *   { step, action, reasoning, url, screenshot, screenshotMime, pageState }
 * onFrame(payload) is called ~6 times/sec with the live viewport:
 *   { frame: base64, mime: 'image/jpeg', ts }
 */
async function runAgent(task, {
  userId,
  onStep,
  onFrame,           // live frame callback ~6fps
  onStatus,          // Phase 5.5: reliability events (awaiting_email, solving_captcha, etc.)
  maxSteps = 35,
  startUrl,
  variables,
  signal,
  liveFps = 6,       // live preview fps (0 to disable streaming)
  // legacy 'mode' param accepted but ignored — browser-use auto-picks tools
  // eslint-disable-next-line no-unused-vars
  mode,
} = {}) {
  const session = await getSessionForUser(userId);
  const llm = makeLlm();
  const sensitive_data = buildSensitiveData(variables, startUrl);

  let stepIndex = 0;
  const stepHistory = [];
  let notifiedState = null;

  // ── LIVE FRAME TICKER ────────────────────────────────────────────────────
  // Fires every ~167ms (6fps) in parallel with the agent loop. Sends frames
  // to onFrame() if set, so the frontend can render a live screen-share feed.
  let liveTicker = null;
  let liveTicking = false;
  if (typeof onFrame === 'function' && liveFps > 0) {
    const intervalMs = Math.round(1000 / liveFps);
    liveTicker = setInterval(async () => {
      if (liveTicking) return;        // skip if previous capture still running
      liveTicking = true;
      try {
        const frame = await captureLiveFrame(session);
        if (frame) await onFrame({ frame, mime: 'image/jpeg', ts: Date.now() });
      } catch {}
      finally { liveTicking = false; }
    }, intervalMs);
  }

  // Build the task text — prepend startUrl hint if provided so the agent
  // navigates there first.
  const fullTask = startUrl
    ? `First navigate to ${startUrl}, then: ${task}`
    : task;

  const stepCallback = async (summary, output, step) => {
    stepIndex++;
    try {
      const url = summary?.url || null;
      const screenshot = summary?.screenshot || null; // already base64 jpeg per browser-use
      const visibleText = (summary?.recent_events || '').slice(0, 4000);
      const pageState = classifyPageState(visibleText + ' ' + (summary?.title || ''));

      // Pull the model's reasoning + chosen action from output
      const action = output?.action?.[0]
        ? Object.keys(output.action[0])[0] || 'step'
        : (output?.current_state?.next_goal || 'thinking');
      const reasoning = output?.current_state?.memory || output?.current_state?.evaluation_previous_goal || '';

      const payload = {
        step: stepIndex,
        action,
        reasoning: String(reasoning).slice(0, 280),
        url,
        screenshot,
        screenshotMime: 'image/jpeg',
        pageState,
      };
      stepHistory.push({ step: stepIndex, action, url, pageState });

      // Alert user once on first 2FA/CAPTCHA detection
      if (pageState !== 'normal' && notifiedState !== pageState) {
        notifiedState = pageState;
        payload._needsAttention = pageState;
      }

      if (typeof onStep === 'function') {
        try { await onStep(payload); } catch (e) { console.warn('[stagehandService] onStep err:', e.message); }
      }
    } catch (e) {
      console.warn('[stagehandService] step callback err:', e.message);
    }
  };

  console.log(`[stagehandService] 🚀 browser-use agent user=${userId || 'anon'} task="${task.slice(0, 80)}"`);
  const fallback_llm = makeFallbackLlm();
  if (fallback_llm) console.log('[stagehandService] fallback_llm configured (Gemini pool)');

  // Phase 5.5: custom Controller with wait_for_verification_email + solve_captcha_on_page
  const controller = buildAgentController({
    onStatus: (event) => {
      try {
        if (typeof onStatus === 'function') onStatus(event);
      } catch (e) { console.warn('[stagehandService] onStatus err:', e.message); }
    },
    abortSignal: signal,
  });

  const agent = new Agent({
    task: fullTask,
    llm,
    fallback_llm,                // recover from transient LLM errors automatically
    browser_session: session,
    controller,                  // Phase 5.5: enables wait_for_email + solve_captcha
    sensitive_data,
    use_vision: false,           // DOM-only mode — cleaner, faster, fewer LLM tokens
    use_judge: false,            // skip the optional judge LLM (extra 503-prone call)
    max_actions_per_step: 3,
    loop_detection_enabled: true,
    loop_detection_window: 4,
    register_new_step_callback: stepCallback,
    register_should_stop_callback: async () => Boolean(signal?.aborted),
  });

  let history;
  try {
    // ⚠️ agent.run() takes POSITIONAL args: (max_steps, on_step_start, on_step_end)
    // NOT an options object. Passing an object silently coerces to 0 steps.
    history = await agent.run(maxSteps);
  } catch (e) {
    console.error('[stagehandService] agent.run threw:', e.message);
    throw e;
  } finally {
    if (liveTicker) clearInterval(liveTicker);
  }

  // Touch lastUsed
  const s = sessions.get(userId || 'anonymous'); if (s) s.lastUsed = Date.now();

  // Prefer is_successful() — distinguishes "done with success" from
  // "done with success=false" (LLM gave up, called noop done).
  // Fall back to is_done() only when is_successful() is undefined.
  const explicitSuccess = typeof history?.is_successful === 'function' ? history.is_successful() : null;
  const reachedDone = history?.is_done?.() === true;
  const finalText = history?.final_result?.() || '';
  const looksLikeGiveUp = /no next action|llm.+(?:fail|empty|gave up)|stop.+failures/i.test(finalText);
  const success = explicitSuccess === true
    ? true
    : (explicitSuccess === false || looksLikeGiveUp)
      ? false
      : reachedDone;
  const finalMsg = finalText || (success
    ? 'Task completed.'
    : 'Task could not complete — the LLM ran out of responses (likely rate-limited or the fallback model returned malformed output). Retry in ~60s.');
  console.log(`[stagehandService] done success=${success} (explicit=${explicitSuccess} reachedDone=${reachedDone} giveUp=${looksLikeGiveUp}) steps=${stepIndex}`);

  return {
    success,
    message: finalMsg,
    actions: stepHistory.map(h => ({ type: h.action, url: h.url })),
    finalUrl: stepHistory[stepHistory.length - 1]?.url || null,
    finalScreenshot: null, // browser-use already streamed every screenshot via onStep
    stepHistory,
  };
}

// Single-shot helpers — used by /api/hands/act, /api/hands/extract-ai, etc.
// browser-use doesn't expose a one-shot act API, so these wrap a 1-step agent run.
async function act(instruction, { userId, startUrl } = {}) {
  const result = await runAgent(instruction, { userId, startUrl, maxSteps: 5 });
  return { success: result.success, action: result.message, finalUrl: result.finalUrl, finalScreenshot: null };
}

async function extractData(instruction, { userId, startUrl } = {}) {
  const result = await runAgent(`Extract the following information from the page: ${instruction}`,
    { userId, startUrl, maxSteps: 5 });
  return { data: result.message, finalUrl: result.finalUrl };
}

async function observe(instruction, { userId, startUrl } = {}) {
  const result = await runAgent(`List the interactive elements on this page that match: ${instruction}`,
    { userId, startUrl, maxSteps: 3 });
  return { actions: result.message, finalUrl: result.finalUrl };
}

module.exports = {
  runAgent, act, extractData, observe,
  shutdown, closeSession,
  // internals exposed for tests/admin
  getUserDataDir, classifyPageState,
};
