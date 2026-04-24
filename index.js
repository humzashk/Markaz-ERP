const express = require('express');
const path = require('path');
const session = require('express-session');
const { initDatabase } = require('./database');
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
  if (num == null) return 'Rs. 0.00';
  return 'Rs. ' + Number(num).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  // Auth + RBAC (must be before protected routes)
  app.use(loadUser);
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

  // Global error handler — prevent crashes from schema mismatches
  app.use((err, req, res, next) => {
    console.error('Route error:', req.method, req.url, '→', err.message);
    if (res.headersSent) return next(err);
    res.status(500).send(`<div style="font-family:sans-serif;padding:20px">
      <h3>Something went wrong</h3>
      <pre style="background:#f4f4f4;padding:10px">${(err.message||'Unknown error').replace(/</g,'&lt;')}</pre>
      <a href="javascript:history.back()">← Back</a></div>`);
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
