const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog } = require('../database');

function getCategories() {
  const regions = db.prepare(`SELECT * FROM party_categories WHERE cat_group='region' AND status='active' ORDER BY sort_order, name`).all();
  const types = db.prepare(`SELECT * FROM party_categories WHERE cat_group='type' AND applies_to IN ('vendor','both') AND status='active' ORDER BY sort_order, name`).all();
  return { regions, types };
}

router.get('/', (req, res) => {
  const search = req.query.search || '';
  const region = req.query.region || '';
  const party_type = req.query.party_type || '';
  let sql = `SELECT * FROM vendors WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (name LIKE ? OR phone LIKE ? OR city LIKE ?)`; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (region) { sql += ` AND region = ?`; params.push(region); }
  if (party_type) { sql += ` AND party_type = ?`; params.push(party_type); }
  sql += ` ORDER BY name`;
  const vendors = db.prepare(sql).all(...params);
  const { regions, types } = getCategories();
  res.render('vendors/index', { page: 'vendors', vendors, search, region, party_type, regions, types });
});

router.get('/add', (req, res) => {
  const { regions, types } = getCategories();
  res.render('vendors/form', { page: 'vendors', vendor: null, edit: false, regions, types });
});

router.post('/add', validate(schemas.vendorCreate), (req, res) => {
  const { name, phone, email, address, city, opening_balance, region, party_type, notes, commission } = req.body;
  const bal = parseFloat(opening_balance) || 0;
  const result = db.prepare(
    `INSERT INTO vendors (name, phone, email, address, city, opening_balance, balance, region, party_type, notes, commission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, phone||'', email||'', address||'', city||'', bal, bal, region||'', party_type||'', notes||'', parseFloat(commission)||0);
  addAuditLog('create', 'vendors', result.lastInsertRowid, `Created vendor: ${name}`);
  res.redirect('/vendors');
});

router.get('/edit/:id', (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) return res.redirect('/vendors');
  const { regions, types } = getCategories();
  res.render('vendors/form', { page: 'vendors', vendor, edit: true, regions, types });
});

router.post('/edit/:id', validate(schemas.vendorCreate), (req, res) => {
  const { name, phone, email, address, city, status, region, party_type, notes, commission } = req.body;
  db.prepare(
    `UPDATE vendors SET name=?, phone=?, email=?, address=?, city=?, status=?, region=?, party_type=?, notes=?, commission=? WHERE id=?`
  ).run(name, phone||'', email||'', address||'', city||'', status||'active', region||'', party_type||'', notes||'', parseFloat(commission)||0, req.params.id);
  addAuditLog('update', 'vendors', req.params.id, `Updated vendor: ${name}`);
  res.redirect('/vendors');
});

router.get('/view/:id', (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) return res.redirect('/vendors');
  const purchases = db.prepare('SELECT * FROM purchases WHERE vendor_id = ? ORDER BY id DESC LIMIT 10').all(req.params.id);
  const ledgerEntries = db.prepare('SELECT * FROM ledger WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 20').all('vendor', req.params.id);
  res.render('vendors/view', { page: 'vendors', vendor, purchases, ledgerEntries });
});

router.post('/delete/:id', (req, res) => {
  db.prepare('UPDATE vendors SET status = ? WHERE id = ?').run('inactive', req.params.id);
  addAuditLog('delete', 'vendors', req.params.id, 'Deactivated vendor');
  res.redirect('/vendors');
});

module.exports = router;
