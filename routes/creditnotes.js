'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, nextDocNo,
        addLedgerEntry, removeLedgerForRef, recomputeBalance,
        addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas, requireEditPermission, isOlderThan2Years } = require('../middleware/validate');
const _lockNote = requireEditPermission('credit_notes', 'note_date');

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', wrap(async (req, res) => {
  const type = req.query.type || '';
  const params = [], parts = [`1=1`]; let i = 1;
  if (type) { parts.push(`note_type=$${i}`); params.push(type); i++; }
  const r = await pool.query(`
    SELECT cn.*, COALESCE(c.name,'') AS customer_name, COALESCE(v.name,'') AS vendor_name
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.customer_id
    LEFT JOIN vendors v   ON v.id = cn.vendor_id
    WHERE ${parts.join(' AND ')} ORDER BY cn.id DESC LIMIT 500`, params);
  res.render('creditnotes/index', { page:'creditnotes', notes: r.rows, type,
    ok: req.query.ok || null, err: req.query.err || null });
}));

// ── GET /add ──────────────────────────────────────────────────────────────────
router.get('/add', wrap(async (req, res) => {
  const noteType = req.query.type || 'credit';
  const mode     = req.query.mode === 'manual' ? 'manual' : 'invoice';
  const [customers, vendors, products] = await Promise.all([
    pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM vendors   WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name, qty_per_pack, selling_price, default_commission_rate FROM products WHERE status='active' ORDER BY name`)
  ]);
  res.render('creditnotes/form', {
    page: 'creditnotes', note: null, noteType, mode,
    customers: customers.rows, vendors: vendors.rows, products: products.rows,
    formError: req.query.err ? decodeURIComponent(req.query.err) : null
  });
}));

// ── POST /add ─────────────────────────────────────────────────────────────────
router.post('/add', validate(schemas.creditNoteCreate), wrap(async (req, res) => {
  const v    = req.valid;
  const mode = v._mode || 'invoice';   // set by validator

  // Filter zero-qty rows
  const items = (v._items || []).filter(it => (it.quantity || 0) > 0);
  if (!items.length) {
    return res.redirect('/creditnotes/add?type=' + (v.note_type || 'credit') +
      '&mode=' + mode + '&err=' + encodeURIComponent('At least one item must have a return quantity'));
  }

  const newId = await tx(async (db) => {
    let total = 0;

    for (const it of items) {
      if (mode === 'invoice') {
        // ── Invoice-linked mode ──────────────────────────────────────────────
        // quantity[] from form = Cartons; convert to PCS
        const prod = await db.one(`SELECT qty_per_pack FROM products WHERE id=$1`, [it.product_id]);
        const qpp  = Math.max(1, Number(prod?.qty_per_pack || 1));
        const pcs  = it.quantity * qpp;   // total PCS being returned

        // Rate always fetched server-side — never trust client-supplied rate.
        // Commission % comes from the form (user-editable, validated 0-50 by schema).
        let commPct = 0, serverRate = 0;
        if (v.note_type === 'credit' && v.invoice_id) {
          const src = await db.one(
            `SELECT rate AS server_rate
             FROM invoice_items WHERE invoice_id=$1 AND product_id=$2 LIMIT 1`,
            [v.invoice_id, it.product_id]);
          serverRate = Number(src?.server_rate || 0);
          // Use user-submitted commission% (schema validates 0–50); default to 0 if absent
          commPct = Math.min(50, Math.max(0, Number(it.commission_pct ?? 0)));
        } else if (v.note_type === 'debit' && v.purchase_id) {
          const src = await db.one(
            `SELECT rate AS server_rate
             FROM purchase_items WHERE purchase_id=$1 AND product_id=$2 LIMIT 1`,
            [v.purchase_id, it.product_id]);
          serverRate = Number(src?.server_rate || 0);
          commPct = Math.min(50, Math.max(0, Number(it.commission_pct ?? 0)));
        }
        if (!serverRate) throw new Error(`Rate not found for product ${it.product_id} on source document`);

        // final_rate_per_pcs = server_rate × (1 - commission_pct / 100)
        const finalRate = Math.round(serverRate * (1 - commPct / 100) * 10000) / 10000;
        const amount    = Math.round(pcs * finalRate * 100) / 100;

        it._pcs         = pcs;
        it._commPct     = commPct;
        it._finalRate   = finalRate;
        it._amount      = amount;
        total += amount;

      } else {
        // ── Manual mode ──────────────────────────────────────────────────────
        // quantity[] from form = PCS directly; rate = rate_per_pcs entered by user
        if (it.quantity < 1)    throw new Error('PCS must be ≥ 1');
        if (it.rate   <= 0)     throw new Error('Rate must be > 0');
        const amount = Math.round(it.quantity * it.rate * 100) / 100;
        it._pcs       = it.quantity;
        it._commPct   = 0;
        it._finalRate = it.rate;
        it._amount    = amount;
        total += amount;
      }
    }

    const prefix = v.note_type === 'credit' ? 'CN' : 'DN';
    const noteNo = await nextDocNo(db, prefix, 'credit_notes', 'note_no');

    const ins = await db.run(`
      INSERT INTO credit_notes(note_no, note_type, customer_id, vendor_id,
        invoice_id, purchase_id, note_date, amount, reason, status, notes, account_scope)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,
        COALESCE($11::account_scope_t,'plastic_markaz'::account_scope_t)) RETURNING id`,
      [noteNo, v.note_type,
       v.customer_id || null, v.vendor_id || null,
       v.invoice_id  || null, v.purchase_id || null,
       v.note_date, total, v.reason || null, v.notes || null,
       req.body.account_scope || null]);

    const id = ins.id;

    for (const it of items) {
      // Store PCS quantity + final (net) rate in credit_note_items
      await db.run(
        `INSERT INTO credit_note_items(note_id, product_id, quantity, rate, amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, it.product_id, it._pcs, it._finalRate, it._amount]);

      // ✅ DO NOT move stock — returned goods do not re-enter inventory
    }

    await addAuditLog('create', 'credit_notes', id,
      `${noteNo} mode=${mode} total=${total}`);
    return id;
  });

  res.redirect('/creditnotes/view/' + newId);
}));

// ── POST /apply/:id → post to ledger ─────────────────────────────────────────
router.post('/apply/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const note = await db.one(`SELECT * FROM credit_notes WHERE id=$1`, [id]);
    if (!note || note.status === 'applied') return;
    await db.run(`UPDATE credit_notes SET status='applied' WHERE id=$1`, [id]);
    if (note.note_type === 'credit' && note.customer_id) {
      await addLedgerEntry(db, 'customer', note.customer_id, note.note_date,
        `Credit Note ${note.note_no} - ${note.reason || 'Sales Return'}`,
        0, note.amount, 'credit_note', note.id, note.account_scope);
    } else if (note.note_type === 'debit' && note.vendor_id) {
      await addLedgerEntry(db, 'vendor', note.vendor_id, note.note_date,
        `Debit Note ${note.note_no} - ${note.reason || 'Purchase Return'}`,
        note.amount, 0, 'debit_note', note.id, note.account_scope);
    }
  });
  res.redirect('/creditnotes');
}));

// ── API: customer invoices for credit note form ───────────────────────────────
router.get('/api/customer-invoices', wrap(async (req, res) => {
  const customerId = toInt(req.query.customer_id);
  if (!customerId) return res.json([]);
  const rows = (await pool.query(`
    SELECT i.id, i.invoice_no AS ref_no,
           TO_CHAR(i.invoice_date,'DD-Mon-YYYY') AS date_str, i.total
    FROM invoices i
    WHERE i.customer_id=$1 AND i.status != 'cancelled'
    ORDER BY i.invoice_date DESC, i.id DESC LIMIT 200`, [customerId])).rows;
  res.json(rows);
}));

// ── API: vendor purchases for debit note form ─────────────────────────────────
router.get('/api/vendor-purchases', wrap(async (req, res) => {
  const vendorId = toInt(req.query.vendor_id);
  if (!vendorId) return res.json([]);
  const rows = (await pool.query(`
    SELECT p.id, p.purchase_no AS ref_no,
           TO_CHAR(p.purchase_date,'DD-Mon-YYYY') AS date_str, p.total
    FROM purchases p
    WHERE p.vendor_id=$1 AND p.status != 'cancelled'
    ORDER BY p.purchase_date DESC, p.id DESC LIMIT 200`, [vendorId])).rows;
  res.json(rows);
}));

// ── API: line items from invoice or purchase ──────────────────────────────────
// Returns qty in Ctn (for display), rate per PCS, commission_pct
router.get('/api/items', wrap(async (req, res) => {
  const invoiceId  = toInt(req.query.invoice_id);
  const purchaseId = toInt(req.query.purchase_id);

  if (invoiceId) {
    const rows = (await pool.query(`
      SELECT ii.product_id,
             p.name,
             ii.rate,
             COALESCE(ii.commission_pct, 0)                                              AS commission_pct,
             COALESCE(ii.packages,
               CEIL(ii.quantity::numeric / NULLIF(p.qty_per_pack,0)))::int               AS max_qty,
             p.qty_per_pack
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY p.name`, [invoiceId])).rows;
    return res.json(rows);
  }

  if (purchaseId) {
    const rows = (await pool.query(`
      SELECT pi.product_id,
             p.name,
             pi.rate,
             0                                                                            AS commission_pct,
             COALESCE(pi.packages,
               CEIL(pi.quantity::numeric / NULLIF(p.qty_per_pack,0)))::int               AS max_qty,
             p.qty_per_pack
      FROM purchase_items pi
      JOIN products p ON p.id = pi.product_id
      WHERE pi.purchase_id = $1
      ORDER BY p.name`, [purchaseId])).rows;
    return res.json(rows);
  }

  res.json([]);
}));

// ── GET /view/:id ─────────────────────────────────────────────────────────────
router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const note = (await pool.query(`
    SELECT cn.*, COALESCE(c.name,'') AS customer_name, COALESCE(v.name,'') AS vendor_name
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.customer_id
    LEFT JOIN vendors v   ON v.id = cn.vendor_id
    WHERE cn.id=$1`, [id])).rows[0];
  if (!note) return res.redirect('/creditnotes');
  const items = (await pool.query(
    `SELECT cni.*, p.name AS product_name
     FROM credit_note_items cni JOIN products p ON p.id = cni.product_id
     WHERE cni.note_id=$1`, [id])).rows;
  res.render('creditnotes/view', { page:'creditnotes', note, items });
}));

// ── POST /delete/:id ──────────────────────────────────────────────────────────
router.post('/delete/:id', _lockNote, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const note = await db.one(`SELECT * FROM credit_notes WHERE id=$1`, [id]);
    if (!note) return;
    const refType = note.note_type === 'credit' ? 'credit_note' : 'debit_note';
    // No stock to reverse (we never moved stock on create)
    if (note.status === 'applied') {
      const entityType = note.note_type === 'credit' ? 'customer' : 'vendor';
      const entityId   = note.note_type === 'credit' ? note.customer_id : note.vendor_id;
      await removeLedgerForRef(db, entityType, entityId, refType, id);
      await recomputeBalance(db, entityType, entityId);
    }
    await db.run(`DELETE FROM credit_note_items WHERE note_id=$1`, [id]);
    await db.run(`DELETE FROM credit_notes WHERE id=$1`, [id]);
    await addAuditLog('delete', 'credit_notes', id, 'Deleted note');
  });
  res.redirect('/creditnotes');
}));

// ── POST /bulk ────────────────────────────────────────────────────────────────
router.post('/bulk', wrap(async (req, res) => {
  const action = req.body.action || '';
  const ids = (req.body.ids || '').split(',').map(s => toInt(s.trim())).filter(n => n > 0);
  if (!ids.length) return res.redirect('/creditnotes?err=' + encodeURIComponent('No notes selected'));

  if (action === 'delete') {
    // Age-gate each record before bulk delete
    const notes = (await pool.query(
      `SELECT id, note_type, status, customer_id, vendor_id, note_date FROM credit_notes WHERE id=ANY($1::int[])`, [ids])).rows;
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const locked = notes.filter(n => isOlderThan2Years(n.note_date));
    if (locked.length && !isSuperadmin) {
      return res.redirect('/creditnotes?err=' + encodeURIComponent(
        `${locked.length} note(s) are older than 2 years and cannot be deleted`));
    }
    // Log superadmin override for every locked record before proceeding
    for (const n of locked) {
      await addAuditLog('superadmin_override', 'credit_notes', n.id,
        `Superadmin bulk-deleted credit note older than 2 years (note_date: ${n.note_date})`,
        req.user && req.user.id, n, null);
    }
    await tx(async (db) => {
      for (const note of notes) {
        const refType = note.note_type === 'credit' ? 'credit_note' : 'debit_note';
        // No stock reversal needed
        if (note.status === 'applied') {
          const entityType = note.note_type === 'credit' ? 'customer' : 'vendor';
          const entityId   = note.note_type === 'credit' ? note.customer_id : note.vendor_id;
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
