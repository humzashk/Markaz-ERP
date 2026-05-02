'use strict';
/**
 * LEGACY MIGRATION SCRIPT — PLASTIC MARKAZ ITEM (1).xlsx
 * -------------------------------------------------------
 * Imports products from:
 *   Sheet "ITEMS"  → 929 products (main plastic household items)
 *   Sheet "COOLER" → 169 products (cooler/jug items)
 *   Sheet "PARTY"  → 280 party names (customers — imported separately)
 *
 * Run: node db/migrate-legacy-items.js
 * Options:
 *   --delete-test    Delete the 10 seeded test products first
 *   --dry-run        Show what would happen without writing to DB
 *   --skip-cooler    Skip the COOLER sheet
 *   --parties        Also import PARTY sheet as customers
 */

require('dotenv').config();
const path  = require('path');
const XLSX  = require('xlsx');
const { pool } = require('../database');

const EXCEL_PATH = path.resolve('C:/Users/sheik/Downloads/PLASTIC MARKAZ ITEM (1).xlsx');

const DRY_RUN     = process.argv.includes('--dry-run');
const DELETE_TEST = process.argv.includes('--delete-test');
const SKIP_COOLER = process.argv.includes('--skip-cooler');
const DO_PARTIES  = process.argv.includes('--parties');

// ── Unit normalisation ───────────────────────────────────────────────────────
// Fix typos/inconsistencies found in the legacy data
const UNIT_MAP = {
  'PCS.': 'PCS',
  'PCS1': 'PCS',
  'PCE':  'PCS',
  'OCS':  'PCS',
  'DOX':  'DOZ',
};
function normaliseUnit(raw) {
  const u = String(raw || 'PCS').trim().toUpperCase();
  return UNIT_MAP[u] || u || 'PCS';
}

// ── Auto-category from product name keywords ─────────────────────────────────
const CATEGORY_RULES = [
  { words: ['BOTTLE','WATER BOTTLE'],            cat: 'Bottles' },
  { words: ['JAR','CONT','CONTAINER','STOREX'],   cat: 'Containers' },
  { words: ['BASKET','CRATE','TRAY','BOX'],       cat: 'Crates & Baskets' },
  { words: ['BUCKET','TUB','DRUM','PAIL'],        cat: 'Buckets & Tubs' },
  { words: ['CHAIR','STOOL','TABLE'],             cat: 'Furniture' },
  { words: ['GLASS','CUP','MUG'],                 cat: 'Drinkware' },
  { words: ['STRAINER','COLANDER'],               cat: 'Kitchen Tools' },
  { words: ['JUG','COOLER','THERMOS','FLASK'],    cat: 'Cooler & Jugs' },
  { words: ['HANGER','CLIP','PEG'],               cat: 'Laundry' },
  { words: ['RACK','SHELF','STAND'],              cat: 'Storage' },
];
function autoCategory(name, sheetName) {
  if (sheetName === 'COOLER') return 'Cooler & Jugs';
  const upper = name.toUpperCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some(w => upper.includes(w))) return rule.cat;
  }
  return 'General';
}

// ── Read sheet ────────────────────────────────────────────────────────────────
function readSheet(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  return rows.slice(1).filter(r => r[1] && String(r[1]).trim());
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       PLASTIC MARKAZ — LEGACY DATA MIGRATION     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(DRY_RUN ? '\n⚠️  DRY RUN — no data will be written\n' : '\n🚀 LIVE RUN — writing to database\n');

  // 1. Read Excel
  const wb = XLSX.readFile(EXCEL_PATH);
  console.log(`📂 Opened: ${EXCEL_PATH}`);
  console.log(`   Sheets found: ${wb.SheetNames.join(', ')}\n`);

  // 2. Optionally wipe all seeded test data
  if (DELETE_TEST && !DRY_RUN) {
    console.log('🗑️  Wiping all seeded test/sample data...');
    // Must delete in dependency order (children before parents)
    await pool.query(`DELETE FROM credit_note_items`);
    await pool.query(`DELETE FROM invoice_items`);
    await pool.query(`DELETE FROM purchase_items`);
    await pool.query(`DELETE FROM order_items`);
    await pool.query(`DELETE FROM breakage`);
    await pool.query(`DELETE FROM invoices`);
    await pool.query(`DELETE FROM purchases`);
    await pool.query(`DELETE FROM orders`);
    await pool.query(`DELETE FROM payments`);
    await pool.query(`DELETE FROM ledger`);
    await pool.query(`DELETE FROM stock_ledger`);
    await pool.query(`DELETE FROM warehouse_stock`);
    await pool.query(`DELETE FROM stock_adjustments`);
    await pool.query(`DELETE FROM credit_notes`);
    await pool.query(`DELETE FROM rate_list`);
    await pool.query(`DELETE FROM audit_log`);
    const deleted = await pool.query(`DELETE FROM products WHERE item_id LIKE 'HH-%' RETURNING id, name`);
    console.log(`   ✅ Deleted ${deleted.rows.length} test products and all related test transactions\n`);
  } else if (DELETE_TEST && DRY_RUN) {
    console.log('🗑️  [DRY RUN] Would wipe all test transactions + seeded products (HH-001..HH-010)\n');
  }

  // 3. Import products from ITEMS + COOLER sheets
  const sheets = SKIP_COOLER ? ['ITEMS'] : ['ITEMS', 'COOLER'];
  let totalImported = 0, totalSkipped = 0, totalErrors = 0;
  const errorLog = [];

  for (const sheetName of sheets) {
    const rows = readSheet(wb, sheetName);
    console.log(`📋 Sheet "${sheetName}": ${rows.length} product rows`);

    let imp = 0, skip = 0;

    for (const row of rows) {
      const legacyNo   = Number(row[0]) || null;
      const name       = String(row[1]).trim();
      const unit       = normaliseUnit(row[2]);
      const qtyPerPack = Math.max(1, parseInt(row[3], 10) || 1);
      const rate       = parseFloat(row[4]) || 0;
      const category   = autoCategory(name, sheetName);
      const itemId     = sheetName === 'COOLER'
        ? `CL-${String(legacyNo).padStart(3,'0')}`
        : `PM-${String(legacyNo).padStart(3,'0')}`;

      if (!name) continue;

      try {
        if (DRY_RUN) {
          console.log(`  [DRY] ${itemId} | ${name.padEnd(35)} | ${unit.padEnd(4)} | pack:${String(qtyPerPack).padStart(3)} | rate:${rate} | cat:${category}`);
          imp++;
          continue;
        }

        // Check duplicate by name (case-insensitive)
        const existing = await pool.query(
          `SELECT id FROM products WHERE LOWER(name) = LOWER($1)`, [name]
        );

        if (existing.rows.length) {
          // Update rate and packaging if it changed — don't skip silently
          await pool.query(`
            UPDATE products
            SET item_id=$1, unit=$2, qty_per_pack=$3, selling_price=$4, category=$5, status='active'
            WHERE LOWER(name) = LOWER($6)`,
            [itemId, unit, qtyPerPack, rate, category, name]
          );
          skip++;   // counted as "updated" not new
        } else {
          await pool.query(`
            INSERT INTO products
              (item_id, name, category, unit, qty_per_pack, cost_price, selling_price, stock, min_stock, status)
            VALUES
              ($1, $2, $3, $4, $5, 0, $6, 0, 0, 'active')`,
            [itemId, name, category, unit, qtyPerPack, rate]
          );
          imp++;
        }
      } catch (e) {
        totalErrors++;
        errorLog.push(`  ❌ [${sheetName}] Row ${legacyNo} "${name}": ${e.message}`);
      }
    }

    console.log(`   ✅ New: ${imp}  |  🔄 Updated existing: ${skip}\n`);
    totalImported += imp;
    totalSkipped  += skip;
  }

  // 4. Optionally import PARTY sheet as customers (names only)
  if (DO_PARTIES) {
    const partyRows = readSheet(wb, 'PARTY');
    console.log(`👥 Sheet "PARTY": ${partyRows.length} customer names`);
    let pImp = 0, pSkip = 0;

    for (const row of partyRows) {
      const name = String(row[1]).trim();
      if (!name) continue;
      try {
        if (DRY_RUN) { pImp++; continue; }
        const exists = await pool.query(`SELECT id FROM customers WHERE LOWER(name)=LOWER($1)`, [name]);
        if (exists.rows.length) { pSkip++; continue; }
        await pool.query(
          `INSERT INTO customers(name, status) VALUES($1, 'active')`, [name]
        );
        pImp++;
      } catch(e) {
        totalErrors++;
        errorLog.push(`  ❌ [PARTY] "${name}": ${e.message}`);
      }
    }
    console.log(`   ✅ Customers imported: ${pImp}  |  🔄 Skipped: ${pSkip}\n`);
  }

  // 5. Summary
  console.log('══════════════════════════════════════════════════');
  console.log(`✅ Products imported  : ${totalImported}`);
  console.log(`🔄 Existing updated   : ${totalSkipped}`);
  console.log(`❌ Errors             : ${totalErrors}`);
  if (errorLog.length) {
    console.log('\nError details:');
    errorLog.forEach(e => console.log(e));
  }
  console.log('══════════════════════════════════════════════════\n');

  if (!DRY_RUN && totalImported > 0) {
    // Ensure product_categories table has the auto-assigned categories
    const cats = ['Bottles','Containers','Crates & Baskets','Buckets & Tubs',
                  'Furniture','Drinkware','Kitchen Tools','Cooler & Jugs',
                  'Laundry','Storage','General'];
    for (const cat of cats) {
      await pool.query(`INSERT INTO product_categories(name) VALUES($1) ON CONFLICT(name) DO NOTHING`, [cat]);
    }
    console.log('📁 Product categories ensured in product_categories table.\n');
  }

  await pool.end();
}

run().catch(e => { console.error('\n[FATAL]', e.message); process.exit(1); });
