'use strict';
const express = require('express');
const router = express.Router();
const { pool, addAuditLog } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const r = await pool.query(`
    SELECT rl.*, p.name AS product_name, p.unit FROM rate_list rl
    JOIN products p ON p.id = rl.product_id
    ORDER BY rl.id DESC LIMIT 500
  `);
  const products = await pool.query(`SELECT id, name, unit, selling_price AS rate, qty_per_pack FROM products WHERE status='active' ORDER BY name`);
  res.render('ratelist/index', { page:'ratelist', rates: r.rows, products: products.rows });
}));

router.get('/add', wrap(async (req, res) => {
  const products = await pool.query(`SELECT id, name, unit, selling_price FROM products WHERE status='active' ORDER BY name`);
  res.render('ratelist/form', { page:'ratelist', rate:null, products: products.rows, edit:false });
}));

router.post('/add', validate(schemas.rateListCreate), wrap(async (req, res) => {
  const v = req.valid;
  const r = await pool.query(`
    INSERT INTO rate_list(product_id, customer_type, rate, effective_date, packaging, commission_pct)
    VALUES ($1,$2,$3,$4,COALESCE($5,1),COALESCE($6,0)) RETURNING id`,
    [v.product_id, v.customer_type, v.rate, v.effective_date, req.body.packaging || 1, req.body.commission_pct || 0]);
  await addAuditLog('create','ratelist', r.rows[0].id, `Rate set`);
  res.redirect('/ratelist');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM rate_list WHERE id=$1`, [req.params.id]);
  res.redirect('/ratelist');
}));

module.exports = router;
