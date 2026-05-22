const apiKeyManager = require('../utils/apiKeyManager');
const { streamGeminiChat } = require('../services/geminiService');
const { streamClaudeChat, isClaudeAvailable } = require('../services/claudeService');
const { routeRequest, detectImage } = require('../services/modelRouter');
const { generateSpeechRaw } = require('../services/ttsService');
const { injectCapabilities } = require('../utils/capabilities');

const MASTER_TIMEOUT = 90000;

function extractText(raw) {
  const match = raw.match(/"final_answer"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (match) {
    try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
  }
  if (raw.trim().startsWith('{')) {
    try {
      const json = JSON.parse(raw);
      return json.final_answer || json.text || raw;
    } catch {}
  }
  return raw;
}

exports.handleChatRequest = async (req, res) => {
  const { model, contents, voiceInput, plainText } = req.body || {};

  // --- Input validation (fail fast with 400 instead of crashing into 500) ---
  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "contents" array.' });
  }
  for (const msg of contents) {
    if (!msg || !msg.role || !Array.isArray(msg.parts)) {
      return res.status(400).json({ error: 'Each item in "contents" must be { role, parts: [...] }.' });
    }
  }

  const hasImage = detectImage(contents);

  // --- Inject tool awareness so Chaka knows her own capabilities ---
  injectCapabilities(contents);

  // --- Route: decide Claude vs Gemini ---
  const route = routeRequest({ model, contents, voiceInput, hasImage });
  console.log(`🧠 Model Router → brain=${route.brain} | reason="${route.reason}" | model=${route.suggestedModel}`);

  if (voiceInput) console.log('🎙  Voice input turn detected.');
  if (hasImage)   console.log(`📸 Image input detected.`);

  const payload = { contents };
  const startTime = Date.now();
  let success = false;

  // ── CLAUDE BRAIN ──────────────────────────────────────────────────────────
  if (route.brain === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    try {
      const result = await streamClaudeChat(apiKey, payload, route.suggestedModel);
      res.setHeader('Content-Type', 'application/json');
      success = true;

      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        res.write(JSON.stringify({ text: chunkText, _brain: 'claude' }) + '\n');
      }
      res.end();
      return;
    } catch (err) {
      console.error(`❌ Claude failed: ${err.message}. Falling back to Gemini.`);
      // Fall through to Gemini retry loop below
    }
  }

  // ── GEMINI BRAIN (default + Claude fallback) ───────────────────────────────
  while (Date.now() - startTime < MASTER_TIMEOUT) {
    const currentKeyInfo = apiKeyManager.getCurrentKey();
    if (!currentKeyInfo) {
      return res.status(503).json({ error: 'No API keys available.' });
    }

    console.log(`⚡️ Gemini attempt with Key #${currentKeyInfo.index}...`);

    try {
      const result = await streamGeminiChat(currentKeyInfo.key, payload, route.suggestedModel, { plainText: !!plainText });
      success = true;
      apiKeyManager.recordUsage(currentKeyInfo.id);
      res.setHeader('Content-Type', 'application/json');

      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        res.write(JSON.stringify({ text: chunkText, _brain: 'gemini' }) + '\n');
      }
      res.end();
      break;
    } catch (error) {
      console.error(`❌ Gemini Key #${currentKeyInfo.index} failed: ${error.message}`);
      apiKeyManager.reportFailure(currentKeyInfo.id);
      const nextKey = apiKeyManager.switchToNextKey();
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!nextKey) break;
    }
  }

  if (!success && !res.headersSent) {
    res.status(500).json({ error: 'All AI services failed. Please try again.' });
  }
};
