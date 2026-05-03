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

  // Build the WHERE clause for date range filter
  const params = [id]; const whereParts = [`entity_type='customer'`, `entity_id=$1`]; let i=2;
  if (from) { whereParts.push(`txn_date >= $${i}`); params.push(from); i++; }
  if (to)   { whereParts.push(`txn_date <= $${i}`); params.push(to);   i++; }

  // Use subquery to calculate running balance including all prior entries
  const entries = (await pool.query(`
    SELECT *,
      SUM(debit - credit) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS balance
    FROM ledger
    WHERE entity_type='customer' AND entity_id=$1
    ORDER BY id ASC
  `, [id])).rows;

  // Filter to the requested date range in application layer to preserve running balance calculation
  const filteredEntries = entries.filter(e => {
    if (from && e.txn_date < from) return false;
    if (to && e.txn_date > to) return false;
    return true;
  });

  res.render('ledger/detail', { page:'ledger', entity: customer, entityType:'customer', entries: filteredEntries, from, to });
}));

router.get('/vendor/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.redirect('/ledger');
  const vendor = (await pool.query(`SELECT * FROM vendors WHERE id=$1`, [id])).rows[0];
  if (!vendor) return res.redirect('/ledger');
  const from = req.query.from || '', to = req.query.to || '';

  // Use subquery to calculate running balance including all prior entries
  const entries = (await pool.query(`
    SELECT *,
      SUM(debit - credit) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS balance
    FROM ledger
    WHERE entity_type='vendor' AND entity_id=$1
    ORDER BY id ASC
  `, [id])).rows;

  // Filter to the requested date range in application layer to preserve running balance calculation
  const filteredEntries = entries.filter(e => {
    if (from && e.txn_date < from) return false;
    if (to && e.txn_date > to) return false;
    return true;
  });

  res.render('ledger/detail', { page:'ledger', entity: vendor, entityType:'vendor', entries: filteredEntries, from, to });
}));

router.get('/print/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params;
  const tbl = type === 'customer' ? 'customers' : 'vendors';
  const entity = (await pool.query(`SELECT * FROM ${tbl} WHERE id=$1`, [id])).rows[0];
  if (!entity) return res.redirect('/ledger');
  const from = req.query.from || '', to = req.query.to || '';

  // Use subquery to calculate running balance including all prior entries
  const entries = (await pool.query(`
    SELECT *,
      SUM(debit - credit) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS balance
    FROM ledger
    WHERE entity_type=$1 AND entity_id=$2
    ORDER BY id ASC
  `, [type, id])).rows;

  // Filter to the requested date range in application layer to preserve running balance calculation
  const filteredEntries = entries.filter(e => {
    if (from && e.txn_date < from) return false;
    if (to && e.txn_date > to) return false;
    return true;
  });

  res.render('ledger/print', { page:'ledger', entity, entityType: type, entries: filteredEntries, from, to, layout:false });
}));

module.exports = router;
