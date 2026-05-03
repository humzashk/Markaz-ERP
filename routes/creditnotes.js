'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, nextDocNo, applyStockMovement, reverseStockForRef,
        addLedgerEntry, removeLedgerForRef, recomputeBalance,
        addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const type = req.query.type || '';
  const params = [], parts = [`1=1`]; let i=1;
  if (type) { parts.push(`note_type=$${i}`); params.push(type); i++; }
  const r = await pool.query(`
    SELECT cn.*, COALESCE(c.name,'') AS customer_name, COALESCE(v.name,'') AS vendor_name
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.customer_id
    LEFT JOIN vendors v   ON v.id = cn.vendor_id
    WHERE ${parts.join(' AND ')} ORDER BY cn.id DESC LIMIT 500`, params);
  res.render('creditnotes/index', { page:'creditnotes', notes: r.rows, type, ok: req.query.ok || null, err: req.query.err || null });
}));

router.get('/add', wrap(async (req, res) => {
  const noteType = req.query.type || 'credit';
  const [customers, vendors] = await Promise.all([
    pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM vendors WHERE status='active' ORDER BY name`)
  ]);
  res.render('creditnotes/form', {
    page:'creditnotes', note:null, noteType,
    customers: customers.rows, vendors: vendors.rows,
    formError: req.query.err ? decodeURIComponent(req.query.err) : null
  });
}));

router.post('/add', validate(schemas.creditNoteCreate), wrap(async (req, res) => {
  const v = req.valid;
  // Filter out items with quantity = 0 (user left them blank — means "not returning this item")
  const items = (v._items || []).filter(it => it.quantity > 0);
  if (!items.length) return res.redirect('/creditnotes/add?type=' + (v.note_type || 'credit') + '&err=' + encodeURIComponent('At least one item must have a return quantity'));
  let total = 0;
  for (const it of items) { it.amount = it.quantity * it.rate; total += it.amount; }

  const newId = await tx(async (db) => {
    const noteNo = await nextDocNo(db, v.note_type === 'credit' ? 'CN' : 'DN', 'credit_notes', 'note_no');
    const ins = await db.run(`
      INSERT INTO credit_notes(note_no, note_type, customer_id, vendor_id, invoice_id, purchase_id, note_date, amount, reason, status, notes, account_scope)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,COALESCE($11,'plastic_markaz')) RETURNING id`,
      [noteNo, v.note_type, v.customer_id, v.vendor_id, v.invoice_id, v.purchase_id, v.note_date, total, v.reason, v.notes, req.body.account_scope]);
    const id = ins.id;
    for (const it of items) {
      await db.run(`INSERT INTO credit_note_items(note_id, product_id, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5)`,
        [id, it.product_id, it.quantity, it.rate, it.amount]);
      // Credit (sales return): stock IN
      // Debit  (purchase return): stock OUT
      const delta = v.note_type === 'credit' ? +it.quantity : -it.quantity;
      await applyStockMovement(db, it.product_id, null, delta, v.note_type === 'credit' ? 'credit_note' : 'debit_note', id, v.note_type === 'credit' ? 'sales-return' : 'purchase-return', `${noteNo}`);
    }
    await addAuditLog('create','credit_notes', id, `${noteNo} ${total}`);
    return id;
  });

  res.redirect('/creditnotes/view/' + newId);
}));

// Apply note → post to ledger
router.post('/apply/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const note = await db.one(`SELECT * FROM credit_notes WHERE id=$1`, [id]);
    if (!note || note.status === 'applied') return;
    await db.run(`UPDATE credit_notes SET status='applied' WHERE id=$1`, [id]);
    if (note.note_type === 'credit' && note.customer_id) {
      // Credit note → CREDIT customer (reduces receivable)
      await addLedgerEntry(db, 'customer', note.customer_id, note.note_date, `Credit Note ${note.note_no} - ${note.reason || 'Sales Return'}`, 0, note.amount, 'credit_note', note.id, note.account_scope);
    } else if (note.note_type === 'debit' && note.vendor_id) {
      // Debit note → DEBIT vendor (reduces payable)
      await addLedgerEntry(db, 'vendor', note.vendor_id, note.note_date, `Debit Note ${note.note_no} - ${note.reason || 'Purchase Return'}`, note.amount, 0, 'debit_note', note.id, note.account_scope);
    }
  });
  res.redirect('/creditnotes');
}));

// API: customer's invoices for credit note form
router.get('/api/customer-invoices', wrap(async (req, res) => {
  const customerId = toInt(req.query.customer_id);
  if (!customerId) return res.json([]);
  const rows = (await pool.query(`
    SELECT i.id, i.invoice_no AS ref_no, TO_CHAR(i.invoice_date,'DD-Mon-YYYY') AS date_str, i.total
    FROM invoices i
    WHERE i.customer_id=$1 AND i.status != 'cancelled'
    ORDER BY i.invoice_date DESC, i.id DESC LIMIT 200`, [customerId])).rows;
  res.json(rows);
}));

// API: vendor's purchases for debit note form
router.get('/api/vendor-purchases', wrap(async (req, res) => {
  const vendorId = toInt(req.query.vendor_id);
  if (!vendorId) return res.json([]);
  const rows = (await pool.query(`
    SELECT p.id, p.purchase_no AS ref_no, TO_CHAR(p.purchase_date,'DD-Mon-YYYY') AS date_str, p.total
    FROM purchases p
    WHERE p.vendor_id=$1 AND p.status != 'cancelled'
    ORDER BY p.purchase_date DESC, p.id DESC LIMIT 200`, [vendorId])).rows;
  res.json(rows);
}));

// API: return items for a given invoice or purchase (for credit/debit note filtering)
router.get('/api/items', wrap(async (req, res) => {
  const invoiceId  = toInt(req.query.invoice_id);
  const purchaseId = toInt(req.query.purchase_id);
  if (invoiceId) {
    const rows = (await pool.query(`
      SELECT ii.product_id, p.name, ii.rate, ii.quantity AS max_qty
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY p.name`, [invoiceId])).rows;
    return res.json(rows);
  }
  if (purchaseId) {
    const rows = (await pool.query(`
      SELECT pi.product_id, p.name, pi.rate, pi.quantity AS max_qty
      FROM purchase_items pi
      JOIN products p ON p.id = pi.product_id
      WHERE pi.purchase_id = $1
      ORDER BY p.name`, [purchaseId])).rows;
    return res.json(rows);
  }
  res.json([]);
}));

router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const note = (await pool.query(`
    SELECT cn.*, COALESCE(c.name,'') AS customer_name, COALESCE(v.name,'') AS vendor_name
    FROM credit_notes cn LEFT JOIN customers c ON c.id=cn.customer_id LEFT JOIN vendors v ON v.id=cn.vendor_id
    WHERE cn.id=$1`, [id])).rows[0];
  if (!note) return res.redirect('/creditnotes');
  const items = (await pool.query(`SELECT cni.*, p.name AS product_name FROM credit_note_items cni JOIN products p ON p.id=cni.product_id WHERE cni.note_id=$1`, [id])).rows;
  res.render('creditnotes/view', { page:'creditnotes', note, items });
}));

router.post('/delete/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const note = await db.one(`SELECT * FROM credit_notes WHERE id=$1`, [id]);
    if (!note) return;
    const refType = note.note_type === 'credit' ? 'credit_note' : 'debit_note';
    await reverseStockForRef(db, refType, id);
    if (note.status === 'applied') {
      const entityType = note.note_type === 'credit' ? 'customer' : 'vendor';
      const entityId = note.note_type === 'credit' ? note.customer_id : note.vendor_id;
      await removeLedgerForRef(db, entityType, entityId, refType, id);
      await recomputeBalance(db, entityType, entityId);
    }
    await db.run(`DELETE FROM credit_note_items WHERE note_id=$1`, [id]);
    await db.run(`DELETE FROM credit_notes WHERE id=$1`, [id]);
    await addAuditLog('delete','credit_notes', id, 'Deleted note');
  });
  res.redirect('/creditnotes');
}));

// Bulk operations on credit/debit notes
router.post('/bulk', wrap(async (req, res) => {
  const action = req.body.action || '';
  const ids = (req.body.ids || '').split(',').map(s => toInt(s.trim())).filter(n => n > 0);
  if (!ids.length) return res.redirect('/creditnotes?err=' + encodeURIComponent('No notes selected'));

  if (action === 'delete') {
    await tx(async (db) => {
      const notes = await db.many(`SELECT id, note_type, status, customer_id, vendor_id FROM credit_notes WHERE id=ANY($1::int[])`, [ids]);
      for (const note of notes) {
        const refType = note.note_type === 'credit' ? 'credit_note' : 'debit_note';
        await reverseStockForRef(db, refType, note.id);
        if (note.status === 'applied') {
          const entityType = note.note_type === 'credit' ? 'customer' : 'vendor';
          const entityId = note.note_type === 'credit' ? note.customer_id : note.vendor_id;
          await removeLedgerForRef(db, entityType, entityId, refType, note.id);
          await recomputeBalance(db, entityType, entityId);
        }
        await db.run(`DELETE FROM credit_note_items WHERE note_id=$1`, [note.id]);
        await db.run(`DELETE FROM credit_notes WHERE id=$1`, [note.id]);
      }
    });
    await addAuditLog('delete', 'credit_notes', null, `Bulk deleted notes: ${ids.join(',')}`);
    return res.redirect('/creditnotes?ok=' + encodeURIComponent(`${ids.length} note(s) deleted`));
  }

  res.redirect('/creditnotes?err=' + encodeURIComponent('Unknown action'));
}));

module.exports = router;
