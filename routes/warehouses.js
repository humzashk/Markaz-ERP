const express = require('express');
const router = express.Router();
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const warehouses = db.prepare(`
    SELECT w.*,
      COALESCE((SELECT SUM(ws.quantity) FROM warehouse_stock ws WHERE ws.warehouse_id = w.id), 0) as total_stock
    FROM warehouses w ORDER BY w.name
  `).all();
  res.render('warehouses/index', { page: 'warehouses', warehouses });
});

router.get('/add', (req, res) => {
  res.render('warehouses/form', { page: 'warehouses', warehouse: null, edit: false });
});

router.post('/add', (req, res) => {
  const { name, location, manager, phone, notes } = req.body;
  const result = db.prepare(
    `INSERT INTO warehouses (name, location, manager, phone, notes) VALUES (?, ?, ?, ?, ?)`
  ).run(name || '', location || '', manager || '', phone || '', notes || '');
  addAuditLog('create', 'warehouses', result.lastInsertRowid, `Created warehouse: ${name}`);
  res.redirect('/warehouses');
});

router.get('/edit/:id', (req, res) => {
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(req.params.id);
  if (!warehouse) return res.redirect('/warehouses');
  res.render('warehouses/form', { page: 'warehouses', warehouse, edit: true });
});

router.post('/edit/:id', (req, res) => {
  const { name, location, manager, phone, notes, status } = req.body;
  db.prepare(
    `UPDATE warehouses SET name=?, location=?, manager=?, phone=?, notes=?, status=? WHERE id=?`
  ).run(name || '', location || '', manager || '', phone || '', notes || '', status || 'active', req.params.id);
  res.redirect('/warehouses');
});

router.get('/view/:id', (req, res) => {
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(req.params.id);
  if (!warehouse) return res.redirect('/warehouses');
  const stock = db.prepare(`
    SELECT ws.quantity, p.name as product_name, p.rate, p.min_stock, p.category,
      (ws.quantity * p.rate) as value
    FROM warehouse_stock ws
    JOIN products p ON p.id = ws.product_id
    WHERE ws.warehouse_id = ?
    ORDER BY p.name
  `).all(req.params.id);
  const adjustments = db.prepare(`
    SELECT sa.*, p.name as product_name
    FROM stock_adjustments sa JOIN products p ON p.id = sa.product_id
    WHERE sa.warehouse_id = ? ORDER BY sa.id DESC LIMIT 20
  `).all(req.params.id);
  res.render('warehouses/view', { page: 'warehouses', warehouse, stock, adjustments });
});

// Transfer stock between warehouses
router.get('/transfer', (req, res) => {
  const warehouses = db.prepare('SELECT * FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, stock FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('warehouses/transfer', { page: 'warehouses', warehouses, products });
});

router.post('/transfer', (req, res) => {
  const { from_warehouse_id, to_warehouse_id, product_id, quantity, notes } = req.body;
  const qty = parseInt(quantity) || 0;
  const today = new Date().toISOString().split('T')[0];

  db.transaction(() => {
    // Reduce from source
    const fromStock = db.prepare('SELECT quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?').get(from_warehouse_id, product_id);
    if (!fromStock || fromStock.quantity < qty) throw new Error('Insufficient stock');

    db.prepare('UPDATE warehouse_stock SET quantity = quantity - ? WHERE warehouse_id = ? AND product_id = ?').run(qty, from_warehouse_id, product_id);

    // Add to destination
    const toStock = db.prepare('SELECT id FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?').get(to_warehouse_id, product_id);
    if (toStock) {
      db.prepare('UPDATE warehouse_stock SET quantity = quantity + ? WHERE warehouse_id = ? AND product_id = ?').run(qty, to_warehouse_id, product_id);
    } else {
      db.prepare('INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)').run(to_warehouse_id, product_id, qty);
    }

    // Log adjustment for both
    db.prepare('INSERT INTO stock_adjustments (product_id, warehouse_id, adjustment_type, quantity, reason, adj_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(product_id, from_warehouse_id, 'transfer_out', qty, `Transfer to WH-${to_warehouse_id}`, today, notes);
    db.prepare('INSERT INTO stock_adjustments (product_id, warehouse_id, adjustment_type, quantity, reason, adj_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(product_id, to_warehouse_id, 'transfer_in', qty, `Transfer from WH-${from_warehouse_id}`, today, notes);
  })();

  res.redirect('/warehouses');
});

router.post('/delete/:id', (req, res) => {
  db.prepare('UPDATE warehouses SET status = ? WHERE id = ?').run('inactive', req.params.id);
  res.redirect('/warehouses');
});

module.exports = router;
