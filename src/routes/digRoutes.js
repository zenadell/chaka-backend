'use strict';

const express = require('express');
const router = express.Router();
const { handleDig, status } = require('../controllers/deepDigController');

router.post('/', handleDig);
router.get('/status', status);

module.exports = router;
