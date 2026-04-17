const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'markaz_erp.db');

// ============ SQL.JS WRAPPER (better-sqlite3 compatible API) ============
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._inTransaction = false;
  }

  exec(sql) {
    this._db.run(sql);
  }

  prepare(sql) {
    const wrapper = this;
    const db = this._db;
    return {
      get(...params) {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        const result = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return result;
      },
      all(...params) {
        const results = [];
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
      run(...params) {
        // sql.js throws on undefined; convert to null (SQL NULL)
        const sanitized = params.map(p => (p === undefined ? null : p));
        db.run(sql, sanitized);
        const lastId = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0];
        const changes = db.getRowsModified();
        // Only save to disk outside transactions (transaction saves on commit)
        if (!wrapper._inTransaction) _saveDb(db);
        return { lastInsertRowid: lastId, changes };
      }
    };
  }

  transaction(fn) {
    const self = this;
    return function (...args) {
      self._db.run("BEGIN TRANSACTION");
      self._inTransaction = true;
      try {
        const result = fn(...args);
        self._db.run("COMMIT");
        self._inTransaction = false;
        _saveDb(self._db);
        return result;
      } catch (e) {
        self._db.run("ROLLBACK");
        self._inTransaction = false;
        throw e;
      }
    };
  }
}

function _saveDb(sqlDb) {
  const data = sqlDb.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ============ ASYNC INIT ============
let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new DatabaseWrapper(sqlDb);

  // Enable foreign keys
  db.exec("PRAGMA foreign_keys = ON;");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      opening_balance REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      opening_balance REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      packaging INTEGER DEFAULT 1,
      stock INTEGER DEFAULT 0,
      rate REAL DEFAULT 0,
      min_stock INTEGER DEFAULT 10,
      unit TEXT DEFAULT 'piece',
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rate_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      customer_type TEXT DEFAULT 'retail',
      rate REAL NOT NULL,
      effective_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE,
      customer_id INTEGER NOT NULL,
      order_date TEXT NOT NULL,
      delivery_date TEXT,
      status TEXT DEFAULT 'pending',
      subtotal REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      packages INTEGER DEFAULT 0,
      packaging INTEGER DEFAULT 1,
      quantity INTEGER NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE,
      order_id INTEGER,
      customer_id INTEGER NOT NULL,
      invoice_date TEXT NOT NULL,
      due_date TEXT,
      subtotal REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      paid REAL DEFAULT 0,
      status TEXT DEFAULT 'unpaid',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      packages INTEGER DEFAULT 0,
      packaging INTEGER DEFAULT 1,
      quantity INTEGER NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_no TEXT UNIQUE,
      vendor_id INTEGER NOT NULL,
      purchase_date TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      subtotal REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      packages INTEGER DEFAULT 0,
      packaging INTEGER DEFAULT 1,
      quantity INTEGER NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      expense_date TEXT NOT NULL,
      payment_method TEXT DEFAULT 'cash',
      reference TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bilty (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bilty_no TEXT,
      order_id INTEGER,
      invoice_id INTEGER,
      transport_name TEXT NOT NULL,
      from_city TEXT NOT NULL,
      to_city TEXT NOT NULL,
      bilty_date TEXT NOT NULL,
      freight_charges REAL DEFAULT 0,
      weight TEXT,
      packages_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_transit',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS breakage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      invoice_id INTEGER,
      customer_id INTEGER,
      vendor_id INTEGER,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT,
      claim_status TEXT DEFAULT 'pending',
      claim_type TEXT DEFAULT 'customer',
      adjustment_amount REAL DEFAULT 0,
      breakage_date TEXT NOT NULL,
      resolved_date TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      txn_date TEXT NOT NULL,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      reference_type TEXT,
      reference_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      payment_method TEXT DEFAULT 'cash',
      reference TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      record_id INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      location TEXT,
      manager TEXT,
      phone TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS warehouse_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 0,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER,
      adjustment_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT,
      reference TEXT,
      adj_date TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name TEXT NOT NULL,
      bank_name TEXT,
      account_number TEXT,
      account_type TEXT DEFAULT 'bank',
      opening_balance REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      txn_date TEXT NOT NULL,
      txn_type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      reference TEXT,
      balance REAL DEFAULT 0,
      related_type TEXT,
      related_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES bank_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS credit_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_no TEXT UNIQUE,
      note_type TEXT NOT NULL,
      customer_id INTEGER,
      vendor_id INTEGER,
      invoice_id INTEGER,
      purchase_id INTEGER,
      note_date TEXT NOT NULL,
      amount REAL DEFAULT 0,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    );

    CREATE TABLE IF NOT EXISTS credit_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (note_id) REFERENCES credit_notes(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS party_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cat_group TEXT NOT NULL,
      applies_to TEXT DEFAULT 'both',
      color TEXT DEFAULT 'secondary',
      sort_order INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS product_rate_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      old_rate REAL DEFAULT 0,
      new_rate REAL DEFAULT 0,
      changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_no TEXT UNIQUE,
      entry_date TEXT NOT NULL,
      description TEXT,
      reference TEXT,
      status TEXT DEFAULT 'posted',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      account TEXT NOT NULL,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
  `);

  // Create indexes (one at a time for sql.js)
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_ledger_entity ON ledger(entity_type, entity_id)",
    "CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger(txn_date)",
    "CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_purchases_vendor ON purchases(vendor_id)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)",
    "CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)",
    "CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id)",
    "CREATE INDEX IF NOT EXISTS idx_bilty_order ON bilty(order_id)",
    "CREATE INDEX IF NOT EXISTS idx_breakage_product ON breakage(product_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module)",
    "CREATE INDEX IF NOT EXISTS idx_stock_adj_product ON stock_adjustments(product_id)",
    "CREATE INDEX IF NOT EXISTS idx_wh_stock ON warehouse_stock(warehouse_id, product_id)",
    "CREATE INDEX IF NOT EXISTS idx_bank_txn ON bank_transactions(account_id)",
    "CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id)"
  ];
  for (const idx of indexes) {
    db.exec(idx);
  }

  // Migrations: add columns that may not exist in older DBs
  const migrations = [
    "ALTER TABLE customers ADD COLUMN category TEXT DEFAULT 'general'",
    "ALTER TABLE customers ADD COLUMN notes TEXT",
    "ALTER TABLE customers ADD COLUMN region TEXT DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN party_type TEXT DEFAULT ''",
    "ALTER TABLE customers ADD COLUMN commission REAL DEFAULT 0",
    "ALTER TABLE vendors ADD COLUMN category TEXT DEFAULT 'general'",
    "ALTER TABLE vendors ADD COLUMN region TEXT DEFAULT ''",
    "ALTER TABLE vendors ADD COLUMN party_type TEXT DEFAULT ''",
    "ALTER TABLE vendors ADD COLUMN notes TEXT",
    "ALTER TABLE vendors ADD COLUMN commission REAL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN vendor_id INTEGER",
    "ALTER TABLE orders ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE expenses ADD COLUMN paid_to TEXT",
    "ALTER TABLE orders ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE warehouses ADD COLUMN notes TEXT",
    "ALTER TABLE rate_list ADD COLUMN packaging INTEGER DEFAULT 1",
    "ALTER TABLE rate_list ADD COLUMN commission_pct REAL DEFAULT 0",
  ];
  for (const m of migrations) {
    try { db.exec(m); } catch(e) { /* column already exists */ }
  }

  // Seed default party categories
  const catCount = db.prepare('SELECT COUNT(*) as cnt FROM party_categories').get();
  if (!catCount || catCount.cnt === 0) {
    const cats = [
      ['Local', 'region', 'both', 'success', 1],
      ['Upcountry', 'region', 'both', 'info', 2],
      ['Karachi', 'region', 'both', 'primary', 3],
      ['Lahore', 'region', 'both', 'warning', 4],
      ['Retail', 'type', 'customer', 'secondary', 1],
      ['Wholesale', 'type', 'customer', 'dark', 2],
      ['Shop', 'type', 'customer', 'primary', 3],
      ['Distributor', 'type', 'customer', 'success', 4],
      ['Manufacturer', 'type', 'vendor', 'dark', 1],
      ['Importer', 'type', 'vendor', 'info', 2],
      ['Trader', 'type', 'vendor', 'secondary', 3],
    ];
    for (const [name, cat_group, applies_to, color, sort_order] of cats) {
      db.prepare('INSERT INTO party_categories (name, cat_group, applies_to, color, sort_order) VALUES (?, ?, ?, ?, ?)').run(name, cat_group, applies_to, color, sort_order);
    }
  }

  // Seed expense categories
  const expCatCount = db.prepare('SELECT COUNT(*) as cnt FROM expense_categories').get();
  if (!expCatCount || expCatCount.cnt === 0) {
    const expCats = [
      'Rent', 'Electricity', 'Gas', 'Water', 'Internet / Phone',
      'Staff Salary', 'Worker Wages', 'Overtime Pay', 'Bonus',
      'Transport / Freight', 'Fuel', 'Vehicle Maintenance',
      'Packaging Material', 'Printing & Stationery', 'Office Supplies',
      'Loading / Unloading', 'Warehouse Charges', 'Storage Fee',
      'Bank Charges', 'Loan Interest', 'Commission Paid',
      'Repair & Maintenance', 'Generator Fuel', 'Security Guard',
      'Cleaning / Janitorial', 'Tea & Refreshments', 'Guest Entertainment',
      'Marketing / Advertising', 'Exhibition / Fair Expense',
      'Custom / Import Duty', 'Tax Payment', 'Government Fee',
      'Insurance', 'Medical / First Aid', 'Miscellaneous'
    ];
    expCats.forEach((name, i) => {
      db.prepare('INSERT INTO expense_categories (name, sort_order) VALUES (?, ?)').run(name, i + 1);
    });
  }

  // Seed plastic product categories
  const prodCatCount = db.prepare('SELECT COUNT(*) as cnt FROM product_categories').get();
  if (!prodCatCount || prodCatCount.cnt === 0) {
    const prodCats = [
      // Storage & Containers
      'Airtight Containers', 'Food Containers', 'Lunch Boxes', 'Tiffin Boxes',
      'Water Bottles', 'Juice Bottles', 'Milk Bottles', 'Oil Bottles',
      'Storage Jars', 'Spice Jars', 'Kitchen Canisters',
      // Buckets & Tubs
      'Buckets', 'Wash Tubs', 'Laundry Tubs', 'Mixing Bowls',
      'Basins', 'Foot Tubs', 'Storage Boxes',
      // Household Items
      'Mugs & Cups', 'Plates & Trays', 'Serving Bowls', 'Colanders / Strainers',
      'Measuring Jugs', 'Ice Trays', 'Chopping Boards', 'Dustpans',
      'Soap Dispensers', 'Trash Bins / Dustbins',
      // Hangers & Organization
      'Clothes Hangers', 'Laundry Baskets', 'Shoe Racks', 'Drawer Organizers',
      'Stacking Racks', 'Shelves',
      // Bags & Packaging
      'Shopping Bags', 'Zip Lock Bags', 'Garbage Bags', 'PP Bags',
      'Poly Bags', 'Woven Bags',
      // Industrial / Commercial
      'Crates', 'Pallets', 'Drums / Barrels', 'Jerry Cans',
      'Pipes & Fittings', 'Tanks',
      // Other
      'Kids Toys', 'Garden Items', 'Miscellaneous Plastic'
    ];
    prodCats.forEach((name, i) => {
      db.prepare('INSERT INTO product_categories (name, sort_order) VALUES (?, ?)').run(name, i + 1);
    });
  }

  // Seed default settings (only if not already present)
  const defaults = [
    ['business_name', 'PLASTIC MARKAZ'],
    ['business_tagline', 'Plastic Products & Trading'],
    ['business_address', ''],
    ['business_phone', ''],
    ['business_city', ''],
    ['business_email', ''],
    ['customer_categories', 'Local,Upcountry,Wholesale,Retail,Export'],
    ['vendor_categories', 'Local,Upcountry,Importer,Manufacturer'],
    ['invoice_footer', 'Thank you for your business!'],
    ['invoice_terms', 'Payment due within 30 days.'],
    ['currency_symbol', 'Rs.'],
  ];
  for (const [key, val] of defaults) {
    const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (!existing) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, val);
  }

  _saveDb(sqlDb);
  return db;
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

// ============ HELPER FUNCTIONS ============

function generateNumber(prefix, table) {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get();
  const num = ((row?.cnt || 0) + 1).toString().padStart(5, '0');
  return `${prefix}-${num}`;
}

function addLedgerEntry(entityType, entityId, date, description, debit, credit, refType, refId) {
  const lastEntry = db.prepare(
    `SELECT balance FROM ledger WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1`
  ).get(entityType, entityId);

  const prevBalance = lastEntry ? lastEntry.balance : 0;
  const newBalance = prevBalance + debit - credit;

  db.prepare(
    `INSERT INTO ledger (entity_type, entity_id, txn_date, description, debit, credit, balance, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entityType, entityId, date, description, debit, credit, newBalance, refType, refId);

  if (entityType === 'customer') {
    db.prepare(`UPDATE customers SET balance = ? WHERE id = ?`).run(newBalance, entityId);
  } else if (entityType === 'vendor') {
    db.prepare(`UPDATE vendors SET balance = ? WHERE id = ?`).run(newBalance, entityId);
  }

  return newBalance;
}

function addAuditLog(action, module, recordId, details) {
  db.prepare(
    `INSERT INTO audit_log (action, module, record_id, details) VALUES (?, ?, ?, ?)`
  ).run(action, module, recordId, details);
}

// Export a getter so routes always get the initialized db
module.exports = {
  get db() { return db; },
  initDatabase,
  generateNumber,
  addLedgerEntry,
  addAuditLog,
  getSettings
};
