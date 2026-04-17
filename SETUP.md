# Setup & Configuration Guide

## Requirements

- **Node.js** v16 or later — [Download](https://nodejs.org)
- **npm** (comes with Node.js)
- Windows / macOS / Linux

---

## Installation

```bash
cd "Markaz ERP"
npm install
```

This installs all dependencies listed in `package.json`.

---

## First Run

```bash
node index.js
```

Then open: **http://localhost:3000**

The database (`markaz_erp.db`) is created automatically on first run with all tables and seed data.

---

## Settings

Go to **Settings** in the sidebar to configure:

| Setting | Description |
|---|---|
| Business Name | Appears on invoices and PDFs |
| Business Tagline | Sub-title on prints |
| Address / City / Phone / Email | Contact info on invoices |
| Currency Symbol | Default: `Rs.` |
| Invoice Terms | Payment terms text |
| Invoice Footer | Thank-you message |
| Default Due Days | Auto-set due date on invoices |

---

## Database Backup

The entire database is a single file: `markaz_erp.db`

**To back up:** Copy this file to a safe location (USB, Google Drive, etc.)

**To restore:** Replace the file with your backup copy and restart the server.

---

## Running on Startup (Windows)

Create a shortcut to this batch file:

```batch
@echo off
cd /d "C:\Path\To\Markaz ERP"
node index.js
pause
```

Or use **PM2** for background running:
```bash
npm install -g pm2
pm2 start index.js --name "markaz-erp"
pm2 startup
pm2 save
```

---

## Changing Port

Edit `index.js`, find:
```js
const PORT = 3000;
```
Change to your desired port number.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Port already in use" | Kill the process using port 3000, or change port |
| Blank page | Check console for errors, restart server |
| Data not saving | Check disk space, ensure `markaz_erp.db` is not read-only |
| Import fails | Ensure Excel columns match expected names (see IMPORT.md) |
