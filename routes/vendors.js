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
  let sql = `SELECT * FROM vendors WHERE 1=1`;
  if (search) { sql += ` AND (name ILIKE $1 OR phone ILIKE $1 OR city ILIKE $1)`; params.push('%'+search+'%'); }
  if (region) { sql += ` AND region=$${params.length + 1}`; params.push(region); }
  sql += ` ORDER BY id DESC`;
  const r = await pool.query(sql, params);
  const regionsR = await pool.query(`SELECT DISTINCT name, sort_order FROM party_categories WHERE cat_group='region' ORDER BY sort_order`);
  const typesR = await pool.query(`SELECT DISTINCT name, sort_order FROM party_categories WHERE cat_group='type' AND applies_to='vendor' ORDER BY sort_order`);
  res.render('vendors/index', { page:'vendors', vendors: r.rows, regions: regionsR.rows, types: typesR.rows, search, region, party_type: req.query.party_type || '' });
}));

router.get('/add', (req, res) => res.render('vendors/form', { page:'vendors', vendor:null, edit:false }));

router.post('/add', validate(schemas.vendorCreate), wrap(async (req, res) => {
  const v = req.valid;
  const r = await pool.query(`
    INSERT INTO vendors(name,phone,email,address,city,ntn,category,region,credit_days,opening_balance,balance,account_scope,status,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,60),COALESCE($10,0),COALESCE($10,0),COALESCE($11,'plastic_markaz'),COALESCE($12,'active'),$13)
    RETURNING id`,
    [v.name,v.phone,v.email,v.address,v.city,v.ntn,v.category,v.region,v.credit_days,v.opening_balance,v.account_scope,v.status,v.notes]
  );
  await addAuditLog('create','vendors', r.rows[0].id, `Created ${v.name}`);
  res.redirect('/vendors');
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const r = await pool.query(`SELECT * FROM vendors WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.redirect('/vendors');
  res.render('vendors/form', { page:'vendors', vendor: r.rows[0], edit:true });
}));

router.post('/edit/:id', validate(schemas.vendorCreate), wrap(async (req, res) => {
  const v = req.valid;
  await pool.query(`
    UPDATE vendors SET name=$1,phone=$2,email=$3,address=$4,city=$5,ntn=$6,category=$7,region=$8,
      credit_days=COALESCE($9,60), opening_balance=COALESCE($10,0),
      account_scope=COALESCE($11,'plastic_markaz'), status=COALESCE($12,'active'), notes=$13
    WHERE id=$14`,
    [v.name,v.phone,v.email,v.address,v.city,v.ntn,v.category,v.region,v.credit_days,v.opening_balance,v.account_scope,v.status,v.notes, req.params.id]);
  await addAuditLog('update','vendors', req.params.id, `Updated ${v.name}`);
  res.redirect('/vendors');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM vendors WHERE id=$1`, [req.params.id]);
  await addAuditLog('delete','vendors', req.params.id, 'Deleted');
  res.redirect('/vendors');
}));

router.get('/ledger/:id', (req, res) => res.redirect('/ledger/vendor/' + req.params.id));

module.exports = router;
