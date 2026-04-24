const express = require('express');
const router = express.Router();
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const search = req.query.search || '';
  const type = req.query.type || '';
  let sql = `
    SELECT sa.*, p.name as product_name, w.name as warehouse_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    WHERE 1=1
  `;
  const params = [];
  if (search) { sql += ` AND p.name LIKE ?`; params.push(`%${search}%`); }
  if (type) { sql += ` AND sa.adjustment_type = ?`; params.push(type); }
  sql += ` ORDER BY sa.id DESC`;
  const adjustments = db.prepare(sql).all(...params);
  res.render('stock/index', { page: 'stock', adjustments, search, type });
});

router.get('/add', (req, res) => {
  const products = db.prepare('SELECT id, name, stock FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const adjType = req.query.type || 'add';
  res.render('stock/form', { page: 'stock', products, warehouses, adjType });
});

router.post('/add', (req, res) => {
  const { product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes } = req.body;
  const qty = parseInt(quantity) || 0;
  const pid = parseInt(product_id);
  const wid = warehouse_id ? parseInt(warehouse_id) : null;
  if (!pid || !qty || !adjustment_type || !adj_date) {
    return res.redirect('/stock/add?error=missing_fields');
  }

  db.transaction(() => {
    // Update main product stock
    if (adjustment_type === 'add' || adjustment_type === 'return' || adjustment_type === 'transfer_in') {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, pid);
    } else if (adjustment_type === 'reduce' || adjustment_type === 'damage' || adjustment_type === 'transfer_out') {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, pid);
    }

    // Update warehouse stock if warehouse selected
    if (warehouse_id) {
      const existing = db.prepare('SELECT id FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?').get(wid, pid);
      if (existing) {
        if (adjustment_type === 'add' || adjustment_type === 'return' || adjustment_type === 'transfer_in') {
          db.prepare('UPDATE warehouse_stock SET quantity = quantity + ? WHERE warehouse_id = ? AND product_id = ?').run(qty, wid, pid);
        } else {
          db.prepare('UPDATE warehouse_stock SET quantity = quantity - ? WHERE warehouse_id = ? AND product_id = ?').run(qty, wid, pid);
        }
      } else {
        const whQty = (adjustment_type === 'add' || adjustment_type === 'return') ? qty : -qty;
        db.prepare('INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)').run(wid, pid, Math.max(0, whQty));
      }
    }

    db.prepare(
      `INSERT INTO stock_adjustments (product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(pid, wid, adjustment_type, qty, reason || '', reference || '', adj_date, notes || '');
  })();

  addAuditLog('create', 'stock_adjustments', null, `Stock ${adjustment_type}: ${qty} pcs for product ${pid}`);
  res.redirect('/stock');
});

// Edit stock adjustment
router.get('/edit/:id', (req, res) => {
  const adj = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(req.params.id);
  if (!adj) return res.redirect('/stock');
  const products = db.prepare('SELECT id, name, stock FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  res.render('stock/edit', { page: 'stock', adj, products, warehouses });
});

router.post('/edit/:id', (req, res) => {
  const { product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes } = req.body;
  const qty = parseInt(quantity) || 0;
  const pid = parseInt(product_id);
  const wid = warehouse_id ? parseInt(warehouse_id) : null;
  const old = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(req.params.id);
  if (!old) return res.redirect('/stock');

  db.transaction(() => {
    // Reverse old effect
    const addTypes = ['add','return','transfer_in'];
    if (addTypes.includes(old.adjustment_type)) {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(old.quantity, old.product_id);
    } else {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(old.quantity, old.product_id);
    }
    // Apply new effect
    if (addTypes.includes(adjustment_type)) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, pid);
    } else {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, pid);
    }
    db.prepare(
      `UPDATE stock_adjustments SET product_id=?, warehouse_id=?, adjustment_type=?, quantity=?, reason=?, reference=?, adj_date=?, notes=? WHERE id=?`
    ).run(pid, wid, adjustment_type, qty, reason || '', reference || '', adj_date, notes || '', req.params.id);
  })();
  addAuditLog('update', 'stock_adjustments', req.params.id, 'Updated stock adjustment');
  res.redirect('/stock');
});

router.post('/delete/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(req.params.id);
  if (old) {
    db.transaction(() => {
      const addTypes = ['add','return','transfer_in'];
      if (addTypes.includes(old.adjustment_type)) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(old.quantity, old.product_id);
      } else {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(old.quantity, old.product_id);
      }
      db.prepare('DELETE FROM stock_adjustments WHERE id = ?').run(req.params.id);
    })();
  }
  addAuditLog('delete', 'stock_adjustments', req.params.id, 'Deleted stock adjustment');
  res.redirect('/stock');
});

router.get('/print/:id', (req, res) => {
  const adj = db.prepare(`
    SELECT sa.*, p.name as product_name, w.name as warehouse_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    WHERE sa.id = ?
  `).get(req.params.id);
  if (!adj) return res.redirect('/stock');
  res.render('stock/print', { adj, layout: false });
});

// Stock Movements - Combined view of all stock movements
router.get('/movements', (req, res) => {
  const search = req.query.search || '';
  const type = req.query.type || '';

  let movements = [];

  // Fetch order movements (outbound to customers)
  if (!type || type === 'outbound') {
    const orderSql = `
      SELECT
        oi.product_id,
        p.name as product_name,
        c.name as party_name,
        'Customer' as party_type,
        oi.quantity,
        o.order_date as movement_date,
        o.id as order_id,
        o.order_no as reference_number,
        'Order' as doc_type
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = oi.product_id
      ${search ? 'WHERE p.name LIKE ?' : ''}
    `;
    const orderMovements = search
      ? db.prepare(orderSql).all(`%${search}%`)
      : db.prepare(orderSql).all();
    movements = [...movements, ...orderMovements];
  }

  // Fetch purchase movements (inbound from vendors)
  if (!type || type === 'inbound') {
    const purchaseSql = `
      SELECT
        pi.product_id,
        p.name as product_name,
        v.name as party_name,
        'Vendor' as party_type,
        pi.quantity,
        pur.purchase_date as movement_date,
        pur.id as purchase_id,
        pur.purchase_no as reference_number,
        'Purchase' as doc_type
      FROM purchase_items pi
      JOIN purchases pur ON pur.id = pi.purchase_id
      JOIN vendors v ON v.id = pur.vendor_id
      JOIN products p ON p.id = pi.product_id
      ${search ? 'WHERE p.name LIKE ?' : ''}
    `;
    const purchaseMovements = search
      ? db.prepare(purchaseSql).all(`%${search}%`)
      : db.prepare(purchaseSql).all();
    movements = [...movements, ...purchaseMovements];
  }

  movements.sort((a, b) => new Date(b.movement_date) - new Date(a.movement_date));

  res.render('stock/movements', { page: 'stock', movements, search, type });
});

router.get('/ledger', (req, res) => {
  const productId = req.query.product_id || '';
  const products = db.prepare('SELECT id, name FROM products WHERE status=? ORDER BY name').all('active');
  let movements = [];
  let product = null;
  if (productId) {
    product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (product) {
      const adjs = db.prepare('SELECT id, adjustment_type, quantity, reason, reference, COALESCE(adj_date, created_at) as txn_date FROM stock_adjustments WHERE product_id = ? ORDER BY COALESCE(adj_date, created_at) ASC').all(productId);
      let runningBal = product.stock;
      movements = adjs.map(a => ({
        type: a.adjustment_type === 'add' ? '+' : '-',
        source_type: 'adjustment',
        source_id: a.id,
        quantity: a.quantity,
        reason: a.reason,
        reference: a.reference,
        txn_date: a.txn_date,
        balance: (runningBal += (a.adjustment_type === 'add' ? a.quantity : -a.quantity))
      }));
    }
  }
  res.render('stock/ledger', { page: 'stock-ledger', products, productId, product, movements });
});

router.get('/position', (req, res) => {
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const warehouseId = req.query.warehouse_id || '';
  let position = [];

  if (warehouseId) {
    position = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.unit,
        ws.quantity as wh_qty,
        p.stock as total_qty
      FROM warehouse_stock ws
      JOIN products p ON p.id = ws.product_id
      WHERE ws.warehouse_id = ? AND p.status = ?
      ORDER BY p.name
    `).all(warehouseId, 'active');
  } else {
    position = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.unit,
        p.stock,
        (SELECT COUNT(DISTINCT warehouse_id) FROM warehouse_stock WHERE product_id = p.id) as warehouse_count
      FROM products p
      WHERE p.status = ?
      ORDER BY p.name
    `).all('active');
  }

  res.render('stock/position', { page: 'stock-position', warehouses, warehouseId, position });
});

module.exports = router;
