# Data Import Guide

## Import Methods

### Method 1: Web UI Import/Export

Go to **Import/Export** in the sidebar → Upload your Excel file → Select data type.

### Method 2: Legacy Product Migration (TechnoCom)

For migrating from TechnoCom Power Suite, use the dedicated migration script:

```bash
node db/migrate-legacy-items.js [OPTIONS]
```

**Options:**
- `--dry-run` - Preview import without saving (recommended first run)
- `--delete-test` - Clear all products and re-import
- `--skip-cooler` - Skip COOLER sheet (import ITEMS sheet only)
- `--parties` - Also import customers from PARTIES sheet

**Example:**
```bash
# Preview what will be imported
node db/migrate-legacy-items.js --dry-run

# Perform actual import
node db/migrate-legacy-items.js

# Import only main products, skip COOLER
node db/migrate-legacy-items.js --skip-cooler
```

**Features:**
- Auto-categorizes products based on name keywords
- Generates smart item IDs: PM-001 to PM-999 (Plastic Markaz), CL-001 to CL-999 (Cooler)
- Handles unit normalization (PCS., DOX → PCS, OCS)
- Detects duplicates by normalized name (case-insensitive)
- Skips test/dummy products automatically

---

## Supported Import Types

### Customers

| Column Name | Required | Notes |
|---|---|---|
| name | ✅ | Customer full name |
| phone | | Contact number |
| email | | Email address |
| address | | Street address |
| city | | City name |
| commission | | Commission % (e.g. 5 for 5%) |
| category | | e.g. wholesale, retail |
| notes | | Any remarks |

### Vendors

| Column Name | Required | Notes |
|---|---|---|
| name | ✅ | Vendor/supplier name |
| phone | | Contact number |
| email | | Email address |
| address | | Address |
| city | | City |
| commission | | Commission % |
| notes | | Remarks |

### Products

| Column Name | Required | Notes |
|---|---|---|
| name | ✅ | Product name |
| category | | Product category |
| rate | | Price per piece (Rs.) |
| packaging | | Pieces per carton |
| stock | | Current stock (pcs) |
| min_stock | | Minimum stock alert level |

---

## Tips

- Column names are case-insensitive (NAME = name = Name)
- Leave optional columns blank — they'll be imported as empty
- Duplicate names will be flagged in the import result
- Unrecognized categories will be noted but still imported
- Download a sample template from the Import/Export page first

---

## Export

Go to **Import/Export** → Select what to export → Click **Export Excel**

Exported files can be re-imported after editing.
