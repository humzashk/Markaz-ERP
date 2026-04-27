'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { wrap } = require('../middleware/errorHandler');

router.get('/', (req, res) => res.render('importexport/index', { page:'importexport' }));

router.get('/export/:entity', wrap(async (req, res) => {
  const allowed = { customers:'customers', vendors:'vendors', products:'products', invoices:'invoices', purchases:'purchases', orders:'orders' };
  const tbl = allowed[req.params.entity];
  if (!tbl) return res.status(400).send('bad entity');
  const r = await pool.query(`SELECT * FROM ${tbl} ORDER BY id`);
  const rows = r.rows;
  if (!rows.length) return res.status(204).end();
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(',')].concat(rows.map(row => cols.map(c => {
    const v = row[c]; if (v == null) return '';
    const s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }).join(','))).join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${tbl}.csv`);
  res.send(csv);
}));

module.exports = router;
