const { GoogleGenerativeAI } = require('@google/generative-ai');
const { executeSql } = require('./tursoService');
const sharp = require('sharp');

// Compress image before sending to Gemini (saves tokens, speeds up response)
async function compressImageBase64(base64, mimeType) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const compressed = await sharp(buffer)
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { data: compressed.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { data: base64, mimeType };
  }
}

async function callGeminiVision(apiKey, imageBase64, mimeType, prompt) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const { data, mimeType: finalMime } = await compressImageBase64(imageBase64, mimeType);

  const result = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: finalMime, data } },
        { text: prompt }
      ]
    }]
  });

  return result.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── SCREEN ANALYSIS ─────────────────────────────────────────────────────────

async function analyzeScreen(apiKey, imageBase64, mimeType = 'image/png', customPrompt = null) {
  const prompt = customPrompt ||
    `You are Chaka, an AI assistant with vision. The user has shared their screen with you.
Describe what you see clearly and concisely. If there is text, read it. If there is code, analyze it.
If there is an error, diagnose it. Be specific — mention app names, file names, and content you can see.
Then ask how you can help with what's on screen.`;

  console.log('[visionService] Analyzing screen capture...');
  return await callGeminiVision(apiKey, imageBase64, mimeType, prompt);
}

// ── WEBCAM ANALYSIS ──────────────────────────────────────────────────────────

async function analyzeWebcam(apiKey, imageBase64, mimeType = 'image/jpeg', customPrompt = null) {
  const prompt = customPrompt ||
    `You are Chaka with live webcam vision. Describe what you see in the camera feed naturally,
as if you're genuinely looking at the person or scene. Note the environment, what the person is doing,
any objects visible, lighting, and mood. Be warm and conversational, not clinical.`;

  console.log('[visionService] Analyzing webcam frame...');
  return await callGeminiVision(apiKey, imageBase64, mimeType, prompt);
}

// ── OCR — TEXT EXTRACTION ────────────────────────────────────────────────────

async function performOCR(apiKey, imageBase64, mimeType = 'image/jpeg') {
  const prompt =
    `Extract ALL text from this image exactly as written. Preserve formatting, line breaks, and structure.
If it is a table, preserve the table structure. If it is handwriting, transcribe it faithfully.
Output ONLY the extracted text — no commentary, no explanation.`;

  console.log('[visionService] Performing OCR...');
  const text = await callGeminiVision(apiKey, imageBase64, mimeType, prompt);
  return text.trim();
}

// ── VISUAL MEMORY ────────────────────────────────────────────────────────────

async function storeVisualMemory(userId, description, source = 'screen') {
  try {
    const memId = 'vis_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    await executeSql(
      `INSERT INTO memories (id, userId, text, topic, emotion, status, createdAt)
       VALUES (?, ?, ?, 'visual', 'neutral', 'ACTIVE', CURRENT_TIMESTAMP)`,
      [memId, userId, `[${source.toUpperCase()} SEEN] ${description}`]
    );
    console.log(`[visionService] Visual memory stored: ${memId}`);
    return memId;
  } catch (err) {
    console.warn('[visionService] Could not store visual memory:', err.message);
    return null;
  }
}

async function getVisualMemories(userId, limit = 10) {
  try {
    const result = await executeSql(
      `SELECT id, text, createdAt FROM memories
       WHERE userId = ? AND topic = 'visual' AND status = 'ACTIVE'
       ORDER BY createdAt DESC LIMIT ?`,
      [userId, limit]
    );
    return result.rows;
  } catch {
    return [];
  }
}

// ── SURVEILLANCE MODE (admin-only) ───────────────────────────────────────────

async function checkSurveillanceTrigger(apiKey, imageBase64, mimeType, triggerCondition) {
  const prompt =
    `You are a surveillance AI. Analyze this image and determine if the following condition is met:
"${triggerCondition}"

Reply with ONLY a JSON object: { "triggered": true/false, "confidence": 0-100, "reason": "brief explanation" }
No markdown, no extra text.`;

  const raw = await callGeminiVision(apiKey, imageBase64, mimeType, prompt);
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { triggered: false, confidence: 0, reason: 'Parse error' };
  }
}

// ── OBJECT & SCENE DETECTION ─────────────────────────────────────────────────

async function detectObjects(apiKey, imageBase64, mimeType = 'image/jpeg') {
  const prompt =
    `List all objects, people, text, and elements visible in this image.
Return a JSON array: [{ "label": "object name", "confidence": "high/medium/low", "location": "top-left/center/etc" }]
No markdown, JSON only.`;

  const raw = await callGeminiVision(apiKey, imageBase64, mimeType, prompt);
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return [];
  }
}

module.exports = {
  analyzeScreen,
  analyzeWebcam,
  performOCR,
  storeVisualMemory,
  getVisualMemories,
  checkSurveillanceTrigger,
  detectObjects,
};
