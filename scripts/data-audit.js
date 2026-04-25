#!/usr/bin/env node
// scripts/data-audit.js — read-only audit + Postgres-readiness report.
// Usage: node scripts/data-audit.js [--fix-safe]
'use strict';
const path = require('path');
const { db } = require(path.join('..', 'database'));
const { detectOrphans, reconcileBalances, reconcileStock, runStabilization } = require(path.join('..', 'db', 'stabilize'));

function safe(fn, fb) { try { return fn(); } catch (e) { return fb; } }

function header(s) { console.log('\n=== ' + s + ' ==='); }
function row(k, v) { console.log('  ' + k.padEnd(38) + ' : ' + v); }

const FIX = process.argv.includes('--fix-safe');

header('ORPHAN RECORDS');
const orph = detectOrphans(db);
Object.keys(orph).forEach(k => row(k, orph[k]));

header('DUPLICATE USERS (case-insensitive)');
const dupUsers = safe(() => db.prepare(`
  SELECT LOWER(TRIM(username)) u, COUNT(*) c, GROUP_CONCAT(id) ids
  FROM users GROUP BY LOWER(TRIM(username)) HAVING c > 1
`).all(), []);
dupUsers.forEach(r => row(r.u, r.c + ' rows ids=' + r.ids));
if (!dupUsers.length) row('result', 'none');

header('INVALID DATES');
const invalidDates = [
  ['invoices.invoice_date',  `SELECT COUNT(*) c FROM invoices  WHERE invoice_date  IS NULL OR invoice_date  NOT GLOB '????-??-??*'`],
  ['orders.order_date',      `SELECT COUNT(*) c FROM orders    WHERE order_date    IS NULL OR order_date    NOT GLOB '????-??-??*'`],
  ['purchases.purchase_date',`SELECT COUNT(*) c FROM purchases WHERE purchase_date IS NULL OR purchase_date NOT GLOB '????-??-??*'`],
  ['payments.payment_date',  `SELECT COUNT(*) c FROM payments  WHERE payment_date  IS NULL OR payment_date  NOT GLOB '????-??-??*'`],
  ['expenses.expense_date',  `SELECT COUNT(*) c FROM expenses  WHERE expense_date  IS NULL OR expense_date  NOT GLOB '????-??-??*'`],
];
invalidDates.forEach(([n, sql]) => row(n, safe(() => db.prepare(sql).get().c, 'err')));

header('STOCK VARIANCE (products.stock vs stock_ledger SUM)');
const stockVar = safe(() => db.prepare(`
  SELECT p.id, p.name, p.stock cached,
    COALESCE((SELECT SUM(qty_delta) FROM stock_ledger WHERE product_id=p.id),0) ledger_qty
  FROM products p
  WHERE EXISTS (SELECT 1 FROM stock_ledger WHERE product_id=p.id)
    AND p.stock <> COALESCE((SELECT SUM(qty_delta) FROM stock_ledger WHERE product_id=p.id),0)
  LIMIT 25
`).all(), []);
stockVar.forEach(r => row('p#' + r.id + ' ' + (r.name || ''), 'cached=' + r.cached + ' ledger=' + r.ledger_qty));
if (!stockVar.length) row('result', 'consistent');

header('BALANCE VARIANCE (entity.balance vs ledger SUM)');
const cBal = safe(() => db.prepare(`
  SELECT c.id, c.name, c.balance cached,
    COALESCE((SELECT SUM(COALESCE(debit,0)-COALESCE(credit,0)) FROM ledger WHERE entity_type='customer' AND entity_id=c.id),0) computed
  FROM customers c
  WHERE c.balance <> COALESCE((SELECT SUM(COALESCE(debit,0)-COALESCE(credit,0)) FROM ledger WHERE entity_type='customer' AND entity_id=c.id),0)
  LIMIT 25
`).all(), []);
cBal.forEach(r => row('cust#' + r.id + ' ' + (r.name || ''), 'cached=' + r.cached + ' computed=' + r.computed));
const vBal = safe(() => db.prepare(`
  SELECT v.id, v.name, v.balance cached,
    COALESCE((SELECT SUM(COALESCE(credit,0)-COALESCE(debit,0)) FROM ledger WHERE entity_type='vendor' AND entity_id=v.id),0) computed
  FROM vendors v
  WHERE v.balance <> COALESCE((SELECT SUM(COALESCE(credit,0)-COALESCE(debit,0)) FROM ledger WHERE entity_type='vendor' AND entity_id=v.id),0)
  LIMIT 25
`).all(), []);
vBal.forEach(r => row('vend#' + r.id + ' ' + (r.name || ''), 'cached=' + r.cached + ' computed=' + r.computed));
if (!cBal.length && !vBal.length) row('result', 'consistent');

header('NULL CRITICAL FIELDS');
[
  ['invoices.customer_id null',   `SELECT COUNT(*) c FROM invoices  WHERE customer_id IS NULL`],
  ['invoices.total null',         `SELECT COUNT(*) c FROM invoices  WHERE total IS NULL`],
  ['invoice_items.product_id null',`SELECT COUNT(*) c FROM invoice_items WHERE product_id IS NULL`],
  ['invoice_items.quantity null', `SELECT COUNT(*) c FROM invoice_items WHERE quantity IS NULL OR quantity <= 0`],
  ['products.name null/empty',    `SELECT COUNT(*) c FROM products WHERE name IS NULL OR TRIM(name)=''`],
  ['customers.name null/empty',   `SELECT COUNT(*) c FROM customers WHERE name IS NULL OR TRIM(name)=''`],
].forEach(([n, sql]) => row(n, safe(() => db.prepare(sql).get().c, 'err')));

header('POSTGRES COMPATIBILITY FLAGS (code-level — informational)');
[
  'AUTOINCREMENT (use SERIAL/IDENTITY in PG)',
  'INTEGER PRIMARY KEY rowid alias (use SERIAL)',
  'datetime("now"), julianday() (use NOW(), date arithmetic)',
  'GROUP_CONCAT (use STRING_AGG)',
  'LIKE case-insensitive (PG LIKE is case-sensitive — use ILIKE)',
  'GLOB (PG: SIMILAR TO / regex)',
  'INSERT OR REPLACE (PG: INSERT ... ON CONFLICT DO UPDATE)',
  'pragma table_info (PG: information_schema.columns)',
  'BOOLEAN stored as 0/1 (PG: real BOOLEAN)',
  'lack of strict types — TEXT vs VARCHAR semantics differ',
].forEach((s, i) => row('flag' + (i + 1), s));

if (FIX) {
  header('SAFE FIX: reconcile balances + stock from ledgers');
  const r = runStabilization(db);
  r.steps.forEach(s => row(s.name, s.ok ? 'ok' : ('FAIL: ' + s.error)));
}

console.log('\nDone.');
