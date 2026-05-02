# Markaz ERP - Multi-Business Accounting & Inventory System

A full-featured ERP system for multi-business trading operations. Built with **Node.js + PostgreSQL**, supporting multiple business scopes (Plastic Markaz, Wings Furniture, Cooler) with integrated accounting, inventory, and logistics management.

---

## Features

| Module | Description |
|---|---|
| **Dashboard** | Live KPIs, charts, period filters, quick order/purchase buttons |
| **Orders** | Create/edit orders with commission % auto-loaded from customer |
| **Invoices** | Invoices with commission flow: Total → Less Commission → Gross |
| **Purchases** | Record vendor purchases, auto-update stock |
| **Customers** | Full ledger, commission %, category, region |
| **Vendors** | Vendor ledger, commission %, manufacturer linking |
| **Products** | Categories, Pcs/Ctn, manufacturer, rate history, bulk edit |
| **Rate List** | Per-customer-type rates with history & commission % |
| **Payments** | Receive from customers / pay vendors, link to invoices |
| **Ledger** | Auto-maintained double-entry ledger per customer/vendor |
| **Bilty** | Transport records linked to invoices |
| **Expenses** | 35+ categories, paid-to tracking |
| **Journal** | Manual double-entry journal entries |
| **Stock** | Warehouse stock, adjustments, transfers |
| **Reports** | P&L, balance sheet, sales, purchase, aging, audit log |
| **Import/Export** | Excel import/export for customers, vendors, products |
| **Settings** | Business info, currency, invoice terms |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
node index.js

# 3. Open in browser
http://localhost:3000
```

---

## Technology Stack

- **Backend:** Node.js 18+ + Express.js
- **Database:** PostgreSQL 12+ (async-await with pg driver)
- **Authentication:** Session-based (express-session)
- **Templating:** EJS
- **UI:** Bootstrap 5 + Bootstrap Icons
- **Charts:** Chart.js
- **PDF:** PDFKit
- **Excel:** xlsx (SheetJS)
- **Password Hashing:** bcryptjs (PBKDF2, 10 rounds)
- **Validation:** Custom schema-based middleware with item-level parsing

---

## Commission System

This system is built around a **commission-based profit model**:

1. Set commission % on each **Customer** profile
2. When creating an Order or Invoice, commission % is **auto-loaded** from the customer
3. The form shows: **Total → Less Commission → Gross Amount**
4. Commission amount is stored and visible throughout (list, view, print, PDF)

---

## Key Concepts

- **Ctns** = Cartons (packages)
- **Pcs/Ctn** = Pieces per Carton (packaging)
- **Total Pcs** = Ctns × Pcs/Ctn (auto-calculated)
- **Gross Amount** = Total − Commission

---

## Data Storage

The system uses **PostgreSQL** running on your local machine:

```
Database: markaz_erp
Host: localhost
Port: 5432
User: postgres (default)
```

Backup via PostgreSQL tools:
```bash
pg_dump -U postgres markaz_erp > backup.sql
```

Restore from backup:
```bash
psql -U postgres -d markaz_erp < backup.sql
```

---

## Default Port

The app runs on port **3000**. Change in `index.js` if needed.
