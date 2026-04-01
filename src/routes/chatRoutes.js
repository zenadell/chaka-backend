const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');

// Define the POST route that the frontend will call
router.post('/', chatController.handleChatRequest);

module.exports = router;