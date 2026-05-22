const apiKeyManager = require('../utils/apiKeyManager');
const {
  analyzeScreen,
  analyzeWebcam,
  performOCR,
  storeVisualMemory,
  getVisualMemories,
  checkSurveillanceTrigger,
  detectObjects,
} = require('../services/visionService');

function getVisionKey() {
  // Vision calls use Gemini API — must be a 'text' type key (Gemini API key).
  // 'image' type keys are Vertex AI keys and won't work with @google/generative-ai.
  return (
    apiKeyManager.keys.find(k => k.type === 'text')?.key ||
    apiKeyManager.getCurrentKey()?.key
  );
}

// POST /api/vision/screen
exports.handleAnalyzeScreen = async (req, res) => {
  const { imageBase64, mimeType, prompt, storeMemory } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

  const apiKey = getVisionKey();
  if (!apiKey) return res.status(503).json({ error: 'No vision API key available' });

  try {
    const description = await analyzeScreen(apiKey, imageBase64, mimeType || 'image/png', prompt);

    if (storeMemory && req.user?.uid) {
      await storeVisualMemory(req.user.uid, description, 'screen');
    }

    res.json({ description, source: 'screen' });
  } catch (err) {
    console.error('[visionController] screen error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/vision/webcam
exports.handleAnalyzeWebcam = async (req, res) => {
  const { imageBase64, mimeType, prompt, storeMemory } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

  const apiKey = getVisionKey();
  if (!apiKey) return res.status(503).json({ error: 'No vision API key available' });

  try {
    const description = await analyzeWebcam(apiKey, imageBase64, mimeType || 'image/jpeg', prompt);

    if (storeMemory && req.user?.uid) {
      await storeVisualMemory(req.user.uid, description, 'webcam');
    }

    res.json({ description, source: 'webcam' });
  } catch (err) {
    console.error('[visionController] webcam error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/vision/ocr
exports.handleOCR = async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

  const apiKey = getVisionKey();
  if (!apiKey) return res.status(503).json({ error: 'No vision API key available' });

  try {
    const text = await performOCR(apiKey, imageBase64, mimeType || 'image/jpeg');
    res.json({ text });
  } catch (err) {
    console.error('[visionController] OCR error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/vision/objects
exports.handleDetectObjects = async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

  const apiKey = getVisionKey();
  if (!apiKey) return res.status(503).json({ error: 'No vision API key available' });

  try {
    const objects = await detectObjects(apiKey, imageBase64, mimeType || 'image/jpeg');
    res.json({ objects });
  } catch (err) {
    console.error('[visionController] object detection error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/vision/memory
exports.handleGetVisualMemory = async (req, res) => {
  const userId = req.user?.uid;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const memories = await getVisualMemories(userId, parseInt(req.query.limit) || 10);
    res.json({ memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/vision/surveillance  (admin-only)
exports.handleSurveillance = async (req, res) => {
  const { imageBase64, mimeType, triggerCondition } = req.body;
  if (!imageBase64 || !triggerCondition) {
    return res.status(400).json({ error: 'imageBase64 and triggerCondition are required' });
  }

  // Admin gate — checked via Firebase custom claim or known admin UID
  const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const callerUid = req.user?.uid;
  if (!callerUid || (!ADMIN_UIDS.includes(callerUid) && !req.user?.admin)) {
    return res.status(403).json({ error: 'Surveillance is admin-only.' });
  }

  const apiKey = getVisionKey();
  if (!apiKey) return res.status(503).json({ error: 'No vision API key available' });

  try {
    const result = await checkSurveillanceTrigger(apiKey, imageBase64, mimeType || 'image/jpeg', triggerCondition);
    res.json(result);
  } catch (err) {
    console.error('[visionController] surveillance error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
