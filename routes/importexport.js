'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { pool, tx, applyStockMovement } = require('../database');
const { wrap }  = require('../middleware/errorHandler');

const upload = multer({ dest: 'uploads/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

const EXPORTABLE = {
  customers: { label: 'Customers' },
  vendors:   { label: 'Vendors' },
  products:  { label: 'Products' },
  invoices:  { label: 'Invoices' },
  purchases: { label: 'Purchases' },
  orders:    { label: 'Orders' },
  payments:  { label: 'Payments' },
  expenses:  { label: 'Expenses' },
};

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(',')].concat(rows.map(row => cols.map(c => {
    const v = row[c];
    if (v == null) return '';
    const s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(','))).join('\n');
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).map(line => {
    const vals = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else { cur += line[i]; }
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i].replace(/^"|"$/g, '') : ''; });
    return obj;
  });
}

// ── GET ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('importexport/index', { page: 'importexport', error: null, result: null, exportable: EXPORTABLE });
});

// ── GET single-table export (legacy URL) ─────────────────────────────────────
router.get('/export/:entity', wrap(async (req, res) => {
  const tbl = EXPORTABLE[req.params.entity] ? req.params.entity : null;
  if (!tbl) return res.status(400).send('Unknown table');
  const rows = (await pool.query(`SELECT * FROM ${tbl} ORDER BY id`)).rows;
  if (!rows.length) return res.status(204).end();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${tbl}.csv`);
  res.send(toCSV(rows));
}));

// ── POST multi-table export (from form) ───────────────────────────────────────
router.post('/export', wrap(async (req, res) => {
  const tables = req.body.tables
    ? (Array.isArray(req.body.tables) ? req.body.tables : [req.body.tables])
    : [];
  const valid = tables.filter(t => EXPORTABLE[t]);
  if (!valid.length) return res.redirect('/importexport');

  let output = '';
  for (const t of valid) {
    const rows = (await pool.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    output += (output ? '\n\n' : '') + `--- ${t.toUpperCase()} ---\n` + toCSV(rows);
  }

  const filename = valid.length === 1 ? `${valid[0]}.csv` : `markaz_export_${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(output);
}));

// ── POST import ───────────────────────────────────────────────────────────────
router.post('/import', upload.single('file'), wrap(async (req, res) => {
  const importType = req.body.import_type || '';
  const file = req.file;

  const renderResult = (error, result) => {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.render('importexport/index', { page: 'importexport', error, result, exportable: EXPORTABLE });
  };

  if (!file) return renderResult('No file uploaded.', null);
  if (!['customers', 'vendors', 'products'].includes(importType))
    return renderResult('Invalid import type selected.', null);

  let text;
  try { text = fs.readFileSync(file.path, 'utf8'); }
  catch (e) { return renderResult('Could not read uploaded file. Ensure it is a valid CSV.', null); }

  const rows = parseCSV(text);
  if (!rows.length) return renderResult('File is empty or has no data rows.', null);

  let imported = 0, skipped = 0;
  const errors = [], unrecognized = [];

  if (importType === 'customers') {
    for (const row of rows) {
      const name = (row.name || '').trim();
      if (!name) { skipped++; continue; }
      try {
        const exists = (await pool.query(`SELECT id FROM customers WHERE LOWER(name)=LOWER($1)`, [name])).rows[0];
        if (exists) { skipped++; continue; }
        await pool.query(
          `INSERT INTO customers(name,phone,email,address,city,category,region,notes,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
          [name, row.phone||null, row.email||null, row.address||null,
           row.city||null, row.party_type||row.category||null,
           row.region||null, row.notes||null]
        );
        imported++;
      } catch (e) { errors.push(`Row "${name}": ${e.message}`); }
    }
  } else if (importType === 'vendors') {
    for (const row of rows) {
      const name = (row.name || '').trim();
      if (!name) { skipped++; continue; }
      try {
        const exists = (await pool.query(`SELECT id FROM vendors WHERE LOWER(name)=LOWER($1)`, [name])).rows[0];
        if (exists) { skipped++; continue; }
        await pool.query(
          `INSERT INTO vendors(name,phone,email,address,city,category,region,notes,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
          [name, row.phone||null, row.email||null, row.address||null,
           row.city||null, row.category||null, row.region||null, row.notes||null]
        );
        imported++;
      } catch (e) { errors.push(`Row "${name}": ${e.message}`); }
    }
  } else if (importType === 'products') {
    for (const row of rows) {
      const name = (row.name || '').trim();
      if (!name) { skipped++; continue; }
      try {
        const exists = (await pool.query(`SELECT id FROM products WHERE LOWER(name)=LOWER($1)`, [name])).rows[0];
        if (exists) { skipped++; continue; }
        const sellPrice = parseFloat(row.selling_price || row.rate || row.price || 0) || 0;
        const costPrice = parseFloat(row.cost_price || row.cost || 0) || 0;
        const stock     = parseInt(row.stock || row.qty || 0, 10) || 0;
        const qtyPack   = parseInt(row.qty_per_pack || row.packaging || 1, 10) || 1;
        const itemId    = (row.item_id || row.code || '').trim() || null;

        // Use transaction to ensure product insert and stock ledger entry are atomic
        await tx(async (db) => {
          const result = await db.one(
            `INSERT INTO products(item_id,name,category,unit,qty_per_pack,cost_price,selling_price,stock,status)
             VALUES($1,$2,$3,COALESCE($4,'PCS'),$5,$6,$7,$8,'active') RETURNING id`,
            [itemId, name, row.category||null, row.unit||null, qtyPack, costPrice, sellPrice, stock]
          );
          const productId = result.id;

          // Record stock in ledger if initial stock > 0
          if (stock > 0) {
            // Use default warehouse ID 1 (or first available)
            const wh = await db.one(`SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1`);
            if (wh) {
              await applyStockMovement(db, productId, wh.id, stock, 'import', productId, 'opening', 'Product import');
            }
          }
        });
        imported++;
      } catch (e) { errors.push(`Row "${name}": ${e.message}`); }
    }
  }

  renderResult(null, { imported, skipped, errors, unrecognized });
}));

module.exports = router;
