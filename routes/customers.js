'use strict';
const express = require('express');
const router = express.Router();
const { pool, addAuditLog } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const search = req.query.search || '';
  const region = req.query.region || '';
  const params = [];
  let sql = `SELECT * FROM customers WHERE 1=1`;
  if (search) { sql += ` AND (name ILIKE $1 OR phone ILIKE $1 OR city ILIKE $1)`; params.push('%'+search+'%'); }
  if (region) { sql += ` AND region=$${params.length + 1}`; params.push(region); }
  sql += ` ORDER BY id DESC`;
  const r = await pool.query(sql, params);
  const regionsR = await pool.query(`SELECT DISTINCT name, sort_order FROM party_categories WHERE cat_group='region' ORDER BY sort_order`);
  const typesR = await pool.query(`SELECT DISTINCT name, sort_order FROM party_categories WHERE cat_group='type' AND applies_to='customer' ORDER BY sort_order`);
  res.render('customers/index', { page:'customers', customers: r.rows, regions: regionsR.rows, types: typesR.rows, search, region, party_type: req.query.party_type || '' });
}));

router.get('/add', wrap(async (req, res) => {
  const regionsR = (await pool.query(`SELECT name FROM party_categories WHERE cat_group='region' ORDER BY sort_order`)).rows;
  const typesR   = (await pool.query(`SELECT name FROM party_categories WHERE cat_group='type' AND applies_to='customer' ORDER BY sort_order`)).rows;
  res.render('customers/form', { page:'customers', customer:null, edit:false, regions: regionsR, types: typesR });
}));

router.post('/add', validate(schemas.customerCreate), wrap(async (req, res) => {
  const v = req.valid;
  const r = await pool.query(`
    INSERT INTO customers(name,phone,email,address,city,ntn,category,region,credit_days,opening_balance,balance,default_commission_rate,account_scope,status,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,30),COALESCE($10,0),COALESCE($10,0),COALESCE($11,0),COALESCE($12,'plastic_markaz')::account_scope_t,COALESCE($13,'active')::active_status_t,$14)
    RETURNING id`,
    [v.name,v.phone,v.email,v.address,v.city,v.ntn,v.category,v.region,v.credit_days,v.opening_balance,v.default_commission_rate,v.account_scope,v.status,v.notes]
  );
  await addAuditLog('create','customers', r.rows[0].id, `Created ${v.name}`);
  res.redirect('/customers');
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const r = await pool.query(`SELECT * FROM customers WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.redirect('/customers');
  const regionsR = (await pool.query(`SELECT name FROM party_categories WHERE cat_group='region' ORDER BY sort_order`)).rows;
  const typesR   = (await pool.query(`SELECT name FROM party_categories WHERE cat_group='type' AND applies_to='customer' ORDER BY sort_order`)).rows;
  res.render('customers/form', { page:'customers', customer: r.rows[0], edit:true, regions: regionsR, types: typesR });
}));

router.post('/edit/:id', validate(schemas.customerCreate), wrap(async (req, res) => {
  const v = req.valid;
  await pool.query(`
    UPDATE customers SET name=$1,phone=$2,email=$3,address=$4,city=$5,ntn=$6,category=$7,region=$8,
      credit_days=COALESCE($9,30), opening_balance=COALESCE($10,0),
      default_commission_rate=COALESCE($11,0), account_scope=COALESCE($12,'plastic_markaz')::account_scope_t,
      status=COALESCE($13,'active')::active_status_t, notes=$14
    WHERE id=$15`,
    [v.name,v.phone,v.email,v.address,v.city,v.ntn,v.category,v.region,v.credit_days,v.opening_balance,v.default_commission_rate,v.account_scope,v.status,v.notes, req.params.id]);
  await addAuditLog('update','customers', req.params.id, `Updated ${v.name}`);
  res.redirect('/customers');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM customers WHERE id=$1`, [req.params.id]);
  await addAuditLog('delete','customers', req.params.id, 'Deleted');
  res.redirect('/customers');
}));

router.get('/ledger/:id', (req, res) => res.redirect('/ledger/customer/' + req.params.id));

// Bulk update: region, category (party_type), status
router.post('/bulk', wrap(async (req, res) => {
  const ids = (req.body.ids || '').split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
  if (!ids.length) return res.redirect('/customers?err=' + encodeURIComponent('No customers selected'));

  const sets = [], params = [];
  if (req.body.region && req.body.region.trim()) {
    params.push(req.body.region.trim());
    sets.push(`region=$${params.length}`);
  }
  // party_type from form → category column in DB
  if (req.body.party_type && req.body.party_type.trim()) {
    params.push(req.body.party_type.trim());
    sets.push(`category=$${params.length}`);
  }
  if (req.body.status && ['active','inactive'].includes(req.body.status)) {
    params.push(req.body.status);
    sets.push(`status=$${params.length}::active_status_t`);
  }
  if (sets.length) {
    params.push(ids);
    await pool.query(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = ANY($${params.length}::int[])`,
      params
    );
    await addAuditLog('update', 'customers', null, `Bulk updated ${ids.length} customer(s)`);
  }
  res.redirect('/customers?ok=' + encodeURIComponent(`${ids.length} customer(s) updated`));
}));

module.exports = router;
