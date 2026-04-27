'use strict';
const express = require('express');
const router = express.Router();
const { pool, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');

router.get('/', wrap(async (req, res) => {
  const search = (req.query.search || '').trim();
  const sql = (table) => search
    ? `SELECT id, name, balance, phone, city FROM ${table} WHERE status='active' AND (name ILIKE $1 OR phone ILIKE $1 OR city ILIKE $1) ORDER BY name`
    : `SELECT id, name, balance, phone, city FROM ${table} WHERE status='active' ORDER BY name`;
  const params = search ? ['%'+search+'%'] : [];
  const customers = (await pool.query(sql('customers'), params)).rows;
  const vendors   = (await pool.query(sql('vendors'),   params)).rows;
  res.render('ledger/index', { page:'ledger', customers, vendors, search });
}));

router.get('/customer/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.redirect('/ledger');
  const customer = (await pool.query(`SELECT * FROM customers WHERE id=$1`, [id])).rows[0];
  if (!customer) return res.redirect('/ledger');
  const from = req.query.from || '', to = req.query.to || '';
  const params = [id]; const parts = [`entity_type='customer'`, `entity_id=$1`]; let i=2;
  if (from) { parts.push(`txn_date >= $${i}`); params.push(from); i++; }
  if (to)   { parts.push(`txn_date <= $${i}`); params.push(to);   i++; }
  const entries = (await pool.query(`SELECT * FROM ledger WHERE ${parts.join(' AND ')} ORDER BY id ASC`, params)).rows;
  res.render('ledger/detail', { page:'ledger', entity: customer, entityType:'customer', entries, from, to });
}));

router.get('/vendor/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.redirect('/ledger');
  const vendor = (await pool.query(`SELECT * FROM vendors WHERE id=$1`, [id])).rows[0];
  if (!vendor) return res.redirect('/ledger');
  const from = req.query.from || '', to = req.query.to || '';
  const params = [id]; const parts = [`entity_type='vendor'`, `entity_id=$1`]; let i=2;
  if (from) { parts.push(`txn_date >= $${i}`); params.push(from); i++; }
  if (to)   { parts.push(`txn_date <= $${i}`); params.push(to);   i++; }
  const entries = (await pool.query(`SELECT * FROM ledger WHERE ${parts.join(' AND ')} ORDER BY id ASC`, params)).rows;
  res.render('ledger/detail', { page:'ledger', entity: vendor, entityType:'vendor', entries, from, to });
}));

router.get('/print/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params;
  const tbl = type === 'customer' ? 'customers' : 'vendors';
  const entity = (await pool.query(`SELECT * FROM ${tbl} WHERE id=$1`, [id])).rows[0];
  if (!entity) return res.redirect('/ledger');
  const from = req.query.from || '', to = req.query.to || '';
  const params = [type, id]; const parts = [`entity_type=$1`, `entity_id=$2`]; let i=3;
  if (from) { parts.push(`txn_date >= $${i}`); params.push(from); i++; }
  if (to)   { parts.push(`txn_date <= $${i}`); params.push(to);   i++; }
  const entries = (await pool.query(`SELECT * FROM ledger WHERE ${parts.join(' AND ')} ORDER BY id ASC`, params)).rows;
  res.render('ledger/print', { page:'ledger', entity, entityType: type, entries, from, to, layout:false });
}));

module.exports = router;
