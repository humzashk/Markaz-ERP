/**
 * Markaz ERP - Full 2-Year Demo Seed Script
 * Covers: Jan 2025 – Apr 2026 (16 months)
 * Touches every module: customers, vendors, products, warehouses,
 * orders, invoices, purchases, payments, expenses, bilty,
 * breakage, ledger, bank, credit notes, journal, stock adjustments
 *
 * Run: node seed_data.js
 */

const { initDatabase } = require('./database');

async function seed() {
  const db = await initDatabase();
  console.log('✅ Database initialized');

  // ─── WIPE ALL TRANSACTIONAL & MASTER DATA ───────────────────────────────
  const wipe = [
    'DELETE FROM journal_lines',
    'DELETE FROM journal_entries',
    'DELETE FROM credit_note_items',
    'DELETE FROM credit_notes',
    'DELETE FROM bank_transactions',
    'DELETE FROM bank_accounts',
    'DELETE FROM stock_adjustments',
    'DELETE FROM warehouse_stock',
    'DELETE FROM warehouses',
    'DELETE FROM breakage',
    'DELETE FROM bilty',
    'DELETE FROM payments',
    'DELETE FROM ledger',
    'DELETE FROM invoice_items',
    'DELETE FROM invoices',
    'DELETE FROM order_items',
    'DELETE FROM orders',
    'DELETE FROM purchase_items',
    'DELETE FROM purchases',
    'DELETE FROM expenses',
    'DELETE FROM audit_log',
    'DELETE FROM rate_list',
    'DELETE FROM product_rate_history',
    'DELETE FROM products',
    'DELETE FROM vendors',
    'DELETE FROM customers',
    // Reset autoincrement counters
    "DELETE FROM sqlite_sequence WHERE name IN ('customers','vendors','products','orders','order_items','invoices','invoice_items','purchases','purchase_items','payments','ledger','expenses','bilty','breakage','warehouses','warehouse_stock','stock_adjustments','bank_accounts','bank_transactions','credit_notes','credit_note_items','journal_entries','journal_lines','rate_list')",
  ];
  for (const sql of wipe) { try { db.exec(sql); } catch(e) {} }
  console.log('🗑️  All data wiped');

  // ─── MASTER DATA ─────────────────────────────────────────────────────────

  // Customers
  const customerData = [
    ['Ahmed Traders',      '03001234567', 'ahmed@traders.pk',    'Shop 12, Saddar',    'Karachi',   5, 50000],
    ['Zubair & Sons',      '03111234567', 'zubair@sons.pk',      'Hall Rd',            'Lahore',    4, 30000],
    ['Malik Store',        '03211234567', 'malik@store.pk',      'Tariq Rd',           'Karachi',   5, 20000],
    ['Royal Plastics',     '03221234567', 'royal@plastics.pk',   'Auto Bahn Rd',       'Hyderabad', 3, 0],
    ['Star Traders',       '03001112222', 'star@traders.pk',     'Orangi Town',        'Karachi',   5, 10000],
    ['Khan & Brothers',    '03331234567', 'khan@brothers.pk',    'Qissa Khwani',       'Peshawar',  4, 0],
    ['City Mart',          '03211112222', 'city@mart.pk',        'Johar Colony',       'Karachi',   3, 15000],
    ['Metro Traders',      '03121234567', 'metro@traders.pk',    'Model Town',         'Lahore',    4, 25000],
    ['Pak Distributors',   '03061234567', 'pak@dist.pk',         'Hussain Agahi',      'Multan',    3, 0],
    ['Sunrise Shop',       '03001239999', 'sunrise@shop.pk',     'North Nazimabad',    'Karachi',   5, 5000],
  ];
  const custIds = [];
  for (const [name, phone, email, address, city, commission, opening_balance] of customerData) {
    const r = db.prepare(`INSERT INTO customers (name,phone,email,address,city,commission,opening_balance,balance,status) VALUES (?,?,?,?,?,?,?,?,?)`).run(name,phone,email,address,city,commission,opening_balance,opening_balance,'active');
    custIds.push(r.lastInsertRowid);
  }
  console.log(`👥 ${custIds.length} customers inserted`);

  // Vendors
  const vendorData = [
    ['Master Polymers',         '02134567890', 'info@masterpolymers.pk', 'SITE Area',        'Karachi',  0],
    ['Allied Plastics Mfg',     '04235678901', 'allied@plastics.pk',     'Sundar Ind Estate','Lahore',   0],
    ['Global Plastic Ind.',     '02145678901', 'global@plastic.pk',      'Korangi',          'Karachi',  0],
    ['National Raw Materials',  '02156789012', 'national@rawmat.pk',     'Landhi',           'Karachi',  0],
    ['Sigma Chemicals',         '02167890123', 'sigma@chem.pk',          'North Karachi',    'Karachi',  0],
  ];
  const vendIds = [];
  for (const [name, phone, email, address, city, opening_balance] of vendorData) {
    const r = db.prepare(`INSERT INTO vendors (name,phone,email,address,city,opening_balance,balance,status) VALUES (?,?,?,?,?,?,?,?)`).run(name,phone,email,address,city,opening_balance,opening_balance,'active');
    vendIds.push(r.lastInsertRowid);
  }
  console.log(`🏭 ${vendIds.length} vendors inserted`);

  // Products (plastic goods)
  // [name, category, qty_per_pack, rate, min_stock, initial_stock, vendor_id_idx]
  const productData = [
    ['Water Bucket 15L',       'Buckets',            12, 320,  50, 600, 0],
    ['Storage Box Large',      'Storage Boxes',       6, 850,  30, 300, 2],
    ['Food Container Set 3pc', 'Food Containers',    12, 420,  40, 480, 0],
    ['Water Bottle 1L',        'Water Bottles',      24, 180,  60, 960, 1],
    ['Laundry Tub 25L',        'Laundry Tubs',        6, 680,  20, 180, 0],
    ['Kitchen Colander',       'Colanders / Strainers',12,220, 30, 360, 1],
    ['Dustbin 20L',            'Trash Bins / Dustbins',6,540,  25, 150, 2],
    ['Lunch Box 3pc Set',      'Lunch Boxes',        12, 380,  40, 480, 1],
    ['PP Shopping Bag 50pcs',  'PP Bags',            10, 150,  80,1000, 3],
    ['Spice Jar Set 6pcs',     'Spice Jars',         12, 290,  30, 360, 0],
    ['Ice Tray',               'Ice Trays',          24, 120,  50, 960, 1],
    ['Mug Set 6pcs',           'Mugs & Cups',        12, 350,  30, 360, 2],
    ['Chopping Board Large',   'Chopping Boards',    12, 260,  30, 360, 1],
    ['Soap Dispenser 500ml',   'Soap Dispensers',    12, 310,  25, 300, 0],
    ['Jerry Can 5L',           'Jerry Cans',          6, 480,  20, 180, 4],
  ];
  const prodIds = [];
  for (const [name, category, qty_per_pack, rate, min_stock, stock, vendIdx] of productData) {
    const r = db.prepare(`INSERT INTO products (name,category,qty_per_pack,rate,purchase_price,selling_price,min_stock,stock,unit,status,vendor_id) VALUES (?,?,?,?,?,?,?,?,'PCS','active',?)`).run(name,category,qty_per_pack,rate,Math.round(rate*0.75),rate,min_stock,stock,vendIds[vendIdx]);
    prodIds.push(r.lastInsertRowid);
  }
  console.log(`📦 ${prodIds.length} products inserted`);

  // Warehouses
  const wh1 = db.prepare(`INSERT INTO warehouses (name,location,manager,phone,status) VALUES (?,?,?,?,?)`).run('Main Warehouse','SITE Area, Karachi','Rashid Khan','03001111111','active');
  const wh2 = db.prepare(`INSERT INTO warehouses (name,location,manager,phone,status) VALUES (?,?,?,?,?)`).run('Lahore Branch','Sundar Estate, Lahore','Tariq Mehmood','03111112222','active');
  const whIds = [wh1.lastInsertRowid, wh2.lastInsertRowid];

  // Seed warehouse stock
  for (const pid of prodIds) {
    const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(pid);
    const mainQty = Math.floor(prod.stock * 0.7);
    const lhQty = prod.stock - mainQty;
    db.prepare(`INSERT INTO warehouse_stock (warehouse_id,product_id,quantity) VALUES (?,?,?)`).run(whIds[0], pid, mainQty);
    db.prepare(`INSERT INTO warehouse_stock (warehouse_id,product_id,quantity) VALUES (?,?,?)`).run(whIds[1], pid, lhQty);
  }
  console.log('🏗️  Warehouses & stock seeded');

  // Bank Accounts
  const ba1 = db.prepare(`INSERT INTO bank_accounts (account_name,bank_name,account_number,account_type,opening_balance,balance,status) VALUES (?,?,?,?,?,?,?)`).run('MCB Current Account','MCB Bank','1234-5678-9012','bank',500000,500000,'active');
  const ba2 = db.prepare(`INSERT INTO bank_accounts (account_name,bank_name,account_number,account_type,opening_balance,balance,status) VALUES (?,?,?,?,?,?,?)`).run('Cash Account','Cash',null,'cash',100000,100000,'active');
  const bankIds = [ba1.lastInsertRowid, ba2.lastInsertRowid];
  console.log('🏦 Bank accounts seeded');

  // Rate list
  const rateTypes = ['retail','wholesale'];
  for (const pid of prodIds) {
    const prod = db.prepare('SELECT rate FROM products WHERE id=?').get(pid);
    for (const rt of rateTypes) {
      const r = rt === 'wholesale' ? prod.rate * 0.92 : prod.rate;
      db.prepare(`INSERT INTO rate_list (product_id,customer_type,rate,effective_date) VALUES (?,?,?,'2025-01-01')`).run(pid, rt, Math.round(r));
    }
  }
  console.log('💰 Rate list seeded');

  // ─── TRANSACTIONAL DATA ───────────────────────────────────────────────────

  let orderCounter = 0;
  let invoiceCounter = 0;
  let purchaseCounter = 0;
  let paymentCounter = 0;
  let biltyCounter = 0;
  let breakageCounter = 0;
  let creditNoteCounter = 0;
  let journalCounter = 0;

  const pad = (n, p=5) => n.toString().padStart(p,'0');
  const fmtDate = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  // Month list: Jan 2025 → Apr 2026
  const months = [];
  for (let y = 2025; y <= 2026; y++) {
    const start = (y === 2025) ? 1 : 1;
    const end   = (y === 2026) ? 4 : 12;
    for (let m = start; m <= end; m++) months.push([y, m]);
  }

  // Helper: days in month
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

  // Helper: random int
  const ri = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const pick = arr => arr[ri(0, arr.length-1)];

  // ─── MONTH-BY-MONTH LOOP ─────────────────────────────────────────────────
  for (const [year, month] of months) {
    const days = daysInMonth(year, month);
    const monthLabel = `${year}-${String(month).padStart(2,'0')}`;
    console.log(`\n📅 Processing ${monthLabel}...`);

    // ── PURCHASES (3–5 per month) ──────────────────────────────────────────
    const purchaseCount = ri(3, 5);
    for (let p = 0; p < purchaseCount; p++) {
      purchaseCounter++;
      const purchDate = fmtDate(year, month, ri(1, Math.floor(days/2)));
      const vendId = pick(vendIds);
      // Pick 2-4 products to purchase
      const numItems = ri(2, 4);
      const shuffled = [...prodIds].sort(() => Math.random()-0.5).slice(0, numItems);
      let subtotal = 0;
      const pItems = [];
      for (const pid of shuffled) {
        const prod = db.prepare('SELECT rate, qty_per_pack FROM products WHERE id=?').get(pid);
        if (!prod) continue;
        const packs = ri(2, 10);
        const qty = packs * (prod.qty_per_pack || 1);
        const rate = Math.round(prod.rate * 0.75); // buy at 75% of sell rate
        const amt = qty * rate;
        subtotal += amt;
        pItems.push({ pid, packs, pkg: prod.qty_per_pack || 1, qty, rate, amt });
      }
      const purchNo = `PUR-${pad(purchaseCounter)}`;
      const pr = db.prepare(`INSERT INTO purchases (purchase_no,vendor_id,purchase_date,status,subtotal,discount,total,notes) VALUES (?,?,?,'received',?,0,?,?)`).run(purchNo, vendId, purchDate, subtotal, subtotal, `Monthly restock ${monthLabel}`);
      const purId = pr.lastInsertRowid;
      for (const it of pItems) {
        db.prepare(`INSERT INTO purchase_items (purchase_id,product_id,packages,packaging,quantity,rate,amount) VALUES (?,?,?,?,?,?,?)`).run(purId, it.pid, it.packs, it.pkg, it.qty, it.rate, it.amt);
        db.prepare(`UPDATE products SET stock = stock + ? WHERE id=?`).run(it.qty, it.pid);
        // Update warehouse stock (70% to main, 30% to Lahore)
        const mainQ = Math.floor(it.qty * 0.7);
        db.prepare(`UPDATE warehouse_stock SET quantity = quantity + ? WHERE warehouse_id=? AND product_id=?`).run(mainQ, whIds[0], it.pid);
        db.prepare(`UPDATE warehouse_stock SET quantity = quantity + ? WHERE warehouse_id=? AND product_id=?`).run(it.qty-mainQ, whIds[1], it.pid);
      }
      // Vendor ledger
      addLedgerEntry(db, 'vendor', vendId, purchDate, `Purchase ${purchNo}`, subtotal, 0, 'purchase', purId);
      // Pay vendor (60% immediately, rest next month)
      const paidNow = Math.round(subtotal * 0.6);
      if (paidNow > 0) {
        const pmtDate = fmtDate(year, month, ri(Math.floor(days/2)+1, days));
        db.prepare(`INSERT INTO payments (entity_type,entity_id,amount,payment_date,payment_method,reference,notes) VALUES ('vendor',?,?,?,'bank',?,'Partial payment for ${purchNo}')`).run(vendId, paidNow, pmtDate, `VPM-${pad(purchaseCounter)}`);
        addLedgerEntry(db, 'vendor', vendId, pmtDate, `Payment for ${purchNo}`, 0, paidNow, 'payment', purId);
        // Bank transaction
        db.prepare(`INSERT INTO bank_transactions (account_id,txn_date,txn_type,amount,description,reference,balance) VALUES (?,?,?,?,?,?,?)`).run(bankIds[0], pmtDate,'debit', paidNow, `Vendor payment - ${purchNo}`, `VPM-${pad(purchaseCounter)}`, 0);
      }
    }

    // ── ORDERS (6–10 per month) → most become invoices ────────────────────
    const orderCount = ri(6, 10);
    for (let o = 0; o < orderCount; o++) {
      orderCounter++;
      const orderDay = ri(1, days-5);
      const orderDate = fmtDate(year, month, orderDay);
      const delivDay = Math.min(orderDay + ri(2, 5), days);
      const delivDate = fmtDate(year, month, delivDay);
      const custId = pick(custIds);
      const cust = db.prepare('SELECT commission FROM customers WHERE id=?').get(custId);
      const commPct = cust ? (cust.commission || 0) : 0;

      // 2-4 items per order
      const numItems = ri(2, 4);
      const shuffled = [...prodIds].sort(() => Math.random()-0.5).slice(0, numItems);
      let subtotal = 0;
      const oItems = [];
      for (const pid of shuffled) {
        const prod = db.prepare('SELECT rate, qty_per_pack, stock FROM products WHERE id=?').get(pid);
        if (!prod || prod.stock < 1) continue;
        const packs = ri(2, 20);
        const qty = packs * (prod.qty_per_pack || 1);
        const rate = prod.rate;
        const amt = qty * rate;
        subtotal += amt;
        oItems.push({ pid, packs, pkg: prod.packaging, qty, rate, amt });
      }
      if (oItems.length === 0) continue;

      const commission = Math.round(subtotal * commPct / 100);
      const orderNo = `ORD-${pad(orderCounter)}`;
      const or = db.prepare(`INSERT INTO orders (order_no,customer_id,order_date,delivery_date,status,subtotal,discount,total,commission_pct,commission_amount,notes) VALUES (?,?,?,?,'confirmed',?,0,?,?,?,?)`).run(orderNo, custId, orderDate, delivDate, subtotal, subtotal, commPct, commission, `Order ${monthLabel}`);
      const orderId = or.lastInsertRowid;
      for (const it of oItems) {
        db.prepare(`INSERT INTO order_items (order_id,product_id,packages,packaging,quantity,rate,amount) VALUES (?,?,?,?,?,?,?)`).run(orderId, it.pid, it.packs, it.pkg, it.qty, it.rate, it.amt);
      }

      // ── BILTY for ~40% of orders ───────────────────────────────────────
      if (Math.random() < 0.4) {
        biltyCounter++;
        const bDate = fmtDate(year, month, Math.min(delivDay, days));
        const transports = ['Daewoo Cargo','Al-Hamid Transport','TCS Cargo','Pak Goods Transport','Rehman Cargo'];
        const cities = ['Karachi','Lahore','Hyderabad','Peshawar','Multan','Faisalabad'];
        const freight = ri(500, 3000);
        const biltyNo = `BLT-${pad(biltyCounter)}`;
        db.prepare(`INSERT INTO bilty (bilty_no,order_id,transport_name,from_city,to_city,bilty_date,freight_charges,weight,packages_count,status) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(biltyNo, orderId, pick(transports),'Karachi', pick(cities), bDate, freight, `${ri(50,500)} kg`, oItems.reduce((s,i)=>s+i.packs,0), 'delivered');
      }

      // ── INVOICE for 85% of orders ──────────────────────────────────────
      if (Math.random() < 0.85) {
        invoiceCounter++;
        const invDay = Math.min(delivDay + ri(0, 3), days);
        const invDate = fmtDate(year, month, invDay);
        const dueDate = fmtDate(year, month+1 > 12 ? 1 : month+1, 15);
        const invoiceNo = `INV-${pad(invoiceCounter)}`;
        const ir = db.prepare(`INSERT INTO invoices (invoice_no,order_id,customer_id,invoice_date,due_date,subtotal,discount,total,commission_pct,commission_amount,status,notes) VALUES (?,?,?,?,?,?,0,?,?,?,'unpaid',?)`).run(invoiceNo, orderId, custId, invDate, dueDate, subtotal, subtotal, commPct, commission, `Invoice for ${orderNo}`);
        const invId = ir.lastInsertRowid;
        for (const it of oItems) {
          db.prepare(`INSERT INTO invoice_items (invoice_id,product_id,packages,packaging,quantity,rate,amount) VALUES (?,?,?,?,?,?,?)`).run(invId, it.pid, it.packs, it.pkg, it.qty, it.rate, it.amt);
          db.prepare(`UPDATE products SET stock = stock - ? WHERE id=?`).run(it.qty, it.pid);
        }
        db.prepare(`UPDATE orders SET status='confirmed' WHERE id=?`).run(orderId);
        // Customer ledger
        addLedgerEntry(db, 'customer', custId, invDate, `Invoice ${invoiceNo}`, subtotal, 0, 'invoice', invId);

        // ── PAYMENT for ~70% of invoices ────────────────────────────────
        if (Math.random() < 0.70) {
          paymentCounter++;
          const pmtDay = Math.min(invDay + ri(3, 20), days);
          const pmtDate = fmtDate(year, month, pmtDay);
          const paidPct = Math.random() < 0.5 ? 1.0 : (Math.random() < 0.5 ? 0.5 : 0.75);
          const paidAmt = Math.round(subtotal * paidPct);
          const pmtMethod = Math.random() < 0.6 ? 'bank' : 'cash';
          db.prepare(`INSERT INTO payments (entity_type,entity_id,amount,payment_date,payment_method,reference,notes) VALUES ('customer',?,?,?,?,?,'Payment for ${invoiceNo}')`).run(custId, paidAmt, pmtDate, pmtMethod, `REC-${pad(paymentCounter)}`);
          addLedgerEntry(db, 'customer', custId, pmtDate, `Payment rcvd ${invoiceNo}`, 0, paidAmt, 'payment', invId);
          const newPaid = paidAmt;
          const newStatus = paidAmt >= subtotal ? 'paid' : 'partial';
          db.prepare(`UPDATE invoices SET paid=?, status=? WHERE id=?`).run(newPaid, newStatus, invId);
          // Bank
          db.prepare(`INSERT INTO bank_transactions (account_id,txn_date,txn_type,amount,description,reference,balance) VALUES (?,?,?,?,?,?,?)`).run(pmtMethod==='bank'?bankIds[0]:bankIds[1], pmtDate,'credit',paidAmt,`Customer payment - ${invoiceNo}`,`REC-${pad(paymentCounter)}`,0);
        }
      }
    }

    // ── EXPENSES (3-6 per month) ──────────────────────────────────────────
    const expenseTemplates = [
      ['Staff Salary',         5000, 15000],
      ['Rent',                 25000,35000],
      ['Electricity',          3000, 8000],
      ['Transport / Freight',  1500, 5000],
      ['Packaging Material',   2000, 6000],
      ['Loading / Unloading',  500,  2000],
      ['Tea & Refreshments',   300,  800],
      ['Fuel',                 1000, 3000],
      ['Repair & Maintenance', 1000, 5000],
      ['Printing & Stationery',500,  2000],
      ['Bank Charges',         200,  500],
      ['Generator Fuel',       800,  2500],
      ['Security Guard',       8000, 12000],
      ['Miscellaneous',        500,  3000],
    ];
    const expCount = ri(3, 6);
    const chosenExp = [...expenseTemplates].sort(()=>Math.random()-0.5).slice(0, expCount);
    for (const [cat, minAmt, maxAmt] of chosenExp) {
      const expDay = ri(1, days);
      const expAmt = ri(minAmt, maxAmt);
      const pmMethod = Math.random() < 0.6 ? 'cash' : 'bank';
      db.prepare(`INSERT INTO expenses (category,description,amount,expense_date,payment_method,reference) VALUES (?,?,?,?,?,?)`).run(cat, `${cat} - ${monthLabel}`, expAmt, fmtDate(year,month,expDay), pmMethod, `EXP-${monthLabel}`);
      // Bank debit for bank expenses
      if (pmMethod === 'bank') {
        db.prepare(`INSERT INTO bank_transactions (account_id,txn_date,txn_type,amount,description,reference,balance) VALUES (?,?,?,?,?,?,?)`).run(bankIds[0], fmtDate(year,month,expDay),'debit',expAmt,`Expense: ${cat}`,`EXP-${monthLabel}`,0);
      }
    }

    // ── STOCK ADJUSTMENT (~1 per month) ───────────────────────────────────
    if (Math.random() < 0.7) {
      const adjProd = pick(prodIds);
      const adjQty = ri(-20, 20);
      const adjTypes = ['damage','recount','return','write-off'];
      const adjType = adjQty < 0 ? pick(['damage','write-off']) : pick(['return','recount']);
      db.prepare(`INSERT INTO stock_adjustments (product_id,warehouse_id,adjustment_type,quantity,reason,reference,adj_date) VALUES (?,?,?,?,?,?,?)`).run(adjProd, pick(whIds), adjType, adjQty, `Monthly stock check`, `ADJ-${monthLabel}`, fmtDate(year,month,ri(25,days)));
      db.prepare(`UPDATE products SET stock = MAX(0, stock + ?) WHERE id=?`).run(adjQty, adjProd);
    }

    // ── BREAKAGE (every 2 months) ─────────────────────────────────────────
    if (month % 2 === 0) {
      breakageCounter++;
      const brProd = pick(prodIds);
      const brCust = pick(custIds);
      const brQty = ri(5, 30);
      const brProd2 = db.prepare('SELECT rate FROM products WHERE id=?').get(brProd);
      const brAdj = brProd2 ? Math.round(brQty * brProd2.rate * 0.8) : 0;
      db.prepare(`INSERT INTO breakage (customer_id,product_id,quantity,reason,claim_status,claim_type,adjustment_amount,breakage_date) VALUES (?,?,?,?,?,?,?,?)`).run(brCust, brProd, brQty, 'In-transit damage', Math.random()<0.6?'approved':'pending', 'customer', brAdj, fmtDate(year,month,ri(10,20)));
    }

    // ── CREDIT NOTE (every 2 months) ─────────────────────────────────────
    if (month % 2 === 1) {
      creditNoteCounter++;
      const cnCust = pick(custIds);
      const cnProd = pick(prodIds);
      const cnProd2 = db.prepare('SELECT rate FROM products WHERE id=?').get(cnProd);
      const cnQty = ri(5, 20);
      const cnRate = cnProd2 ? cnProd2.rate : 300;
      const cnAmt = cnQty * cnRate;
      const cnNo = `CN-${pad(creditNoteCounter)}`;
      const cnr = db.prepare(`INSERT INTO credit_notes (note_no,note_type,customer_id,note_date,amount,reason,status) VALUES (?,?,?,?,?,'Product return / quality issue','approved')`).run(cnNo, 'credit', cnCust, fmtDate(year,month,ri(5,15)), cnAmt);
      db.prepare(`INSERT INTO credit_note_items (note_id,product_id,quantity,rate,amount) VALUES (?,?,?,?,?)`).run(cnr.lastInsertRowid, cnProd, cnQty, cnRate, cnAmt);
    }

    // ── JOURNAL ENTRY (monthly) ───────────────────────────────────────────
    journalCounter++;
    const jNo = `JV-${pad(journalCounter)}`;
    const jAmt = ri(5000, 20000);
    const jr = db.prepare(`INSERT INTO journal_entries (entry_no,entry_date,description,reference,status) VALUES (?,?,?,?,?)`).run(jNo, fmtDate(year,month,days), `Monthly closing entry ${monthLabel}`, jNo, 'posted');
    const jId = jr.lastInsertRowid;
    db.prepare(`INSERT INTO journal_lines (entry_id,account,description,debit,credit) VALUES (?,?,?,?,?)`).run(jId,'Sales Revenue','Monthly sales',0,jAmt);
    db.prepare(`INSERT INTO journal_lines (entry_id,account,description,debit,credit) VALUES (?,?,?,?,?)`).run(jId,'Cash/Bank','Monthly receipts',jAmt,0);
  }

  // ── EXTRA: A FEW PENDING ORDERS (Apr 2026 – active work in progress) ────
  const currentPending = [
    ['2026-04-10', 0, 'Urgent delivery needed'],
    ['2026-04-14', 1, 'Hold for bilty confirmation'],
    ['2026-04-17', 2, null],
  ];
  for (const [oDate, cIdx, notes] of currentPending) {
    orderCounter++;
    const custId = custIds[cIdx];
    const cust = db.prepare('SELECT commission FROM customers WHERE id=?').get(custId);
    const commPct = cust ? (cust.commission || 0) : 0;
    const pid1 = prodIds[ri(0, prodIds.length-1)];
    const pid2 = prodIds[ri(0, prodIds.length-1)];
    const prod1 = db.prepare('SELECT rate, qty_per_pack FROM products WHERE id=?').get(pid1);
    const prod2 = db.prepare('SELECT rate, qty_per_pack FROM products WHERE id=?').get(pid2);
    const qty1 = ri(2,10) * (prod1.qty_per_pack || 1);
    const qty2 = ri(2,10) * (prod2.qty_per_pack || 1);
    const subtotal = qty1*prod1.rate + qty2*prod2.rate;
    const commission = Math.round(subtotal * commPct / 100);
    const orderNo = `ORD-${pad(orderCounter)}`;
    const or = db.prepare(`INSERT INTO orders (order_no,customer_id,order_date,delivery_date,status,subtotal,discount,total,commission_pct,commission_amount,notes) VALUES (?,?,?,?,'pending',?,0,?,?,?,?)`).run(orderNo, custId, oDate, null, subtotal, subtotal, commPct, commission, notes);
    const orderId = or.lastInsertRowid;
    db.prepare(`INSERT INTO order_items (order_id,product_id,packages,packaging,quantity,rate,amount) VALUES (?,?,?,?,?,?,?)`).run(orderId, pid1, Math.floor(qty1/(prod1.qty_per_pack||1)), (prod1.qty_per_pack||1), qty1, prod1.rate, qty1*prod1.rate);
    db.prepare(`INSERT INTO order_items (order_id,product_id,packages,packaging,quantity,rate,amount) VALUES (?,?,?,?,?,?,?)`).run(orderId, pid2, Math.floor(qty2/(prod2.qty_per_pack||1)), (prod2.qty_per_pack||1), qty2, prod2.rate, qty2*prod2.rate);
  }

  // ── UPDATE BANK BALANCES (recalculate from transactions) ─────────────────
  for (const bid of bankIds) {
    const ba = db.prepare('SELECT opening_balance FROM bank_accounts WHERE id=?').get(bid);
    const credits = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM bank_transactions WHERE account_id=? AND txn_type='credit'`).get(bid);
    const debits  = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM bank_transactions WHERE account_id=? AND txn_type='debit'`).get(bid);
    const bal = (ba ? ba.opening_balance : 0) + (credits ? credits.s : 0) - (debits ? debits.s : 0);
    db.prepare('UPDATE bank_accounts SET balance=? WHERE id=?').run(bal, bid);
  }

  console.log('\n✅ SEED COMPLETE!');
  console.log(`   Orders    : ${orderCounter}`);
  console.log(`   Invoices  : ${invoiceCounter}`);
  console.log(`   Purchases : ${purchaseCounter}`);
  console.log(`   Payments  : ${paymentCounter}`);
  console.log(`   Bilty     : ${biltyCounter}`);
  console.log(`   Breakage  : ${breakageCounter}`);
  console.log(`   CreditNotes: ${creditNoteCounter}`);
  console.log(`   Journals  : ${journalCounter}`);
}

// ─── INLINE LEDGER HELPER (no transaction wrapping needed here) ────────────
function addLedgerEntry(db, entityType, entityId, date, description, debit, credit, refType, refId) {
  const lastEntry = db.prepare(`SELECT balance FROM ledger WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 1`).get(entityType, entityId);
  const prevBalance = lastEntry ? lastEntry.balance : 0;
  const newBalance = prevBalance + debit - credit;
  db.prepare(`INSERT INTO ledger (entity_type,entity_id,txn_date,description,debit,credit,balance,reference_type,reference_id) VALUES (?,?,?,?,?,?,?,?,?)`).run(entityType,entityId,date,description,debit,credit,newBalance,refType,refId);
  if (entityType === 'customer') db.prepare(`UPDATE customers SET balance=? WHERE id=?`).run(newBalance, entityId);
  else if (entityType === 'vendor') db.prepare(`UPDATE vendors SET balance=? WHERE id=?`).run(newBalance, entityId);
  return newBalance;
}

seed()
  .then(() => { console.log('\n🚀 Server can now be started: node index.js'); process.exit(0); })
  .catch(err => { console.error('❌ Seed error:', err); process.exit(1); });
