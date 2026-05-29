'use strict';

const express = require('express');
const router = express.Router();
const { handleDig, status } = require('../controllers/deepDigController');
const { verifyToken } = require('../middleware/auth');

router.post('/', verifyToken, handleDig);
router.get('/status', verifyToken, status);

module.exports = router;
