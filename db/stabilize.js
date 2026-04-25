// db/stabilize.js — idempotent schema + data stabilization.
// Run once on boot AFTER initDatabase(). Safe to re-run.
'use strict';

function tryExec(db, sql) {
  try { db.exec(sql); return true; } catch (e) { return false; }
}
function colExists(db, table, col) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase());
  } catch (e) { return false; }
}
function tableExists(db, table) {
  try {
    return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  } catch (e) { return false; }
}

// ---------- 1. SCHEMA: indices, NOT NULL guards, canonical columns ----------
function ensureIndices(db) {
  const idx = [
    `CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON invoice_items(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_customer    ON invoices(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_date        ON invoices(invoice_date)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_customer      ON orders(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order    ON order_items(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_purchases_vendor     ON purchases(vendor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_entity        ON ledger(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_ref           ON ledger(ref_type, ref_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_entity      ON payments(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_warehouse_stock_pw   ON warehouse_stock(product_id, warehouse_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_module     ON audit_log(module, record_id)`,
  ];
  idx.forEach(s => tryExec(db, s));
}

function ensureCanonicalColumns(db) {
  // Standard names (do NOT drop legacy; backfill canonical from legacy if missing)
  // products: selling_price, cost_price, qty_per_pack
  if (tableExists(db, 'products')) {
    if (!colExists(db, 'products', 'selling_price')) tryExec(db, `ALTER TABLE products ADD COLUMN selling_price REAL DEFAULT 0`);
    if (!colExists(db, 'products', 'cost_price'))    tryExec(db, `ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0`);
    if (!colExists(db, 'products', 'qty_per_pack'))  tryExec(db, `ALTER TABLE products ADD COLUMN qty_per_pack INTEGER DEFAULT 1`);

    // Backfill canonical from legacy when canonical is null/zero
    tryExec(db, `UPDATE products SET selling_price = COALESCE(NULLIF(selling_price,0), rate, price, 0) WHERE selling_price IS NULL OR selling_price = 0`);
    tryExec(db, `UPDATE products SET cost_price    = COALESCE(NULLIF(cost_price,0), purchase_rate, cost, 0) WHERE cost_price IS NULL OR cost_price = 0`);
    tryExec(db, `UPDATE products SET qty_per_pack  = COALESCE(NULLIF(qty_per_pack,0), packaging, 1) WHERE qty_per_pack IS NULL OR qty_per_pack = 0`);
  }

  // invoice_items / order_items: cost_at_sale (frozen historical cost)
  if (tableExists(db, 'invoice_items') && !colExists(db, 'invoice_items', 'cost_at_sale')) {
    tryExec(db, `ALTER TABLE invoice_items ADD COLUMN cost_at_sale REAL DEFAULT 0`);
  }
  if (tableExists(db, 'order_items') && !colExists(db, 'order_items', 'cost_at_sale')) {
    tryExec(db, `ALTER TABLE order_items ADD COLUMN cost_at_sale REAL DEFAULT 0`);
  }
}

// ---------- 2. BACKFILL: freeze cost_at_sale on legacy rows ----------
function backfillCostAtSale(db) {
  if (tableExists(db, 'invoice_items')) {
    tryExec(db, `
      UPDATE invoice_items
      SET cost_at_sale = (
        SELECT COALESCE(NULLIF(p.cost_price,0), p.purchase_rate, p.cost, 0)
        FROM products p WHERE p.id = invoice_items.product_id
      )
      WHERE (cost_at_sale IS NULL OR cost_at_sale = 0)
    `);
  }
  if (tableExists(db, 'order_items')) {
    tryExec(db, `
      UPDATE order_items
      SET cost_at_sale = (
        SELECT COALESCE(NULLIF(p.cost_price,0), p.purchase_rate, p.cost, 0)
        FROM products p WHERE p.id = order_items.product_id
      )
      WHERE (cost_at_sale IS NULL OR cost_at_sale = 0)
    `);
  }
}

// ---------- 3. RECONCILE: cached aggregates from authoritative ledgers ----------
function reconcileBalances(db) {
  if (!tableExists(db, 'ledger')) return;
  // customers
  if (tableExists(db, 'customers')) {
    tryExec(db, `
      UPDATE customers SET balance = COALESCE((
        SELECT SUM(COALESCE(debit,0) - COALESCE(credit,0))
        FROM ledger WHERE entity_type='customer' AND entity_id = customers.id
      ), 0)
    `);
  }
  // vendors (vendor balance convention: credit - debit = payable)
  if (tableExists(db, 'vendors')) {
    tryExec(db, `
      UPDATE vendors SET balance = COALESCE((
        SELECT SUM(COALESCE(credit,0) - COALESCE(debit,0))
        FROM ledger WHERE entity_type='vendor' AND entity_id = vendors.id
      ), 0)
    `);
  }
}

function reconcileStock(db) {
  if (!tableExists(db, 'stock_ledger')) return;
  if (tableExists(db, 'products')) {
    tryExec(db, `
      UPDATE products SET stock = COALESCE((
        SELECT SUM(qty_delta) FROM stock_ledger WHERE product_id = products.id
      ), products.stock)
      WHERE EXISTS (SELECT 1 FROM stock_ledger WHERE product_id = products.id)
    `);
  }
  if (tableExists(db, 'warehouse_stock')) {
    // Recompute per-warehouse caches from stock_ledger where warehouse_id is set
    const rows = db.prepare(`
      SELECT product_id, warehouse_id, SUM(qty_delta) qty
      FROM stock_ledger WHERE warehouse_id IS NOT NULL
      GROUP BY product_id, warehouse_id
    `).all();
    const upsert = db.prepare(`
      INSERT INTO warehouse_stock (product_id, warehouse_id, quantity)
      VALUES (?, ?, ?)
      ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = excluded.quantity
    `);
    const tx = db.transaction((rs) => { for (const r of rs) { try { upsert.run(r.product_id, r.warehouse_id, r.qty); } catch (_) {} } });
    try { tx(rows); } catch (_) {}
  }
}

// ---------- 4. ORPHAN DETECTION (report only — never auto-delete) ----------
function detectOrphans(db) {
  const checks = [
    { name: 'invoice_items_orphan_invoice',  sql: `SELECT COUNT(*) c FROM invoice_items WHERE invoice_id NOT IN (SELECT id FROM invoices)` },
    { name: 'invoice_items_orphan_product',  sql: `SELECT COUNT(*) c FROM invoice_items WHERE product_id NOT IN (SELECT id FROM products)` },
    { name: 'order_items_orphan_order',      sql: `SELECT COUNT(*) c FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)` },
    { name: 'order_items_orphan_product',    sql: `SELECT COUNT(*) c FROM order_items WHERE product_id NOT IN (SELECT id FROM products)` },
    { name: 'purchase_items_orphan_purchase',sql: `SELECT COUNT(*) c FROM purchase_items WHERE purchase_id NOT IN (SELECT id FROM purchases)` },
    { name: 'invoices_orphan_customer',      sql: `SELECT COUNT(*) c FROM invoices WHERE customer_id NOT IN (SELECT id FROM customers)` },
    { name: 'orders_orphan_customer',        sql: `SELECT COUNT(*) c FROM orders WHERE customer_id NOT IN (SELECT id FROM customers)` },
    { name: 'purchases_orphan_vendor',       sql: `SELECT COUNT(*) c FROM purchases WHERE vendor_id NOT IN (SELECT id FROM vendors)` },
    { name: 'ledger_orphan_customer',        sql: `SELECT COUNT(*) c FROM ledger WHERE entity_type='customer' AND entity_id NOT IN (SELECT id FROM customers)` },
    { name: 'ledger_orphan_vendor',          sql: `SELECT COUNT(*) c FROM ledger WHERE entity_type='vendor' AND entity_id NOT IN (SELECT id FROM vendors)` },
    { name: 'payments_orphan',               sql: `SELECT COUNT(*) c FROM payments WHERE (entity_type='customer' AND entity_id NOT IN (SELECT id FROM customers)) OR (entity_type='vendor' AND entity_id NOT IN (SELECT id FROM vendors))` },
  ];
  const out = {};
  for (const ch of checks) {
    try { out[ch.name] = db.prepare(ch.sql).get().c; } catch (e) { out[ch.name] = null; }
  }
  return out;
}

// ---------- 5. PERSIST AUDIT REPORT ----------
function persistAuditReport(db, report) {
  tryExec(db, `CREATE TABLE IF NOT EXISTS data_audit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT CURRENT_TIMESTAMP,
    report TEXT
  )`);
  try { db.prepare(`INSERT INTO data_audit_runs (report) VALUES (?)`).run(JSON.stringify(report)); } catch (_) {}
}

// ---------- ENTRY POINT ----------
function runStabilization(db, opts = {}) {
  const report = { startedAt: new Date().toISOString(), steps: [] };
  const step = (name, fn) => {
    try { fn(); report.steps.push({ name, ok: true }); }
    catch (e) { report.steps.push({ name, ok: false, error: e && e.message }); }
  };
  step('ensureIndices',          () => ensureIndices(db));
  step('ensureCanonicalColumns', () => ensureCanonicalColumns(db));
  step('backfillCostAtSale',     () => backfillCostAtSale(db));
  step('reconcileBalances',      () => reconcileBalances(db));
  step('reconcileStock',         () => reconcileStock(db));
  report.orphans = detectOrphans(db);
  report.finishedAt = new Date().toISOString();
  if (opts.persist !== false) persistAuditReport(db, report);
  return report;
}

module.exports = {
  runStabilization,
  ensureIndices,
  ensureCanonicalColumns,
  backfillCostAtSale,
  reconcileBalances,
  reconcileStock,
  detectOrphans,
};
