const express = require('express');
const path = require('path');
const { initDatabase } = require('./database');

const app = express();
const PORT = 3000;

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

  // API endpoints for AJAX
  const dbModule = require('./database');
  app.get('/api/customers', (req, res) => {
    res.json(dbModule.db.prepare('SELECT id, name, phone, city, balance FROM customers WHERE status = ? ORDER BY name').all('active'));
  });
  app.get('/api/vendors', (req, res) => {
    res.json(dbModule.db.prepare('SELECT id, name, phone, city, balance FROM vendors WHERE status = ? ORDER BY name').all('active'));
  });
  app.get('/api/products', (req, res) => {
    res.json(dbModule.db.prepare('SELECT id, name, category, packaging, stock, rate FROM products WHERE status = ? ORDER BY name').all('active'));
  });
  app.get('/api/products/:id', (req, res) => {
    const p = dbModule.db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(p || {});
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
