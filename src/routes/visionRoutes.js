const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const vc = require('../controllers/visionController');

router.post('/screen',      verifyToken, vc.handleAnalyzeScreen);
router.post('/webcam',      verifyToken, vc.handleAnalyzeWebcam);
router.post('/ocr',         verifyToken, vc.handleOCR);
router.post('/objects',     verifyToken, vc.handleDetectObjects);
router.get('/memory',       verifyToken, vc.handleGetVisualMemory);
router.post('/surveillance',verifyToken, vc.handleSurveillance);

module.exports = router;
