const express = require('express');
const router = express.Router();
const { db, getSettings } = require('../database');

router.get('/', (req, res) => {
  const settings = getSettings();
  res.render('settings/index', { page: 'settings', settings, saved: req.query.saved });
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
