'use strict';
/**
 * db/audit-qty.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AUDIT: Product qty_per_pack integrity check
 *
 * Usage:
 *   node db/audit-qty.js              → full audit + suggestions (stdout)
 *   node db/audit-qty.js --json       → machine-readable JSON output
 *   node db/audit-qty.js --csv        → CSV output (pipe to file)
 *
 * NEVER modifies any data.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const ARGS  = new Set(process.argv.slice(2));
const FMT   = ARGS.has('--json') ? 'json' : ARGS.has('--csv') ? 'csv' : 'text';

// ─── Thresholds ──────────────────────────────────────────────────────────────
const SUSPICIOUS_HIGH  = 500;   // qty_per_pack > this is unusual
const SUSPICIOUS_LOW   = 1;     // qty_per_pack = 1 with non-pcs unit is suspicious
const PCS_UNITS        = new Set(['PCS', 'PIECE', 'PIECES', 'EA', 'EACH', 'NOS', 'NO']);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isPcsUnit(unit) {
  return !unit || PCS_UNITS.has((unit || '').toUpperCase().trim());
}

function issueLabel(code) {
  return {
    NULL_QTY_PER_PACK:        'qty_per_pack is NULL or 0',
    LOW_QTY_PER_PACK:         'qty_per_pack = 1 (suspicious for non-PCS unit)',
    HIGH_QTY_PER_PACK:        `qty_per_pack > ${SUSPICIOUS_HIGH} (unusually high)`,
    ITEM_QTY_MISMATCH:        'Line: packages × packaging ≠ quantity (CTN conversion wrong)',
    STOCK_LEDGER_MISMATCH:    'Stock ledger qty_delta ≠ line item quantity',
    PACKAGING_DIFFERS_MASTER: 'Line item packaging differs from current product qty_per_pack',
    ZERO_QUANTITY_LINE:       'Line item has packages > 0 but quantity = 0',
  }[code] || code;
}

async function run() {
  const client = await pool.connect();
  const issues  = [];
  const suggest = [];

  try {
    // ── 1. Products with suspicious qty_per_pack ─────────────────────────────
    const prods = await client.query(`
      SELECT id, name, unit, qty_per_pack, stock, status
      FROM   products
      ORDER  BY id
    `);

    for (const p of prods.rows) {
      const qpp  = Number(p.qty_per_pack);
      const unit = (p.unit || '').trim();

      if (!qpp || qpp < 1) {
        issues.push({ table:'products', id:p.id, name:p.name, issue:'NULL_QTY_PER_PACK',
                      detail:`qty_per_pack = ${p.qty_per_pack}` });
      } else if (qpp === 1 && !isPcsUnit(unit)) {
        issues.push({ table:'products', id:p.id, name:p.name, issue:'LOW_QTY_PER_PACK',
                      detail:`qty_per_pack=1, unit="${unit}"` });
      } else if (qpp > SUSPICIOUS_HIGH) {
        issues.push({ table:'products', id:p.id, name:p.name, issue:'HIGH_QTY_PER_PACK',
                      detail:`qty_per_pack=${qpp}` });
      }
    }

    // ── 2. Build "most-used packaging" per product from all line tables ──────
    const packagingFreq = {};  // product_id → { packaging_value → count }

    const lineTables = [
      { table:'invoice_items',  refCol:'invoice_id',  refLabel:'invoice' },
      { table:'order_items',    refCol:'order_id',    refLabel:'order'   },
      { table:'purchase_items', refCol:'purchase_id', refLabel:'purchase'},
    ];

    for (const lt of lineTables) {
      let rows;
      try {
        rows = await client.query(`
          SELECT product_id, packaging, COUNT(*) AS cnt
          FROM   ${lt.table}
          WHERE  packaging > 0
          GROUP  BY product_id, packaging
        `);
      } catch (e) {
        // Table may not exist in all schema versions
        continue;
      }
      for (const r of rows.rows) {
        const pid = Number(r.product_id);
        const pkg = Number(r.packaging);
        const cnt = Number(r.cnt);
        if (!packagingFreq[pid]) packagingFreq[pid] = {};
        packagingFreq[pid][pkg] = (packagingFreq[pid][pkg] || 0) + cnt;
      }
    }

    // ── 3. Check each line table for CTN × packaging ≠ quantity ─────────────
    for (const lt of lineTables) {
      let rows;
      try {
        rows = await client.query(`
          SELECT li.id, li.${lt.refCol} AS ref_id, li.product_id,
                 p.name AS product_name, p.unit,
                 li.packages, li.packaging, li.quantity,
                 p.qty_per_pack AS master_qpp
          FROM   ${lt.table} li
          JOIN   products p ON p.id = li.product_id
          WHERE  li.packages IS NOT NULL AND li.packages > 0
          ORDER  BY li.id DESC
          LIMIT  2000
        `);
      } catch (e) { continue; }

      for (const r of rows.rows) {
        const packages  = Number(r.packages  || 0);
        const packaging = Number(r.packaging || 1);
        const quantity  = Number(r.quantity  || 0);
        const masterQpp = Number(r.master_qpp || 1);

        const expectedQty = packages * packaging;

        // CTN × packaging ≠ quantity
        if (expectedQty !== quantity && quantity !== 0) {
          issues.push({
            table: lt.table,
            id: r.id,
            ref_id: r.ref_id,
            name: r.product_name,
            issue: 'ITEM_QTY_MISMATCH',
            detail: `packages=${packages} × packaging=${packaging}=${expectedQty}, but quantity stored=${quantity} (diff ${quantity - expectedQty})`,
          });
        }

        // packages > 0 but quantity = 0
        if (packages > 0 && quantity === 0) {
          issues.push({
            table: lt.table,
            id: r.id,
            ref_id: r.ref_id,
            name: r.product_name,
            issue: 'ZERO_QUANTITY_LINE',
            detail: `packages=${packages} but quantity=0`,
          });
        }

        // Line item packaging differs from current product master
        if (packaging !== masterQpp && packages > 0) {
          // Only flag if the difference is significant (not just user override)
          const ratio = masterQpp > 0 ? packaging / masterQpp : 0;
          if (ratio < 0.5 || ratio > 2) {
            issues.push({
              table: lt.table,
              id: r.id,
              ref_id: r.ref_id,
              name: r.product_name,
              issue: 'PACKAGING_DIFFERS_MASTER',
              detail: `line packaging=${packaging}, current product qty_per_pack=${masterQpp}`,
            });
          }
        }
      }
    }

    // ── 4. Cross-check stock_ledger qty_delta vs line item quantity ───────────
    const ledgerChecks = [
      { table:'invoice_items',  refType:'invoice',  sign:-1 },
      { table:'order_items',    refType:'order',    sign:-1 },
      { table:'purchase_items', refType:'purchase', sign:+1 },
    ];

    for (const lc of ledgerChecks) {
      let rows;
      try {
        rows = await client.query(`
          SELECT sl.id AS ledger_id, sl.product_id, p.name AS product_name,
                 sl.qty_delta, sl.ref_id, sl.ref_type,
                 li.packages, li.packaging, li.quantity AS line_qty
          FROM   stock_ledger sl
          JOIN   ${lc.table} li ON li.${lc.refType}_id = sl.ref_id
                                AND li.product_id      = sl.product_id
          JOIN   products p ON p.id = sl.product_id
          WHERE  sl.ref_type = $1
          LIMIT  2000
        `, [lc.refType]);
      } catch (e) { continue; }

      for (const r of rows.rows) {
        const delta   = Number(r.qty_delta);
        const lineQty = Number(r.line_qty);
        // Expected: for invoices/orders, delta = -lineQty; for purchases, +lineQty
        const expected = lc.sign * lineQty;
        if (delta !== expected && lineQty !== 0) {
          issues.push({
            table: 'stock_ledger',
            id: r.ledger_id,
            ref_id: r.ref_id,
            name: r.product_name,
            issue: 'STOCK_LEDGER_MISMATCH',
            detail: `ledger qty_delta=${delta}, expected=${expected} (from ${lc.table}.quantity=${lineQty})`,
          });
        }
      }
    }

    // ── 5. Correction Suggestions (read-only) ────────────────────────────────
    const productMap = {};
    for (const p of prods.rows) productMap[p.id] = p;

    for (const p of prods.rows) {
      const currentQpp = Number(p.qty_per_pack || 0);
      const freq = packagingFreq[p.id];

      if (!freq || Object.keys(freq).length === 0) continue;

      // Most-used packaging across all line tables
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
      const [mostUsedPkg, usageCount] = sorted[0];
      const mostUsed = Number(mostUsedPkg);
      const total    = Object.values(freq).reduce((s, v) => s + v, 0);
      const pct      = Math.round((usageCount / total) * 100);

      if (mostUsed !== currentQpp && mostUsed >= 1) {
        suggest.push({
          product_id:       p.id,
          name:             p.name,
          unit:             p.unit,
          current_qpp:      currentQpp,
          suggested_qpp:    mostUsed,
          based_on_entries: usageCount,
          total_entries:    total,
          confidence_pct:   pct,
          all_values:       Object.entries(freq).map(([v,c]) => `${v}×${c}`).join(', '),
          sql_to_apply:     `UPDATE products SET qty_per_pack = ${mostUsed} WHERE id = ${p.id}; -- was ${currentQpp}`,
        });
      }
    }

    // ── 6. Output ─────────────────────────────────────────────────────────────
    if (FMT === 'json') {
      process.stdout.write(JSON.stringify({ issues, suggestions: suggest }, null, 2) + '\n');
      return;
    }

    if (FMT === 'csv') {
      const header = 'table,id,ref_id,name,issue,detail';
      console.log(header);
      for (const iss of issues) {
        const row = [iss.table, iss.id, iss.ref_id || '', iss.name || '', iss.issue, `"${(iss.detail||'').replace(/"/g,'""')}"`].join(',');
        console.log(row);
      }
      return;
    }

    // ── TEXT output ───────────────────────────────────────────────────────────
    const LINE = '─'.repeat(80);
    const BOLD = s => `\x1b[1m${s}\x1b[0m`;
    const RED  = s => `\x1b[31m${s}\x1b[0m`;
    const YLW  = s => `\x1b[33m${s}\x1b[0m`;
    const GRN  = s => `\x1b[32m${s}\x1b[0m`;
    const CYN  = s => `\x1b[36m${s}\x1b[0m`;

    console.log(`\n${BOLD('MARKAZ ERP — QTY/PACK AUDIT REPORT')}`);
    console.log(`Generated: ${new Date().toLocaleString('en-PK')}`);
    console.log(LINE);

    // Group issues by type
    const byType = {};
    for (const iss of issues) {
      (byType[iss.issue] = byType[iss.issue] || []).push(iss);
    }

    if (!issues.length) {
      console.log(GRN('\n✓ No issues found — all qty_per_pack values look consistent.\n'));
    } else {
      console.log(`\n${RED(BOLD('ISSUES FOUND:'))} ${issues.length} total\n`);

      for (const [code, list] of Object.entries(byType)) {
        console.log(YLW(`▶ ${issueLabel(code)}  (${list.length} records)`));
        const show = list.slice(0, 20);
        for (const iss of show) {
          const ref = iss.ref_id ? ` [ref #${iss.ref_id}]` : '';
          console.log(`  ${CYN(iss.table)} #${iss.id}${ref}  ${iss.name || ''}`);
          console.log(`    → ${iss.detail}`);
        }
        if (list.length > 20) console.log(`  ... and ${list.length - 20} more`);
        console.log();
      }
    }

    console.log(LINE);

    if (!suggest.length) {
      console.log(GRN('✓ No qty_per_pack correction suggestions — all values match usage patterns.\n'));
    } else {
      console.log(BOLD(`CORRECTION SUGGESTIONS (${suggest.length}) — DO NOT APPLY WITHOUT REVIEW\n`));
      console.log(`${'Product'.padEnd(40)} ${'Current'.padStart(8)} ${'Suggested'.padStart(10)} ${'Confidence'.padStart(12)} ${'Based On'.padStart(10)}`);
      console.log('─'.repeat(82));
      for (const s of suggest) {
        const name = s.name.length > 39 ? s.name.substring(0, 37) + '..' : s.name;
        const conf = s.confidence_pct + '%';
        console.log(
          `${name.padEnd(40)} ${String(s.current_qpp).padStart(8)} ${String(s.suggested_qpp).padStart(10)} ${conf.padStart(12)} ${String(s.based_on_entries+'/'+s.total_entries).padStart(10)}`
        );
        console.log(`  Values seen: ${s.all_values}`);
      }
      console.log(`\n${YLW('To apply a correction, run the SQL manually (after verification):')}`);
      for (const s of suggest) {
        if (s.confidence_pct >= 80) console.log(`  ${s.sql_to_apply}`);
      }
      console.log(`\n  Run with --json for full output with all SQL statements.`);
    }

    console.log(LINE);
    console.log(BOLD('SUMMARY'));
    const counts = {};
    for (const iss of issues) counts[iss.issue] = (counts[iss.issue] || 0) + 1;
    for (const [code, cnt] of Object.entries(counts)) {
      console.log(`  ${issueLabel(code).padEnd(55)} ${cnt}`);
    }
    console.log(`  ${'Total suggestions'.padEnd(55)} ${suggest.length}`);
    console.log(`\n  Tip: run with --json > audit.json for the full machine-readable report`);
    console.log(`       run with --csv  > audit.csv  for import into Excel\n`);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('Audit failed:', e.message); process.exit(1); });
