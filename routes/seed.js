'use strict';
const express = require('express');
const router = express.Router();
router.get('/', (req, res) => res.status(410).send('Seed route disabled. Use `npm run db:reset` to bootstrap a clean DB.'));
module.exports = router;
