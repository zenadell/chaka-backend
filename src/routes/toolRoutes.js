const express = require('express');
const router = express.Router();
const toolController = require('../controllers/toolController');
const { verifyToken } = require('../middleware/auth');
const multer = require('multer');
const os = require('os');

// Setup Multer to save temp files to system temp folder
// This prevents "Live Server" from reloading when a temp file is created
const upload = multer({ dest: os.tmpdir() });

// Check if middleware was imported correctly
if (!verifyToken) console.error("CRITICAL ERROR: verifyToken middleware is undefined.");

router.post('/search', verifyToken, toolController.handleSearch);
router.post('/image', verifyToken, toolController.handleImageGen);
router.post('/tts', verifyToken, toolController.handleTts);
router.post('/tts-raw', verifyToken, toolController.handleTtsRaw);
router.post('/youtube', verifyToken, toolController.handleYoutube);
router.post('/memory', verifyToken, toolController.handleUpdateMemory);
router.post('/reflection', verifyToken, toolController.handleReflection);
router.post('/email', verifyToken, toolController.handleEmail);
router.post('/image-edit', verifyToken, toolController.handleImageEdit);
router.post('/scrape-url', verifyToken, toolController.handleScrapeUrl);

// ✅ NEW WHISPER ROUTE (Uses 'upload.single' middleware)
router.post('/whisper', verifyToken, upload.single('audio'), toolController.handleWhisper);
router.post('/database', verifyToken, toolController.handleDatabaseQuery);

// ✅ LIVE STREAM MODE CONFIG
router.get('/live/config', verifyToken, toolController.handleLiveConfig);

// ✅ AI-POWERED EMOTION CLASSIFIER (for Live Mode visualizer)
router.post('/classify-emotion', verifyToken, toolController.handleClassifyEmotion);

// ✅ AUTO CHAT TITLE GENERATION
router.post('/generate-title', async (req, res) => {
  const { userMessage, botResponse } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

  try {
    const title = await generateChatTitle(userMessage, botResponse || '');
    res.json({ title });
  } catch (e) {
    console.error('Title generation error:', e.message);
    // Last resort fallback
    const fallback = heuristicTitle(userMessage);
    res.json({ title: fallback });
  }
});

const TITLE_PROMPT = `You are a chat title generator. Given a user's first message, determine the PURPOSE or TOPIC and generate a short, natural title (2-5 words).

Rules:
- Focus ONLY on the user's INTENT
- Use simple, natural, topic-based titles
- Never describe the assistant or its personality
- No quotes, no punctuation at the end, no explanation
- Just output the title text

Examples:
"hey" → Casual Greeting
"what's up" → Casual Chat
"what's the time in japan?" → Japan Time Check
"help me fix my python code" → Python Code Help
"write me a poem about love" → Love Poem Request
"what is quantum physics" → Quantum Physics Explained
"can you search for restaurants near me" → Restaurant Search
"generate an image of a cat" → Cat Image Generation
"what do you see in this image?" → Image Analysis
"remember my name is John" → Name Memory Update
"tell me a joke" → Joke Request
"tell me about me" → Personal Info Recap
"who am i" → Personal Info Recap
"hi" → Casual Greeting
"what can you do" → Capabilities Overview
"solve 2x + 5 = 15" → Math Problem Solving
"summarize this article" → Article Summary
"translate this to french" → French Translation`;

/**
 * Generate a smart chat title
 * Priority: 1) Existing Gemini keys (zero config) → 2) Groq → 3) Heuristic
 */
async function generateChatTitle(userMessage, botResponse) {
  // Strategy 1: Use existing Gemini API keys (already loaded in apiKeyManager)
  const apiKeyManager = require('../utils/apiKeyManager');
  const keyObj = apiKeyManager.getCurrentKey();
  
  if (keyObj && keyObj.key) {
    try {
      const title = await generateTitleWithGemini(keyObj.key, userMessage);
      if (title && title.length >= 2) {
        console.log(`✅ Title generated via Gemini: "${title}"`);
        return title;
      }
    } catch (e) {
      const errDetail = e.response ? JSON.stringify(e.response.data).substring(0, 300) : e.message;
      console.warn('Gemini title gen failed:', e.response?.status, errDetail);
    }
  }

  // Strategy 2: Try Groq if API key is set
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const title = await generateTitleWithGroq(groqKey, userMessage);
      if (title && title.length >= 2) {
        console.log(`✅ Title generated via Groq: "${title}"`);
        return title;
      }
    } catch (e) {
      console.warn('Groq title gen failed:', e.message);
    }
  }

  // Strategy 3: Smart heuristic fallback
  console.log('⚠️ Using heuristic title fallback');
  return heuristicTitle(userMessage);
}

/**
 * Use Vertex AI SDK (already configured via service account) with gemini-2.5-flash
 * This uses the SAME auth that already works for image generation
 */
async function generateTitleWithGemini(apiKey, userMessage) {
  const { VertexAI } = require('@google-cloud/vertexai');
  const vertexAI = new VertexAI({ project: 'chakachaka-e672a', location: 'us-central1' });
  const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: TITLE_PROMPT + '\n\nUser\'s message: "' + userMessage.substring(0, 300) + '"' }] }],
    generationConfig: {
      maxOutputTokens: 15,
      temperature: 0.2
    }
  });

  const title = result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!title) return null;
  return title.replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').substring(0, 60);
}

/**
 * Use Groq's free Llama API
 */
async function generateTitleWithGroq(groqKey, userMessage) {
  const axios = require('axios');
  const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: TITLE_PROMPT },
      { role: 'user', content: `User's message: "${userMessage.substring(0, 300)}"` }
    ],
    max_tokens: 15,
    temperature: 0.2
  }, {
    headers: {
      'Authorization': `Bearer ${groqKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 5000
  });

  const title = response.data?.choices?.[0]?.message?.content?.trim();
  if (!title) return null;
  return title.replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').substring(0, 60);
}

function heuristicTitle(text) {
  const cleaned = text.replace(/\n/g, ' ').trim();
  const firstSentence = cleaned.split(/[.!?]/)[0].trim();
  if (firstSentence.length <= 50) return firstSentence;
  return firstSentence.substring(0, 47).replace(/\s+\S*$/, '') + '...';
}

module.exports = router;
