# Database Architecture & Schema

## Overview

Markaz ERP uses **PostgreSQL 12+** with a comprehensive relational schema supporting multi-business operations, double-entry accounting, inventory tracking, and transaction ledgers.

---

## PostgreSQL Enum Types

The system uses PostgreSQL enums to enforce data integrity at the database level:

### `active_status_t`
Values: `active`, `inactive`, `pending`
- Used in: customers, vendors, products, warehouses, transports, users
- Default: `active`

### `account_scope_t`
Business entity identifier (multi-tenant support)
- Values: `plastic_markaz`, `wings_furniture`, `cooler`
- Used in: invoices, purchases, expenses, payments, journal_entries, general_ledger
- Default: `plastic_markaz`

### `payment_method_t`
Payment transaction type
- Values: `cash`, `check`, `bank_transfer`, `credit`
- Used in: payments, expenses
- Default: `cash`

### `entity_type_t`
Ledger entry classification
- Values: `customer`, `vendor`, `general`
- Used in: transaction_ledger (links to ledger entries)

---

## Critical: Enum Type Casting

**When using COALESCE or DEFAULT values with enums, explicit casting is required:**

```sql
-- ✅ CORRECT - with explicit cast
INSERT INTO customers(status)
VALUES (COALESCE($1, 'active')::active_status_t)

-- ❌ WRONG - implicit text type causes error
INSERT INTO customers(status)
VALUES (COALESCE($1, 'active'))
-- ERROR: column "status" is of type active_status_t but expression is of type text

-- ✅ CORRECT - without COALESCE if value is guaranteed
INSERT INTO customers(status) VALUES ('active'::active_status_t)
```

**Affected Routes (Enum Casting Required):**
- `routes/transports.js` - INSERT/UPDATE status
- `routes/warehouses.js` - INSERT/UPDATE status
- `routes/customers.js` - INSERT/UPDATE scope and status
- `routes/vendors.js` - INSERT/UPDATE scope and status
- `routes/payments.js` - INSERT/UPDATE method and scope
- `routes/expenses.js` - INSERT/UPDATE method and scope

---

## Core Tables

### users
User accounts with role-based access control

```
id (SERIAL PRIMARY KEY)
username (TEXT UNIQUE)
name (TEXT)
email (TEXT)
password_hash (TEXT)
role (TEXT) - 'superadmin', 'admin', 'user', 'viewer'
status (active_status_t)
created_by (INTEGER, FK users.id)
created_at (TIMESTAMP)
last_login (TIMESTAMP)
```

### customers
Customer master data with ledger balance tracking

```
id (SERIAL PRIMARY KEY)
name (TEXT UNIQUE)
email (TEXT)
phone (TEXT)
address (TEXT)
city (TEXT)
region (TEXT)
type (TEXT) - customer type/category
commission (NUMERIC) - commission %
balance (NUMERIC) - running balance from ledger
account_scope (account_scope_t)
status (active_status_t)
notes (TEXT)
created_at (TIMESTAMP)
```

### vendors
Supplier master data

```
id (SERIAL PRIMARY KEY)
name (TEXT UNIQUE)
email (TEXT)
phone (TEXT)
address (TEXT)
city (TEXT)
commission (NUMERIC)
ntn (TEXT) - National Tax Number
balance (NUMERIC)
account_scope (account_scope_t)
status (active_status_t)
notes (TEXT)
created_at (TIMESTAMP)
```

### products
Inventory master data

```
id (SERIAL PRIMARY KEY)
name (TEXT UNIQUE)
category (TEXT, FK product_categories.name)
item_id (TEXT) - PM-001, CL-001, etc (legacy)
unit (TEXT) - PCS, OCS, etc
qty_per_pack (INTEGER) - pieces per carton
stock (NUMERIC) - total pieces in stock (sum of warehouse_stock)
cost_price (NUMERIC)
selling_price (NUMERIC)
min_stock (NUMERIC)
status (active_status_t)
created_at (TIMESTAMP)
```

### warehouse_stock
Inventory by location

```
id (SERIAL PRIMARY KEY)
product_id (INTEGER, FK products.id)
warehouse_id (INTEGER, FK warehouses.id)
quantity (NUMERIC) - total pieces in warehouse
last_updated (TIMESTAMP)
UNIQUE(product_id, warehouse_id)
```

### warehouses
Storage locations

```
id (SERIAL PRIMARY KEY)
name (TEXT UNIQUE)
address (TEXT)
city (TEXT)
status (active_status_t)
created_at (TIMESTAMP)
```

---

## Transaction Tables

### invoices
Customer sales documents

```
id (SERIAL PRIMARY KEY)
invoice_no (TEXT) - format: INV-001
invoice_date (DATE)
due_date (DATE)
delivery_date (DATE)
customer_id (INTEGER, FK customers.id)
warehouse_id (INTEGER)
bilty_no (TEXT) - shipping reference
transport_id (INTEGER)
transporter_name (TEXT)
account_scope (account_scope_t)
status (TEXT) - unpaid, partial, paid
amount_total (NUMERIC)
commission_amount (NUMERIC)
discount_amount (NUMERIC)
transport_charges (NUMERIC)
amount_net (NUMERIC)
notes (TEXT)
created_by (INTEGER)
created_at (TIMESTAMP)
```

### invoice_lines
Line items within invoices

```
id (SERIAL PRIMARY KEY)
invoice_id (INTEGER, FK invoices.id)
product_id (INTEGER, FK products.id)
quantity (NUMERIC)
rate (NUMERIC)
commission_pct (NUMERIC) - editable per line
discount_per_pack (NUMERIC) - discount amount per unit
amount (NUMERIC) - calculated: quantity × rate - commission - (discount × qty)
```

### purchases
Supplier purchase orders

```
id (SERIAL PRIMARY KEY)
po_no (TEXT) - PO-001
po_date (DATE)
vendor_id (INTEGER, FK vendors.id)
warehouse_id (INTEGER)
bilty_no (TEXT)
account_scope (account_scope_t)
status (TEXT) - pending, received, paid
amount_total (NUMERIC)
discount_amount (NUMERIC)
transport_charges (NUMERIC)
amount_net (NUMERIC)
notes (TEXT)
created_at (TIMESTAMP)
```

### purchase_lines
Purchase order line items

```
id (SERIAL PRIMARY KEY)
purchase_id (INTEGER, FK purchases.id)
product_id (INTEGER, FK products.id)
quantity (NUMERIC)
rate (NUMERIC)
discount_per_pack (NUMERIC)
amount (NUMERIC)
```

### payments
Cash/check/bank transactions

```
id (SERIAL PRIMARY KEY)
payment_type (TEXT) - 'receive', 'pay'
entity_type (entity_type_t) - customer, vendor
entity_id (INTEGER)
amount (NUMERIC)
payment_method (payment_method_t)
check_number (TEXT)
bank_account (TEXT)
reference (TEXT) - linked invoice number
account_scope (account_scope_t)
payment_date (DATE)
notes (TEXT)
created_by (INTEGER)
created_at (TIMESTAMP)
```

---

## Ledger Tables

### transaction_ledger
Double-entry accounting ledger (core financial record)

```
id (SERIAL PRIMARY KEY)
entity_type (entity_type_t) - customer, vendor, general
entity_id (INTEGER)
txn_date (DATE)
txn_type (TEXT) - invoice, purchase, payment, expense, journal, etc
txn_id (INTEGER) - FK to source transaction
debit (NUMERIC) - money owed to business
credit (NUMERIC) - money business owes
description (TEXT)
reference (TEXT) - invoice number, check number, etc
reference_id (INTEGER) - FK to source
account_scope (account_scope_t)
created_at (TIMESTAMP)
INDEX(entity_type, entity_id, txn_date) - optimized for ledger queries
```

### Ledger Balance Calculation (Window Function)

The ledger balance for a customer/vendor is calculated using PostgreSQL window functions:

```sql
SELECT 
  *,
  SUM(debit - credit) OVER (
    ORDER BY id 
    ROWS UNBOUNDED PRECEDING
  ) AS balance
FROM transaction_ledger
WHERE entity_type = 'customer' 
  AND entity_id = $1
ORDER BY id;
```

**Key Points:**
- Window function aggregates AFTER WHERE clause filters
- Running balance at each row = sum of (debit - credit) from start to current row
- Positive balance = amount customer owes (for customer ledger)
- Negative balance = amount business owes (vendor or credit note)

### journal_entries
Manual double-entry journal (for adjustments, corrections)

```
id (SERIAL PRIMARY KEY)
entry_no (TEXT) - JV-001
entry_date (DATE)
description (TEXT)
reference (TEXT)
account_scope (account_scope_t)
created_by (INTEGER)
created_at (TIMESTAMP)
```

### journal_lines
Debit/credit line items for journal entries

```
id (SERIAL PRIMARY KEY)
entry_id (INTEGER, FK journal_entries.id)
account (TEXT) - account code/name
description (TEXT)
debit (NUMERIC)
credit (NUMERIC)
```

---

## Stock Movement Transactions

### stock_adjustments
Inventory adjustments (breakage, waste, loss, initialization)

```
id (SERIAL PRIMARY KEY)
adjustment_type (TEXT) - 'increase', 'reduce', 'transfer'
product_id (INTEGER, FK products.id)
warehouse_id (INTEGER, FK warehouses.id)
target_warehouse_id (INTEGER) - for transfers
quantity (NUMERIC) - pieces
adjustment_amount (NUMERIC) - cost impact
reason (TEXT) - 'breakage', 'initialization', 'stocktake', 'transfer'
reference_type (TEXT) - invoice, purchase, etc
reference_id (INTEGER)
notes (TEXT)
created_by (INTEGER)
created_at (TIMESTAMP)
```

### Stock Movement Function

All stock movements are atomic transactions via `applyStockMovement()`:

```javascript
async function applyStockMovement(
  client,           // database connection
  productId,
  warehouseId,
  qtyDelta,        // +/- quantity in pieces
  refType,         // 'invoice', 'purchase', 'adjustment', etc
  refId,           // id of source transaction
  reason,          // 'sales', 'purchase', 'breakage', etc
  note             // optional note
)
```

**Atomic Operations:**
1. Update warehouse_stock table (lock row)
2. Recalculate products.stock (sum of all warehouses)
3. Create transaction_ledger entry
4. Create stock_adjustments record

This ensures inventory and ledger are always in sync.

---

## EJS Variable Passing Patterns

All route responses must explicitly pass template variables via `res.render()`:

```javascript
// ❌ WRONG - Variables must be explicit
res.render('invoice/form', { invoice });
// EJS will throw: "orders is not defined"

// ✅ CORRECT - All variables required
res.render('invoice/form', {
  page: 'invoices',
  invoice,
  customers,
  warehouses,
  transports,
  ALL_MODULES,
  DASH_WIDGETS,
  perms: []
});

// ✅ CORRECT - Use res.locals for global variables
app.use((req, res, next) => {
  res.locals.appSettings = { logo: '/logo.png' };
  res.locals.formatCurrency = (n) => 'Rs. ' + n;
  next();
});
```

**Global res.locals (set in index.js middleware):**
- formatCurrency, formatDate, statusBadge, accountName
- query, req, err, saved, ok, search, from, to
- empty arrays: regions, types, categories, rateHistory, etc
- appSettings (loaded from database)

---

## Validation Schema Pattern

Item-level validation with skipIf:

```javascript
// middleware/validate.js
const schemas = {
  invoiceCreate: [
    { field: 'customer_id', type: 'number', required: true },
    { field: 'invoice_date', type: 'date', required: true },
    {
      name: 'items',
      type: 'item-list',
      skipIf: (value) => !value || (Array.isArray(value) && value.every(v => !v)),
      items: [
        { field: 'product_id', type: 'number', required: true },
        { field: 'quantity', type: 'number', required: true, min: 1 },
        { field: 'rate', type: 'number', required: true }
      ]
    }
  ]
};

// Usage
router.post('/add', validate(schemas.invoiceCreate), (req, res) => {
  const v = req.valid; // validated & parsed values
});
```

**skipIf** executes BEFORE item validation - it checks raw values:
```javascript
// Skips if: undefined, empty array, or all items are falsy
skipIf: (value) => {
  if (!value) return true;
  if (Array.isArray(value)) {
    return value.every(v => !v || (typeof v === 'object' && Object.values(v).every(x => !x)));
  }
  return false;
}
```

---

## Audit Logging

### audit_logs
System activity trail

```
id (SERIAL PRIMARY KEY)
action (TEXT) - create, update, delete, view
table_name (TEXT) - users, invoices, etc
record_id (INTEGER)
description (TEXT)
user_id (INTEGER, FK users.id)
created_at (TIMESTAMP)
```

Usage:
```javascript
await addAuditLog('create', 'invoices', invoiceId, `Created invoice ${invoiceNo}`);
```

---

## Backup Strategy

### Full Backup
```bash
pg_dump -U postgres -d markaz_erp -F c -f backup_$(date +%Y%m%d).backup
```

### Point-in-Time Recovery
```bash
# Enable WAL archiving in postgresql.conf, then restore from specific timestamp
pg_restore -U postgres -d markaz_erp_restored backup.backup
```

---

## Performance Indexes

Primary indexes created during schema initialization:

```sql
-- Ledger queries (most frequent)
CREATE INDEX ON transaction_ledger(entity_type, entity_id, txn_date);

-- Warehouse stock lookups
CREATE INDEX ON warehouse_stock(product_id, warehouse_id);

-- Invoice/Purchase line lookups
CREATE INDEX ON invoice_lines(invoice_id);
CREATE INDEX ON purchase_lines(purchase_id);

-- Date-based reports
CREATE INDEX ON invoices(invoice_date, account_scope);
CREATE INDEX ON purchases(po_date, account_scope);

-- User audit trail
CREATE INDEX ON audit_logs(user_id, created_at DESC);
```

---

## Migration Notes

When migrating from legacy TechnoCom system:

1. **Products**: Use `db/migrate-legacy-items.js`
   - Generates item_id (PM-xxx, CL-xxx)
   - Auto-categorizes based on name keywords
   - Normalizes units (PCS., DOX → standard values)

2. **Opening Stock**: Use `/stockinit` web interface
   - Bulk CTN + PCS entry
   - Creates stock_adjustments with reason='initialization'
   - Initializes warehouse_stock and recalculates products.stock

3. **Customer/Vendor Balances**: Manual entry required
   - Use Journal Entries to record opening balances
   - Link to 'general' entity type in ledger
   - Or use direct transaction_ledger INSERT with opening balance date

4. **Rate History**: Migrate via rate_list table
   - One row per customer-product combination
   - Historical rates archived in rate_history table
