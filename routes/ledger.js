'use strict';
const express = require('express');
const router = express.Router();
const { pool, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const PDFDocument = require('pdfkit');

// opening balance = 0 when no from_date (all-time view); otherwise SUM before from_date
async function getOpeningBalance(entityType, entityId, from) {
  if (!from) return 0;
  const r = (await pool.query(
    `SELECT COALESCE(SUM(debit - credit), 0) AS ob
     FROM ledger
     WHERE entity_type=$1 AND entity_id=$2 AND txn_date::date < $3::date`,
    [entityType, entityId, from]
  )).rows[0];
  return Number(r.ob) || 0;
}

// For credit/debit notes: use l.description (already contains reason from creditnotes route)
// For all others: use standardised labels
function buildEntriesSql(entityType, isVendor) {
  const descCase = isVendor ? `
    CASE
      WHEN l.reference_type = 'purchase'        THEN 'Supplier Purchase'
      WHEN l.reference_type = 'payment'         THEN 'Vendor Payment'
      WHEN l.reference_type = 'opening_balance' THEN 'Opening Balance'
      WHEN l.reference_type IN ('credit_note','debit_note') THEN COALESCE(l.description, 'Adjustment Note')
      ELSE COALESCE(l.description, 'General Entry')
    END` : `
    CASE
      WHEN l.reference_type = 'invoice'         THEN 'Customer Sale'
      WHEN l.reference_type = 'payment'         THEN 'Customer Payment'
      WHEN l.reference_type = 'opening_balance' THEN 'Opening Balance'
      WHEN l.reference_type IN ('credit_note','debit_note') THEN COALESCE(l.description, 'Adjustment Note')
      ELSE COALESCE(l.description, 'General Entry')
    END`;

  return `
    SELECT l.id, l.txn_date, l.debit, l.credit, l.reference_type, l.reference_id, l.account_scope,
      ${descCase} AS description,
      COALESCE(pay.payment_method::text, '') AS payment_method
    FROM ledger l
    LEFT JOIN payments pay ON l.reference_type = 'payment' AND l.reference_id = pay.id
    WHERE l.entity_type = '${entityType}' AND l.entity_id = $1`;
}

// ── GET / ─────────────────────────────────────────────────────────────────────
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

// ── GET /customer/:id ─────────────────────────────────────────────────────────
router.get('/customer/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.redirect('/ledger');
  const customer = (await pool.query(`SELECT * FROM customers WHERE id=$1`, [id])).rows[0];
  if (!customer) return res.redirect('/ledger');

  const todayStr    = new Date().toISOString().split('T')[0];
  const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const from = req.query.from !== undefined ? req.query.from : defaultFrom;
  const to   = req.query.to   !== undefined ? req.query.to   : todayStr;

  const openingBalance = await getOpeningBalance('customer', id, from);

  let sql = buildEntriesSql('customer', false);
  const params = [id]; let p = 2;
  if (from) { sql += ` AND l.txn_date::date >= $${p}::date`; params.push(from); p++; }
  if (to)   { sql += ` AND l.txn_date::date <= $${p}::date`; params.push(to);   p++; }
  sql += ` ORDER BY l.txn_date ASC, l.id ASC`;

  const rows = (await pool.query(sql, params)).rows;
  let running = openingBalance;
  const entries = rows.map(r => {
    running += Number(r.debit || 0) - Number(r.credit || 0);
    return { ...r, running_balance: running };
  });

  res.render('ledger/detail', { page:'ledger', entity: customer, entityType:'customer', entries, openingBalance, closingBalance: running, from, to });
}));

// ── GET /vendor/:id ───────────────────────────────────────────────────────────
router.get('/vendor/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.redirect('/ledger');
  const vendor = (await pool.query(`SELECT * FROM vendors WHERE id=$1`, [id])).rows[0];
  if (!vendor) return res.redirect('/ledger');

  const todayStr    = new Date().toISOString().split('T')[0];
  const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const from = req.query.from !== undefined ? req.query.from : defaultFrom;
  const to   = req.query.to   !== undefined ? req.query.to   : todayStr;

  const openingBalance = await getOpeningBalance('vendor', id, from);

  let sql = buildEntriesSql('vendor', true);
  const params = [id]; let p = 2;
  if (from) { sql += ` AND l.txn_date::date >= $${p}::date`; params.push(from); p++; }
  if (to)   { sql += ` AND l.txn_date::date <= $${p}::date`; params.push(to);   p++; }
  sql += ` ORDER BY l.txn_date ASC, l.id ASC`;

  const rows = (await pool.query(sql, params)).rows;
  let running = openingBalance;
  const entries = rows.map(r => {
    running += Number(r.debit || 0) - Number(r.credit || 0);
    return { ...r, running_balance: running };
  });

  res.render('ledger/vendor', { page:'ledger', vendor, entries, openingBalance, closingBalance: running, from, to });
}));

// ── GET /print/:type/:id ──────────────────────────────────────────────────────
router.get('/print/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params;
  const tbl = type === 'customer' ? 'customers' : 'vendors';
  const entity = (await pool.query(`SELECT * FROM ${tbl} WHERE id=$1`, [id])).rows[0];
  if (!entity) return res.redirect('/ledger');
  const from = req.query.from || '';
  const to   = req.query.to   || '';

  const openingBalance = await getOpeningBalance(type, id, from);

  let sql = buildEntriesSql(type, type === 'vendor');
  // Override entity_id param (buildEntriesSql uses $1 for entity_id but we need entity_type too)
  const fullSql = `
    SELECT l.id, l.txn_date, l.debit, l.credit, l.reference_type, l.reference_id, l.account_scope,
      CASE
        WHEN l.reference_type IN ('credit_note','debit_note') THEN COALESCE(l.description, 'Adjustment Note')
        WHEN l.reference_type = 'purchase'        THEN 'Supplier Purchase'
        WHEN l.reference_type = 'payment'         THEN CASE WHEN l.entity_type='vendor' THEN 'Vendor Payment' ELSE 'Customer Payment' END
        WHEN l.reference_type = 'invoice'         THEN 'Customer Sale'
        WHEN l.reference_type = 'opening_balance' THEN 'Opening Balance'
        ELSE COALESCE(l.description, 'General Entry')
      END AS description,
      COALESCE(pay.payment_method::text, '') AS payment_method
    FROM ledger l
    LEFT JOIN payments pay ON l.reference_type = 'payment' AND l.reference_id = pay.id
    WHERE l.entity_type = $1 AND l.entity_id = $2`;

  const params = [type, id]; let p = 3;
  let querySql = fullSql;
  if (from) { querySql += ` AND l.txn_date::date >= $${p}::date`; params.push(from); p++; }
  if (to)   { querySql += ` AND l.txn_date::date <= $${p}::date`; params.push(to);   p++; }
  querySql += ` ORDER BY l.txn_date ASC, l.id ASC`;

  const rows = (await pool.query(querySql, params)).rows;
  let running = openingBalance;
  const entries = rows.map(r => { running += Number(r.debit||0) - Number(r.credit||0); return { ...r, running_balance: running }; });

  res.render('ledger/print', { page:'ledger', entity, entityType: type, entries, openingBalance, closingBalance: running, from, to, layout:false });
}));

// ── GET /pdf/:type/:id ────────────────────────────────────────────────────────
router.get('/pdf/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params;
  const tbl = type === 'customer' ? 'customers' : 'vendors';
  const entity = (await pool.query(`SELECT * FROM ${tbl} WHERE id=$1`, [id])).rows[0];
  if (!entity) return res.status(404).send('Not found');
  const from = req.query.from || '';
  const to   = req.query.to   || '';

  const openingBalance = await getOpeningBalance(type, id, from);

  const fullSql = `
    SELECT l.id, l.txn_date, l.debit, l.credit, l.reference_type, l.reference_id,
      CASE
        WHEN l.reference_type IN ('credit_note','debit_note') THEN COALESCE(l.description, 'Adjustment Note')
        WHEN l.reference_type = 'purchase'        THEN 'Supplier Purchase'
        WHEN l.reference_type = 'payment'         THEN CASE WHEN l.entity_type='vendor' THEN 'Vendor Payment' ELSE 'Customer Payment' END
        WHEN l.reference_type = 'invoice'         THEN 'Customer Sale'
        WHEN l.reference_type = 'opening_balance' THEN 'Opening Balance'
        ELSE COALESCE(l.description, 'General Entry')
      END AS description,
      COALESCE(pay.payment_method::text, '') AS payment_method
    FROM ledger l
    LEFT JOIN payments pay ON l.reference_type = 'payment' AND l.reference_id = pay.id
    WHERE l.entity_type = $1 AND l.entity_id = $2`;

  const params = [type, id]; let p = 3;
  let querySql = fullSql;
  if (from) { querySql += ` AND l.txn_date::date >= $${p}::date`; params.push(from); p++; }
  if (to)   { querySql += ` AND l.txn_date::date <= $${p}::date`; params.push(to);   p++; }
  querySql += ` ORDER BY l.txn_date ASC, l.id ASC`;

  const rows = (await pool.query(querySql, params)).rows;
  let running = openingBalance;
  const entries = rows.map(r => {
    running += Number(r.debit||0) - Number(r.credit||0);
    return { ...r, running_balance: running };
  });
  const closingBalance = running;

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const doc = new PDFDocument({ margin: 0, size: 'A4', bufferPages: true });
  const filename = `Ledger_${entity.name.replace(/[^a-zA-Z0-9]/g,'_')}_${from||'all'}_${to||'present'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const fmtNum  = n => Number(n||0).toLocaleString('en-PK', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', weekday:'short' }).replace(/,/g,'');

  // A4 = 595.28 × 841.89 pt. Margins: left/right 36, top 36, bottom 30
  const ML = 36, MR = 36, MT = 36;
  const PW = 595.28;
  const PH = 841.89;
  const W  = PW - ML - MR;  // 523.28

  // Columns — must sum to W exactly
  // date:78  desc:180  pay:65  dr:70  cr:70  bal:60  → 78+180+65+70+70+60 = 523 ✓
  const C = { date:78, desc:180, pay:65, dr:70, cr:70, bal:60 };
  // verify: 78+180+65+70+70+60 = 523 — W is ~523.28, close enough with 0.28 rounding
  const C_PAD = 4; // inner padding per cell

  const DARK  = '#1e293b';
  const MID   = '#475569';
  const LIGHT = '#f1f5f9';
  const WHITE = '#ffffff';
  const RED   = '#cc2222';
  const GREEN = '#16a34a';
  const BLUE  = '#1d4ed8';
  const RULE  = '#e2e8f0';

  const ROW_H = 17;
  const HDR_H = 20;

  // ── helper: draw one table header band ────────────────────────────────────
  const drawHeader = (y) => {
    doc.rect(ML, y, W, HDR_H).fill(DARK);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE);
    let x = ML + C_PAD;
    doc.text('DATE',           x, y+6, { width: C.date-C_PAD, lineBreak:false });       x += C.date;
    doc.text('DESCRIPTION',    x, y+6, { width: C.desc-C_PAD, lineBreak:false });       x += C.desc;
    doc.text('PAY TYPE',       x, y+6, { width: C.pay-C_PAD,  lineBreak:false });       x += C.pay;
    doc.text('DEBIT (Rs.)',    x, y+6, { width: C.dr-C_PAD,   align:'right', lineBreak:false }); x += C.dr;
    doc.text('CREDIT (Rs.)',   x, y+6, { width: C.cr-C_PAD,   align:'right', lineBreak:false }); x += C.cr;
    doc.text('BALANCE (Rs.)', x, y+6, { width: C.bal-C_PAD,  align:'right', lineBreak:false });
    return y + HDR_H;
  };

  // ── helper: draw one data row ──────────────────────────────────────────────
  const drawRow = (y, bg, cells) => {
    // cells: [{ text, color, bold, align }] matching column order
    doc.rect(ML, y, W, ROW_H).fill(bg);
    doc.rect(ML, y, W, ROW_H).strokeColor(RULE).lineWidth(0.3).stroke();
    let x = ML + C_PAD;
    const cols = [C.date, C.desc, C.pay, C.dr, C.cr, C.bal];
    cells.forEach((cell, i) => {
      doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(8).fillColor(cell.color || DARK)
         .text(cell.text || '—', x, y+5, {
           width: cols[i] - C_PAD,
           align: cell.align || 'left',
           lineBreak: false
         });
      x += cols[i];
    });
    return y + ROW_H;
  };

  // ── Page 1 letterhead ──────────────────────────────────────────────────────
  let y = MT;

  // Top dark band
  doc.rect(0, 0, PW, 28).fill(DARK);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE)
     .text('PLASTIC MARKAZ', 0, 8, { align:'center', width: PW });

  y = 36;

  // Company subtitle + doc type
  doc.font('Helvetica').fontSize(9).fillColor(MID)
     .text('Account Statement', ML, y, { width: W, align:'center' }); y += 13;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(DARK)
     .text(`${type === 'customer' ? 'Customer' : 'Vendor'} Ledger`, ML, y, { width: W, align:'center' }); y += 20;

  // Thin rule
  doc.moveTo(ML, y).lineTo(ML+W, y).lineWidth(1.5).strokeColor(DARK).stroke(); y += 10;

  // Party info box
  const partyLabel = type === 'customer' ? 'RECEIVABLE' : 'PAYABLE';
  const PIH = 44;
  doc.rect(ML, y, W, PIH).fill(LIGHT);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK)
     .text(entity.name.toUpperCase(), ML+10, y+8, { width: W*0.65, lineBreak:false });
  doc.rect(ML+10 + Math.min(entity.name.length*8, W*0.55), y+10, 70, 14).fill(DARK);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(WHITE)
     .text(partyLabel, ML+10 + Math.min(entity.name.length*8, W*0.55)+4, y+14, { lineBreak:false });

  // Right side of party box
  doc.font('Helvetica').fontSize(8).fillColor(MID)
     .text(`Period: ${from || 'Beginning'} → ${to || 'Present'}`, ML + W*0.6, y+8, { width: W*0.38, align:'right', lineBreak:false });
  if (entity.phone) {
    doc.text(`Phone: ${entity.phone}`, ML + W*0.6, y+20, { width: W*0.38, align:'right', lineBreak:false });
  }
  doc.text(`Printed: ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}`,
     ML + W*0.6, y+32, { width: W*0.38, align:'right', lineBreak:false });
  y += PIH + 10;

  // Summary boxes (4 boxes in a row)
  const totalDr = entries.reduce((s,e) => s+Number(e.debit||0), 0);
  const totalCr = entries.reduce((s,e) => s+Number(e.credit||0), 0);
  const BW = (W - 9) / 4;
  const summaries = [
    { label:'Opening Balance', val: fmtNum(openingBalance), color: MID },
    { label:'Total Debit',     val: fmtNum(totalDr),        color: RED  },
    { label:'Total Credit',    val: fmtNum(totalCr),        color: GREEN},
    { label:`Closing Balance (${closingBalance>0?'Dr':closingBalance<0?'Cr':'Nil'})`, val: fmtNum(closingBalance), color: BLUE }
  ];
  summaries.forEach((s, i) => {
    const bx = ML + i*(BW+3);
    doc.rect(bx, y, BW, 34).fill('#f8fafc').stroke(RULE);
    doc.moveTo(bx, y).lineTo(bx, y+34).lineWidth(3).strokeColor(s.color).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(MID)
       .text(s.label.toUpperCase(), bx+7, y+6, { width: BW-10, lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(s.color)
       .text('Rs. '+s.val, bx+7, y+18, { width: BW-10, lineBreak:false });
  });
  y += 44;

  // ── Table ──────────────────────────────────────────────────────────────────
  y = drawHeader(y);

  // Opening balance row
  let x = ML + C_PAD;
  doc.rect(ML, y, W, ROW_H).fill(LIGHT);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MID);
  doc.text(from || '—',        ML+C_PAD, y+5, { width: C.date-C_PAD, lineBreak:false });
  doc.text('Opening Balance',  ML+C_PAD+C.date, y+5, { width: C.desc+C.pay+C.dr+C.cr-C_PAD, lineBreak:false });
  doc.fillColor(openingBalance>0?RED:openingBalance<0?GREEN:MID)
     .text(fmtNum(openingBalance)+(openingBalance>0?' Dr':openingBalance<0?' Cr':''),
       ML+C_PAD+C.date+C.desc+C.pay+C.dr+C.cr, y+5,
       { width: C.bal-C_PAD, align:'right', lineBreak:false });
  y += ROW_H;

  // Data rows
  let rowIdx = 0;
  for (const e of entries) {
    if (y > PH - 70) {
      // Footer on current page
      doc.font('Helvetica').fontSize(7).fillColor(MID)
         .text(`PLASTIC MARKAZ  —  ${entity.name}  —  Continued...`, ML, PH-22, { width:W, align:'center', lineBreak:false });
      doc.addPage();
      y = drawHeader(MT);
    }
    const bg = rowIdx % 2 === 0 ? WHITE : '#f8fafc';
    const rb  = Number(e.running_balance || 0);
    const dr  = Number(e.debit  || 0);
    const cr  = Number(e.credit || 0);
    const pm  = e.payment_method ? e.payment_method.charAt(0).toUpperCase()+e.payment_method.slice(1) : '—';
    y = drawRow(y, bg, [
      { text: fmtDate(e.txn_date),                       color: MID                              },
      { text: (e.description||'—').substring(0,42),      color: DARK                             },
      { text: pm,                                         color: MID,  align:'center'             },
      { text: dr>0 ? fmtNum(dr) : '—',                  color: dr>0 ? RED   : '#aaa', align:'right' },
      { text: cr>0 ? fmtNum(cr) : '—',                  color: cr>0 ? GREEN : '#aaa', align:'right' },
      { text: fmtNum(rb)+(rb>0?' Dr':rb<0?' Cr':''),    color: rb>0 ? RED : rb<0 ? GREEN : MID, bold:true, align:'right' }
    ]);
    rowIdx++;
  }

  if (!entries.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#94a3b8')
       .text('No transactions found for this period.', ML, y+12, { width:W, align:'center', lineBreak:false });
    y += 32;
  }

  // Period totals row
  if (y > PH - 60) { doc.addPage(); y = MT; }
  doc.rect(ML, y, W, ROW_H+1).fill('#e8ecf0');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MID)
     .text('PERIOD TOTALS', ML+C_PAD, y+5, { width: C.date+C.desc+C.pay-C_PAD, lineBreak:false });
  doc.fillColor(RED)
     .text(fmtNum(totalDr), ML+C_PAD+C.date+C.desc+C.pay, y+5, { width: C.dr-C_PAD, align:'right', lineBreak:false });
  doc.fillColor(GREEN)
     .text(fmtNum(totalCr), ML+C_PAD+C.date+C.desc+C.pay+C.dr, y+5, { width: C.cr-C_PAD, align:'right', lineBreak:false });
  y += ROW_H + 1;

  // Closing balance row
  doc.rect(ML, y, W, ROW_H+4).fill(DARK);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE)
     .text('CLOSING BALANCE', ML+C_PAD, y+7, { width: C.date+C.desc+C.pay+C.dr+C.cr-C_PAD, lineBreak:false });
  doc.fillColor(closingBalance>0?'#fca5a5':closingBalance<0?'#86efac':WHITE)
     .text(fmtNum(closingBalance)+(closingBalance>0?' Dr':closingBalance<0?' Cr':''),
       ML+C_PAD+C.date+C.desc+C.pay+C.dr+C.cr, y+7,
       { width: C.bal-C_PAD, align:'right', lineBreak:false });
  y += ROW_H + 4;

  // ── Doc footer ─────────────────────────────────────────────────────────────
  y += 16;
  doc.moveTo(ML, y).lineTo(ML+W, y).lineWidth(0.5).strokeColor(RULE).stroke(); y += 8;
  doc.font('Helvetica').fontSize(7.5).fillColor('#94a3b8')
     .text('PLASTIC MARKAZ', ML, y, { width:W*0.5, lineBreak:false });
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`, ML+W*0.5, y, { width:W*0.5, align:'right', lineBreak:false });
  y += 12;
  doc.moveTo(ML+W-100, y).lineTo(ML+W, y).lineWidth(0.7).strokeColor(DARK).stroke(); y += 5;
  doc.font('Helvetica').fontSize(7).fillColor(MID)
     .text('Authorised Signature', ML+W-100, y, { width:100, align:'center', lineBreak:false });

  doc.end();
}));

module.exports = router;
