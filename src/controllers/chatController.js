// src/controllers/chatController.js
const apiKeyManager = require('../utils/apiKeyManager');
const { streamGeminiChat } = require('../services/geminiService');
const { generateSpeechRaw } = require('../services/ttsService');

const MASTER_TIMEOUT = 90000;

/**
 * Extracts the actual answer text from JSON-wrapped responses.
 */
function extractText(raw) {
  // 1. Try to find "final_answer" via surgery
  const match = raw.match(/"final_answer"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (match) {
    try {
      // Decode escaped characters
      return JSON.parse(`"${match[1]}"`);
    } catch (err) {
      return match[1];
    }
  }

  // 2. If it's a raw JSON object but missing final_answer (unlikely)
  if (raw.trim().startsWith('{')) {
    try {
      const json = JSON.parse(raw);
      return json.final_answer || json.text || raw;
    } catch (e) { }
  }

  // 3. Just return the raw text (standard conversational mode)
  return raw;
}

exports.handleChatRequest = async (req, res) => {
  const { model, contents, voiceInput } = req.body;

  if (voiceInput) {
    console.log("🎙  Voice input turn detected. Auto-TTS will trigger after generation.");
  } else {
    console.log("⌨️  Text input turn detected.");
  }

  // Debug Log: Check if images are present
  const lastMsg = contents[contents.length - 1];
  const hasImage = lastMsg.parts.some(p => p.inlineData);

  if (hasImage) {
    console.log(`📸 Image input detected! Using model: ${model || 'default'}`);
  }

  // Construct payload
  const payload = { contents };

  const startTime = Date.now();
  let success = false;

  // --- THE RETRY LOOP ---
  while (Date.now() - startTime < MASTER_TIMEOUT) {
    const currentKeyInfo = apiKeyManager.getCurrentKey();
    if (!currentKeyInfo) {
      return res.status(503).json({ error: "No API keys available." });
    }

    console.log(`⚡️ Attempting chat with Key Index #${currentKeyInfo.index}...`);

    try {
      // 1. Call Google SDK
      const result = await streamGeminiChat(currentKeyInfo.key, payload, model);

      // 2. Success Setup
      success = true;
      apiKeyManager.recordUsage(currentKeyInfo.id);
      res.setHeader('Content-Type', 'application/json');

      let accumulatedText = "";

      // 3. Stream response
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        accumulatedText += chunkText;
        res.write(JSON.stringify({ text: chunkText }) + "\n");
      }
      res.end();
      break;

    } catch (error) {
      console.error(`❌ Key #${currentKeyInfo.index} failed: ${error.message}`);
      apiKeyManager.reportFailure(currentKeyInfo.id);

      const nextKey = apiKeyManager.switchToNextKey();
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (!nextKey) break;
    }
  }

  if (!success && !res.headersSent) {
    res.status(500).json({ error: "All API keys failed. Please try again." });
  }
};
