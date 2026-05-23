'use strict';

const express = require('express');
const router = express.Router();
const { handleResearch, status } = require('../controllers/researchController');

router.get('/status', status);
router.post('/',      handleResearch);

module.exports = router;
