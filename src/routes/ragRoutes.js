const express = require('express');
const router = express.Router();
const ragController = require('../controllers/ragController');

// Route to turn text into vectors
router.post('/embed', ragController.embedText);

module.exports = router;