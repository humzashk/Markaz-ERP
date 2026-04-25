// middleware/validate.js
// Declarative request validation middleware for Express.
//
// Usage:
//   const { validate, schemas } = require('./middleware/validate');
//   router.post('/add', validate(schemas.invoiceCreate), handler);
//
// On failure: renders the previous page with a flash error (HTML), or
// returns { success:false, error, fields } JSON if `Accept: application/json`.
// On success: req.valid is populated with strictly-typed/sanitized values.
'use strict';

const path = require('path');
const { logError } = require(path.join('..', 'database'));

// ---------- atomic coercers/validators ----------
function _num(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}
function _int(v) {
  const n = _num(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}
function _date(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return null;
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  return isNaN(d.getTime()) ? null : s.substring(0, 10);
}
function _str(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.substring(0, max || 500);
}
function _bool(v) {
  if (v === true || v === 'true' || v === '1' || v === 1 || v === 'on') return 1;
  return 0;
}

// ---------- rule registry ----------
const RULES = {
  posInt: (v, opt) => {
    const n = _int(v);
    if (!Number.isFinite(n) || n < 1) return { err: 'must be an integer ≥ 1' };
    if (opt && opt.max != null && n > opt.max) return { err: `must be ≤ ${opt.max}` };
    return { ok: n };
  },
  nonNegInt: (v, opt) => {
    const n = _int(v);
    if (!Number.isFinite(n) || n < 0) return { err: 'must be an integer ≥ 0' };
    if (opt && opt.max != null && n > opt.max) return { err: `must be ≤ ${opt.max}` };
    return { ok: n };
  },
  nonNegNum: (v, opt) => {
    const n = _num(v);
    if (!Number.isFinite(n) || n < 0) return { err: 'must be a number ≥ 0' };
    if (opt && opt.max != null && n > opt.max) return { err: `must be ≤ ${opt.max}` };
    return { ok: n };
  },
  num: (v, opt) => {
    const n = _num(v);
    if (!Number.isFinite(n)) return { err: 'must be a valid number' };
    if (opt && opt.min != null && n < opt.min) return { err: `must be ≥ ${opt.min}` };
    if (opt && opt.max != null && n > opt.max) return { err: `must be ≤ ${opt.max}` };
    return { ok: n };
  },
  date: (v) => {
    const d = _date(v);
    return d ? { ok: d } : { err: 'must be a valid date (YYYY-MM-DD)' };
  },
  str: (v, opt) => {
    const s = _str(v, (opt && opt.max) || 500);
    if (!s) return { err: 'is required' };
    if (opt && opt.min && s.length < opt.min) return { err: `must be at least ${opt.min} chars` };
    return { ok: s };
  },
  oneOf: (v, opt) => {
    const choices = (opt && opt.choices) || [];
    return choices.indexOf(v) !== -1 ? { ok: v } : { err: 'has an invalid value' };
  },
  bool: (v) => ({ ok: _bool(v) }),
  // Foreign-key existence check (synchronous, uses db). opt.table required.
  exists: (v, opt, ctx) => {
    const n = _int(v);
    if (!Number.isFinite(n) || n < 1) return { err: 'is required' };
    try {
      const row = ctx.db.prepare(`SELECT 1 AS x FROM ${opt.table} WHERE id = ? LIMIT 1`).get(n);
      if (!row) return { err: `references a missing ${opt.label || opt.table} record` };
      return { ok: n };
    } catch (e) {
      return { err: `validation lookup failed: ${e.message}` };
    }
  },
  // Optional FK: empty/null permitted
  existsOpt: (v, opt, ctx) => {
    if (v === null || v === undefined || v === '') return { ok: null };
    return RULES.exists(v, opt, ctx);
  },
};

// ---------- schema runner ----------
function applySchema(schema, body, ctx) {
  const out = {};
  const errs = {};
  const required = schema.required || {};
  const optional = schema.optional || {};

  for (const f of Object.keys(required)) {
    const [rule, opt] = required[f];
    const fn = RULES[rule];
    if (!fn) { errs[f] = 'unknown rule ' + rule; continue; }
    const r = fn(body[f], opt || {}, ctx);
    if (r.err) errs[f] = `'${f}' ${r.err}`;
    else out[f] = r.ok;
  }
  for (const f of Object.keys(optional)) {
    if (body[f] === undefined || body[f] === null || body[f] === '') { out[f] = null; continue; }
    const [rule, opt] = optional[f];
    const fn = RULES[rule];
    if (!fn) { errs[f] = 'unknown rule ' + rule; continue; }
    const r = fn(body[f], opt || {}, ctx);
    if (r.err) errs[f] = `'${f}' ${r.err}`;
    else out[f] = r.ok;
  }

  // Optional cross-field business validation
  if (typeof schema.validate === 'function') {
    try {
      const msg = schema.validate(out, body, ctx);
      if (msg) errs._form = msg;
    } catch (e) { errs._form = e.message; }
  }

  // Line-items array support: schema.items = { fields: {...}, required:true, min:1 }
  if (schema.items) {
    const cfg = schema.items;
    const ids = Array.isArray(body[cfg.parentField]) ? body[cfg.parentField] : (body[cfg.parentField] !== undefined ? [body[cfg.parentField]] : []);
    const lines = [];
    for (let i = 0; i < ids.length; i++) {
      const line = {};
      let lineHasError = false;
      for (const f of Object.keys(cfg.fields)) {
        const [rule, opt] = cfg.fields[f];
        const arr = Array.isArray(body[f]) ? body[f] : [body[f]];
        const v = arr[i];
        if ((v === undefined || v === null || v === '') && (cfg.optional || []).includes(f)) {
          line[f] = null; continue;
        }
        const fn = RULES[rule];
        const r = fn(v, opt || {}, ctx);
        if (r.err) { errs[`item_${i}_${f}`] = `Line ${i+1} '${f}' ${r.err}`; lineHasError = true; }
        else line[f] = r.ok;
      }
      // Skip blank lines (no product selected) silently
      if (cfg.skipIf && cfg.skipIf(line)) continue;
      if (!lineHasError) lines.push(line);
    }
    if (cfg.minRequired && lines.length < cfg.minRequired) {
      errs._items = `At least ${cfg.minRequired} valid line item required`;
    }
    out._items = lines;
  }

  return { values: out, errors: errs };
}

// ---------- middleware factory ----------
function validate(schema) {
  return function (req, res, next) {
    let db;
    try { db = require(path.join('..', 'database')).db; } catch (_) {}
    const { values, errors } = applySchema(schema, req.body || {}, { db, req });

    if (Object.keys(errors).length) {
      try { logError('validation.' + (req.path || ''), new Error('Validation failed: ' + JSON.stringify(errors)), { body: req.body }); } catch (_) {}
      const summary = Object.values(errors).filter(Boolean).join(' | ');
      const wantsJson = (req.headers.accept || '').includes('application/json') || req.xhr;
      if (wantsJson) {
        return res.status(400).json({ success: false, error: summary, fields: errors });
      }
      // Redirect back with error query param (forms read this and display)
      const back = req.get('Referer') || (req.baseUrl + '/add');
      const sep = back.includes('?') ? '&' : '?';
      return res.redirect(back + sep + 'err=' + encodeURIComponent(summary).slice(0, 800));
    }

    req.valid = values;
    next();
  };
}

// ---------- per-module schemas ----------
const schemas = {
  // --------- INVOICES ---------
  invoiceCreate: {
    required: {
      customer_id:  ['exists', { table: 'customers', label: 'customer' }],
      invoice_date: ['date'],
    },
    optional: {
      due_date:          ['date'],
      delivery_date:     ['date'],
      warehouse_id:      ['existsOpt', { table: 'warehouses', label: 'warehouse' }],
      bilty_no:          ['str', { max: 50 }],
      transporter_name:  ['str', { max: 100 }],
      notes:             ['str', { max: 1000 }],
      transport_charges: ['num', { min: -1e9, max: 1e9 }],
      delivery_charges:  ['nonNegNum', { max: 1e9 }],
      account_scope:     ['oneOf', { choices: ['plastic_markaz','wings_furniture','cooler'] }],
    },
    items: {
      parentField: 'product_id',
      optional: ['packages','packaging','commission_pct','discount_per_pack'],
      skipIf: (l) => !l.product_id,
      minRequired: 1,
      fields: {
        product_id:        ['exists', { table: 'products', label: 'product' }],
        quantity:          ['posInt', { max: 10000000 }],
        rate:              ['nonNegNum', { max: 1e9 }],
        packages:          ['nonNegInt', { max: 10000000 }],
        packaging:         ['posInt', { max: 1000000 }],
        commission_pct:    ['num', { min: 0, max: 50 }],
        discount_per_pack: ['nonNegNum', { max: 1e9 }],
      }
    },
    validate: (v) => {
      if (v.invoice_date && v.due_date && v.due_date < v.invoice_date) return 'Due date cannot be before invoice date';
      if (v.invoice_date && v.delivery_date && v.delivery_date < v.invoice_date) return 'Delivery date cannot be before invoice date';
      // Per-line: discount per pack must not exceed gross-per-pack (rate * packaging)
      for (const it of (v._items || [])) {
        if (it.discount_per_pack && it.rate && it.packaging && it.discount_per_pack > it.rate * it.packaging) {
          return 'A line discount-per-pack exceeds its rate × packaging';
        }
      }
    }
  },

  // --------- ORDERS ---------
  orderCreate: {
    required: {
      customer_id: ['exists', { table: 'customers', label: 'customer' }],
      order_date:  ['date'],
    },
    optional: {
      delivery_date: ['date'],
      warehouse_id:  ['existsOpt', { table: 'warehouses', label: 'warehouse' }],
      notes:         ['str', { max: 1000 }],
      account_scope: ['oneOf', { choices: ['plastic_markaz','wings_furniture','cooler'] }],
    },
    items: {
      parentField: 'product_id',
      optional: ['packages','packaging','commission_pct','discount_per_pack'],
      skipIf: (l) => !l.product_id,
      minRequired: 1,
      fields: {
        product_id:        ['exists', { table: 'products', label: 'product' }],
        quantity:          ['posInt', { max: 10000000 }],
        rate:              ['nonNegNum', { max: 1e9 }],
        packages:          ['nonNegInt', { max: 10000000 }],
        packaging:         ['posInt', { max: 1000000 }],
        commission_pct:    ['num', { min: 0, max: 50 }],
        discount_per_pack: ['nonNegNum', { max: 1e9 }],
      }
    },
    validate: (v) => {
      if (v.order_date && v.delivery_date && v.delivery_date < v.order_date) return 'Delivery date cannot be before order date';
    }
  },

  // --------- PURCHASES ---------
  purchaseCreate: {
    required: {
      vendor_id:     ['exists', { table: 'vendors', label: 'vendor' }],
      purchase_date: ['date'],
    },
    optional: {
      delivery_date:    ['date'],
      warehouse_id:     ['existsOpt', { table: 'warehouses', label: 'warehouse' }],
      bilty_no:         ['str', { max: 50 }],
      discount:         ['nonNegNum', { max: 1e9 }],
      delivery_charges: ['nonNegNum', { max: 1e9 }],
      notes:            ['str', { max: 1000 }],
      account_scope:    ['oneOf', { choices: ['plastic_markaz','wings_furniture','cooler'] }],
    },
    items: {
      parentField: 'product_id',
      optional: ['packages','packaging','discount_per_pack'],
      skipIf: (l) => !l.product_id,
      minRequired: 1,
      fields: {
        product_id:        ['exists', { table: 'products', label: 'product' }],
        quantity:          ['posInt', { max: 10000000 }],
        rate:              ['nonNegNum', { max: 1e9 }],
        packages:          ['nonNegInt', { max: 10000000 }],
        packaging:         ['posInt', { max: 1000000 }],
        discount_per_pack: ['nonNegNum', { max: 1e9 }],
      }
    },
  },

  // --------- STOCK ADJUSTMENTS ---------
  stockAdjust: {
    required: {
      product_id:      ['exists', { table: 'products', label: 'product' }],
      adjustment_type: ['oneOf', { choices: ['add','remove','damage','return','transfer_in','transfer_out'] }],
      quantity:        ['posInt', { max: 10000000 }],
      adj_date:        ['date'],
    },
    optional: {
      warehouse_id: ['existsOpt', { table: 'warehouses', label: 'warehouse' }],
      reason:       ['str', { max: 500 }],
      reference:    ['str', { max: 100 }],
      notes:        ['str', { max: 1000 }],
    }
  },

  // --------- PAYMENTS ---------
  paymentCreate: {
    required: {
      entity_type:  ['oneOf', { choices: ['customer','vendor'] }],
      entity_id:    ['posInt'],
      payment_date: ['date'],
      amount:       ['nonNegNum', { max: 1e9 }],
      payment_method: ['oneOf', { choices: ['cash','bank','cheque','online','adjustment'] }],
    },
    optional: {
      bank_account_id: ['existsOpt', { table: 'bank_accounts', label: 'bank account' }],
      reference:    ['str', { max: 100 }],
      notes:        ['str', { max: 1000 }],
    },
    validate: (v, body, ctx) => {
      if (v.amount <= 0) return 'Payment amount must be greater than 0';
      const tbl = v.entity_type === 'customer' ? 'customers' : 'vendors';
      try {
        const row = ctx.db.prepare(`SELECT 1 FROM ${tbl} WHERE id = ?`).get(v.entity_id);
        if (!row) return `Selected ${v.entity_type} no longer exists`;
      } catch(_) {}
    }
  },

  // --------- PRODUCTS ---------
  productCreate: {
    required: {
      name: ['str', { max: 100, min: 1 }],
    },
    optional: {
      category:        ['str', { max: 50 }],
      unit:            ['str', { max: 20 }],
      qty_per_pack:    ['posInt', { max: 1000000 }],
      purchase_price:  ['nonNegNum', { max: 1e9 }],
      selling_price:   ['nonNegNum', { max: 1e9 }],
      rate:            ['nonNegNum', { max: 1e9 }],
      default_commission_rate: ['num', { min: 0, max: 50 }],
      stock:           ['num', { min: -1e9, max: 1e9 }],
      min_stock:       ['nonNegInt', { max: 1e9 }],
      status:          ['oneOf', { choices: ['active','inactive'] }],
    }
  },

  // --------- USERS ---------
  userCreate: {
    required: {
      username: ['str', { max: 64, min: 3 }],
      role:     ['oneOf', { choices: ['superadmin','admin','employee'] }],
    },
    optional: {
      name:   ['str', { max: 100 }],
      email:  ['str', { max: 100 }],
      password: ['str', { max: 200, min: 6 }],
      status: ['oneOf', { choices: ['active','inactive'] }],
    }
  },

  // --------- BILTY ---------
  biltyCreate: {
    required: {
      bilty_no:    ['str', { max: 50 }],
      bilty_date:  ['date'],
      from_city:   ['str', { max: 50 }],
      to_city:     ['str', { max: 50 }],
    },
    optional: {
      order_id:        ['existsOpt', { table: 'orders', label: 'order' }],
      invoice_id:      ['existsOpt', { table: 'invoices', label: 'invoice' }],
      transport_id:    ['existsOpt', { table: 'transports', label: 'transport' }],
      transport_name:  ['str', { max: 100 }],
      freight_charges: ['nonNegNum', { max: 1e9 }],
      weight:          ['str', { max: 30 }],
      packages_count:  ['nonNegInt', { max: 1e9 }],
      account_scope:   ['oneOf', { choices: ['plastic_markaz','wings_furniture','cooler'] }],
      notes:           ['str', { max: 1000 }],
    },
    validate: (v) => {
      // Bilty must link to an order OR invoice (required for traceability)
      if (!v.order_id && !v.invoice_id) return 'Link bilty to either an order or invoice';
      // Either transport_id or transport_name is needed
      if (!v.transport_id && !v.transport_name) return 'Select an existing transport or enter a transport name';
    }
  },

  // --------- RATE LIST ---------
  rateListCreate: {
    required: {
      product_id:    ['exists', { table: 'products', label: 'product' }],
      customer_type: ['str', { max: 50 }],
      rate:          ['nonNegNum', { max: 1e9 }],
      effective_date:['date'],
    }
  },

  // --------- CUSTOMERS / VENDORS ---------
  customerCreate: {
    required: { name: ['str', { max: 100, min: 1 }] },
    optional: {
      phone:   ['str', { max: 30 }],
      email:   ['str', { max: 100 }],
      address: ['str', { max: 500 }],
      city:    ['str', { max: 50 }],
      opening_balance: ['num', { min: -1e9, max: 1e9 }],
      status:  ['oneOf', { choices: ['active','inactive'] }],
      default_commission_rate: ['num', { min: 0, max: 50 }],
    }
  },
  bankCreate: {
    required: { name: ['str', { max: 100, min: 1 }] },
    optional: {
      account_no: ['str', { max: 50 }], bank_name: ['str', { max: 100 }],
      branch: ['str', { max: 100 }], iban: ['str', { max: 50 }],
      opening_balance: ['num', { min: -1e9, max: 1e9 }],
      status: ['oneOf', { choices: ['active','inactive'] }],
    }
  },
  warehouseCreate: {
    required: { name: ['str', { max: 100, min: 1 }] },
    optional: {
      address: ['str', { max: 500 }], city: ['str', { max: 50 }],
      floor: ['str', { max: 50 }], room: ['str', { max: 50 }],
      rack: ['str', { max: 50 }],  lot: ['str', { max: 50 }],
      status: ['oneOf', { choices: ['active','inactive'] }],
    }
  },
  categoryCreate: {
    required: { name: ['str', { max: 100, min: 1 }] },
    optional: { description: ['str', { max: 500 }] }
  },
  expenseCreate: {
    required: {
      expense_date: ['date'],
      amount:       ['nonNegNum', { max: 1e9 }],
      category:     ['str', { max: 100 }],
    },
    optional: {
      description: ['str', { max: 500 }],
      payment_method: ['oneOf', { choices: ['cash','bank','cheque','online'] }],
      bank_account_id: ['existsOpt', { table: 'bank_accounts', label: 'bank account' }],
      account_scope: ['oneOf', { choices: ['plastic_markaz','wings_furniture','cooler'] }],
    },
    validate: (v) => { if (v.amount <= 0) return 'Amount must be greater than 0'; }
  },
  creditNoteCreate: {
    required: {
      note_type: ['oneOf', { choices: ['credit','debit'] }],
      note_date: ['date'],
    },
    optional: {
      customer_id: ['existsOpt', { table: 'customers', label: 'customer' }],
      vendor_id:   ['existsOpt', { table: 'vendors',   label: 'vendor' }],
      invoice_id:  ['existsOpt', { table: 'invoices',  label: 'invoice' }],
      purchase_id: ['existsOpt', { table: 'purchases', label: 'purchase' }],
      reason: ['str', { max: 500 }], notes: ['str', { max: 1000 }],
    },
    items: {
      parentField: 'product_id',
      skipIf: (l) => !l.product_id,
      minRequired: 1,
      fields: {
        product_id: ['exists', { table: 'products', label: 'product' }],
        quantity:   ['posInt', { max: 10000000 }],
        rate:       ['nonNegNum', { max: 1e9 }],
      }
    },
    validate: (v) => {
      if (v.note_type === 'credit' && !v.customer_id) return 'Credit note requires a customer';
      if (v.note_type === 'debit'  && !v.vendor_id)   return 'Debit note requires a vendor';
    }
  },
  journalCreate: {
    required: { entry_date: ['date'], description: ['str', { max: 500 }] },
  },
  breakageCreate: {
    required: {
      product_id:    ['exists', { table: 'products', label: 'product' }],
      quantity:      ['posInt', { max: 10000000 }],
      breakage_date: ['date'],
    },
    optional: {
      warehouse_id: ['existsOpt', { table: 'warehouses', label: 'warehouse' }],
      reason: ['str', { max: 500 }], notes: ['str', { max: 1000 }],
    }
  },

  vendorCreate: {
    required: { name: ['str', { max: 100, min: 1 }] },
    optional: {
      phone:   ['str', { max: 30 }],
      email:   ['str', { max: 100 }],
      address: ['str', { max: 500 }],
      city:    ['str', { max: 50 }],
      opening_balance: ['num', { min: -1e9, max: 1e9 }],
      status:  ['oneOf', { choices: ['active','inactive'] }],
    }
  },
};

// Idempotency: prevents accidental double-submit of the same form within a window.
// Uses a per-session set of recent fingerprints (action + body hash).
const _seenByUser = new Map(); // userId/sessionId -> Map(fp -> ts)
const IDEMPOTENCY_WINDOW_MS = 8000;
function _hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i); return h >>> 0; }
function preventDoubleSubmit(req, res, next) {
  if ((req.method || '').toUpperCase() !== 'POST') return next();
  const key = (req.session && req.session.id) || (req.user && req.user.id) || (req.ip || 'anon');
  const fp = (req.originalUrl || '') + '|' + _hash(JSON.stringify(req.body || {}));
  const now = Date.now();
  let bag = _seenByUser.get(key);
  if (!bag) { bag = new Map(); _seenByUser.set(key, bag); }
  // GC old entries
  for (const [k, ts] of bag) if (now - ts > IDEMPOTENCY_WINDOW_MS) bag.delete(k);
  if (bag.has(fp)) {
    const wantsJson = (req.headers.accept || '').includes('application/json') || req.xhr;
    if (wantsJson) return res.status(409).json({ success: false, error: 'Duplicate submission ignored' });
    const back = req.get('Referer') || '/';
    return res.redirect(back);
  }
  bag.set(fp, now);
  next();
}

module.exports = { validate, schemas, RULES, preventDoubleSubmit };
