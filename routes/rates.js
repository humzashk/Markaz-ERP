'use strict';
const express = require('express');
const router  = express.Router();
const { pool, tx, addAuditLog, toNum } = require('../database');
const { wrap } = require('../middleware/errorHandler');

const PAGE_SIZE = 75;

// Auto-create rate_history table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS rate_history (
    id         SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    old_rate   NUMERIC(14,2) NOT NULL DEFAULT 0,
    new_rate   NUMERIC(14,2) NOT NULL DEFAULT 0,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rate_history_product ON rate_history(product_id);
  CREATE INDEX IF NOT EXISTS idx_rate_history_changed ON rate_history(changed_at DESC);
`).catch(e => console.error('[rates] table init failed:', e.message));

// ── GET /rates ────────────────────────────────────────────────────────────────
router.get('/', wrap(async (req, res) => {
  const search   = (req.query.search || '').trim();
  const category = (req.query.category || '').trim();
  const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset   = (page - 1) * PAGE_SIZE;

  const params = []; let i = 1;
  let where = `WHERE status='active'`;
  if (search)   { where += ` AND (name ILIKE $${i} OR item_id ILIKE $${i})`; params.push('%' + search + '%'); i++; }
  if (category) { where += ` AND category ILIKE $${i}`;                       params.push('%' + category + '%'); i++; }

  const countSql   = `SELECT COUNT(*) FROM products ${where}`;
  const productSql = `
    SELECT p.id, p.item_id, p.name, p.category, p.unit, p.selling_price,
           rh.old_rate   AS prev_rate,
           rh.changed_at AS rate_changed_at
    FROM products p
    LEFT JOIN LATERAL (
      SELECT old_rate, changed_at
      FROM rate_history
      WHERE product_id = p.id
      ORDER BY id DESC
      LIMIT 1
    ) rh ON true
    ${where} ORDER BY p.name LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
  const catSql     = `SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY category`;

  const [cntR, prodR, catR] = await Promise.all([
    pool.query(countSql,   params),
    pool.query(productSql, params),
    pool.query(catSql)
  ]);

  const total = parseInt(cntR.rows[0].count, 10);
  const pages = Math.ceil(total / PAGE_SIZE);

  res.render('rates', {
    page: 'rates',
    products:   prodR.rows,
    categories: catR.rows.map(r => r.category),
    search, category,
    currentPage: page, pages, total,
    ok:  req.query.ok  || null,
    err: req.query.err || null
  });
}));

// ── POST /rates/update  (single product) ─────────────────────────────────────
router.post('/update', wrap(async (req, res) => {
  const id      = parseInt(req.body.product_id, 10);
  const newRate = toNum(req.body.new_rate, NaN);
  const back    = req.body.back || '/rates';

  if (!id || isNaN(id))            return res.redirect(back + '?err=' + encodeURIComponent('Invalid product'));
  if (isNaN(newRate) || newRate < 0) return res.redirect(back + '?err=' + encodeURIComponent('Rate must be a valid number ≥ 0'));

  await tx(async (db) => {
    const r = await db.one(`SELECT selling_price FROM products WHERE id=$1 FOR UPDATE`, [id]);
    if (!r) throw new Error('Product not found');
    const oldRate = Number(r.selling_price) || 0;

    await db.run(`UPDATE products SET selling_price=$1 WHERE id=$2`, [newRate, id]);
    await db.run(
      `INSERT INTO rate_history(product_id, old_rate, new_rate, user_id) VALUES($1,$2,$3,$4)`,
      [id, oldRate, newRate, (req.user ? req.user.id : null)]
    );
  });

  await addAuditLog('update', 'products', id, `Rate updated to ${newRate}`);
  res.redirect(back + '?ok=' + encodeURIComponent('Rate updated successfully'));
}));

// ── POST /rates/bulk-update  (multiple products) ──────────────────────────────
router.post('/bulk-update', wrap(async (req, res) => {
  // Body: ids[] and rates[] arrays (parallel index)
  const rawIds   = Array.isArray(req.body.ids)   ? req.body.ids   : (req.body.ids   ? [req.body.ids]   : []);
  const rawRates = Array.isArray(req.body.rates)  ? req.body.rates : (req.body.rates ? [req.body.rates] : []);

  if (!rawIds.length) return res.redirect('/rates?err=' + encodeURIComponent('No products selected'));
  if (rawIds.length !== rawRates.length) return res.redirect('/rates?err=' + encodeURIComponent('Data mismatch — please reload and try again'));

  // Validate all before touching DB
  const entries = [];
  for (let i = 0; i < rawIds.length; i++) {
    const id  = parseInt(rawIds[i], 10);
    const val = toNum(rawRates[i], NaN);
    if (!id || isNaN(id))          return res.redirect('/rates?err=' + encodeURIComponent(`Invalid product ID at row ${i + 1}`));
    if (isNaN(val) || val < 0)     return res.redirect('/rates?err=' + encodeURIComponent(`Invalid rate at row ${i + 1} — must be ≥ 0`));
    entries.push({ id, newRate: val });
  }

  let updatedCount = 0;
  await tx(async (db) => {
    for (const { id, newRate } of entries) {
      const r = await db.one(`SELECT selling_price FROM products WHERE id=$1 FOR UPDATE`, [id]);
      if (!r) throw new Error(`Product ${id} not found`);
      const oldRate = Number(r.selling_price) || 0;
      if (oldRate === newRate) continue; // skip unchanged

      await db.run(`UPDATE products SET selling_price=$1 WHERE id=$2`, [newRate, id]);
      await db.run(
        `INSERT INTO rate_history(product_id, old_rate, new_rate, user_id) VALUES($1,$2,$3,$4)`,
        [id, oldRate, newRate, (req.user ? req.user.id : null)]
      );
      updatedCount++;
    }
  });

  await addAuditLog('update', 'products', null, `Bulk rate update: ${updatedCount} product(s) changed`);
  res.redirect('/rates?ok=' + encodeURIComponent(`${updatedCount} product rate(s) updated`));
}));

module.exports = router;
