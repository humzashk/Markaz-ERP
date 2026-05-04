-- =====================================================================
-- Plastic Markaz ERP — Clean PostgreSQL schema (v2)
-- Single source of truth. No legacy/duplicate columns.
-- =====================================================================

DROP TABLE IF EXISTS audit_log              CASCADE;
DROP TABLE IF EXISTS system_errors          CASCADE;
DROP TABLE IF EXISTS user_permissions       CASCADE;
DROP TABLE IF EXISTS users                  CASCADE;
DROP TABLE IF EXISTS settings               CASCADE;
DROP TABLE IF EXISTS journal_lines          CASCADE;
DROP TABLE IF EXISTS journal_entries        CASCADE;
DROP TABLE IF EXISTS expense_categories     CASCADE;
DROP TABLE IF EXISTS product_categories     CASCADE;
DROP TABLE IF EXISTS party_categories       CASCADE;
DROP TABLE IF EXISTS expenses               CASCADE;
DROP TABLE IF EXISTS payments               CASCADE;
DROP TABLE IF EXISTS ledger                 CASCADE;
DROP TABLE IF EXISTS credit_note_items      CASCADE;
DROP TABLE IF EXISTS credit_notes           CASCADE;
DROP TABLE IF EXISTS bilty                  CASCADE;
DROP TABLE IF EXISTS transports             CASCADE;
DROP TABLE IF EXISTS delivery_challans      CASCADE;
DROP TABLE IF EXISTS breakage               CASCADE;
DROP TABLE IF EXISTS stock_ledger           CASCADE;
DROP TABLE IF EXISTS stock_adjustments      CASCADE;
DROP TABLE IF EXISTS warehouse_stock        CASCADE;
DROP TABLE IF EXISTS warehouses             CASCADE;
DROP TABLE IF EXISTS purchase_items         CASCADE;
DROP TABLE IF EXISTS purchases              CASCADE;
DROP TABLE IF EXISTS invoice_items          CASCADE;
DROP TABLE IF EXISTS invoices               CASCADE;
DROP TABLE IF EXISTS order_items            CASCADE;
DROP TABLE IF EXISTS orders                 CASCADE;
DROP TABLE IF EXISTS rate_list              CASCADE;
DROP TABLE IF EXISTS products               CASCADE;
DROP TABLE IF EXISTS vendors                CASCADE;
DROP TABLE IF EXISTS customers              CASCADE;

DROP TYPE IF EXISTS account_scope_t;
DROP TYPE IF EXISTS entity_type_t;
DROP TYPE IF EXISTS order_status_t;
DROP TYPE IF EXISTS invoice_status_t;
DROP TYPE IF EXISTS purchase_status_t;
DROP TYPE IF EXISTS payment_method_t;
DROP TYPE IF EXISTS active_status_t;
DROP TYPE IF EXISTS user_role_t;
DROP TYPE IF EXISTS note_type_t;

CREATE TYPE account_scope_t  AS ENUM ('plastic_markaz','wings_furniture','cooler');
CREATE TYPE entity_type_t    AS ENUM ('customer','vendor');
CREATE TYPE order_status_t   AS ENUM ('pending','confirmed','invoiced','delivered','cancelled');
CREATE TYPE invoice_status_t AS ENUM ('unpaid','partial','paid','cancelled');
CREATE TYPE purchase_status_t AS ENUM ('pending','received','cancelled');
CREATE TYPE payment_method_t AS ENUM ('cash','cheque','bank_transfer','adjustment');
CREATE TYPE active_status_t  AS ENUM ('active','inactive');
CREATE TYPE user_role_t      AS ENUM ('superadmin','admin','employee');
CREATE TYPE note_type_t      AS ENUM ('credit','debit');

-- ===================== PARTIES =====================
CREATE TABLE customers (
  id              SERIAL PRIMARY KEY,
  name            TEXT    NOT NULL,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  city            TEXT,
  ntn             TEXT,
  category        TEXT,
  region          TEXT,
  credit_days     INTEGER NOT NULL DEFAULT 30 CHECK (credit_days >= 0),
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance         NUMERIC(14,2) NOT NULL DEFAULT 0,
  default_commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (default_commission_rate BETWEEN 0 AND 50),
  account_scope   account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  status          active_status_t NOT NULL DEFAULT 'active',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vendors (
  id              SERIAL PRIMARY KEY,
  name            TEXT    NOT NULL,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  city            TEXT,
  ntn             TEXT,
  category        TEXT,
  region          TEXT,
  credit_days     INTEGER NOT NULL DEFAULT 60 CHECK (credit_days >= 0),
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance         NUMERIC(14,2) NOT NULL DEFAULT 0,
  account_scope   account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  status          active_status_t NOT NULL DEFAULT 'active',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== PRODUCTS =====================
-- Single canonical pricing: cost_price + selling_price + qty_per_pack. No duplicates.
CREATE TABLE products (
  id             SERIAL PRIMARY KEY,
  item_id        TEXT UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT,
  unit           TEXT NOT NULL DEFAULT 'PCS',
  qty_per_pack   INTEGER NOT NULL DEFAULT 1 CHECK (qty_per_pack >= 1),
  cost_price     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cost_price    >= 0),
  selling_price  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  default_commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (default_commission_rate BETWEEN 0 AND 50),
  stock          INTEGER NOT NULL DEFAULT 0,
  min_stock      INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  status         active_status_t NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_low ON products(stock, min_stock);

-- Per-customer-type pricing (overrides selling_price)
CREATE TABLE rate_list (
  id             SERIAL PRIMARY KEY,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_type  TEXT    NOT NULL DEFAULT 'retail',
  rate           NUMERIC(14,2) NOT NULL CHECK (rate >= 0),
  effective_date DATE    NOT NULL DEFAULT CURRENT_DATE,
  packaging      INTEGER NOT NULL DEFAULT 1 CHECK (packaging >= 1),
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 50),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ratelist_lookup ON rate_list(product_id, customer_type, effective_date DESC);

-- ===================== WAREHOUSES =====================
CREATE TABLE warehouses (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  location  TEXT,
  address   TEXT,
  city      TEXT,
  manager   TEXT,
  phone     TEXT,
  floor     TEXT,
  room      TEXT,
  rack      TEXT,
  lot       TEXT,
  notes     TEXT,
  status    active_status_t NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE warehouse_stock (
  id           SERIAL PRIMARY KEY,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  quantity     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (warehouse_id, product_id)
);
CREATE INDEX idx_wh_stock_lookup ON warehouse_stock(product_id, warehouse_id);

-- ===================== TRANSPORTS =====================
CREATE TABLE transports (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  contact      TEXT,
  phone        TEXT,
  city         TEXT,
  vehicle_no   TEXT,
  driver_name  TEXT,
  notes        TEXT,
  status       active_status_t NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== ORDERS =====================
CREATE TABLE orders (
  id              SERIAL PRIMARY KEY,
  order_no        TEXT NOT NULL UNIQUE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
  transport_id    INTEGER REFERENCES transports(id),
  bilty_no        TEXT,
  order_date      DATE NOT NULL,
  delivery_date   DATE,
  status          order_status_t NOT NULL DEFAULT 'pending',
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  account_scope   account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status   ON orders(status);

CREATE TABLE order_items (
  id             SERIAL PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id)   ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  packages       INTEGER NOT NULL DEFAULT 0 CHECK (packages  >= 0),
  packaging      INTEGER NOT NULL DEFAULT 1 CHECK (packaging >= 1),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  rate           NUMERIC(14,2) NOT NULL CHECK (rate >= 0),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  commission_pct NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 50),
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ===================== INVOICES =====================
CREATE TABLE invoices (
  id              SERIAL PRIMARY KEY,
  invoice_no      TEXT NOT NULL UNIQUE,
  order_id        INTEGER REFERENCES orders(id),
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
  transport_id    INTEGER REFERENCES transports(id),
  bilty_no        TEXT,
  transporter_name TEXT,
  invoice_date    DATE NOT NULL,
  due_date        DATE NOT NULL,
  delivery_date   DATE,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  transport_charges NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid            NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          invoice_status_t NOT NULL DEFAULT 'unpaid',
  account_scope   account_scope_t  NOT NULL DEFAULT 'plastic_markaz',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status   ON invoices(status);
CREATE INDEX idx_invoices_due      ON invoices(due_date);

CREATE TABLE invoice_items (
  id             SERIAL PRIMARY KEY,
  invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  packages       INTEGER NOT NULL DEFAULT 0 CHECK (packages  >= 0),
  packaging      INTEGER NOT NULL DEFAULT 1 CHECK (packaging >= 1),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  rate           NUMERIC(14,2) NOT NULL CHECK (rate >= 0),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  commission_pct NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 50),
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_per_pack NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_per_pack >= 0),
  -- Frozen at sale time. NEVER recompute. Past profit must not change.
  cost_at_sale   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cost_at_sale >= 0)
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_product ON invoice_items(product_id);

-- ===================== PURCHASES =====================
CREATE TABLE purchases (
  id              SERIAL PRIMARY KEY,
  purchase_no     TEXT NOT NULL UNIQUE,
  vendor_id       INTEGER NOT NULL REFERENCES vendors(id),
  warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
  transport_id    INTEGER REFERENCES transports(id),
  bilty_no        TEXT,
  purchase_date   DATE NOT NULL,
  delivery_date   DATE,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  delivery_charges NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          purchase_status_t NOT NULL DEFAULT 'pending',
  account_scope   account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_purchases_vendor ON purchases(vendor_id);

CREATE TABLE purchase_items (
  id              SERIAL PRIMARY KEY,
  purchase_id     INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  packages        INTEGER NOT NULL DEFAULT 0 CHECK (packages  >= 0),
  packaging       INTEGER NOT NULL DEFAULT 1 CHECK (packaging >= 1),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  rate            NUMERIC(14,2) NOT NULL CHECK (rate >= 0),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  discount_per_pack NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_per_pack >= 0),
  commission_pct  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

-- ===================== STOCK LEDGER (insert-only authoritative log) =====
CREATE TABLE stock_ledger (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  warehouse_id  INTEGER REFERENCES warehouses(id),
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  qty_delta     INTEGER NOT NULL,
  ref_type      TEXT,
  ref_id        INTEGER,
  reason        TEXT,
  user_id       INTEGER,
  note          TEXT
);
CREATE INDEX idx_stock_ledger_product ON stock_ledger(product_id);
CREATE INDEX idx_stock_ledger_ref     ON stock_ledger(ref_type, ref_id);

CREATE TABLE stock_adjustments (
  id              SERIAL PRIMARY KEY,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  warehouse_id    INTEGER REFERENCES warehouses(id),
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('add','remove','damage','return','transfer_in','transfer_out')),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  reason          TEXT,
  reference       TEXT,
  adj_date        DATE NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== BREAKAGE =====================
CREATE TABLE breakage (
  id                SERIAL PRIMARY KEY,
  customer_id       INTEGER REFERENCES customers(id),
  vendor_id         INTEGER REFERENCES vendors(id),
  order_id          INTEGER REFERENCES orders(id),
  invoice_id        INTEGER REFERENCES invoices(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  adjustment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit_note_id    INTEGER,
  claim_status      TEXT NOT NULL DEFAULT 'pending' CHECK (claim_status IN ('pending','approved','rejected','resolved')),
  breakage_date     DATE NOT NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== DELIVERY CHALLAN + BILTY =====================
CREATE TABLE delivery_challans (
  id        SERIAL PRIMARY KEY,
  dc_no     TEXT NOT NULL UNIQUE,
  order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  dc_date   DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bilty (
  id              SERIAL PRIMARY KEY,
  bilty_no        TEXT NOT NULL,
  order_id        INTEGER REFERENCES orders(id),
  invoice_id      INTEGER REFERENCES invoices(id),
  dc_id           INTEGER REFERENCES delivery_challans(id),
  transport_id    INTEGER REFERENCES transports(id),
  transport_name  TEXT NOT NULL,
  from_city       TEXT NOT NULL,
  to_city         TEXT NOT NULL,
  bilty_date      DATE NOT NULL,
  freight_charges NUMERIC(14,2) NOT NULL DEFAULT 0,
  weight          TEXT,
  packages_count  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit','delivered','cancelled')),
  account_scope   account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bilty must link to either an order OR an invoice
  CONSTRAINT bilty_linkage CHECK (order_id IS NOT NULL OR invoice_id IS NOT NULL)
);

-- ===================== LEDGER (double-entry per party) =====================
-- customer:  debit = sale,        credit = payment
-- vendor:    credit = purchase,   debit  = payment/return
CREATE TABLE ledger (
  id              SERIAL PRIMARY KEY,
  entity_type     entity_type_t NOT NULL,
  entity_id       INTEGER NOT NULL,
  txn_date        DATE NOT NULL,
  description     TEXT,
  debit           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  reference_type  TEXT,
  reference_id    INTEGER,
  account_scope   account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ledger_one_side_only CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_ledger_entity ON ledger(entity_type, entity_id);
CREATE INDEX idx_ledger_date   ON ledger(txn_date);
CREATE INDEX idx_ledger_ref    ON ledger(reference_type, reference_id);

-- ===================== PAYMENTS =====================
CREATE TABLE payments (
  id              SERIAL PRIMARY KEY,
  entity_type     entity_type_t NOT NULL,
  entity_id       INTEGER NOT NULL,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_date    DATE NOT NULL,
  payment_method  payment_method_t NOT NULL DEFAULT 'cash',
  reference       TEXT,
  notes           TEXT,
  account_scope   account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payments_entity ON payments(entity_type, entity_id);

-- ===================== EXPENSES =====================
CREATE TABLE expenses (
  id             SERIAL PRIMARY KEY,
  category       TEXT NOT NULL,
  description    TEXT,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  expense_date   DATE NOT NULL,
  payment_method payment_method_t NOT NULL DEFAULT 'cash',
  reference      TEXT,
  paid_to        TEXT,
  account_scope  account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== CREDIT / DEBIT NOTES =====================
CREATE TABLE credit_notes (
  id             SERIAL PRIMARY KEY,
  note_no        TEXT NOT NULL UNIQUE,
  note_type      note_type_t NOT NULL,
  customer_id    INTEGER REFERENCES customers(id),
  vendor_id      INTEGER REFERENCES vendors(id),
  invoice_id     INTEGER REFERENCES invoices(id),
  purchase_id    INTEGER REFERENCES purchases(id),
  note_date      DATE NOT NULL,
  amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled')),
  notes          TEXT,
  account_scope  account_scope_t NOT NULL DEFAULT 'plastic_markaz',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cn_party_consistency CHECK (
    (note_type='credit' AND customer_id IS NOT NULL AND invoice_id  IS NOT NULL AND vendor_id   IS NULL) OR
    (note_type='debit'  AND vendor_id   IS NOT NULL AND purchase_id IS NOT NULL AND customer_id IS NULL)
  )
);

CREATE TABLE credit_note_items (
  id          SERIAL PRIMARY KEY,
  note_id     INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  rate        NUMERIC(14,2) NOT NULL CHECK (rate >= 0),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0)
);

-- ===================== JOURNAL =====================
CREATE TABLE journal_entries (
  id          SERIAL PRIMARY KEY,
  entry_no    TEXT NOT NULL UNIQUE,
  entry_date  DATE NOT NULL,
  description TEXT,
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'posted',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE journal_lines (
  id          SERIAL PRIMARY KEY,
  entry_id    INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account     TEXT    NOT NULL,
  description TEXT,
  debit       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0)
);

-- ===================== TAX/CATEGORY METADATA =====================
CREATE TABLE party_categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  cat_group   TEXT NOT NULL,
  applies_to  TEXT NOT NULL DEFAULT 'both',
  color       TEXT NOT NULL DEFAULT 'secondary',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      active_status_t NOT NULL DEFAULT 'active'
);
CREATE TABLE expense_categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE product_categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);

-- ===================== AUTH =====================
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  role          user_role_t NOT NULL DEFAULT 'employee',
  status        active_status_t NOT NULL DEFAULT 'active',
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

CREATE TABLE user_permissions (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module  TEXT NOT NULL,
  UNIQUE (user_id, module)
);

-- ===================== SETTINGS / AUDIT =====================
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE audit_log (
  id                  SERIAL PRIMARY KEY,
  action              TEXT NOT NULL,
  module              TEXT NOT NULL,
  record_id           INTEGER,
  details             TEXT,
  user_id             INTEGER REFERENCES users(id),
  old_value           JSONB,
  new_value           JSONB,
  superadmin_override BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_module             ON audit_log(module);
CREATE INDEX idx_audit_created_at         ON audit_log(created_at DESC);
CREATE INDEX idx_audit_superadmin_override ON audit_log(superadmin_override) WHERE superadmin_override = true;

CREATE TABLE system_errors (
  id        SERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope     TEXT,
  message   TEXT,
  stack     TEXT,
  context   TEXT,
  user_id   INTEGER
);
