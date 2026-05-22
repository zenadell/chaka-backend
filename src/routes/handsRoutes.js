const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const hc = require('../controllers/handsController');

// Browser hands (Playwright low-level)
router.post('/browser/navigate',   verifyToken, hc.handleNavigate);
router.post('/browser/screenshot', verifyToken, hc.handleScreenshot);
router.post('/browser/click',      verifyToken, hc.handleClick);
router.post('/browser/fill',       verifyToken, hc.handleFill);
router.post('/browser/extract',    verifyToken, hc.handleExtract);

// Autonomous agent hands (Stagehand AI — natural language)
router.post('/agent',       verifyToken, hc.handleAgent);     // SSE stream — multi-step task
router.post('/act',         verifyToken, hc.handleAct);       // single act
router.post('/observe',     verifyToken, hc.handleObserve);   // list interactable elements
router.post('/extract-ai',  verifyToken, hc.handleExtractAI); // semantic extraction
router.post('/session/close', verifyToken, hc.handleSessionClose);

// Credential vault (Phase 4E) — encrypted creds for autonomous logins
router.get('/credentials',    verifyToken, hc.handleListCredentials);
router.post('/credentials',   verifyToken, hc.handleSetCredential);
router.delete('/credentials', verifyToken, hc.handleDeleteCredential);

module.exports = router;
