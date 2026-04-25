const express = require('express');
const path = require('path');
const session = require('express-session');
const { initDatabase, runStabilization } = require('./database');
const { loadUser, autoGuard } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session (RBAC)
app.use(session({
  secret: process.env.SESSION_SECRET || 'markaz-erp-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Template helpers
app.locals.formatCurrency = (num) => {
  if (num == null) return 'PKR 0.00';
  return 'PKR ' + Number(num).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
app.locals.formatDate = (d) => {
  if (!d) return '-';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' });
};
app.locals.getLogoPath = function(scope) {
  try {
    const { db } = require('./database');
    if (!db) return '/Logo.png';
    const key = 'logo_' + (scope || 'plastic_markaz');
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (row && row.value) return row.value;
    const def = db.prepare('SELECT value FROM settings WHERE key=?').get('logo_default');
    if (def && def.value) return def.value;
  } catch(e){}
  return '/Logo.png';
};
app.locals.accountName = function(scope) {
  const map = { plastic_markaz:'PLASTIC MARKAZ', wings_furniture:'WINGS FURNITURE', cooler:'COOLER' };
  return map[scope] || 'PLASTIC MARKAZ';
};
app.use((req, res, next) => {
  try {
    const { getSettings } = require('./database');
    res.locals.appSettings = getSettings();
  } catch(e) { res.locals.appSettings = {}; }
  // Make query string available to every view (used by partials/form-error.ejs)
  res.locals.query = req.query || {};
  res.locals.req = req;
  next();
});
app.locals.statusBadge = (status) => {
  const colors = {
    active: 'success', inactive: 'secondary',
    pending: 'warning', confirmed: 'info', delivered: 'success', cancelled: 'danger',
    paid: 'success', unpaid: 'danger', partial: 'warning',
    in_transit: 'info', resolved: 'success', rejected: 'danger'
  };
  return colors[status] || 'secondary';
};

async function startServer() {
  // Initialize database first
  await initDatabase();

  // Idempotent data-integrity pass (indices, canonical columns, balance/stock reconciliation, orphan report)
  try {
    const report = runStabilization();
    if (report && report.steps) {
      const failed = report.steps.filter(s => !s.ok);
      if (failed.length) console.warn('[stabilize] failed steps:', failed.map(s => s.name).join(','));
      const orph = report.orphans || {};
      const totalOrph = Object.values(orph).reduce((s, v) => s + (Number(v) || 0), 0);
      if (totalOrph > 0) console.warn('[stabilize] orphan rows detected:', JSON.stringify(orph));
    }
  } catch (e) {
    console.error('[stabilize] error:', e && e.message);
  }

  // Auth + RBAC (must be before protected routes)
  app.use(loadUser);

  // Audit user-context: store current user in AsyncLocalStorage so addAuditLog can pick it up
  const { auditContext } = require('./database');
  app.use((req, res, next) => {
    auditContext.run({ userId: req.user ? req.user.id : null }, () => next());
  });

  // Idempotency / double-submit prevention (applies to all POSTs site-wide).
  const { preventDoubleSubmit } = require('./middleware/validate');
  app.use(preventDoubleSubmit);

  app.use('/', require('./routes/auth'));     // /login, /logout, /profile (public bits handled inside)
  app.use(autoGuard);                         // anything below requires auth + module permission
  app.use('/users', require('./routes/users'));

  // Routes (loaded after db init so they get the initialized db)
  app.use('/', require('./routes/dashboard'));
  app.use('/customers', require('./routes/customers'));
  app.use('/vendors', require('./routes/vendors'));
  app.use('/products', require('./routes/products'));
  app.use('/ratelist', require('./routes/ratelist'));
  app.use('/orders', require('./routes/orders'));
  app.use('/invoices', require('./routes/invoices'));
  app.use('/purchases', require('./routes/purchases'));
  app.use('/expenses', require('./routes/expenses'));
  app.use('/bilty', require('./routes/bilty'));
  app.use('/transports', require('./routes/transports'));
  app.use('/breakage', require('./routes/breakage'));
  app.use('/ledger', require('./routes/ledger'));
  app.use('/payments', require('./routes/payments'));
  app.use('/reports', require('./routes/reports'));
  app.use('/warehouses', require('./routes/warehouses'));
  app.use('/stock', require('./routes/stock'));
  app.use('/bank', require('./routes/bank'));
  app.use('/creditnotes', require('./routes/creditnotes'));
  app.use('/daybook', require('./routes/daybook'));
  app.use('/settings', require('./routes/settings'));
  app.use('/categories', require('./routes/categories'));
  app.use('/journal', require('./routes/journal'));
  app.use('/importexport', require('./routes/importexport'));
  app.use('/admin/seed', require('./routes/seed'));

  // API endpoints for AJAX
  const dbModule = require('./database');
  app.get('/api/customers', (req, res) => {
    res.json(dbModule.db.prepare('SELECT id, name, phone, city, balance FROM customers WHERE status = ? ORDER BY name').all('active'));
  });
  app.get('/api/vendors', (req, res) => {
    res.json(dbModule.db.prepare('SELECT id, name, phone, city, balance FROM vendors WHERE status = ? ORDER BY name').all('active'));
  });
  app.get('/api/products', (req, res) => {
    try {
      res.json(dbModule.db.prepare(
        `SELECT id, name, category, COALESCE(packaging, qty_per_pack, 1) as packaging,
                qty_per_pack, stock, rate, COALESCE(base_unit, unit, 'PCS') as base_unit,
                unit, selling_price, purchase_price
         FROM products WHERE status = ? ORDER BY name`
      ).all('active'));
    } catch (e) {
      console.error('api/products error:', e.message);
      res.json([]);
    }
  });
  app.get('/api/products/:id', (req, res) => {
    const p = dbModule.db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(p || {});
  });
  app.get('/api/reports/stock-position', (req, res) => {
    try {
      const products = dbModule.db.prepare(
        `SELECT id, name, stock, rate, min_stock FROM products WHERE status='active' ORDER BY name`
      ).all();
      res.json(products);
    } catch (e) {
      console.error('stock-position error:', e.message);
      res.json([]);
    }
  });

  // Global error handler — prevent crashes from schema mismatches & log + redirect
  const { globalErrorHandler, notFound } = require('./middleware/errorHandler');
  app.use(notFound);
  app.use(globalErrorHandler);

  // Last-resort process-level guards: never crash on unhandled rejection.
  process.on('unhandledRejection', (reason) => {
    try { require('./database').logError('process.unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))); } catch(_) {}
    console.error('[unhandledRejection]', reason && reason.message || reason);
  });
  process.on('uncaughtException', (err) => {
    try { require('./database').logError('process.uncaughtException', err); } catch(_) {}
    console.error('[uncaughtException]', err && err.message);
  });

  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║      PLASTIC MARKAZ ERP System       ║`);
    console.log(`  ║      http://localhost:${PORT}            ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
