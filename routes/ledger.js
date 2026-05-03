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

  const todayStr    = new Date().toISOString().split('T')[0];
  const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const from = req.query.from !== undefined ? req.query.from : defaultFrom;
  const to   = req.query.to   !== undefined ? req.query.to   : todayStr;

  // Opening balance: all entries strictly before from_date
  const obParams = [id];
  let obSql = `SELECT COALESCE(SUM(debit - credit), 0) AS ob FROM ledger WHERE entity_type='customer' AND entity_id=$1`;
  if (from) { obSql += ` AND txn_date < $2`; obParams.push(from); }
  const obRow = (await pool.query(obSql, obParams)).rows[0];
  const openingBalance = Number(obRow.ob) || 0;

  const params = [id];
  let sql = `
    SELECT
      l.id, l.txn_date, l.debit, l.credit, l.reference_type, l.reference_id, l.account_scope,
      CASE
        WHEN l.reference_type = 'invoice'     THEN 'Customer Invoice'
        WHEN l.reference_type = 'payment'     THEN 'Customer Payment'
        WHEN l.reference_type = 'credit_note' THEN 'Credit Note'
        WHEN l.reference_type = 'debit_note'  THEN 'Debit Note'
        ELSE COALESCE(l.description, 'General Entry')
      END AS description,
      COALESCE(pay.payment_method, '') AS payment_method
    FROM ledger l
    LEFT JOIN payments pay ON l.reference_type = 'payment' AND l.reference_id = pay.id
    WHERE l.entity_type = 'customer' AND l.entity_id = $1`;

  let p = 2;
  if (from) { sql += ` AND l.txn_date >= $${p}`; params.push(from); p++; }
  if (to)   { sql += ` AND l.txn_date <= $${p}`; params.push(to);   p++; }
  sql += ` ORDER BY l.txn_date ASC, l.id ASC`;

  const rows = (await pool.query(sql, params)).rows;

  let running = openingBalance;
  const entries = rows.map(r => {
    running += Number(r.debit || 0) - Number(r.credit || 0);
    return { ...r, running_balance: running };
  });
  const closingBalance = running;

  res.render('ledger/detail', { page:'ledger', entity: customer, entityType:'customer', entries, openingBalance, closingBalance, from, to });
}));

router.get('/vendor/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.redirect('/ledger');
  const vendor = (await pool.query(`SELECT * FROM vendors WHERE id=$1`, [id])).rows[0];
  if (!vendor) return res.redirect('/ledger');

  // Default range: last 30 days
  const todayStr      = new Date().toISOString().split('T')[0];
  const defaultFrom   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const from = req.query.from !== undefined ? req.query.from : defaultFrom;
  const to   = req.query.to   !== undefined ? req.query.to   : todayStr;

  // Opening balance: all entries strictly before from_date
  const obParams = [id];
  let obSql = `SELECT COALESCE(SUM(debit - credit), 0) AS ob FROM ledger WHERE entity_type='vendor' AND entity_id=$1`;
  if (from) { obSql += ` AND txn_date < $2`; obParams.push(from); }
  const obRow = (await pool.query(obSql, obParams)).rows[0];
  const openingBalance = Number(obRow.ob) || 0;

  // Entries within date range + payment_method from payments table
  const params = [id];
  let sql = `
    SELECT
      l.id, l.txn_date, l.debit, l.credit, l.reference_type, l.reference_id, l.account_scope,
      CASE
        WHEN l.reference_type = 'purchase'    THEN 'Supplier Purchase'
        WHEN l.reference_type = 'payment'     THEN 'Vendor Payment'
        WHEN l.reference_type = 'debit_note'  THEN 'Adjustment Debit Note'
        WHEN l.reference_type = 'credit_note' THEN 'Adjustment Credit Note'
        ELSE COALESCE(l.description, 'General Entry')
      END AS description,
      COALESCE(pay.payment_method, '') AS payment_method
    FROM ledger l
    LEFT JOIN payments pay ON l.reference_type = 'payment' AND l.reference_id = pay.id
    WHERE l.entity_type = 'vendor' AND l.entity_id = $1`;

  let p = 2;
  if (from) { sql += ` AND l.txn_date >= $${p}`; params.push(from); p++; }
  if (to)   { sql += ` AND l.txn_date <= $${p}`; params.push(to);   p++; }
  sql += ` ORDER BY l.txn_date ASC, l.id ASC`;

  const rows = (await pool.query(sql, params)).rows;

  // Compute running balance from opening balance
  let running = openingBalance;
  const entries = rows.map(r => {
    running += Number(r.debit || 0) - Number(r.credit || 0);
    return { ...r, running_balance: running };
  });
  const closingBalance = running;

  res.render('ledger/vendor', {
    page: 'ledger',
    vendor, entries,
    openingBalance, closingBalance,
    from, to
  });
}));

router.get('/print/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params;
  const tbl = type === 'customer' ? 'customers' : 'vendors';
  const entity = (await pool.query(`SELECT * FROM ${tbl} WHERE id=$1`, [id])).rows[0];
  if (!entity) return res.redirect('/ledger');
  const from = req.query.from || '', to = req.query.to || '';

  const obParams = [id];
  let obSql = `SELECT COALESCE(SUM(debit - credit), 0) AS ob FROM ledger WHERE entity_type=${ type === 'customer' ? "'customer'" : "'vendor'" } AND entity_id=$1`;
  if (from) { obSql += ` AND txn_date < $2`; obParams.push(from); }
  const obRow = (await pool.query(obSql, obParams)).rows[0];
  const openingBalance = Number(obRow.ob) || 0;

  const params = [type, id];
  let sql = `
    SELECT l.id, l.txn_date, l.debit, l.credit, l.reference_type, l.reference_id, l.account_scope,
      CASE
        WHEN l.reference_type = 'purchase'    THEN 'Supplier Purchase'
        WHEN l.reference_type = 'payment'     THEN CASE WHEN l.entity_type='vendor' THEN 'Vendor Payment' ELSE 'Customer Payment' END
        WHEN l.reference_type = 'invoice'     THEN 'Customer Invoice'
        WHEN l.reference_type = 'debit_note'  THEN 'Adjustment Debit Note'
        WHEN l.reference_type = 'credit_note' THEN 'Adjustment Credit Note'
        ELSE COALESCE(l.description, 'General Entry')
      END AS description,
      COALESCE(pay.payment_method, '') AS payment_method
    FROM ledger l
    LEFT JOIN payments pay ON l.reference_type = 'payment' AND l.reference_id = pay.id
    WHERE l.entity_type = $1 AND l.entity_id = $2`;
  let p = 3;
  if (from) { sql += ` AND l.txn_date >= $${p}`; params.push(from); p++; }
  if (to)   { sql += ` AND l.txn_date <= $${p}`; params.push(to);   p++; }
  sql += ` ORDER BY l.txn_date ASC, l.id ASC`;

  const rows = (await pool.query(sql, params)).rows;
  let running = openingBalance;
  const entries = rows.map(r => { running += Number(r.debit||0) - Number(r.credit||0); return { ...r, running_balance: running }; });

  res.render('ledger/print', { page:'ledger', entity, entityType: type, entries, openingBalance, closingBalance: running, from, to, layout:false });
}));

module.exports = router;
