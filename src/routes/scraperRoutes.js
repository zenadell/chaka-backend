'use strict';

const express = require('express');
const router = express.Router();
const { scrapeOne, scrapeMany, bustCache, status } = require('../controllers/scraperController');

router.get('/status', status);
router.post('/', scrapeOne);
router.post('/batch', scrapeMany);
router.delete('/cache', bustCache);

module.exports = router;
