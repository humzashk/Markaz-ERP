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
      sax_no TEXT,
      ntn TEXT,
      credit_days INTEGER DEFAULT 30,
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
      sax_no TEXT,
      ntn TEXT,
      credit_days INTEGER DEFAULT 60,
      opening_balance REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      unit TEXT DEFAULT 'PCS',
      qty_per_pack INTEGER DEFAULT 1,
      purchase_price REAL DEFAULT 0,
      selling_price REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      default_commission_rate REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      min_stock INTEGER DEFAULT 10,
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
      commission_pct REAL DEFAULT 0,
      commission_amount REAL DEFAULT 0,
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
      commission_pct REAL DEFAULT 0,
      commission_amount REAL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS delivery_challans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dc_no TEXT UNIQUE NOT NULL,
      order_id INTEGER NOT NULL,
      dc_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT,
      phone TEXT,
      city TEXT,
      vehicle_no TEXT,
      driver_name TEXT,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bilty (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bilty_no TEXT,
      order_id INTEGER,
      invoice_id INTEGER,
      dc_id INTEGER,
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
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (dc_id) REFERENCES delivery_challans(id)
    );

    CREATE TABLE IF NOT EXISTS breakage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      vendor_id INTEGER,
      order_id INTEGER,
      invoice_id INTEGER,
      product_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 0,
      adjustment_amount REAL DEFAULT 0,
      credit_note_id INTEGER,
      claim_status TEXT DEFAULT 'pending',
      breakage_date TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      status TEXT DEFAULT 'active',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module TEXT NOT NULL,
      UNIQUE(user_id, module),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
    "ALTER TABLE customers ADD COLUMN sax_no TEXT",
    "ALTER TABLE customers ADD COLUMN ntn TEXT",
    "ALTER TABLE customers ADD COLUMN credit_days INTEGER DEFAULT 30",
    "ALTER TABLE vendors ADD COLUMN category TEXT DEFAULT 'general'",
    "ALTER TABLE vendors ADD COLUMN region TEXT DEFAULT ''",
    "ALTER TABLE vendors ADD COLUMN party_type TEXT DEFAULT ''",
    "ALTER TABLE vendors ADD COLUMN notes TEXT",
    "ALTER TABLE vendors ADD COLUMN commission REAL DEFAULT 0",
    "ALTER TABLE vendors ADD COLUMN sax_no TEXT",
    "ALTER TABLE vendors ADD COLUMN ntn TEXT",
    "ALTER TABLE vendors ADD COLUMN credit_days INTEGER DEFAULT 60",
    "ALTER TABLE products ADD COLUMN vendor_id INTEGER",
    "ALTER TABLE products ADD COLUMN item_id TEXT UNIQUE",
    "ALTER TABLE products ADD COLUMN purchase_price REAL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN selling_price REAL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN qty_per_pack INTEGER DEFAULT 1",
    "ALTER TABLE products ADD COLUMN default_commission_rate REAL DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE expenses ADD COLUMN paid_to TEXT",
    "ALTER TABLE orders ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN commission_pct REAL DEFAULT 0",
    // Ensure per-item commission columns exist on older DBs
    "ALTER TABLE invoice_items ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE invoice_items ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE purchase_items ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE purchase_items ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE warehouses ADD COLUMN notes TEXT",
    "ALTER TABLE rate_list ADD COLUMN packaging INTEGER DEFAULT 1",
    "ALTER TABLE rate_list ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN warehouse_id INTEGER",
    "ALTER TABLE orders ADD COLUMN bilty_no TEXT",
    "ALTER TABLE orders ADD COLUMN transporter_name TEXT",
    "ALTER TABLE invoices ADD COLUMN warehouse_id INTEGER",
    "ALTER TABLE invoices ADD COLUMN bilty_no TEXT",
    "ALTER TABLE invoices ADD COLUMN transporter_name TEXT",
    "ALTER TABLE purchases ADD COLUMN warehouse_id INTEGER",
    "ALTER TABLE purchases ADD COLUMN bilty_no TEXT",
    "ALTER TABLE purchase_items ADD COLUMN discount_per_pack REAL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN discount_per_pack REAL DEFAULT 0",
    "ALTER TABLE invoice_items ADD COLUMN discount_per_pack REAL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN packaging INTEGER DEFAULT 1",
    "ALTER TABLE invoice_items ADD COLUMN packaging INTEGER DEFAULT 1",
    "ALTER TABLE purchase_items ADD COLUMN packaging INTEGER DEFAULT 1",
    // Phantom column fixes: ensure products has packaging + base_unit used by /api/products
    "ALTER TABLE products ADD COLUMN packaging INTEGER DEFAULT 1",
    "ALTER TABLE products ADD COLUMN base_unit TEXT DEFAULT 'PCS'",
    // Account scope (multi-company: Plastic Markaz / Wings Furniture / Cooler)
    "ALTER TABLE customers ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    "ALTER TABLE vendors ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    "ALTER TABLE orders ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    "ALTER TABLE invoices ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    "ALTER TABLE purchases ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    "ALTER TABLE payments ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    "ALTER TABLE expenses ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    "ALTER TABLE ledger ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    // Invoice: support delivery/transport charges (+/-) in total
    "ALTER TABLE invoices ADD COLUMN transport_charges REAL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN delivery_charges REAL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN delivery_date TEXT",
    "ALTER TABLE purchases ADD COLUMN delivery_charges REAL DEFAULT 0",
    "ALTER TABLE purchases ADD COLUMN delivery_date TEXT",
    // Commission rollout: ensure header + line items carry commission everywhere
    "ALTER TABLE purchases ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE purchases ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE purchase_items ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE purchase_items ADD COLUMN commission_amount REAL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN commission_pct REAL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN commission_amount REAL DEFAULT 0",
    // Bilty linking + transport reference
    "ALTER TABLE bilty ADD COLUMN order_id INTEGER",
    "ALTER TABLE bilty ADD COLUMN invoice_id INTEGER",
    "ALTER TABLE bilty ADD COLUMN transport_id INTEGER",
    "ALTER TABLE invoices ADD COLUMN transport_id INTEGER",
    "ALTER TABLE purchases ADD COLUMN transport_id INTEGER",
    "ALTER TABLE orders ADD COLUMN transport_id INTEGER",
    // Warehouse location schema (NIAZI CHOWK - UI coming soon)
    "ALTER TABLE warehouses ADD COLUMN floor TEXT",
    "ALTER TABLE warehouses ADD COLUMN room TEXT",
    "ALTER TABLE warehouses ADD COLUMN rack TEXT",
    "ALTER TABLE warehouses ADD COLUMN lot TEXT",
    "ALTER TABLE warehouse_stock ADD COLUMN floor TEXT",
    "ALTER TABLE warehouse_stock ADD COLUMN room TEXT",
    "ALTER TABLE warehouse_stock ADD COLUMN rack TEXT",
    "ALTER TABLE warehouse_stock ADD COLUMN lot TEXT",
    // Payments simplification: cash/cheque/bank_transfer (no invoice linking required)
    // entity_type/entity_id already used — no schema change needed
    // Breakage: missing columns referenced in FK declarations
    "ALTER TABLE breakage ADD COLUMN order_id INTEGER",
    "ALTER TABLE breakage ADD COLUMN invoice_id INTEGER",
    "ALTER TABLE breakage ADD COLUMN vendor_id INTEGER",
    "ALTER TABLE breakage ADD COLUMN claim_status TEXT DEFAULT 'pending'",
    "ALTER TABLE breakage ADD COLUMN credit_note_id INTEGER",
    // Bilty per-account scope
    "ALTER TABLE bilty ADD COLUMN account_scope TEXT DEFAULT 'plastic_markaz'",
    // Audit log: user tracking
    "ALTER TABLE audit_log ADD COLUMN user_id INTEGER",
    // Profit correctness: freeze cost at sale time
    "ALTER TABLE invoice_items ADD COLUMN cost_at_sale REAL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN cost_at_sale REAL DEFAULT 0",
    // Stock movement ledger: insert-only authoritative stock movements
    `CREATE TABLE IF NOT EXISTS stock_ledger (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       product_id INTEGER NOT NULL,
       warehouse_id INTEGER,
       ts TEXT DEFAULT CURRENT_TIMESTAMP,
       qty_delta INTEGER NOT NULL,
       reason TEXT,
       ref_type TEXT,
       ref_id INTEGER,
       user_id INTEGER,
       note TEXT
     )`,
    "CREATE INDEX IF NOT EXISTS idx_stock_ledger_product ON stock_ledger(product_id)",
    "CREATE INDEX IF NOT EXISTS idx_stock_ledger_ref ON stock_ledger(ref_type, ref_id)",
    // System errors: replaces silent try/catch
    `CREATE TABLE IF NOT EXISTS system_errors (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts TEXT DEFAULT CURRENT_TIMESTAMP,
       scope TEXT,
       message TEXT,
       stack TEXT,
       context TEXT,
       user_id INTEGER
     )`,
    "CREATE INDEX IF NOT EXISTS idx_system_errors_ts ON system_errors(ts)",
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

  // Seed/heal default superadmin (username: admin / password: admin123)
  // Ensures user can ALWAYS login. Set RESET_ADMIN=1 env to force password reset.
  try {
    const bcrypt = require('bcryptjs');
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const existing = db.prepare("SELECT id, status FROM users WHERE LOWER(username)='admin'").get();
    if (!existing) {
      const hash = bcrypt.hashSync(adminPass, 10);
      db.prepare(
        'INSERT INTO users (username, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('admin', 'Super Administrator', 'admin@markaz.local', hash, 'superadmin', 'active');
      console.log('[seed] created default admin / ' + adminPass);
    } else {
      // Self-heal: ensure active and superadmin role
      db.prepare("UPDATE users SET status='active', role='superadmin' WHERE id=?").run(existing.id);
      if (process.env.RESET_ADMIN === '1') {
        const hash = bcrypt.hashSync(adminPass, 10);
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, existing.id);
        console.log('[seed] reset admin password to ' + adminPass);
      }
    }
  } catch(e) { console.warn('Seed user skipped:', e.message); }

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

// Safe unique number generator. Picks MAX(numeric suffix)+1 from existing
// rows, then probes with INSERT-collision-tolerant retries against unique col.
function generateNumber(prefix, table, column) {
  const col = column || (
    table === 'orders' ? 'order_no' :
    table === 'invoices' ? 'invoice_no' :
    table === 'purchases' ? 'purchase_no' :
    table === 'credit_notes' ? 'note_no' :
    table === 'payments' ? 'payment_no' :
    table === 'bilty' ? 'bilty_no' : 'no'
  );
  // Get the highest numeric tail in the column
  let next = 1;
  try {
    const rows = db.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE ?`).all(prefix + '-%');
    let max = 0;
    for (const r of rows) {
      if (!r.v) continue;
      const tail = String(r.v).split('-').pop();
      const n = parseInt(tail, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    next = max + 1;
  } catch (_) {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get();
    next = (row?.cnt || 0) + 1;
  }
  // Probe-and-bump until unique (handles concurrent inserts / rare gaps)
  for (let attempts = 0; attempts < 50; attempts++) {
    const candidate = `${prefix}-${String(next).padStart(5, '0')}`;
    try {
      const exists = db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${col} = ? LIMIT 1`).get(candidate);
      if (!exists) return candidate;
    } catch (_) { return candidate; }
    next++;
  }
  // Fallback: timestamp-based
  return `${prefix}-${Date.now()}`;
}

function addLedgerEntry(entityType, entityId, date, description, debit, credit, refType, refId) {
  const dr = Number.isFinite(Number(debit)) ? Number(debit) : 0;
  const cr = Number.isFinite(Number(credit)) ? Number(credit) : 0;

  const lastEntry = db.prepare(
    `SELECT balance FROM ledger WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1`
  ).get(entityType, entityId);
  const prevBalance = lastEntry ? lastEntry.balance : 0;
  const newBalance = prevBalance + dr - cr;

  db.prepare(
    `INSERT INTO ledger (entity_type, entity_id, txn_date, description, debit, credit, balance, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entityType, entityId, date, description, dr, cr, newBalance, refType, refId);

  // Centralized balance update — recompute from full ledger to prevent drift
  if (entityType === 'customer' || entityType === 'vendor') {
    recomputeBalance(entityType, entityId);
  }
  return newBalance;
}

// AsyncLocalStorage for per-request user context (used by addAuditLog)
const { AsyncLocalStorage } = require('async_hooks');
const auditContext = new AsyncLocalStorage();

// =================================================================
// ERROR LOGGING — replaces silent try/catch and dashboard `safe()` fallback
// =================================================================
function logError(scope, err, context) {
  const msg = (err && err.message) ? err.message : String(err);
  const stack = (err && err.stack) ? err.stack : null;
  const ctxStr = context ? (typeof context === 'string' ? context : JSON.stringify(context)) : null;
  let userId = null;
  try { const ctx = auditContext.getStore(); if (ctx && ctx.userId) userId = ctx.userId; } catch(_){}
  // Always log to console first (loud failure)
  console.error('[ERROR]', scope, '→', msg);
  if (stack) console.error(stack);
  // Persist to system_errors table (best-effort)
  try {
    db.prepare(
      `INSERT INTO system_errors (scope, message, stack, context, user_id) VALUES (?, ?, ?, ?, ?)`
    ).run(scope || 'unknown', msg, stack, ctxStr, userId);
  } catch (_) { /* DB itself broken; console already has it */ }
}

// safeQuery: replaces dashboard `safe()` — runs fn, on error logs + returns sentinel.
// Caller can detect failure via the second return value (errored flag).
function safeQuery(scope, fn, fallback) {
  try { return { value: fn(), errored: false }; }
  catch (e) { logError(scope, e); return { value: fallback, errored: true }; }
}

// =================================================================
// VALIDATION HELPERS — strict numeric parsing, reject NaN
// =================================================================
function toNum(v, def) {
  if (v === null || v === undefined || v === '') return (def !== undefined ? def : 0);
  const n = Number(v);
  if (!Number.isFinite(n)) return (def !== undefined ? def : 0);
  return n;
}
function toInt(v, def) {
  if (v === null || v === undefined || v === '') return (def !== undefined ? def : 0);
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return (def !== undefined ? def : 0);
  return n;
}
function assertPositive(scope, name, v) {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${scope}: ${name} must be a non-negative finite number, got ${v}`);
}

// =================================================================
// STOCK LEDGER — insert-only authoritative stock movements
// All stock changes MUST go through applyStockMovement.
// products.stock and warehouse_stock.quantity are kept in sync as a cache.
// =================================================================
function applyStockMovement(productId, warehouseId, qtyDelta, refType, refId, reason, note) {
  const pid = toInt(productId);
  const wid = warehouseId ? toInt(warehouseId) : null;
  const delta = toInt(qtyDelta);
  if (!pid) throw new Error('applyStockMovement: product_id required');
  if (delta === 0) return;
  let userId = null;
  try { const ctx = auditContext.getStore(); if (ctx && ctx.userId) userId = ctx.userId; } catch(_){}

  db.prepare(
    `INSERT INTO stock_ledger (product_id, warehouse_id, qty_delta, reason, ref_type, ref_id, user_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(pid, wid, delta, reason || null, refType || null, refId || null, userId, note || null);

  // Update cached aggregate stock
  db.prepare('UPDATE products SET stock = COALESCE(stock,0) + ? WHERE id = ?').run(delta, pid);

  if (wid) {
    const ex = db.prepare('SELECT id FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?').get(wid, pid);
    if (ex) {
      db.prepare('UPDATE warehouse_stock SET quantity = COALESCE(quantity,0) + ? WHERE id = ?').run(delta, ex.id);
    } else {
      try {
        db.prepare('INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)').run(wid, pid, delta);
      } catch (e) { logError('applyStockMovement.warehouse_stock_insert', e, { wid, pid, delta }); }
    }
  }
}

// Reverse all stock movements previously recorded for a (refType, refId) pair.
// Used when editing or deleting a transaction so we can re-apply cleanly.
function reverseStockForRef(refType, refId) {
  if (!refType || !refId) return;
  const rows = db.prepare(
    `SELECT product_id, warehouse_id, qty_delta FROM stock_ledger WHERE ref_type = ? AND ref_id = ?`
  ).all(refType, refId);
  for (const r of rows) {
    applyStockMovement(r.product_id, r.warehouse_id, -r.qty_delta, refType, refId, 'reverse', 'auto-reversal on edit/delete');
  }
}

// =================================================================
// BALANCE RECOMPUTATION — single source of truth
// Recomputes customers.balance / vendors.balance from ledger.
// Routes should NOT directly UPDATE balance columns.
// =================================================================
function recomputeBalance(entityType, entityId) {
  if (!['customer','vendor'].includes(entityType)) return;
  const row = db.prepare(
    `SELECT COALESCE(SUM(debit) - SUM(credit), 0) as bal FROM ledger WHERE entity_type = ? AND entity_id = ?`
  ).get(entityType, entityId);
  const bal = row ? row.bal : 0;
  if (entityType === 'customer') {
    db.prepare('UPDATE customers SET balance = ? WHERE id = ?').run(bal, entityId);
  } else {
    db.prepare('UPDATE vendors SET balance = ? WHERE id = ?').run(bal, entityId);
  }
  return bal;
}

// Remove ledger entries for a (refType, refId) — used on edit/delete of source doc
function removeLedgerForRef(entityType, entityId, refType, refId) {
  if (!refType || !refId) return;
  db.prepare(`DELETE FROM ledger WHERE entity_type = ? AND entity_id = ? AND reference_type = ? AND reference_id = ?`)
    .run(entityType, entityId, refType, refId);
}

// Lookup current product cost (used to freeze cost_at_sale on invoices)
function getProductCost(productId) {
  const row = db.prepare(
    `SELECT COALESCE(NULLIF(cost_price,0), NULLIF(purchase_price,0), NULLIF(purchase_rate,0), 0) as c
     FROM products WHERE id = ?`
  ).get(productId);
  return row ? Number(row.c) || 0 : 0;
}

function addAuditLog(action, module, recordId, details, userId) {
  // If userId not explicitly passed, pull from request context
  if (userId == null) {
    const ctx = auditContext.getStore();
    if (ctx && ctx.userId) userId = ctx.userId;
  }
  try {
    db.prepare(
      `INSERT INTO audit_log (action, module, record_id, details, user_id) VALUES (?, ?, ?, ?, ?)`
    ).run(action, module, recordId, details, userId || null);
  } catch (e) {
    // Fallback for old schema without user_id column
    try {
      db.prepare(
        `INSERT INTO audit_log (action, module, record_id, details) VALUES (?, ?, ?, ?)`
      ).run(action, module, recordId, details);
    } catch (_) {}
  }
}

// Export a getter so routes always get the initialized db
module.exports = {
  get db() { return db; },
  initDatabase,
  generateNumber,
  addLedgerEntry,
  addAuditLog,
  auditContext,
  getSettings,
  // Integrity helpers (added for stabilization)
  logError,
  safeQuery,
  toNum,
  toInt,
  assertPositive,
  applyStockMovement,
  reverseStockForRef,
  recomputeBalance,
  removeLedgerForRef,
  getProductCost,
  // Stabilization (idempotent boot-time data integrity pass)
  runStabilization: function (opts) {
    try {
      const { runStabilization } = require('./db/stabilize');
      return runStabilization(db, opts);
    } catch (e) {
      try { logError('database.runStabilization', e); } catch (_) {}
      return { error: e && e.message };
    }
  }
};
