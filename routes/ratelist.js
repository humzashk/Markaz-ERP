const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const rates = db.prepare(`
    SELECT r.*, p.name as product_name, p.category, p.id as product_id
    FROM rate_list r JOIN products p ON p.id = r.product_id
    ORDER BY p.name, r.customer_type, r.effective_date DESC
  `).all();
  const products = db.prepare('SELECT id, name, qty_per_pack, rate FROM products WHERE status = ? ORDER BY name').all('active');
  // Fetch rate history for all products in rate list
  const productIds = [...new Set(rates.map(r => r.product_id))];
  let rateHistory = [];
  if (productIds.length) {
    rateHistory = db.prepare(
      `SELECT * FROM product_rate_history WHERE product_id IN (${productIds.map(() => '?').join(',')}) ORDER BY changed_at DESC`
    ).all(...productIds);
  }
  res.render('ratelist/index', { page: 'ratelist', rates, products, rateHistory });
});

router.post('/add', validate(schemas.rateListCreate), (req, res) => {
  const { product_id, customer_type, rate, effective_date } = req.body;
  db.prepare(
    `INSERT INTO rate_list (product_id, customer_type, rate, effective_date) VALUES (?, ?, ?, ?)`
  ).run(product_id, customer_type || 'retail', parseFloat(rate), effective_date);
  addAuditLog('create', 'rate_list', null, `Added rate for product ${product_id}`);
  res.redirect('/ratelist');
});

router.post('/edit/:id', validate(schemas.rateListCreate), (req, res) => {
  const { rate, effective_date } = req.body;
  db.prepare(
    `UPDATE rate_list SET rate=?, effective_date=? WHERE id=?`
  ).run(parseFloat(rate) || 0, effective_date, req.params.id);
  addAuditLog('update', 'rate_list', req.params.id, `Updated rate`);
  res.redirect('/ratelist');
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM rate_list WHERE id = ?').run(req.params.id);
  res.redirect('/ratelist');
});

router.post('/bulk', (req, res) => {
  const { ids, rate } = req.body;
  if (!ids || !rate) return res.redirect('/ratelist');
  const idList = ids.split(',').map(Number).filter(Boolean);
  if (!idList.length) return res.redirect('/ratelist');
  const stmt = db.prepare('UPDATE rate_list SET rate = ? WHERE id = ?');
  idList.forEach(id => stmt.run(parseFloat(rate), id));
  res.redirect('/ratelist');
});

module.exports = router;
