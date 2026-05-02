'use strict';
/**
 * db/fix-qty-per-pack.js
 * ──────────────────────────────────────────────────────────────────────────
 * ONE-TIME SAFE FIX: set qty_per_pack to 1 for any product that has
 * qty_per_pack IS NULL or < 1.
 *
 * This is the minimum safe fix — it does NOT try to guess the correct value.
 * Run the audit first: node db/audit-qty.js --json > audit.json
 * Then apply specific corrections from the suggestions manually.
 *
 * Usage:
 *   node db/fix-qty-per-pack.js --dry-run     ← preview only (default)
 *   node db/fix-qty-per-pack.js --apply       ← actually update
 *
 * Does NOT touch: stock_ledger, invoice_items, order_items, purchase_items
 * ──────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DRY  = !process.argv.includes('--apply');

async function run() {
  const client = await pool.connect();
  try {
    // Find products needing fix
    const { rows } = await client.query(`
      SELECT id, name, unit, qty_per_pack
      FROM   products
      WHERE  qty_per_pack IS NULL OR qty_per_pack < 1
      ORDER  BY id
    `);

    if (!rows.length) {
      console.log('✓ All products already have qty_per_pack ≥ 1. Nothing to fix.');
      return;
    }

    console.log(`${DRY ? '[DRY RUN] ' : ''}Found ${rows.length} product(s) with NULL or < 1 qty_per_pack:\n`);
    for (const p of rows) {
      console.log(`  #${p.id}  ${p.name.padEnd(50)}  unit=${p.unit||'?'}  qty_per_pack=${p.qty_per_pack}`);
    }

    if (DRY) {
      console.log(`\n[DRY RUN] Would set qty_per_pack = 1 for these ${rows.length} product(s).`);
      console.log('Run with --apply to actually update.');
      return;
    }

    const ids = rows.map(r => r.id);
    const res = await client.query(
      `UPDATE products SET qty_per_pack = 1 WHERE id = ANY($1::int[])`,
      [ids]
    );
    console.log(`\n✓ Updated ${res.rowCount} product(s) → qty_per_pack = 1`);
    console.log('  Re-run audit to verify: node db/audit-qty.js');

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('Fix failed:', e.message); process.exit(1); });
