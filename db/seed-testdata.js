#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'markaz_erp',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await fn(clientApi(c));
    await c.query('COMMIT');
    return res;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

function clientApi(client) {
  return {
    one:  async (s, p) => (await client.query(s, p)).rows[0] || null,
    many: async (s, p) => (await client.query(s, p)).rows,
    run:  async (s, p) => { const r = await client.query(s, p); return { rows: r.rows, rowCount: r.rowCount, id: r.rows && r.rows[0] ? r.rows[0].id : null }; },
  };
}

async function seedData() {
  console.log('[seed] Generating test data for Jan-Apr 2026...');

  // Clean existing test data
  console.log('[seed] Cleaning existing data...');
  await pool.query('DELETE FROM payments');
  await pool.query('DELETE FROM stock_ledger');
  await pool.query('DELETE FROM purchase_items');
  await pool.query('DELETE FROM invoice_items');
  await pool.query('DELETE FROM ledger');
  await pool.query('DELETE FROM invoices');
  await pool.query('DELETE FROM purchases');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM products');
  await pool.query('DELETE FROM vendors');
  await pool.query('DELETE FROM customers');

  // Get warehouse
  const warehouse = await pool.query('SELECT id FROM warehouses LIMIT 1');
  const warehouseId = warehouse.rows[0].id;

  // Create customers
  const customers = [];
  const customerNames = ['ABC Retail', 'XYZ Traders', 'Quick Stop Store', 'Premier Distributors', 'Karachi Wholesalers'];
  for (const name of customerNames) {
    const r = await pool.query(
      'INSERT INTO customers(name, category, phone, email, address, city, status, region) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name, 'Retail', '0300-1234567', `contact@${name.toLowerCase().replace(/ /g, '')}.com`, '123 Main St', 'Karachi', 'active', 'Karachi']
    );
    customers.push({ id: r.rows[0].id, name });
  }
  console.log(`[seed] Created ${customers.length} customers`);

  // Create vendors
  const vendors = [];
  const vendorNames = ['Plastic Corp', 'Raw Materials Ltd', 'Import House', 'Factory Direct'];
  for (const name of vendorNames) {
    const r = await pool.query(
      'INSERT INTO vendors(name, category, phone, email, address, city, status, region) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name, 'Manufacturer', '0300-9876543', `sales@${name.toLowerCase().replace(/ /g, '')}.com`, '456 Industrial', 'Lahore', 'active', 'Lahore']
    );
    vendors.push({ id: r.rows[0].id, name });
  }
  console.log(`[seed] Created ${vendors.length} vendors`);

  // Create products
  const products = [];
  const productData = [
    { item_id: 'PL-001', name: 'Clear Plastic Bags 10x12', category: 'Bags & Packaging', unit: 'PCS', qty_per_pack: 100, cost_price: 0.50, selling_price: 0.75 },
    { item_id: 'PL-002', name: 'White HDPE Sheets', category: 'Containers', unit: 'KG', qty_per_pack: 1, cost_price: 120, selling_price: 150 },
    { item_id: 'PL-003', name: 'Colored Plastic Rolls', category: 'Miscellaneous Plastic', unit: 'MTR', qty_per_pack: 50, cost_price: 45, selling_price: 65 },
    { item_id: 'PL-004', name: 'Plastic Containers 5L', category: 'Containers', unit: 'PCS', qty_per_pack: 20, cost_price: 35, selling_price: 55 },
    { item_id: 'PL-005', name: 'PVC Pipe 1 inch', category: 'Pipes & Fittings', unit: 'MTR', qty_per_pack: 6, cost_price: 25, selling_price: 40 },
  ];
  for (const p of productData) {
    const r = await pool.query(
      'INSERT INTO products(item_id,name,category,unit,qty_per_pack,cost_price,selling_price,stock,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [p.item_id, p.name, p.category, p.unit, p.qty_per_pack, p.cost_price, p.selling_price, 500, 'active']
    );
    products.push({ id: r.rows[0].id, ...p });
  }
  console.log(`[seed] Created ${products.length} products`);

  // Generate invoices and purchases for Jan-Apr 2026
  let invoiceCount = 0, purchaseCount = 0, paymentCount = 0;

  for (let month = 1; month <= 4; month++) {
    const daysInMonth = new Date(2026, month, 0).getDate();

    // 3-4 invoices per month
    for (let i = 0; i < (month % 2 === 0 ? 4 : 3); i++) {
      const day = Math.floor(Math.random() * daysInMonth) + 1;
      const invoiceDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const customerId = customers[Math.floor(Math.random() * customers.length)].id;
      const numItems = 2 + Math.floor(Math.random() * 3);

      await tx(async (db) => {
        // Get customer credit days
        const custR = await db.one('SELECT credit_days FROM customers WHERE id=$1', [customerId]);
        const creditDays = custR?.credit_days || 30;
        const dueDate = new Date(invoiceDate);
        dueDate.setDate(dueDate.getDate() + creditDays);
        const dueDateStr = dueDate.toISOString().split('T')[0];

        const invoiceNo = `INV-${String(invoiceCount + 1).padStart(5, '0')}`;
        const invR = await db.run(
          'INSERT INTO invoices(invoice_no,invoice_date,due_date,customer_id,warehouse_id,status,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [invoiceNo, invoiceDate, dueDateStr, customerId, warehouseId, 'unpaid', 'plastic_markaz']
        );
        const invoiceId = invR.id;
        let totalAmount = 0;

        for (let j = 0; j < numItems; j++) {
          const product = products[Math.floor(Math.random() * products.length)];
          const qty = 10 + Math.floor(Math.random() * 100);
          const rate = product.selling_price;
          const commission_pct = 5 + Math.floor(Math.random() * 10);
          const discount_per_pack = Math.random() > 0.7 ? Math.floor(Math.random() * 5) : 0;

          const amount = qty * rate;
          const commission = (amount * commission_pct) / 100;
          const totalDiscount = discount_per_pack * qty;
          const lineTotal = amount - commission - totalDiscount;
          totalAmount += lineTotal;

          await db.run(
            'INSERT INTO invoice_items(invoice_id,product_id,quantity,rate,amount,cost_at_sale,commission_pct,commission_amount,discount_per_pack) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [invoiceId, product.id, qty, rate, amount, product.cost_price, commission_pct, commission, discount_per_pack]
          );

          // Stock movement (deduction)
          await db.run(
            'INSERT INTO stock_ledger(product_id,warehouse_id,qty_delta,ref_type,ref_id,reason,user_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [product.id, warehouseId, -qty, 'invoice', invoiceId, 'sale', 1]
          );
          await db.run('UPDATE products SET stock = stock - $1 WHERE id = $2', [qty, product.id]);
        }

        // Ledger entry (customer debit = receivable)
        await db.run(
          'INSERT INTO ledger(entity_type,entity_id,txn_date,description,debit,credit,reference_type,reference_id,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          ['customer', customerId, invoiceDate, `Invoice ${invoiceNo}`, totalAmount, 0, 'invoice', invoiceId, 'plastic_markaz']
        );

        // Recompute balance
        const ledgerR = await db.one('SELECT COALESCE(SUM(debit) - SUM(credit),0) AS bal FROM ledger WHERE entity_type=$1 AND entity_id=$2', ['customer', customerId]);
        await db.run('UPDATE customers SET balance=$1 WHERE id=$2', [ledgerR.bal, customerId]);
      });

      invoiceCount++;
    }

    // 2-3 purchases per month
    for (let i = 0; i < (month % 2 === 0 ? 3 : 2); i++) {
      const day = Math.floor(Math.random() * daysInMonth) + 1;
      const purchaseDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const vendorId = vendors[Math.floor(Math.random() * vendors.length)].id;
      const numItems = 2 + Math.floor(Math.random() * 2);

      await tx(async (db) => {
        const purchaseNo = `PUR-${String(purchaseCount + 1).padStart(5, '0')}`;
        const purR = await db.run(
          'INSERT INTO purchases(purchase_no,purchase_date,vendor_id,warehouse_id,status,account_scope) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [purchaseNo, purchaseDate, vendorId, warehouseId, 'received', 'plastic_markaz']
        );
        const purchaseId = purR.id;
        let totalAmount = 0;

        for (let j = 0; j < numItems; j++) {
          const product = products[Math.floor(Math.random() * products.length)];
          const qty = 50 + Math.floor(Math.random() * 200);
          const rate = product.cost_price * (0.9 + Math.random() * 0.2);
          const amount = qty * rate;
          totalAmount += amount;

          await db.run(
            'INSERT INTO purchase_items(purchase_id,product_id,quantity,rate,amount) VALUES($1,$2,$3,$4,$5)',
            [purchaseId, product.id, qty, rate, amount]
          );

          // Stock movement (addition)
          await db.run(
            'INSERT INTO stock_ledger(product_id,warehouse_id,qty_delta,ref_type,ref_id,reason,user_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [product.id, warehouseId, qty, 'purchase', purchaseId, 'purchase', 1]
          );
          await db.run('UPDATE products SET stock = stock + $1 WHERE id = $2', [qty, product.id]);
        }

        // Ledger entry (vendor credit = payable)
        await db.run(
          'INSERT INTO ledger(entity_type,entity_id,txn_date,description,debit,credit,reference_type,reference_id,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          ['vendor', vendorId, purchaseDate, `Purchase ${purchaseNo}`, 0, totalAmount, 'purchase', purchaseId, 'plastic_markaz']
        );

        // Recompute balance
        const ledgerR = await db.one('SELECT COALESCE(SUM(debit) - SUM(credit),0) AS bal FROM ledger WHERE entity_type=$1 AND entity_id=$2', ['vendor', vendorId]);
        await db.run('UPDATE vendors SET balance=$1 WHERE id=$2', [ledgerR.bal, vendorId]);
      });

      purchaseCount++;
    }

    // 2-3 payments per month
    for (let i = 0; i < (month % 2 === 0 ? 3 : 2); i++) {
      const day = Math.floor(Math.random() * daysInMonth) + 1;
      const paymentDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      // Mix of customer payments and vendor payments
      if (i % 2 === 0 && customers.length > 0) {
        const customer = customers[Math.floor(Math.random() * customers.length)];
        const amount = 5000 + Math.floor(Math.random() * 50000);

        await tx(async (db) => {
          const payR = await db.run(
            'INSERT INTO payments(entity_type,entity_id,amount,payment_date,payment_method,reference,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            ['customer', customer.id, amount, paymentDate, 'bank_transfer', `CHK-${paymentCount}`, 'plastic_markaz']
          );

          // Ledger entry (customer credit = reduces receivable)
          await db.run(
            'INSERT INTO ledger(entity_type,entity_id,txn_date,description,debit,credit,reference_type,reference_id,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            ['customer', customer.id, paymentDate, `Payment received`, 0, amount, 'payment', payR.id, 'plastic_markaz']
          );

          // Recompute balance
          const ledgerR = await db.one('SELECT COALESCE(SUM(debit) - SUM(credit),0) AS bal FROM ledger WHERE entity_type=$1 AND entity_id=$2', ['customer', customer.id]);
          await db.run('UPDATE customers SET balance=$1 WHERE id=$2', [ledgerR.bal, customer.id]);
        });
      } else if (vendors.length > 0) {
        const vendor = vendors[Math.floor(Math.random() * vendors.length)];
        const amount = 10000 + Math.floor(Math.random() * 100000);

        await tx(async (db) => {
          const payR = await db.run(
            'INSERT INTO payments(entity_type,entity_id,amount,payment_date,payment_method,reference,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            ['vendor', vendor.id, amount, paymentDate, 'bank_transfer', `CHK-${paymentCount}`, 'plastic_markaz']
          );

          // Ledger entry (vendor debit = reduces payable)
          await db.run(
            'INSERT INTO ledger(entity_type,entity_id,txn_date,description,debit,credit,reference_type,reference_id,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            ['vendor', vendor.id, paymentDate, `Payment made`, amount, 0, 'payment', payR.id, 'plastic_markaz']
          );

          // Recompute balance
          const ledgerR = await db.one('SELECT COALESCE(SUM(debit) - SUM(credit),0) AS bal FROM ledger WHERE entity_type=$1 AND entity_id=$2', ['vendor', vendor.id]);
          await db.run('UPDATE vendors SET balance=$1 WHERE id=$2', [ledgerR.bal, vendor.id]);
        });
      }

      paymentCount++;
    }
  }

  console.log(`[seed] Created ${invoiceCount} invoices`);
  console.log(`[seed] Created ${purchaseCount} purchases`);
  console.log(`[seed] Created ${paymentCount} payments`);
  console.log('[seed] ✓ Test data generation complete!');
}

seedData()
  .then(() => {
    console.log('[seed] SUCCESS');
    process.exit(0);
  })
  .catch(e => {
    console.error('[seed] ERROR:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
