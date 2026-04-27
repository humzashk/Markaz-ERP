'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, applyStockMovement, addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const r = await pool.query(`
    SELECT br.*, p.name AS product_name,
      COALESCE(c.name, '') AS customer_name,
      COALESCE(v.name, '') AS vendor_name
    FROM breakage br
    JOIN products p ON p.id = br.product_id
    LEFT JOIN customers c ON c.id = br.customer_id
    LEFT JOIN vendors v   ON v.id = br.vendor_id
    ORDER BY br.id DESC LIMIT 500`);
  res.render('breakage/index', { page:'breakage', breakages: r.rows });
}));

router.get('/add', wrap(async (req, res) => {
  const products = (await pool.query(`SELECT id, name FROM products WHERE status='active' ORDER BY name`)).rows;
  const customers = (await pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`)).rows;
  const vendors   = (await pool.query(`SELECT id, name FROM vendors   WHERE status='active' ORDER BY name`)).rows;
  res.render('breakage/form', { page:'breakage', products, customers, vendors, breakage:null, edit:false });
}));

router.post('/add', validate(schemas.breakageCreate), wrap(async (req, res) => {
  const v = req.valid;
  await tx(async (db) => {
    const ins = await db.run(`
      INSERT INTO breakage(customer_id, vendor_id, product_id, quantity, breakage_date, claim_status, notes)
      VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING id`,
      [v.customer_id, v.vendor_id, v.product_id, v.quantity, v.breakage_date, v.notes]);
    // Breakage = stock OUT
    await applyStockMovement(db, v.product_id, null, -v.quantity, 'breakage', ins.id, 'breakage', v.notes);
    await addAuditLog('create','breakage', ins.id, `Breakage ${v.quantity}`);
  });
  res.redirect('/breakage');
}));

module.exports = router;
