const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog } = require('../database');

function getCategories() {
  const regions = db.prepare(`SELECT * FROM party_categories WHERE cat_group='region' AND status='active' ORDER BY sort_order, name`).all();
  const types = db.prepare(`SELECT * FROM party_categories WHERE cat_group='type' AND applies_to IN ('customer','both') AND status='active' ORDER BY sort_order, name`).all();
  return { regions, types };
}

router.get('/', (req, res) => {
  const search = req.query.search || '';
  const region = req.query.region || '';
  const party_type = req.query.party_type || '';
  let sql = `SELECT * FROM customers WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (name LIKE ? OR phone LIKE ? OR city LIKE ?)`; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (region) { sql += ` AND region = ?`; params.push(region); }
  if (party_type) { sql += ` AND party_type = ?`; params.push(party_type); }
  sql += ` ORDER BY name`;
  const customers = db.prepare(sql).all(...params);
  const { regions, types } = getCategories();
  res.render('customers/index', { page: 'customers', customers, search, region, party_type, regions, types });
});

router.get('/add', (req, res) => {
  const { regions, types } = getCategories();
  res.render('customers/form', { page: 'customers', customer: null, edit: false, regions, types });
});

router.post('/add', validate(schemas.customerCreate), (req, res) => {
  const { name, phone, email, address, city, opening_balance, region, party_type, notes, commission } = req.body;
  const bal = parseFloat(opening_balance) || 0;
  const result = db.prepare(
    `INSERT INTO customers (name, phone, email, address, city, opening_balance, balance, region, party_type, notes, commission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, phone||'', email||'', address||'', city||'', bal, bal, region||'', party_type||'', notes||'', parseFloat(commission)||0);
  addAuditLog('create', 'customers', result.lastInsertRowid, `Created customer: ${name}`);
  res.redirect('/customers');
});

router.get('/edit/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  const { regions, types } = getCategories();
  res.render('customers/form', { page: 'customers', customer, edit: true, regions, types });
});

router.post('/edit/:id', validate(schemas.customerCreate), (req, res) => {
  const { name, phone, email, address, city, status, region, party_type, notes, commission } = req.body;
  db.prepare(
    `UPDATE customers SET name=?, phone=?, email=?, address=?, city=?, status=?, region=?, party_type=?, notes=?, commission=? WHERE id=?`
  ).run(name, phone||'', email||'', address||'', city||'', status||'active', region||'', party_type||'', notes||'', parseFloat(commission)||0, req.params.id);
  addAuditLog('update', 'customers', req.params.id, `Updated customer: ${name}`);
  res.redirect('/customers');
});

router.get('/view/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 10').all(req.params.id);
  const invoices = db.prepare('SELECT * FROM invoices WHERE customer_id = ? ORDER BY id DESC LIMIT 10').all(req.params.id);
  const ledgerEntries = db.prepare('SELECT * FROM ledger WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 20').all('customer', req.params.id);
  res.render('customers/view', { page: 'customers', customer, orders, invoices, ledgerEntries });
});

router.post('/delete/:id', (req, res) => {
  const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run('inactive', req.params.id);
  addAuditLog('delete', 'customers', req.params.id, `Deactivated customer: ${c?.name}`);
  res.redirect('/customers');
});

router.post('/bulk', (req, res) => {
  const { ids, region, party_type, status } = req.body;
  if (!ids) return res.redirect('/customers');
  const idList = ids.split(',').map(Number).filter(Boolean);
  if (!idList.length) return res.redirect('/customers');

  const updates = [];
  const vals = [];
  if (region) { updates.push('region = ?'); vals.push(region); }
  if (party_type) { updates.push('party_type = ?'); vals.push(party_type); }
  if (status) { updates.push('status = ?'); vals.push(status); }

  if (updates.length) {
    idList.forEach(id => {
      db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...vals, id);
    });
  }
  res.redirect('/customers');
});

module.exports = router;
