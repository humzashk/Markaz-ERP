'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const session = require('express-session');
const { pool, getSettings, auditContext, logError } = require('./database');
const { loadUser, autoGuard } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'markaz-erp-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }
}));

// Locals helpers (currency / dates / logo / scope name)
app.locals.formatCurrency = (n) => 'Rs. ' + Number(n||0).toLocaleString('en-PK', { minimumFractionDigits:2, maximumFractionDigits:2 });
app.locals.formatDate = (d) => {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('en-PK', { day:'2-digit', month:'short', year:'numeric' }); } catch(_){ return String(d); }
};
app.locals.statusBadge = (s) => ({ active:'success', inactive:'secondary', pending:'warning', confirmed:'info', delivered:'success', cancelled:'danger', paid:'success', unpaid:'danger', partial:'warning', in_transit:'info', resolved:'success', received:'success' }[s] || 'secondary');
app.locals.accountName = (scope) => ({ plastic_markaz:'PLASTIC MARKAZ', wings_furniture:'WINGS FURNITURE', cooler:'COOLER' }[scope] || 'PLASTIC MARKAZ');
app.locals.getLogoPath = function(scope) {
  const s = (scope || 'plastic_markaz');
  // Synchronous lookup via cached settings (set per-request below).
  return (this && this.appSettings && this.appSettings['logo_' + s]) || (this && this.appSettings && this.appSettings.logo_default) || '/Logo.png';
};
app.locals.getLogoMeta = function(scope) {
  const def = { w:240, h:90, align:'center', offsetX:0, offsetY:0 };
  try {
    const v = this && this.appSettings && this.appSettings['logo_meta_'+(scope||'plastic_markaz')];
    if (!v) return def;
    const j = JSON.parse(v);
    return {
      w: Math.max(40, Math.min(600, parseInt(j.w,10) || def.w)),
      h: Math.max(20, Math.min(300, parseInt(j.h,10) || def.h)),
      align: ['left','center','right'].includes(j.align) ? j.align : 'center',
      offsetX: Math.max(-200, Math.min(200, parseInt(j.offsetX,10) || 0)),
      offsetY: Math.max(-100, Math.min(100, parseInt(j.offsetY,10) || 0))
    };
  } catch(e){ return def; }
};

// Per-request settings (cached per-request, refreshed on each request)
app.use(async (req, res, next) => {
  try { res.locals.appSettings = await getSettings(); } catch(_) { res.locals.appSettings = {}; }
  res.locals.query = req.query || {};
  res.locals.req = req;
  // Global safe defaults — prevent EJS "is not defined" crashes
  res.locals.err           = req.query.err   || null;
  res.locals.saved         = req.query.saved || null;
  res.locals.ok            = req.query.ok    || null;
  res.locals.search        = req.query.search || '';
  res.locals.from          = req.query.from  || '';
  res.locals.to            = req.query.to    || '';

  // Lists — always arrays
  res.locals.regions       = [];
  res.locals.types         = [];
  res.locals.categories    = [];
  res.locals.rateHistory   = [];
  res.locals.creditNotes   = [];
  res.locals.warehouses    = [];
  res.locals.transports    = [];
  res.locals.position      = [];
  res.locals.allEntries    = [];
  res.locals.customerTypes = [];
  res.locals.vendorTypes   = [];
  res.locals.regionCats    = [];
  res.locals.customers     = [];
  res.locals.vendors       = [];
  res.locals.products      = [];
  res.locals.orders        = [];
  res.locals.invoices      = [];
  res.locals.purchases     = [];
  res.locals.items         = [];
  res.locals.movements     = [];
  res.locals.adjustments   = [];
  res.locals.payments      = [];
  res.locals.notes         = [];

  // Single-record defaults — null
  res.locals.invoice       = null;
  res.locals.purchase      = null;
  res.locals.order         = null;
  res.locals.customer      = null;
  res.locals.vendor        = null;
  res.locals.product       = null;
  res.locals.note          = null;
  res.locals.bilty         = null;
  res.locals.dc            = null;

  // Flags / scalars
  res.locals.edit          = false;
  res.locals.error         = null;
  res.locals.result        = null;
  res.locals.exportable    = {};
  res.locals.noteType      = 'credit';
  res.locals.warehouseId   = null;
  res.locals.productId     = null;
  res.locals.status        = req.query.status || '';
  res.locals.type          = req.query.type   || '';
  res.locals.region        = req.query.region || '';
  res.locals.party_type    = req.query.party_type || '';
  res.locals.linkedOrderIds = [];
  next();
});

// Session timeout
async function getTimeoutMs() {
  try {
    const s = await getSettings();
    const n = parseInt(s.session_timeout_minutes || '15', 10);
    return Math.max(1, Math.min(1440, n)) * 60 * 1000;
  } catch (_) { return 15 * 60 * 1000; }
}
app.use(async (req, res, next) => {
  if (req.session && req.session.userId) {
    const limit = await getTimeoutMs();
    const now = Date.now();
    if (req.session.lastActivity && (now - req.session.lastActivity) > limit) {
      return req.session.destroy(() => {
        if (req.xhr || (req.headers.accept||'').includes('application/json') || req.headers['x-partial']) return res.status(440).json({ error:'session_expired' });
        return res.redirect('/login?timeout=1');
      });
    }
    if (req.path !== '/api/session/keepalive') req.session.lastActivity = now;
    res.locals.sessionTimeoutMs = limit;
  } else {
    res.locals.sessionTimeoutMs = await getTimeoutMs();
  }
  next();
});

app.get('/api/session/keepalive', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ ok:false });
  req.session.lastActivity = Date.now();
  res.json({ ok:true });
});

// Auth + audit context
app.use(loadUser);
app.use((req, res, next) => auditContext.run({ userId: req.user ? req.user.id : null }, () => next()));

// Idempotency
const { preventDoubleSubmit } = require('./middleware/validate');
app.use(preventDoubleSubmit);

// Public auth routes first
app.use('/', require('./routes/auth'));
app.use(autoGuard);

// Protected routes
app.use('/users',       require('./routes/users'));
app.use('/',            require('./routes/dashboard'));
app.use('/customers',   require('./routes/customers'));
app.use('/vendors',     require('./routes/vendors'));
app.use('/products',    require('./routes/products'));
app.use('/ratelist',    require('./routes/ratelist'));
app.use('/orders',      require('./routes/orders'));
app.use('/invoices',    require('./routes/invoices'));
app.use('/purchases',   require('./routes/purchases'));
app.use('/expenses',    require('./routes/expenses'));
app.use('/bilty',       require('./routes/bilty'));
app.use('/transports',  require('./routes/transports'));
app.use('/breakage',    require('./routes/breakage'));
app.use('/ledger',      require('./routes/ledger'));
app.use('/payments',    require('./routes/payments'));
app.use('/reports',     require('./routes/reports'));
app.use('/warehouses',  require('./routes/warehouses'));
app.use('/stock',       require('./routes/stock'));
app.use('/creditnotes', require('./routes/creditnotes'));
app.use('/daybook',     require('./routes/daybook'));
app.use('/settings',    require('./routes/settings'));
app.use('/categories',  require('./routes/categories'));
app.use('/journal',     require('./routes/journal'));
app.use('/importexport',require('./routes/importexport'));
app.use('/stockinit',   require('./routes/stockinit'));
// /bank removed (Bank Account module retired)
app.use('/bank', (req, res) => res.status(410).render('error', { page:'error', message:'Bank Account module has been removed.', back:'/' }));

// API
app.get('/api/customers', async (req, res, next) => {
  try { const r = await pool.query(`SELECT id,name,phone,city,balance FROM customers WHERE status='active' ORDER BY name`); res.json(r.rows); } catch(e){ next(e); }
});
app.get('/api/vendors', async (req, res, next) => {
  try { const r = await pool.query(`SELECT id,name,phone,city,balance FROM vendors WHERE status='active' ORDER BY name`); res.json(r.rows); } catch(e){ next(e); }
});
app.get('/api/products', async (req, res, next) => {
  try { const r = await pool.query(`SELECT id,name,category,qty_per_pack,stock,unit,selling_price,cost_price FROM products WHERE status='active' ORDER BY name`); res.json(r.rows); } catch(e){ next(e); }
});
app.get('/api/products/:id', async (req, res, next) => {
  try { const r = await pool.query(`SELECT * FROM products WHERE id=$1`, [req.params.id]); res.json(r.rows[0] || {}); } catch(e){ next(e); }
});

// Next available BLT-XXXX bilty number (across orders + invoices)
app.get('/api/next-bilty-no', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT COALESCE(MAX(
        CAST(REGEXP_REPLACE(bilty_no, '^BLT-0*', '') AS INTEGER)
      ), 0) AS max_no
      FROM (
        SELECT bilty_no FROM orders   WHERE bilty_no ~ '^BLT-\\d+'
        UNION ALL
        SELECT bilty_no FROM invoices WHERE bilty_no ~ '^BLT-\\d+'
      ) t`);
    const maxNo = parseInt(r.rows[0].max_no, 10) || 0;
    res.json({ next: 'BLT-' + String(maxNo + 1).padStart(4, '0') });
  } catch(e) { next(e); }
});

// Error handlers
const { notFound, globalErrorHandler } = require('./middleware/errorHandler');
app.use(notFound);
app.use(globalErrorHandler);

process.on('unhandledRejection', (r) => { try { logError('process.unhandledRejection', r instanceof Error ? r : new Error(String(r))); } catch(_){} });
process.on('uncaughtException',  (e) => { try { logError('process.uncaughtException', e); } catch(_){} });

(async function start() {
  try {
    await pool.query('SELECT 1');
    app.listen(PORT, () => {
      console.log(`\n  ╔══════════════════════════════════════╗`);
      console.log(`  ║      PLASTIC MARKAZ ERP (PG v2)      ║`);
      console.log(`  ║      http://localhost:${PORT}            ║`);
      console.log(`  ╚══════════════════════════════════════╝\n`);
    });
  } catch (e) {
    console.error('[fatal] Postgres unreachable:', e.message);
    console.error('Run `npm run db:reset` after Postgres is up.');
    process.exit(1);
  }
})();
