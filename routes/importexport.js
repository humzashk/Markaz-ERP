const express = require('express');
const router = express.Router();
const { db } = require('../database');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const EXPORTABLE = {
  customers:  { label: 'Customers',  cols: ['id','name','phone','email','city','address','region','party_type','balance','commission','notes','status'] },
  vendors:    { label: 'Vendors',    cols: ['id','name','phone','email','city','address','region','party_type','balance','commission','notes','status'] },
  products:   { label: 'Products',   cols: ['id','name','category','packaging','rate','stock','min_stock','unit','status'] },
  invoices:   { label: 'Invoices',   cols: ['id','invoice_no','invoice_date','due_date','customer_id','subtotal','discount','total','paid','status'] },
  orders:     { label: 'Orders',     cols: ['id','order_no','order_date','delivery_date','customer_id','total','status'] },
  purchases:  { label: 'Purchases',  cols: ['id','purchase_no','purchase_date','vendor_id','total','status'] },
  expenses:   { label: 'Expenses',   cols: ['id','expense_date','category','description','amount','payment_method','paid_to','reference'] },
  payments:   { label: 'Payments',   cols: ['id','payment_date','entity_type','entity_id','amount','payment_method','reference','notes'] },
};

router.get('/', (req, res) => {
  res.render('importexport/index', { page: 'reports', exportable: EXPORTABLE, result: null, error: null });
});

// ---- EXPORT ----
router.post('/export', (req, res) => {
  const tables = Array.isArray(req.body.tables) ? req.body.tables : [req.body.tables];
  const wb = XLSX.utils.book_new();

  for (const tbl of tables) {
    const meta = EXPORTABLE[tbl];
    if (!meta) continue;
    try {
      const rows = db.prepare(`SELECT ${meta.cols.join(',')} FROM ${tbl} ORDER BY id DESC`).all();
      const ws = XLSX.utils.json_to_sheet(rows, { header: meta.cols });
      XLSX.utils.book_append_sheet(wb, ws, meta.label);
    } catch (e) { /* skip if table error */ }
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `markaz_export_${new Date().toISOString().split('T')[0]}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ---- IMPORT ----
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.render('importexport/index', { page: 'reports', exportable: EXPORTABLE, result: null, error: 'No file uploaded.' });

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.render('importexport/index', { page: 'reports', exportable: EXPORTABLE, result: null, error: 'Could not read file. Upload a valid .xlsx or .csv file.' });
  }

  const importType = req.body.import_type;
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) return res.render('importexport/index', { page: 'reports', exportable: EXPORTABLE, result: null, error: 'File is empty.' });

  const result = { imported: 0, skipped: 0, unrecognized: [], errors: [] };

  if (importType === 'customers') {
    for (const row of rows) {
      const name = (row.name || row.Name || '').toString().trim();
      if (!name) { result.skipped++; continue; }
      const phone = (row.phone || row.Phone || '').toString().trim();
      const city  = (row.city || row.City || '').toString().trim();
      const bal   = parseFloat(row.balance || row.Balance || row.opening_balance || 0) || 0;
      const region = (row.region || row.Region || '').toString().trim();
      const party_type = (row.party_type || row.type || row.Type || '').toString().trim();
      const notes = (row.notes || row.Notes || '').toString().trim();
      try {
        const exists = db.prepare('SELECT id FROM customers WHERE name = ? AND phone = ?').get(name, phone);
        if (!exists) {
          db.prepare('INSERT INTO customers (name,phone,city,opening_balance,balance,region,party_type,notes) VALUES (?,?,?,?,?,?,?,?)').run(name,phone,city,bal,bal,region,party_type,notes);
          result.imported++;
        } else { result.skipped++; }
      } catch (e) { result.errors.push(name + ': ' + e.message); }
    }
  } else if (importType === 'vendors') {
    for (const row of rows) {
      const name = (row.name || row.Name || '').toString().trim();
      if (!name) { result.skipped++; continue; }
      const phone = (row.phone || row.Phone || '').toString().trim();
      const city  = (row.city || row.City || '').toString().trim();
      const bal   = parseFloat(row.balance || row.Balance || 0) || 0;
      try {
        const exists = db.prepare('SELECT id FROM vendors WHERE name = ? AND phone = ?').get(name, phone);
        if (!exists) {
          db.prepare('INSERT INTO vendors (name,phone,city,opening_balance,balance) VALUES (?,?,?,?,?)').run(name,phone,city,bal,bal);
          result.imported++;
        } else { result.skipped++; }
      } catch (e) { result.errors.push(name + ': ' + e.message); }
    }
  } else if (importType === 'products') {
    const knownCats = db.prepare('SELECT name FROM product_categories').all().map(r => r.name.toLowerCase());
    for (const row of rows) {
      const name = (row.name || row.Name || '').toString().trim();
      if (!name) { result.skipped++; continue; }
      const category = (row.category || row.Category || '').toString().trim();
      const packaging = parseInt(row.packaging || row.Packaging || 1) || 1;
      const rate = parseFloat(row.rate || row.Rate || row['Rate/Pc'] || 0) || 0;
      const stock = parseInt(row.stock || row.Stock || 0) || 0;
      if (category && !knownCats.includes(category.toLowerCase())) {
        result.unrecognized.push(`Category "${category}" on product "${name}" is not in the system`);
      }
      try {
        const exists = db.prepare('SELECT id FROM products WHERE name = ?').get(name);
        if (!exists) {
          db.prepare('INSERT INTO products (name,category,packaging,rate,stock,min_stock) VALUES (?,?,?,?,?,10)').run(name,category,packaging,rate,stock);
          result.imported++;
        } else {
          db.prepare('UPDATE products SET category=?,packaging=?,rate=?,stock=? WHERE name=?').run(category,packaging,rate,stock,name);
          result.imported++;
        }
      } catch (e) { result.errors.push(name + ': ' + e.message); }
    }
  } else {
    result.errors.push('Import type not supported.');
  }

  res.render('importexport/index', { page: 'reports', exportable: EXPORTABLE, result, error: null });
});

module.exports = router;
