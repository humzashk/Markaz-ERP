'use strict';
const { pool, logError } = require('../database');

// Shared helper: validate qty_per_pack from product master for each line item.
// Returns an error string if any item is blocked, otherwise null.
const _QPP_PCS_UNITS = new Set(['PCS','PIECE','PIECES','EA','EACH','NOS','NO']);
async function _checkQpp(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.product_id) continue;
    const { rows } = await pool.query(`SELECT qty_per_pack, unit FROM products WHERE id=$1`, [it.product_id]);
    if (!rows[0]) continue;
    const qpp  = Number(rows[0].qty_per_pack);
    const unit = (rows[0].unit || '').toUpperCase().trim();
    const isPcs = !unit || _QPP_PCS_UNITS.has(unit);
    if (!qpp || qpp < 1)            return `Line ${i+1}: Invalid Pcs/Ctn for this product. Fix before proceeding.`;
    if (qpp > 500)                  return `Line ${i+1}: Invalid Pcs/Ctn for this product. Fix before proceeding.`;
    if (qpp === 1 && !isPcs)        return `Line ${i+1}: Invalid Pcs/Ctn for this product. Fix before proceeding.`;
  }
  return null;
}

function _num(v) { if (v === null || v === undefined || v === '') return NaN; const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : NaN; }
function _int(v) { const n = _num(v); return Number.isFinite(n) ? Math.trunc(n) : NaN; }
function _date(v){ if (!v) return null; const s = String(v).trim(); if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null; const d = new Date(s.length===10?s+'T00:00:00':s); return isNaN(d.getTime()) ? null : s.substring(0,10); }
function _str(v, max){ if (v==null) return null; const s = String(v).trim(); if (!s) return null; return s.substring(0, max||500); }
function _bool(v){ return (v===true||v==='true'||v==='1'||v===1||v==='on') ? 1 : 0; }

const RULES = {
  posInt:    async (v, o)    => { const n=_int(v); if (!Number.isFinite(n)||n<1)  return { err:'must be ≥ 1' }; if (o&&o.max!=null&&n>o.max) return { err:`must be ≤ ${o.max}` }; return { ok:n }; },
  nonNegInt: async (v, o)    => { const n=_int(v); if (!Number.isFinite(n)||n<0)  return { err:'must be ≥ 0' }; if (o&&o.max!=null&&n>o.max) return { err:`must be ≤ ${o.max}` }; return { ok:n }; },
  nonNegNum: async (v, o)    => { const n=_num(v); if (!Number.isFinite(n)||n<0)  return { err:'must be ≥ 0' }; if (o&&o.max!=null&&n>o.max) return { err:`must be ≤ ${o.max}` }; return { ok:n }; },
  num:       async (v, o)    => { const n=_num(v); if (!Number.isFinite(n)) return { err:'must be a number' }; if (o&&o.min!=null&&n<o.min) return { err:`must be ≥ ${o.min}` }; if (o&&o.max!=null&&n>o.max) return { err:`must be ≤ ${o.max}` }; return { ok:n }; },
  date:      async (v)       => { const d=_date(v); return d ? { ok:d } : { err:'must be a valid date (YYYY-MM-DD)' }; },
  str:       async (v, o)    => { const s=_str(v, (o&&o.max)||500); if (!s) return { err:'is required' }; if (o&&o.min&&s.length<o.min) return { err:`must be ≥ ${o.min} chars` }; return { ok:s }; },
  oneOf:     async (v, o)    => { return ((o&&o.choices)||[]).indexOf(v) !== -1 ? { ok:v } : { err:'has an invalid value' }; },
  bool:      async (v)       => ({ ok: _bool(v) }),
  exists:    async (v, o)    => { const n=_int(v); if (!Number.isFinite(n)||n<1) return { err:'is required' };
                                  try { const r = await pool.query(`SELECT 1 FROM ${o.table} WHERE id=$1`, [n]); if (!r.rowCount) return { err:`references missing ${o.label||o.table}` }; return { ok:n }; }
                                  catch(e){ return { err:'lookup failed: '+e.message }; } },
  existsOpt: async (v, o)    => { if (v===null||v===undefined||v==='') return { ok:null }; return RULES.exists(v, o); }
};

async function applySchema(schema, body) {
  const out = {}, errs = {};
  const required = schema.required || {}, optional = schema.optional || {};
  for (const f of Object.keys(required)) {
    const [rule, opt] = required[f];
    const fn = RULES[rule]; if (!fn) { errs[f] = 'unknown rule '+rule; continue; }
    const r = await fn(body[f], opt || {});
    if (r.err) errs[f] = `'${f}' ${r.err}`; else out[f] = r.ok;
  }
  for (const f of Object.keys(optional)) {
    if (body[f] === undefined || body[f] === null || body[f] === '') { out[f] = null; continue; }
    const [rule, opt] = optional[f];
    const fn = RULES[rule]; if (!fn) { errs[f] = 'unknown rule '+rule; continue; }
    const r = await fn(body[f], opt || {});
    if (r.err) errs[f] = `'${f}' ${r.err}`; else out[f] = r.ok;
  }
  if (typeof schema.validate === 'function') {
    try { const msg = await schema.validate(out, body); if (msg) errs._form = msg; }
    catch(e){ errs._form = e.message; }
  }
  if (schema.items) {
    const cfg = schema.items;
    const ids = Array.isArray(body[cfg.parentField]) ? body[cfg.parentField] : (body[cfg.parentField]!==undefined ? [body[cfg.parentField]] : []);
    const lines = [];
    for (let i = 0; i < ids.length; i++) {
      // Check skipIf on raw body values BEFORE validating — prevents errors on blank rows
      if (cfg.skipIf) {
        const rawLine = {};
        for (const f of Object.keys(cfg.fields)) {
          const arr = Array.isArray(body[f]) ? body[f] : [body[f]];
          rawLine[f] = arr[i];
        }
        if (cfg.skipIf(rawLine)) continue;
      }
      const line = {}; let bad = false;
      for (const f of Object.keys(cfg.fields)) {
        const [rule, opt] = cfg.fields[f];
        const arr = Array.isArray(body[f]) ? body[f] : [body[f]];
        const v = arr[i];
        if ((v===undefined||v===null||v==='') && (cfg.optional||[]).includes(f)) { line[f] = null; continue; }
        const r = await RULES[rule](v, opt||{});
        if (r.err) { errs[`item_${i}_${f}`] = `Line ${i+1} '${f}' ${r.err}`; bad = true; }
        else line[f] = r.ok;
      }
      if (!bad) lines.push(line);
    }
    if (cfg.minRequired && lines.length < cfg.minRequired) errs._items = `At least ${cfg.minRequired} valid line item required`;
    out._items = lines;
  }
  return { values: out, errors: errs };
}

function validate(schema) {
  return async function (req, res, next) {
    try {
      const { values, errors } = await applySchema(schema, req.body || {});
      if (Object.keys(errors).length) {
        try { logError('validation.'+(req.path||''), new Error(JSON.stringify(errors)), { body: req.body }); } catch(_){}
        const summary = Object.values(errors).filter(Boolean).join(' | ');
        const wantsJson = (req.headers.accept||'').includes('application/json') || req.xhr;
        if (wantsJson) return res.status(400).json({ success:false, error:summary, fields:errors });
        const back = req.get('Referer') || (req.baseUrl+'/add');
        const sep = back.includes('?') ? '&' : '?';
        return res.redirect(back + sep + 'err=' + encodeURIComponent(summary).slice(0, 800));
      }
      req.valid = values; next();
    } catch (e) { next(e); }
  };
}

// Idempotency
const _seen = new Map();
const W = 8000;
function _hash(s){ let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h) ^ s.charCodeAt(i); return h>>>0; }
function preventDoubleSubmit(req, res, next) {
  if ((req.method||'').toUpperCase() !== 'POST') return next();
  const key = (req.session&&req.session.id) || (req.user&&req.user.id) || (req.ip||'anon');
  const fp = (req.originalUrl||'') + '|' + _hash(JSON.stringify(req.body||{}));
  const now = Date.now();
  let bag = _seen.get(key); if (!bag) { bag = new Map(); _seen.set(key, bag); }
  for (const [k,t] of bag) if (now-t > W) bag.delete(k);
  if (bag.has(fp)) {
    const wantsJson = (req.headers.accept||'').includes('application/json') || req.xhr;
    if (wantsJson) return res.status(409).json({ success:false, error:'Duplicate submission ignored' });
    return res.redirect(req.get('Referer') || '/');
  }
  bag.set(fp, now); next();
}

const schemas = {
  invoiceCreate: {
    required: {
      customer_id:  ['exists', { table:'customers', label:'customer' }],
      warehouse_id: ['exists', { table:'warehouses', label:'warehouse' }],
      invoice_date: ['date'],
      due_date:     ['date'],
    },
    optional: {
      delivery_date:    ['date'],
      bilty_no:         ['str', { max:50 }],
      transport_id:     ['existsOpt', { table:'transports', label:'transport' }],
      transporter_name: ['str', { max:100 }],
      notes:            ['str', { max:1000 }],
      transport_charges:['num', { min:-1e9, max:1e9 }],
      account_scope:    ['oneOf', { choices:['plastic_markaz','wings_furniture','cooler'] }],
    },
    items: {
      parentField:'product_id', optional:['packages','packaging','commission_pct','discount_per_pack'],
      skipIf: l => !l.product_id, minRequired: 1,
      fields: {
        product_id:        ['exists', { table:'products', label:'product' }],
        quantity:          ['posInt', { max:1e7 }],
        rate:              ['nonNegNum', { max:1e9 }],
        packages:          ['nonNegInt', { max:1e7 }],
        packaging:         ['posInt', { max:1e6 }],
        commission_pct:    ['num', { min:0, max:50 }],
        discount_per_pack: ['nonNegNum', { max:1e9 }]
      }
    },
    validate: async (v) => {
      if (v.invoice_date && v.due_date && v.due_date < v.invoice_date) return 'Due date cannot be before invoice date';
      if (v.invoice_date && v.delivery_date && v.delivery_date < v.invoice_date) return 'Delivery date cannot be before invoice date';
      if (v.bilty_no && !v.transport_id) return 'Transport is required when Bilty # is filled';
      const items = v._items || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const pkg = Number(it.packages || 0);
        const pkging = Number(it.packaging || 1);
        const qty = Number(it.quantity || 0);
        if (pkging < 1) return `Line ${i+1}: Pcs/Ctn must be ≥ 1`;
        if (pkg > 0 && pkging > 0 && qty > 0 && pkg * pkging !== qty)
          return `Line ${i+1}: ${pkg} CTN × ${pkging} Pcs/Ctn = ${pkg*pkging} but Quantity entered is ${qty} — they must match`;
      }
      return _checkQpp(items);
    }
  },
  orderCreate: {
    required: {
      customer_id:  ['exists', { table:'customers', label:'customer' }],
      warehouse_id: ['exists', { table:'warehouses', label:'warehouse' }],
      order_date:   ['date'],
    },
    optional: {
      delivery_date: ['date'], bilty_no: ['str', { max:50 }],
      transport_id:  ['existsOpt', { table:'transports', label:'transport' }],
      notes: ['str', { max:1000 }],
      account_scope:['oneOf', { choices:['plastic_markaz','wings_furniture','cooler'] }]
    },
    items: {
      parentField:'product_id', optional:['packages','packaging','commission_pct'],
      skipIf: l => !l.product_id, minRequired: 1,
      fields: {
        product_id: ['exists', { table:'products', label:'product' }],
        quantity:   ['posInt', { max:1e7 }],
        rate:       ['nonNegNum', { max:1e9 }],
        packages:   ['nonNegInt', { max:1e7 }],
        packaging:  ['posInt', { max:1e6 }],
        commission_pct:['num', { min:0, max:50 }]
      }
    },
    validate: async (v) => {
      if (v.order_date && v.delivery_date && v.delivery_date < v.order_date) return 'Delivery date cannot be before order date';
      if (v.bilty_no && !v.transport_id) return 'Transport is required when Bilty # is filled';
      const items = v._items || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const pkg = Number(it.packages || 0);
        const pkging = Number(it.packaging || 1);
        const qty = Number(it.quantity || 0);
        if (pkging < 1) return `Line ${i+1}: Pcs/Ctn must be ≥ 1`;
        if (pkg > 0 && pkging > 0 && qty > 0 && pkg * pkging !== qty)
          return `Line ${i+1}: ${pkg} CTN × ${pkging} Pcs/Ctn = ${pkg*pkging} but Quantity entered is ${qty} — they must match`;
      }
      return _checkQpp(items);
    }
  },
  purchaseCreate: {
    required: {
      vendor_id:    ['exists', { table:'vendors', label:'vendor' }],
      warehouse_id: ['exists', { table:'warehouses', label:'warehouse' }],
      purchase_date:['date'],
    },
    optional: {
      delivery_date:['date'], bilty_no:['str', { max:50 }],
      transport_id: ['existsOpt', { table:'transports', label:'transport' }],
      discount: ['nonNegNum', { max:1e9 }],
      delivery_charges:['nonNegNum', { max:1e9 }],
      notes:['str', { max:1000 }],
      account_scope:['oneOf', { choices:['plastic_markaz','wings_furniture','cooler'] }],
    },
    items: {
      parentField:'product_id', optional:['packages','packaging'],
      skipIf: l=>!l.product_id, minRequired:1,
      fields: {
        product_id:['exists', { table:'products', label:'product' }],
        quantity:['posInt', { max:1e7 }],
        rate:['nonNegNum', { max:1e9 }],
        packages:['nonNegInt', { max:1e7 }],
        packaging:['posInt', { max:1e6 }]
      }
    },
    validate: async (v) => {
      const items = v._items || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const pkg = Number(it.packages || 0);
        const pkging = Number(it.packaging || 1);
        const qty = Number(it.quantity || 0);
        if (pkging < 1) return `Line ${i+1}: Pcs/Ctn must be ≥ 1`;
        if (pkg > 0 && pkging > 0 && qty > 0 && pkg * pkging !== qty)
          return `Line ${i+1}: ${pkg} CTN × ${pkging} Pcs/Ctn = ${pkg*pkging} but Quantity entered is ${qty} — they must match`;
      }
      return _checkQpp(items);
    }
  },
  paymentCreate: {
    required: {
      entity_type:   ['oneOf', { choices:['customer','vendor'] }],
      entity_id:     ['posInt'],
      amount:        ['nonNegNum', { max:1e9 }],
      payment_date:  ['date'],
      payment_method:['oneOf', { choices:['cash','cheque','bank_transfer','adjustment'] }]
    },
    optional: { reference:['str',{max:100}], notes:['str',{max:1000}] },
    validate: async (v) => {
      if (v.amount <= 0) return 'Payment amount must be greater than 0';
      const tbl = v.entity_type === 'customer' ? 'customers' : 'vendors';
      const r = await pool.query(`SELECT 1 FROM ${tbl} WHERE id=$1`, [v.entity_id]);
      if (!r.rowCount) return `Selected ${v.entity_type} no longer exists`;
    }
  },
  creditNoteCreate: {
    required: { note_type:['oneOf', { choices:['credit','debit'] }], note_date:['date'] },
    optional: {
      customer_id:['existsOpt', { table:'customers', label:'customer' }],
      vendor_id:  ['existsOpt', { table:'vendors',   label:'vendor' }],
      invoice_id: ['existsOpt', { table:'invoices',  label:'invoice' }],
      purchase_id:['existsOpt', { table:'purchases', label:'purchase' }],
      reason:['str', { max:500 }], notes:['str', { max:1000 }]
    },
    items: {
      parentField:'product_id', skipIf: l=>!l.product_id, minRequired:1,
      fields: {
        product_id:['exists', { table:'products', label:'product' }],
        quantity:['posInt', { max:1e7 }], rate:['nonNegNum', { max:1e9 }]
      }
    },
    validate: async (v, body) => {
      if (v.note_type==='credit' && (!v.customer_id || !v.invoice_id))  return 'Credit note requires customer + invoice';
      if (v.note_type==='debit'  && (!v.vendor_id   || !v.purchase_id)) return 'Debit note requires vendor + purchase';

      // Enforce invoice belongs to customer
      if (v.note_type==='credit' && v.invoice_id && v.customer_id) {
        const r = await pool.query(`SELECT customer_id FROM invoices WHERE id=$1`, [v.invoice_id]);
        if (!r.rows[0] || String(r.rows[0].customer_id) !== String(v.customer_id))
          return 'The selected invoice does not belong to this customer';
      }
      // Enforce purchase belongs to vendor
      if (v.note_type==='debit' && v.purchase_id && v.vendor_id) {
        const r = await pool.query(`SELECT vendor_id FROM purchases WHERE id=$1`, [v.purchase_id]);
        if (!r.rows[0] || String(r.rows[0].vendor_id) !== String(v.vendor_id))
          return 'The selected purchase does not belong to this vendor';
      }

      // Enforce line item quantities don't exceed original document quantities
      if (v._items && v._items.length) {
        for (const item of v._items) {
          if (!item.product_id || !item.quantity) continue;
          if (v.note_type === 'credit' && v.invoice_id) {
            const r = await pool.query(
              `SELECT quantity FROM invoice_items WHERE invoice_id=$1 AND product_id=$2`,
              [v.invoice_id, item.product_id]);
            if (!r.rows[0]) return `Product not found on selected invoice`;
            if (item.quantity > Number(r.rows[0].quantity))
              return `Return quantity (${item.quantity}) exceeds invoice quantity (${r.rows[0].quantity}) for one or more items`;
          }
          if (v.note_type === 'debit' && v.purchase_id) {
            const r = await pool.query(
              `SELECT quantity FROM purchase_items WHERE purchase_id=$1 AND product_id=$2`,
              [v.purchase_id, item.product_id]);
            if (!r.rows[0]) return `Product not found on selected purchase`;
            if (item.quantity > Number(r.rows[0].quantity))
              return `Return quantity (${item.quantity}) exceeds purchase quantity (${r.rows[0].quantity}) for one or more items`;
          }
        }

        // Ensure at least one item has qty > 0
        const hasQty = v._items.some(i => (i.quantity || 0) > 0);
        if (!hasQty) return 'At least one item must have a return quantity greater than 0';
      }
    }
  },
  productCreate: {
    required: { name:['str', { max:100, min:1 }] },
    optional: {
      category:['str',{max:50}], unit:['str',{max:20}],
      qty_per_pack:['posInt',{max:1e6}],
      cost_price:['nonNegNum',{max:1e9}],
      selling_price:['nonNegNum',{max:1e9}],
      default_commission_rate:['num',{min:0,max:50}],
      stock:['num',{min:-1e9,max:1e9}],
      min_stock:['nonNegInt',{max:1e9}],
      status:['oneOf',{choices:['active','inactive']}],
      item_id:['str',{max:50}]
    },
    validate: (v) => {
      if (v.qty_per_pack != null && v.qty_per_pack < 1)
        return 'Pcs/Ctn (qty_per_pack) must be ≥ 1. Cannot save product with zero or missing Pcs/Ctn.';
    }
  },
  customerCreate: {
    required: { name:['str',{max:100, min:1}] },
    optional: {
      phone:['str',{max:30}], email:['str',{max:100}], address:['str',{max:500}],
      city:['str',{max:50}], category:['str',{max:50}], region:['str',{max:50}],
      ntn:['str',{max:30}], credit_days:['nonNegInt',{max:365}],
      opening_balance:['num',{min:-1e9,max:1e9}],
      default_commission_rate:['num',{min:0,max:50}],
      account_scope:['oneOf',{choices:['plastic_markaz','wings_furniture','cooler']}],
      status:['oneOf',{choices:['active','inactive']}], notes:['str',{max:1000}]
    }
  },
  vendorCreate: {
    required: { name:['str',{max:100, min:1}] },
    optional: {
      phone:['str',{max:30}], email:['str',{max:100}], address:['str',{max:500}],
      city:['str',{max:50}], category:['str',{max:50}], region:['str',{max:50}],
      ntn:['str',{max:30}], credit_days:['nonNegInt',{max:365}],
      opening_balance:['num',{min:-1e9,max:1e9}],
      account_scope:['oneOf',{choices:['plastic_markaz','wings_furniture','cooler']}],
      status:['oneOf',{choices:['active','inactive']}], notes:['str',{max:1000}]
    }
  },
  warehouseCreate: {
    required: { name:['str',{max:100, min:1}] },
    optional: { location:['str',{max:200}], address:['str',{max:500}], city:['str',{max:50}], manager:['str',{max:100}], phone:['str',{max:30}], status:['oneOf',{choices:['active','inactive']}] }
  },
  transportCreate: {
    required: { name:['str',{max:100, min:1}] },
    optional: { contact:['str',{max:100}], phone:['str',{max:30}], city:['str',{max:50}], vehicle_no:['str',{max:30}], driver_name:['str',{max:100}], status:['oneOf',{choices:['active','inactive']}] }
  },
  rateListCreate: {
    required: {
      product_id:['exists',{ table:'products', label:'product' }],
      customer_type:['str',{max:50}],
      rate:['nonNegNum',{max:1e9}],
      effective_date:['date']
    }
  },
  expenseCreate: {
    required: { expense_date:['date'], amount:['nonNegNum',{max:1e9}], category:['str',{max:100}] },
    optional: {
      description:['str',{max:500}],
      payment_method:['oneOf',{choices:['cash','cheque','bank_transfer','adjustment']}],
      account_scope:['oneOf',{choices:['plastic_markaz','wings_furniture','cooler']}]
    },
    validate:(v)=>{ if (v.amount <= 0) return 'Amount must be > 0'; }
  },
  biltyCreate: {
    required: { bilty_no:['str',{max:50}], bilty_date:['date'], from_city:['str',{max:50}], to_city:['str',{max:50}] },
    optional: {
      order_id:['existsOpt',{ table:'orders', label:'order' }],
      invoice_id:['existsOpt',{ table:'invoices', label:'invoice' }],
      transport_id:['existsOpt',{ table:'transports', label:'transport' }],
      transport_name:['str',{max:100}],
      freight_charges:['nonNegNum',{max:1e9}],
      weight:['str',{max:30}], packages_count:['nonNegInt',{max:1e9}],
      account_scope:['oneOf',{choices:['plastic_markaz','wings_furniture','cooler']}],
      notes:['str',{max:1000}]
    },
    validate: async (v) => {
      if (!v.order_id && !v.invoice_id) return 'Link bilty to an order or invoice';
      if (!v.transport_id && !v.transport_name) return 'Select an existing transport or enter a transport name';
      if (v.order_id) {
        const r = await pool.query(`SELECT bilty_no FROM orders WHERE id=$1`, [v.order_id]);
        const ob = r.rows[0] && r.rows[0].bilty_no;
        if (!ob) return 'Linked order has no bilty # — set bilty # on the order first';
        if (String(ob).trim() !== v.bilty_no) return `Bilty # must match the linked order (${ob})`;
      } else if (v.invoice_id) {
        const r = await pool.query(`SELECT bilty_no FROM invoices WHERE id=$1`, [v.invoice_id]);
        const ib = r.rows[0] && r.rows[0].bilty_no;
        if (!ib) return 'Linked invoice has no bilty # — set bilty # on the invoice first';
        if (String(ib).trim() !== v.bilty_no) return `Bilty # must match the linked invoice (${ib})`;
      }
    }
  },
  userCreate: {
    required: { username:['str',{min:3, max:64}], role:['oneOf',{choices:['superadmin','admin','employee']}] },
    optional: { name:['str',{max:100}], email:['str',{max:100}], password:['str',{min:6, max:200}], status:['oneOf',{choices:['active','inactive']}] }
  },
  breakageCreate: {
    required: { product_id:['exists',{table:'products', label:'product'}], quantity:['posInt',{max:1e7}], breakage_date:['date'] },
    optional: { customer_id:['existsOpt',{table:'customers', label:'customer'}], vendor_id:['existsOpt',{table:'vendors', label:'vendor'}], notes:['str',{max:1000}] }
  },
  stockAdjust: {
    required: {
      product_id:['exists',{table:'products', label:'product'}],
      adjustment_type:['oneOf',{choices:['add','reduce','damage','return','transfer_in','transfer_out']}],
      quantity:['posInt',{max:1e7}], adj_date:['date']
    },
    optional: { warehouse_id:['existsOpt',{table:'warehouses', label:'warehouse'}], reason:['str',{max:500}], reference:['str',{max:100}], notes:['str',{max:1000}] }
  }
};

module.exports = { validate, schemas, RULES, preventDoubleSubmit };
