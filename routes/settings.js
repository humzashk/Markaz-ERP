const express = require('express');
const router = express.Router();
const { db, getSettings } = require('../database');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const scope = (req.params.scope || req.body.scope || 'plastic_markaz').replace(/[^a-z_]/g,'');
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `logo_${scope}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(png|jpe?g|gif|webp|svg\+xml)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

router.get('/', (req, res) => {
  const settings = getSettings();
  res.render('settings/index', { page: 'settings', settings, saved: req.query.saved });
});

// Upload logo per account scope
router.post('/logo/:scope', upload.single('logo'), (req, res) => {
  const scope = req.params.scope;
  if (!['plastic_markaz','wings_furniture','cooler','default'].includes(scope)) {
    return res.redirect('/settings?err=bad_scope');
  }
  if (!req.file) return res.redirect('/settings?err=no_file');
  const rel = '/uploads/' + req.file.filename;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`logo_${scope}`, rel);
  res.redirect('/settings?saved=1#logos');
});

router.post('/logo/:scope/remove', (req, res) => {
  const scope = req.params.scope;
  const key = `logo_${scope}`;
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (row && row.value) {
    const filePath = path.join(__dirname, '..', 'public', row.value);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e){}
  }
  db.prepare('DELETE FROM settings WHERE key=?').run(key);
  res.redirect('/settings#logos');
});

router.post('/', (req, res) => {
  const fields = [
    'business_name', 'business_tagline', 'business_address', 'business_phone',
    'business_mobile', 'business_city', 'business_email', 'business_ntn', 'business_strn',
    'customer_categories', 'vendor_categories',
    'invoice_footer', 'invoice_terms', 'invoice_default_notes', 'invoice_bank_details',
    'currency_symbol', 'default_due_days', 'show_tax', 'tax_rate', 'paper_size',
    'prefix_invoice', 'prefix_order', 'prefix_purchase', 'prefix_creditnote', 'prefix_debitnote',
    'auto_confirm_order', 'auto_deduct_stock', 'low_stock_threshold', 'fy_start_month',
    'confirm_delete', 'allow_invoice_edit'
  ];
  for (const key of fields) {
    const val = req.body[key] || '';
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, val);
  }
  res.redirect('/settings?saved=1');
});

module.exports = router;
