'use strict';
require('dotenv').config();
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// pg returns NUMERIC + INT8 (BIGINT) as strings by default.
// Force them to JavaScript numbers so route arithmetic works without manual casts.
// 1700 = NUMERIC, 20 = INT8. (INT4=23, INT2=21 already parsed as numbers.)
types.setTypeParser(1700, (v) => v === null ? null : parseFloat(v));
types.setTypeParser(20,   (v) => v === null ? null : parseInt(v, 10));

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'markaz_erp',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});
pool.on('error', (e) => console.error('[pg pool error]', e.message));

const auditContext = new AsyncLocalStorage();

// ===== ASYNC QUERY API =====
async function one(sql, params)  { const r = await pool.query(sql, params); return r.rows[0] || null; }
async function many(sql, params) { const r = await pool.query(sql, params); return r.rows; }
async function run(sql, params)  { const r = await pool.query(sql, params); return { rows: r.rows, rowCount: r.rowCount, id: r.rows && r.rows[0] ? r.rows[0].id : null }; }

function clientApi(client) {
  return {
    one:  async (s, p) => (await client.query(s, p)).rows[0] || null,
    many: async (s, p) => (await client.query(s, p)).rows,
    run:  async (s, p) => { const r = await client.query(s, p); return { rows: r.rows, rowCount: r.rowCount, id: r.rows && r.rows[0] ? r.rows[0].id : null }; },
    raw:  client
  };
}

// Transaction helper. fn receives a `tx` object with one/many/run.
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await fn(clientApi(c));
    await c.query('COMMIT');
    return res;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

// ===== UTIL =====
function toInt(v, d) { if (v === null || v === undefined || v === '') return (d === undefined ? null : d); const n = parseInt(v, 10); return Number.isFinite(n) ? n : (d === undefined ? null : d); }
function toNum(v, d) { if (v === null || v === undefined || v === '') return (d === undefined ? 0 : d); const n = Number(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); }

function logError(scope, err, ctx) {
  const msg = err && err.message ? err.message : String(err);
  console.error('[ERROR]', scope, '→', msg);
  if (err && err.stack) console.error(err.stack);
  let userId = null;
  try { const a = auditContext.getStore(); if (a && a.userId) userId = a.userId; } catch(_){}
  pool.query(`INSERT INTO system_errors(scope,message,stack,context,user_id) VALUES ($1,$2,$3,$4,$5)`,
    [scope || 'unknown', msg, err && err.stack || null, ctx ? JSON.stringify(ctx) : null, userId]).catch(()=>{});
}

// ===== DOC NUMBERING (atomic per transaction) =====
async function nextDocNo(client, prefix, table, col) {
  const r = await client.one(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(${col}, '^.*-', ''), '')::INT), 0) AS m
     FROM ${table} WHERE ${col} LIKE $1`, [prefix + '-%']
  );
  const next = (Number(r && r.m) || 0) + 1;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

// ===== STOCK LEDGER =====
// All stock movements MUST go through here.
async function applyStockMovement(client, productId, warehouseId, qtyDelta, refType, refId, reason, note) {
  const pid = toInt(productId), wid = toInt(warehouseId, null), delta = toInt(qtyDelta, 0);
  if (!pid) throw new Error('applyStockMovement: product_id required');
  if (delta === 0) return;
  let userId = null;
  try { const a = auditContext.getStore(); if (a && a.userId) userId = a.userId; } catch(_){}

  await client.run(
    `INSERT INTO stock_ledger(product_id, warehouse_id, qty_delta, ref_type, ref_id, reason, user_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [pid, wid, delta, refType || null, refId || null, reason || null, userId, note || null]
  );
  await client.run(`UPDATE products SET stock = stock + $1 WHERE id = $2`, [delta, pid]);
  if (wid) {
    await client.run(`
      INSERT INTO warehouse_stock(warehouse_id, product_id, quantity)
      VALUES ($1,$2,$3)
      ON CONFLICT (warehouse_id, product_id)
        DO UPDATE SET quantity = warehouse_stock.quantity + EXCLUDED.quantity
    `, [wid, pid, delta]);
  }
}
async function reverseStockForRef(client, refType, refId) {
  const rows = await client.many(`SELECT product_id, warehouse_id, qty_delta FROM stock_ledger WHERE ref_type=$1 AND ref_id=$2`, [refType, refId]);
  for (const r of rows) {
    await applyStockMovement(client, r.product_id, r.warehouse_id, -r.qty_delta, refType, refId, 'reverse', 'auto-reverse');
  }
}
// Sum current stock from ledger (single source of truth)
async function stockOnHand(client, productId, warehouseId) {
  if (warehouseId) {
    const r = await client.one(`SELECT COALESCE(quantity,0) q FROM warehouse_stock WHERE product_id=$1 AND warehouse_id=$2`, [productId, warehouseId]);
    return Number(r && r.q) || 0;
  }
  const r = await client.one(`SELECT COALESCE(SUM(qty_delta),0) q FROM stock_ledger WHERE product_id=$1`, [productId]);
  return Number(r && r.q) || 0;
}

// ===== LEDGER (party balance) =====
async function addLedgerEntry(client, entityType, entityId, date, desc, debit, credit, refType, refId, scope) {
  const dr = Math.max(0, Number(debit)  || 0);
  const cr = Math.max(0, Number(credit) || 0);
  if (dr === 0 && cr === 0) return;
  await client.run(
    `INSERT INTO ledger(entity_type,entity_id,txn_date,description,debit,credit,reference_type,reference_id,account_scope)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entityType, entityId, date, desc || null, dr, cr, refType || null, refId || null, scope || 'plastic_markaz']
  );
  await recomputeBalance(client, entityType, entityId);
}
async function removeLedgerForRef(client, entityType, entityId, refType, refId) {
  await client.run(`DELETE FROM ledger WHERE entity_type=$1 AND entity_id=$2 AND reference_type=$3 AND reference_id=$4`,
    [entityType, entityId, refType, refId]);
}
async function recomputeBalance(client, entityType, entityId) {
  const r = await client.one(`SELECT COALESCE(SUM(debit) - SUM(credit),0) AS bal FROM ledger WHERE entity_type=$1 AND entity_id=$2`, [entityType, entityId]);
  const bal = Number(r && r.bal) || 0;
  if (entityType === 'customer') await client.run(`UPDATE customers SET balance=$1 WHERE id=$2`, [bal, entityId]);
  else if (entityType === 'vendor') await client.run(`UPDATE vendors SET balance=$1 WHERE id=$2`, [bal, entityId]);
  return bal;
}

// ===== COST FREEZE =====
async function getProductCost(client, productId) {
  const c = client || { one };
  const r = await c.one(`SELECT cost_price FROM products WHERE id=$1`, [productId]);
  return Number(r && r.cost_price) || 0;
}

// ===== AUDIT =====
async function addAuditLog(action, module, recordId, details, userId) {
  if (userId == null) {
    try { const a = auditContext.getStore(); if (a && a.userId) userId = a.userId; } catch(_){}
  }
  try {
    await pool.query(
      `INSERT INTO audit_log(action,module,record_id,details,user_id) VALUES ($1,$2,$3,$4,$5)`,
      [action, module, recordId, details, userId || null]
    );
  } catch(_){}
}

async function getSettings() {
  const rows = await many(`SELECT key, value FROM settings`);
  const o = {}; for (const r of rows) o[r.key] = r.value; return o;
}

module.exports = {
  pool, one, many, run, tx, auditContext,
  toInt, toNum, logError,
  nextDocNo,
  applyStockMovement, reverseStockForRef, stockOnHand,
  addLedgerEntry, removeLedgerForRef, recomputeBalance,
  getProductCost,
  addAuditLog, getSettings
};
