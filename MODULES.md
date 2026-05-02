# Module Reference Guide

Detailed breakdown of each Markaz ERP module with routes, features, and workflows.

---

## Core Modules

### Customers (`/customers`)

**Purpose:** Manage customer master data and view ledger/balance.

**Routes:**
- `GET /customers` - List all customers (paginated)
- `GET /customers/add` - New customer form
- `POST /customers/add` - Create customer
- `GET /customers/edit/:id` - Edit form
- `POST /customers/edit/:id` - Update customer
- `POST /customers/delete/:id` - Delete customer
- `GET /customers/ledger/:id` - Customer ledger (deprecated, use /ledger/customer/:id)

**Key Fields:**
- name, phone, email, address, city, region
- type (category like "wholesale", "retail")
- commission (%) - auto-applied to new invoices
- balance (calculated from transaction_ledger)
- account_scope (plastic_markaz, wings_furniture, cooler)
- status (active, inactive)

**Features:**
- Search by name, phone, city
- Bulk actions: activate/deactivate
- Quick view of outstanding balance
- Region and type filtering for reports

**Database Tables:**
- `customers` - master data
- `transaction_ledger` - balance calculation (entity_type='customer')
- `audit_logs` - track create/update/delete

---

### Vendors (`/vendors`)

**Purpose:** Manage supplier master data and payment tracking.

**Routes:**
- `GET /vendors` - List all vendors
- `GET /vendors/add` - New vendor form
- `POST /vendors/add` - Create vendor
- `GET /vendors/edit/:id` - Edit form
- `POST /vendors/edit/:id` - Update vendor
- `POST /vendors/delete/:id` - Delete vendor

**Key Fields:**
- name, phone, email, address, city
- commission (%)
- ntn (National Tax Number)
- balance (amount owed to vendor)
- status (active, inactive)

**Features:**
- Tax number tracking for compliance
- Commission tracking for purchase orders
- Outstanding payables by vendor
- Payment history linked to purchases

---

### Products (`/products`)

**Purpose:** Inventory master catalog with pricing and categorization.

**Routes:**
- `GET /products` - List all products
- `GET /products/add` - New product form
- `POST /products/add` - Create product
- `GET /products/edit/:id` - Edit form
- `POST /products/edit/:id` - Update product
- `POST /products/delete/:id` - Delete product
- `GET /products/bulk` - Bulk edit page (placeholder)
- `POST /products/bulk-update` - Apply bulk changes

**Key Fields:**
- name (unique)
- category (FK product_categories)
- item_id (legacy TechnoCom ID: PM-001, CL-001, etc)
- unit (PCS, OCS, CTN, etc)
- qty_per_pack (pieces per carton - key for CTN conversion)
- stock (total pieces across all warehouses - auto-calculated)
- cost_price, selling_price (per piece)
- min_stock (reorder alert level)
- status (active, inactive)

**Features:**
- Rate history per customer/product
- Stock by warehouse
- Category-based grouping
- Reorder alerts when stock < min_stock
- Bulk import from Excel (via import/export module)

**Database Tables:**
- `products` - master catalog
- `product_categories` - category list
- `warehouse_stock` - stock per location
- `rate_list` - pricing per customer/product
- `rate_history` - historical pricing

---

### Warehouses (`/warehouses`)

**Purpose:** Manage inventory storage locations.

**Routes:**
- `GET /warehouses` - List all warehouses
- `GET /warehouses/add` - New warehouse form
- `POST /warehouses/add` - Create warehouse
- `GET /warehouses/edit/:id` - Edit form
- `POST /warehouses/edit/:id` - Update warehouse
- `POST /warehouses/delete/:id` - Delete warehouse

**Key Fields:**
- name (unique)
- address, city
- status (active, inactive)

**Features:**
- Default warehouse selection on invoices/purchases
- Warehouse selector with "apply to all" (stock initialization)
- Stock transfer between warehouses
- Warehouse-specific stock reports

---

## Transaction Modules

### Invoices (`/invoices`)

**Purpose:** Customer sales invoices with commission calculation and payment tracking.

**Routes:**
- `GET /invoices` - List invoices (filterable by date, customer, status)
- `GET /invoices/add` - New invoice form
- `POST /invoices/add` - Create invoice
- `GET /invoices/edit/:id` - Edit form
- `POST /invoices/edit/:id` - Update invoice
- `POST /invoices/delete/:id` - Delete invoice
- `GET /invoices/view/:id` - Invoice detail view
- `GET /invoices/print/:id` - Print invoice
- `GET /invoices/pdf/:id` - Download PDF

**Key Fields:**
- invoice_no (auto-generated: INV-0001, etc)
- customer_id
- invoice_date, due_date, delivery_date
- warehouse_id
- bilty_no (shipping reference)
- transport_id (optional - linked to transports)
- account_scope

**Calculation Fields:**
- amount_total (sum of line amounts)
- commission_amount (total commission deducted)
- discount_amount (total discount)
- transport_charges
- amount_net (final invoice amount)
- status (unpaid, partial, paid)

**Line Items:**
- product_id, quantity, rate
- commission_pct (editable per line - can differ per product)
- discount_per_pack
- amount (calculated: qty × rate - commission - discount)

**Features:**
- Auto-load customer commission % on selection
- Per-line commission override (each product can have different %)
- Discount per pack or total discount
- Transport charges
- Link to bilty/transporter
- Invoice locking when marked "paid"
- Print with logo/terms/footer
- Duplicate prevention (idempotency token)

**Workflow:**
```
1. Create invoice with items
2. System deducts warehouse_stock
3. Updates products.stock (sum of warehouses)
4. Creates transaction_ledger entry (debit = amount_net)
5. Updates customer.balance
6. Payments received reduce balance
```

**Database Tables:**
- `invoices`
- `invoice_lines`
- `transaction_ledger`
- `warehouse_stock` (decremented by stock movement)
- `stock_adjustments` (tracks reason='sales')
- `audit_logs`

---

### Purchases (`/purchases`)

**Purpose:** Vendor purchase orders with inventory receipt.

**Routes:**
- `GET /purchases` - List purchases
- `GET /purchases/add` - New PO form
- `POST /purchases/add` - Create PO
- `GET /purchases/edit/:id` - Edit form
- `POST /purchases/edit/:id` - Update PO
- `POST /purchases/delete/:id` - Delete PO
- `GET /purchases/view/:id` - PO detail

**Key Fields:**
- po_no (auto-generated: PO-0001)
- vendor_id
- po_date
- warehouse_id (receive location)
- bilty_no
- status (pending, received, paid)

**Line Items:**
- product_id, quantity, rate
- discount_per_pack
- amount

**Features:**
- Automatic stock increase on PO creation
- GRN (Goods Receipt Note) tracking
- Discount handling
- Link to vendor ledger
- Payment tracking against PO

**Workflow:**
```
1. Create PO with items
2. System increments warehouse_stock (goods receipt)
3. Updates products.stock
4. Creates transaction_ledger entry (credit = amount)
5. Updates vendor.balance (liability)
6. Payments made reduce balance
```

---

### Payments (`/payments`)

**Purpose:** Record cash/check/bank payments to/from customers and vendors.

**Routes:**
- `GET /payments` - List all payments (mixed receive/pay)
- `GET /payments/add` - Redirect to receive or pay form
  - Parameters: `?type=customer|vendor&entity_id=123`
- `GET /payments/receive` - Receive payment from customer
- `POST /payments/receive` - Create receive payment
- `GET /payments/pay` - Pay vendor
- `POST /payments/pay` - Create payment to vendor

**Key Fields:**
- payment_type (receive, pay)
- entity_type (customer, vendor)
- entity_id
- amount
- payment_date
- payment_method (cash, check, bank_transfer, credit)
- check_number (if check)
- bank_account (if transfer)
- reference (linked invoice/PO number)

**Features:**
- Link to specific invoice/PO for partial payments
- Check tracking with number/bank
- Bank transfer details (account, date)
- Automatic balance update via transaction_ledger
- Payment receipt printing

**Workflow:**
```
1. User selects customer/vendor
2. Option to link to specific invoice
3. Payment recorded: transaction_ledger.credit (if payment) or debit (if received)
4. Balance updated: customer/vendor.balance
5. Invoice marked "partial" or "paid" if fully settled
```

---

### Expenses (`/expenses`)

**Purpose:** Track business expenses by category (rent, utilities, salary, etc).

**Routes:**
- `GET /expenses` - List expenses (filterable by date, category)
- `GET /expenses/add` - New expense form
- `POST /expenses/add` - Create expense
- `GET /expenses/edit/:id` - Edit form
- `POST /expenses/edit/:id` - Update expense
- `POST /expenses/delete/:id` - Delete expense

**Key Fields:**
- expense_date
- category (35+ categories: rent, salary, utilities, office, fuel, etc)
- amount
- payment_method (cash, check, bank_transfer)
- paid_to (vendor/person name)
- account_scope
- description

**Features:**
- 35+ predefined categories
- Search by category, date range
- P&L impact reporting
- Grouped by category for analysis

**Database Tables:**
- `expenses`
- `transaction_ledger` (entity_type='general')

---

### Journal (`/journal`)

**Purpose:** Manual double-entry journal for adjustments, corrections, and opening balances.

**Routes:**
- `GET /journal` - List journal entries (filterable by date)
- `GET /journal/add` - New journal entry form
- `POST /journal/add` - Create entry
- `GET /journal/view/:id` - Entry detail

**Key Fields:**
- entry_no (auto-generated: JV-0001)
- entry_date
- description
- reference

**Line Items:**
- account (account name/code)
- description
- debit, credit (must balance: sum(debit) = sum(credit))

**Features:**
- Enforced double-entry balance check
- Opening balance entry (for new accounts)
- Correction entries
- Adjustment entries
- Audit trail of manual entries

**Validation:**
- At least 2 lines required
- Sum of debits = sum of credits (within 0.01 rounding)

---

### Breakage (`/breakage`)

**Purpose:** Record stock loss, damage, or breakage with financial impact.

**Routes:**
- `GET /breakage` - List breakage records
- `GET /breakage/add` - New breakage form
- `POST /breakage/add` - Record breakage
- `GET /breakage/view/:id` - Breakage detail
- `POST /breakage/delete/:id` - Delete record

**Key Fields:**
- product_id
- warehouse_id
- quantity (pieces lost)
- adjustment_amount (cost impact)
- reason (breakage, damage, loss, theft, etc)
- customer_id or vendor_id (if recoverable cost)
- notes

**Features:**
- Stock deduction on creation
- Cost tracking for P&L
- Link to customer/vendor if recoverable
- Reason categorization for analysis

---

## Inventory Modules

### Stock (`/stock`)

**Purpose:** Inventory adjustments, transfers, and recount.

**Routes:**
- `GET /stock` - Stock status by warehouse
- `GET /stock/add` - New adjustment form
  - Parameters: `?type=increase|reduce|transfer`
- `POST /stock/add` - Create adjustment
- `GET /stock/transfers` - Transfer history

**Adjustment Types:**
- **increase** - Add stock (receiving, return, correction)
- **reduce** - Deduct stock (loss, breakage, theft)
- **transfer** - Move between warehouses

**Key Fields:**
- adjustment_type
- product_id
- warehouse_id (from warehouse for transfer)
- target_warehouse_id (to warehouse for transfer)
- quantity (pieces)
- adjustment_amount (cost impact for increase/reduce)
- reason (physical_count, waste, return, damaged, etc)
- reference_type, reference_id (link to source transaction)

**Features:**
- Reason categorization
- Cost impact tracking
- Warehouse-to-warehouse transfers
- Audit trail of all movements

---

### Stock Initialization (`/stockinit`)

**Purpose:** Fast bulk entry of opening stock quantities by warehouse.

**Routes:**
- `GET /stockinit` - Stock init form (paginated products)
  - Parameters: `?page=1&search=...`
- `POST /stockinit/save` - Submit opening stock

**Features:**
- **Pagination:** 50 products per page
- **Search:** Filter by product name
- **Dual Entry:** CTN (cartons) + PCS (pieces)
  - Total Qty = (CTN × Qty/Pack) + PCS
  - Auto-calculates on input
- **Warehouse Selector:** Apply to all products on page
- **Live Validation:**
  - Red highlight: negative values
  - Yellow highlight: duplicate product+warehouse
  - Green background: row has values
- **Confirmation Modal:** Shows summary before submit
  - Total products, total quantities
  - Warehouse breakdown
- **Unsaved Changes Guard:** Warns before navigation

**Keyboard Navigation:**
- Tab: CTN → PCS → next row's CTN
- Enter: Jump within row or next line item

**Workflow:**
```
1. Open /stockinit
2. See 50 products per page
3. For each product:
   - Select warehouse (or use "apply to all" button)
   - Enter CTN (cartons) and PCS (pieces)
   - Total Qty calculated automatically
4. Validation prevents:
   - Negative values
   - Same product+warehouse twice
5. Click "Confirm Opening Stock"
6. Modal shows summary
7. Click "Yes, Save"
   - applyStockMovement(reason='initialization') for each row
   - warehouse_stock updated
   - stock_adjustments created
   - transaction_ledger NOT affected (opening balances separate)
8. Redirect to /stockinit with success message
```

---

## Logistics Modules

### Bilty (`/bilty`)

**Purpose:** Track shipping documents and deliveries.

**Routes:**
- `GET /bilty` - List bilties
- `GET /bilty/add` - New bilty form
- `POST /bilty/add` - Create bilty
- `GET /bilty/view/:id` - Bilty detail

**Key Fields:**
- bilty_no (auto-generated)
- bilty_date
- from_warehouse_id
- to_customer_id
- transport_id
- transporter_name
- items (product, quantity, description)
- status (in_transit, delivered, received)

**Features:**
- Track shipments to customers
- Link to invoices
- Transport provider info
- Delivery status tracking

---

### Transports (`/transports`)

**Purpose:** Manage transport/logistics providers.

**Routes:**
- `GET /transports` - List transport providers
- `GET /transports/add` - New transport form
- `POST /transports/add` - Create transport
- `GET /transports/edit/:id` - Edit form
- `POST /transports/edit/:id` - Update transport
- `POST /transports/delete/:id` - Delete transport

**Key Fields:**
- name
- phone, email
- address, city
- vehicle_info (truck number, capacity, etc)
- status (active, inactive)

**Features:**
- Transport selection on invoices
- Auto-fill transporter name on bilty
- Contact info for logistics coordination

---

## Reporting Modules

### Ledger (`/ledger`)

**Purpose:** View customer/vendor account statements with running balance.

**Routes:**
- `GET /ledger` - Ledger main page (selector)
- `GET /ledger/customer/:id` - Customer ledger detail
- `GET /ledger/vendor/:id` - Vendor ledger detail
- `GET /ledger/print/customer/:id` - Print customer statement
- `GET /ledger/print/vendor/:id` - Print vendor statement
- `GET /ledger/pdf/customer/:id` - PDF export

**Features:**
- Date range filter (from/to dates)
- Running balance (calculated with window function)
- Click row for transaction details in side panel
- Print-friendly format
- PDF export
- Balance color-coded:
  - Red: Customer owes (positive balance)
  - Orange: Vendor credit (negative balance)
  - Green: Settled (zero balance)

**Database Query:**
```sql
SELECT *, 
  SUM(debit - credit) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS balance
FROM transaction_ledger
WHERE entity_type = $1 AND entity_id = $2
  AND txn_date BETWEEN $from AND $to
ORDER BY id DESC
```

---

### Day Book (`/daybook`)

**Purpose:** Daily summary of all transactions.

**Routes:**
- `GET /daybook` - Day book listing (filterable by date range, scope)

**Features:**
- Transactions grouped by date
- Filter by scope (plastic_markaz, wings_furniture, cooler)
- Breakdown by type (invoices, purchases, payments, expenses)
- Daily totals
- Searchable by reference number

---

### Reports (`/reports`)

**Purpose:** Financial and operational analysis reports.

**Routes:**
- `GET /reports` - Reports menu
- `GET /reports/p-and-l` - P&L statement
- `GET /reports/balance-sheet` - Balance sheet
- `GET /reports/sales` - Sales summary by customer/product
- `GET /reports/purchases` - Purchase summary by vendor/product
- `GET /reports/aging` - Customer aging (30/60/90 days overdue)
- `GET /reports/audit-log` - System activity audit

**Features:**
- Date range selection
- Scope filtering (per business)
- Export to Excel
- Print-friendly formatting
- Period comparison (MoM, YoY)

---

## Admin Modules

### Users (`/users`)

**Purpose:** System user management and authentication (superadmin only).

**Routes:**
- `GET /users` - List users
- `GET /users/add` - New user form
- `POST /users/add` - Create user
- `GET /users/edit/:id` - Edit form
- `POST /users/edit/:id` - Update user
- `POST /users/delete/:id` - Delete user

**Key Fields:**
- username (unique)
- name
- email
- password (hashed with bcrypt)
- role (superadmin, admin, user, viewer)
- status (active, inactive)

**Features:**
- Role-based access control
- Module-level permissions (for 'user' role)
- Last login tracking
- Audit log of all changes
- Superadmin-only management

---

### Settings (`/settings`)

**Purpose:** System configuration and business information.

**Routes:**
- `GET /settings` - Settings form
- `POST /settings` - Update settings

**Key Settings:**
- **Business Info**
  - Business name (appears on invoices)
  - Tagline/motto
  - Address, city, phone, email
- **Currency**
  - Symbol (default: Rs.)
  - Decimal places (2)
- **Invoice Terms**
  - Default due days
  - Invoice footer message
  - Payment terms text
- **Session Timeout**
  - Minutes before auto-logout (default: 15)
- **Logo Management**
  - Upload logo per scope
  - Logo metadata (width, height, alignment, offset)

**Storage:** `app_settings` table (key-value store)

---

### Import/Export (`/importexport`)

**Purpose:** Bulk data import/export in Excel format.

**Routes:**
- `GET /importexport` - Import/export menu
- `POST /importexport/upload` - Upload Excel file
- `GET /importexport/template/:type` - Download template
- `GET /importexport/export/:type` - Export data to Excel

**Supported Types:**
- **Customers** - name, phone, email, address, city, region, type, commission
- **Vendors** - name, phone, email, address, city, commission, ntn
- **Products** - name, category, item_id, unit, qty_per_pack, stock, cost_price, selling_price
- **Invoices** (export only) - invoice_no, date, customer, amount, status
- **Purchases** (export only) - po_no, date, vendor, amount, status

**Features:**
- Template download (Excel with columns pre-defined)
- Bulk import with validation
- Duplicate detection
- Import result summary
- Error reporting (row-by-row feedback)
- Legacy product migration (see IMPORT.md)

---

### Dashboard (`/`)

**Purpose:** Real-time KPI overview and quick access.

**Routes:**
- `GET /` - Dashboard home
- `GET /dashboard` - Dashboard (alias)

**Widgets:**
- **Sales This Month** - Total invoice amount
- **Outstanding Receivables** - Sum of customer balances
- **Payables** - Sum of vendor balances
- **Stock Value** - Total inventory cost
- **Low Stock Alerts** - Products below min_stock
- **Top Customers** - Highest balance
- **Recent Transactions** - Latest invoices, payments
- **Charts** - Sales/purchase trends, cash flow

**Features:**
- Scope selector (plastic_markaz, wings_furniture, cooler)
- Date range filter
- Refresh button for real-time data
- Quick buttons:
  - New Invoice
  - New Purchase
  - View Reports
  - Stock Status

---

## API Endpoints (JSON)

For programmatic access (read-only):

```
GET /api/customers
  Returns: [{ id, name, phone, city, balance }]

GET /api/vendors
  Returns: [{ id, name, phone, city, balance }]

GET /api/products
  Returns: [{ id, name, category, qty_per_pack, stock, unit, selling_price, cost_price }]

GET /api/products/:id
  Returns: { full product details }
```

---

## Module Dependencies

```
Core Masters:
  customers ──────┐
                  ├──> invoices ──> payments
  vendors ────────┤
                  ├──> purchases
  products ───────┤
                  ├──> stock adjustments
  warehouses ─────┘

Reporting:
  invoices ─┬──> ledger (customer statements)
            ├──> sales reports
            └──> aging reports

  purchases ┬──> ledger (vendor statements)
            ├──> purchase reports
            └──> P&L statement

  all ───────────> daybook (daily summary)
            ├──> balance sheet
            └──> audit logs

Admin:
  users (system-wide)
  settings (global config)
  import/export (batch operations)
```
